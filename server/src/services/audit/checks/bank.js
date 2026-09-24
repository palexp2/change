// Contrôles du rapprochement bancaire.
//
// Un contrôle CONSTATE, il ne corrige jamais : il n'écrit ni dans QuickBooks,
// ni sur un lien, ni sur un statut. C'est la même doctrine que les propositions
// (« elle prépare, vous confirmez »), appliquée à la vérification.
import db from '../../../db/database.js'
import { TXN_TYPE_ENTITY } from '../../bankQbLink.js'
import { searchAccount } from '../../bankQbSearch.js'
import { deriveFindings, qbVerifyConfig } from '../../bankQbVerify.js'
import { shiftDate } from '../../../utils/datetime.js'
import { qbEntityUrl } from '../../../connectors/quickbooks.js'
import { summarizeAccount, qbBalanceAsOf } from '../../bankReconcileSummary.js'
import { round2 } from '../../../utils/money.js'

const money = (n) => `${Number(n).toFixed(2)} $`

// ── 1. Deux lignes sur la même écriture ──────────────────────────────────────
//
// Légitime quand l'écriture touche DEUX comptes suivis : un paiement de carte
// est un débit au compte courant et un crédit à la carte, une seule écriture
// QuickBooks pour les deux lignes. Illégitime sur le même compte : le mouvement
// est alors comptabilisé deux fois, ou l'une des deux lignes est un doublon.
export const lienPartage = {
  id: 'bank_lien_partage',
  label: 'Deux lignes rattachées à la même écriture',
  domain: 'banque',
  needsLedger: false,
  run() {
    const rows = db.prepare(`
      SELECT t.qb_txn_id, t.qb_txn_type, COUNT(*) AS n,
             COUNT(DISTINCT t.account_id) AS accounts,
             GROUP_CONCAT(t.id) AS ids
      FROM bank_transactions t
      WHERE t.deleted_at IS NULL AND t.status != 'ignore' AND t.qb_txn_id IS NOT NULL
      GROUP BY t.qb_txn_type, t.qb_txn_id
      HAVING n > 1
    `).all()
    const findings = []
    for (const r of rows) {
      const ids = r.ids.split(',')
      const lines = db.prepare(`
        SELECT t.id, t.txn_date, t.amount, t.account_id, a.name AS account_name,
               COALESCE(NULLIF(t.details,''), t.description) AS label
        FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
        WHERE t.id IN (${ids.map(() => '?').join(',')})
        ORDER BY t.txn_date
      `).all(...ids)
      // Les deux jambes d'un même mouvement : comptes différents, une par
      // compte. Rien à signaler.
      if (r.accounts === r.n) continue
      findings.push({
        severity: 'high',
        entity_type: 'bank_transaction',
        entity_id: lines[0].id,
        fingerprint: `bank_lien_partage|${r.qb_txn_type}:${r.qb_txn_id}`,
        title: `${r.n} lignes rattachées à l'écriture ${r.qb_txn_type || ''} #${r.qb_txn_id}`,
        explanation: `${lines.map((l) => `${l.txn_date} ${money(l.amount)} (${l.account_name})`).join(' · ')} — même écriture QuickBooks pour plusieurs lignes du même compte : mouvement comptabilisé deux fois, ou ligne importée en double.`,
        data: { qb_id: r.qb_txn_id, qb_entity: r.qb_txn_type, lines, url: qbEntityUrl(r.qb_txn_type, r.qb_txn_id) },
      })
    }
    return findings
  },
}

// ── 2. Ligne importée deux fois ──────────────────────────────────────────────
export const doublonReleve = {
  id: 'bank_doublon_releve',
  label: 'Ligne du relevé importée deux fois',
  domain: 'banque',
  needsLedger: false,
  run() {
    const rows = db.prepare(`
      SELECT t.account_id, a.name AS account_name, t.txn_date, t.amount,
             COALESCE(NULLIF(t.details,''), t.description, '') AS label,
             COUNT(*) AS n, GROUP_CONCAT(t.id) AS ids
      FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
      WHERE t.deleted_at IS NULL AND t.status != 'ignore' AND COALESCE(t.pending,0)=0
        AND t.txn_date >= date('now','-400 day')
      GROUP BY t.account_id, t.txn_date, t.amount, label
      HAVING n > 1
    `).all()
    return rows.map((r) => ({
      severity: 'medium',
      entity_type: 'bank_transaction',
      entity_id: r.ids.split(',')[0],
      fingerprint: `bank_doublon_releve|${r.account_id}|${r.txn_date}|${r.amount}|${r.label}`,
      title: `${r.n} lignes identiques le ${r.txn_date} — ${money(r.amount)}`,
      explanation: `${r.account_name} · « ${r.label} » : même date, même montant, même libellé. Double import, ou deux vraies transactions — le solde du relevé tranche.`,
      data: { account_id: r.account_id, ids: r.ids.split(','), amount: r.amount, date: r.txn_date },
    }))
  },
}

// ── 3. Lien posé vers une écriture introuvable ───────────────────────────────
//
// C'est le filet du cas des 8 $ US : une ligne peut porter un lien QuickBooks
// parfaitement valide ET être affichée comme absente, ou l'inverse — un lien
// qui ne pointe plus sur rien. Les deux sont un désaccord entre ce qu'on
// affiche et ce que QuickBooks contient.
export const lienIntrouvable = {
  id: 'bank_lien_introuvable',
  label: 'Lien QuickBooks qui ne pointe sur rien',
  domain: 'banque',
  needsLedger: true,
  run({ accounts, index, window }) {
    const findings = []
    for (const account of accounts) {
      const entries = index.byAccount.get(account.id) || []
      const known = new Set(entries.map((e) => e.qbId).filter(Boolean))
      // Une écriture portée par un AUTRE compte suivi reste une écriture qui
      // existe (virement interne comptabilisé de l'autre côté).
      const elsewhere = new Set(index.all.map((e) => e.qbId).filter(Boolean))
      const rows = db.prepare(`
        SELECT id, txn_date, amount, qb_txn_id, qb_txn_type, qb_match_method,
               COALESCE(NULLIF(details,''), description) AS label
        FROM bank_transactions
        WHERE account_id=? AND deleted_at IS NULL AND status != 'ignore'
          AND qb_txn_id IS NOT NULL AND txn_date BETWEEN ? AND ?
      `).all(account.id, window.from, window.to)
      for (const t of rows) {
        if (known.has(String(t.qb_txn_id))) continue
        const ailleurs = elsewhere.has(String(t.qb_txn_id))
        findings.push({
          severity: ailleurs ? 'low' : 'high',
          entity_type: 'bank_transaction',
          entity_id: t.id,
          fingerprint: `bank_lien_introuvable|${account.id}|${t.id}|${t.qb_txn_id}`,
          title: `${t.txn_date} · ${money(t.amount)} — écriture ${t.qb_txn_id} absente de QuickBooks`,
          explanation: ailleurs
            ? `${account.name} · « ${t.label} » : l'écriture existe, mais sur un autre compte que celui du relevé — virement interne, ou mauvais compte dans QuickBooks.`
            : `${account.name} · « ${t.label} » : la ligne est marquée comptabilisée, mais l'écriture rattachée n'existe plus dans QuickBooks (supprimée, ou republiée sous un autre numéro).`,
          data: { account_id: account.id, qb_id: t.qb_txn_id, qb_entity: t.qb_txn_type, method: t.qb_match_method, url: qbEntityUrl(t.qb_txn_type, t.qb_txn_id) },
        })
      }
    }
    return findings
  },
}

// ── 4. Type d'écriture que nous ne savons pas lire ───────────────────────────
//
// Le grand livre nomme les types dans la langue du fichier QuickBooks. Un
// libellé que la table de correspondance ignore donne une écriture sans lien
// cliquable — et, avant le 2026-09-19, une écriture purement et simplement
// jetée, donc « manquante ».
export const typeInconnu = {
  id: 'qb_type_inconnu',
  label: "Type d'écriture QuickBooks inconnu",
  domain: 'banque',
  needsLedger: true,
  run({ index }) {
    const seen = new Map()
    for (const e of index.all) {
      if (!e.type || TXN_TYPE_ENTITY[e.type]) continue
      const cur = seen.get(e.type) || { n: 0, example: e }
      cur.n += 1
      seen.set(e.type, cur)
    }
    return [...seen.entries()].map(([type, { n, example }]) => ({
      severity: 'medium',
      fingerprint: `qb_type_inconnu|${type}`,
      title: `Type d'écriture inconnu : « ${type} » (${n} écriture${n > 1 ? 's' : ''})`,
      explanation: `Ces écritures ne peuvent pas être reliées à une ligne de relevé ni ouvertes d'un clic — exemple le ${example.date}, ${money(example.amount)}. À ajouter à la table des types.`,
      data: { type, count: n, example_date: example.date, example_amount: example.amount },
    }))
  },
}

// ── 5. Le solde ne tombe pas ─────────────────────────────────────────────────
export const ecartSolde = {
  id: 'bank_ecart_solde',
  label: 'Solde du relevé ≠ solde QuickBooks',
  domain: 'banque',
  needsLedger: false,
  async run({ accounts, config }) {
    const seuil = Number(config?.ecart_solde_seuil) || 1
    const findings = []
    for (const account of accounts) {
      const summary = summarizeAccount(account.id)
      if (!summary?.count || summary.statement?.balance_signed == null) continue
      const qbIds = String(account.qb_account_id || '').split(',').map((s) => s.trim()).filter(Boolean)
      if (!qbIds.length) continue
      let b = null
      try { b = await qbBalanceAsOf(qbIds, summary.statement.date) } catch { continue }
      const releve = summary.statement.balance_signed
      const diff = round2(releve - b.as_of)
      // Marge de crédit, carte : le relevé note parfois en positif ce que
      // QuickBooks porte en négatif. Comparer tels quels donnerait un écart
      // double du vrai — on retient alors l'écart des montants.
      const inverse = Math.sign(releve) === -Math.sign(b.as_of) && releve !== 0 && b.as_of !== 0
      const ecart = inverse ? round2(Math.abs(releve) - Math.abs(b.as_of)) : diff
      if (Math.abs(ecart) < seuil) continue
      findings.push({
        severity: Math.abs(ecart) >= 100 ? 'high' : 'medium',
        entity_type: 'bank_account',
        entity_id: account.id,
        fingerprint: `bank_ecart_solde|${account.id}|${summary.statement.date}`,
        title: `${account.name} : ${money(ecart)} d'écart au ${summary.statement.date}`,
        explanation: `Relevé ${money(releve)}, QuickBooks ${money(b.as_of)} à la même date`
          + (inverse ? ' (le relevé note l\'inverse de QuickBooks) — ' : ' — ')
          + "il manque une écriture d'un côté ou de l'autre.",
        data: { account_id: account.id, statement: releve, qb: b.as_of, difference: ecart, inverse, date: summary.statement.date },
      })
    }
    return findings
  },
}

// ── 6. Les constats du rapprochement, mémorisés ──────────────────────────────
//
// Ces deux-là s'affichaient déjà sur la page Rapprochement, mais recalculés à
// chaque visite : impossible d'en écarter un, impossible de savoir s'il est
// nouveau ou s'il traîne depuis un mois. Même moteur, même texte — seule la
// mémoire est ajoutée (deriveFindings n'écrit rien).
export const constatsRapprochement = {
  id: 'bank_rapprochement',
  label: 'Comptabilisée mais introuvable · écriture sans ligne au relevé',
  domain: 'banque',
  needsLedger: true,
  run({ accounts, index, window }) {
    const todayIso = new Date().toISOString().slice(0, 10)
    const graceDays = Number(qbVerifyConfig().grace_days) || 4
    const cutoff = shiftDate(todayIso, -graceDays)
    const KINDS = {
      comptabilisee_introuvable: { severity: 'high', title: (a) => `${a.date} · ${money(a.amount)} — comptabilisée, mais introuvable dans QuickBooks` },
      qb_sans_releve: { severity: 'medium', title: (a) => `${a.date} · ${money(a.amount)} — écriture QuickBooks sans ligne au relevé` },
    }
    const findings = []
    for (const account of accounts) {
      const bankTxns = db.prepare(`
        SELECT id, txn_date, COALESCE(NULLIF(details,''), description) AS description, details, reference,
               amount, status, matched_id, matched_type, sheet_color, qb_txn_id, qb_match_method, transfer_txn_id
        FROM bank_transactions
        WHERE account_id=? AND deleted_at IS NULL AND status != 'ignore'
          AND COALESCE(pending, 0) = 0 AND txn_date >= ? AND txn_date <= ?
        ORDER BY txn_date
      `).all(account.id, window.from, window.to)
      if (!bankTxns.length) continue
      const txnById = new Map(bankTxns.map((t) => [t.id, t]))
      const { matches, unmatchedBank, unmatchedQb } = searchAccount(account, bankTxns, index)
      const { anomalies } = deriveFindings(account, {
        bankTxns, matches, unmatchedBank, unmatchedQb, txnById,
        from: window.from, cutoff, todayIso,
      })
      for (const a of anomalies) {
        const meta = KINDS[a.kind]
        if (!meta) continue // les doublons ont leur propre contrôle
        findings.push({
          severity: meta.severity,
          entity_type: a.txn_id ? 'bank_transaction' : 'bank_account',
          entity_id: a.txn_id || account.id,
          fingerprint: a.key,
          title: `${account.name} : ${meta.title(a)}`,
          explanation: `« ${a.label} » — ${a.explanation}`,
          data: { account_id: account.id, kind: a.kind, date: a.date, amount: a.amount, qb_id: a.qb_id || null, url: a.qb_entity && a.qb_id ? qbEntityUrl(a.qb_entity, a.qb_id) : null },
        })
      }
    }
    return findings
  },
}

// ── 7. La chaîne des soldes du relevé est rompue ─────────────────────────────
//
// Le solde passe d'une ligne à l'autre sans que la somme suive : une
// transaction manque à l'import, et tout ce qui vient après est faux.
export const chaineSolde = {
  id: 'bank_chaine_solde',
  label: 'Une transaction manque au relevé',
  domain: 'banque',
  needsLedger: false,
  run({ accounts }) {
    const findings = []
    for (const account of accounts) {
      const summary = summarizeAccount(account.id)
      // Une rupture fausse tout ce qui suit : on ne signale que la PREMIÈRE du
      // compte, celle par où le relevé a décroché, et on compte les suivantes.
      const breaks = (summary?.anomalies || []).filter((a) => a.kind === 'chaine_solde')
        .sort((a, b) => (a.date < b.date ? -1 : 1))
      if (!breaks.length) continue
      const a = breaks[0]
      const suite = breaks.length - 1
      findings.push({
        severity: 'medium',
        entity_type: 'bank_transaction',
        entity_id: a.txn_id,
        fingerprint: `bank_chaine_solde|${account.id}|${a.date}|${Number(a.amount).toFixed(2)}`,
        title: `${account.name} : ${money(a.amount)} manquants au relevé le ${a.date}`,
        explanation: a.explanation + (suite ? ` ${suite} autre(s) rupture(s) suivent sur ce compte.` : ''),
        data: { account_id: account.id, date: a.date, delta: a.amount, suivantes: suite },
      })
    }
    return findings
  },
}

export const BANK_CHECKS = [lienPartage, doublonReleve, lienIntrouvable, typeInconnu, ecartSolde, constatsRapprochement, chaineSolde]
