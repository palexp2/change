// Revenus perçus d'avance — le compte 23900, prouvé ligne par ligne.
//
// Ce que le compte contient, et rien d'autre : l'argent encaissé pour des
// commandes PAS ENCORE EXPÉDIÉES. Un encaissement le crédite (le passif naît),
// l'expédition le débite (le passif se libère vers les ventes). Les
// abonnements ne passent jamais par ici — ils créditent directement 41000 au
// moment du paiement (voir `creditAccountId` dans services/quickbooks.js).
//
// La question à laquelle cette page répond : « est-ce que tout ce qui est
// entré dans 23900 en est ressorti une fois, et une seule ? » Trois fautes se
// paient au solde, et ce sont celles qu'on cherche :
//   1. une libération passée DEUX FOIS (l'annulation refaite à la main) —
//      le compte descend sous ce qu'il devrait porter ;
//   2. une libération sans encaissement correspondant ;
//   3. un encaissement jamais libéré alors que la commande est partie.
//
// Le piège du rapprochement, et la raison pour laquelle un appariement montant
// par montant échoue : un client paie parfois en DEUX versements (« Paiement 1
// de 2 », « 2 de 2 » chez Les jardins Malbi). Aucun des deux ne correspond au
// montant de la facture ; leur somme, oui. On apparie donc par client, pas par
// ligne, et on additionne avant de comparer.
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { qbGet, qbPost, qbEntityUrl } from '../connectors/quickbooks.js'
import { resolveAccountByAcctNum } from './quickbooks.js'
import { logSync } from './syncLog.js'

export const DEFERRAL_ACCTNUM = '23900'   // Revenus perçus d'avance (passif)
export const SALES_ACCTNUM = '40000'      // Ventes de produits

const r2 = n => Math.round((Number(n) || 0) * 100) / 100
const EPS = 0.01

// ── Lecture du grand livre ──────────────────────────────────────────────────

// Montants du rapport : « 1 234,56 », « (1 234,56) », « $1,234.56 ».
export function parseAmount(v) {
  const s = String(v ?? '').trim()
  if (!s) return 0
  const neg = /^\(.*\)$/.test(s)
  const n = parseFloat(s.replace(/[()\s$]/g, '').replace(/,(\d{3})/g, '$1').replace(',', '.'))
  if (!Number.isFinite(n)) return 0
  return r2(neg ? -n : n)
}

// Numéro de document Orisha : huit caractères, tiret, quatre chiffres
// (« #868A5792-0005 »). Il voyage dans le mémo des écritures de constatation
// et dans le numéro des reçus de vente.
export function parseRef(text) {
  const m = String(text || '').match(/([0-9A-Z]{8}-\d{4})/)
  return m ? m[1] : null
}

// Le client d'une ligne. QuickBooks ne remplit la colonne « Nom » que sur les
// dépôts ; sur les écritures de journal, le client est en tête du mémo
// (« Ferme Giroflée: Constatation de la vente », « Constatation #ABC-0001 »).
// Sans cette lecture, toutes les constatations tombent dans un même tas.
// Certains « noms » n'en sont pas : sur un reçu de vente, QuickBooks met le
// compte d'encaissement (« Stripe CAD ») dans la colonne Nom et le client dans
// le mémo ; « Solde d'ouverture » et les libellés de relevé ne nomment personne.
const NON_NOMS = /^(stripe|paypal|solde d.ouverture|opening balance|miscellaneous|interac|depot|dépôt|virement)/i

export function lineParty(line) {
  const memoHead = String(line.memo || '').split(':')[0].trim()
  const usableMemo = memoHead && memoHead.length <= 60
    && !/^constatation/i.test(memoHead) && !/^#/.test(memoHead) && !NON_NOMS.test(memoHead)
    ? memoHead : ''
  if (line.name && !NON_NOMS.test(line.name)) return line.name
  return usableMemo
}

// Nom de client comparable : sans accents, sans ponctuation, sans forme
// juridique. « Au potager du paysan Inc. » et « au potager du paysan » sont le
// même client ; c'est la seule clé disponible sur les dépôts saisis à la main.
export function normalizeName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(inc|ltd|ltee|ltée|llc|enr|senc|srl|co|corp|cie)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Les lignes du compte 23900 sur la période, à plat.
export async function ledgerLines({ start = '2019-01-01', end } = {}) {
  const accountId = await resolveAccountByAcctNum(DEFERRAL_ACCTNUM)
  if (!accountId) throw new Error(`Compte QB #${DEFERRAL_ACCTNUM} introuvable`)
  const params = new URLSearchParams({
    start_date: start,
    end_date: end || new Date().toISOString().slice(0, 10),
    accounting_method: 'Accrual',
    // Montants en dollars CANADIENS (« home ») : les colonnes ordinaires rendent
    // le montant dans la devise de l'opération, si bien qu'un encaissement en
    // USD entre au grand livre pour sa valeur américaine. Somme fausse de
    // 7 302,46 $ sur le compte avant cette correction.
    columns: 'tx_date,txn_type,doc_num,name,memo,debt_home_amt,credit_home_amt',
    account: String(accountId),
  })
  const report = await qbGet(`/reports/GeneralLedger?${params}`)
  const rows = []
  const walk = node => {
    for (const row of node?.Row || []) {
      if (row.ColData?.[0]?.value) {
        const [date, type, docNum, name, memo, debit, credit] = row.ColData.map(c => c.value)
        rows.push({
          date, type, doc_num: docNum || '', name: name || '', memo: memo || '',
          debit: parseAmount(debit), credit: parseAmount(credit),
        })
      }
      if (row.Rows) walk(row.Rows)
    }
  }
  walk((report?.Report || report)?.Rows)
  return rows
}

// Solde du compte, tel que QuickBooks le porte. On interroge le compte
// lui-même : son `CurrentBalance` colle au grand livre au cent près, alors que
// le rapport Bilan en écartait un dépôt récent (142 $ vus le 2026-09-15).
// Un passif se lit en négatif dans QuickBooks — on rend le solde créditeur.
export async function qbBalance() {
  const accountId = await resolveAccountByAcctNum(DEFERRAL_ACCTNUM)
  if (!accountId) return null
  const query = encodeURIComponent(`select * from Account where Id = '${accountId}'`)
  const data = await qbGet(`/query?query=${query}`)
  const account = data?.QueryResponse?.Account?.[0]
  if (!account) return null
  return r2(-Number(account.CurrentBalance || 0))
}

// ── Côté ERP : ce que l'application croit avoir posé ────────────────────────

export function erpDeposits() {
  return db.prepare(`
    SELECT f.id, f.document_number, f.company_id, f.currency, f.paid_at, f.status,
           f.paid_amount, f.total_amount,
           f.deferred_revenue_at, f.deferred_revenue_amount_cad,
           f.revenue_recognized_at, f.revenue_recognized_je_id,
           c.name AS company_name
    FROM factures f
    LEFT JOIN companies c ON c.id = f.company_id
    WHERE f.kind = 'order'
      AND (f.deferred_revenue_at IS NOT NULL
           OR (f.paid_at IS NOT NULL AND f.revenue_recognized_at IS NULL AND COALESCE(f.status,'') = 'Payé'))
    ORDER BY f.paid_at DESC
  `).all()
}

// Toutes les factures, juste pour mettre un nom sur un numéro. Une écriture
// peut citer une facture qui n'est plus dans la liste des dépôts (déjà soldée,
// d'un autre type) : sans ce répertoire, la page affiche « C01EE1F9-0004 » au
// lieu du client.
export function factureDirectory() {
  const rows = db.prepare(`
    SELECT f.id, f.document_number, f.company_id, c.name AS company_name
    FROM factures f LEFT JOIN companies c ON c.id = f.company_id
    WHERE f.document_number IS NOT NULL
  `).all()
  const index = new Map()
  for (const r of rows) index.set(String(r.document_number).toUpperCase(), r)
  return index
}

// ── Appariement (pur, testable) ─────────────────────────────────────────────

// Chaque ligne du grand livre rejoint un groupe : la facture dont elle porte le
// numéro, sinon le client dont elle porte le nom. Un groupe = un dossier à
// solder.
// Deux écritures d'un même client ne portent pas toujours le même nom : la
// banque ajoute une division, QuickBooks un suffixe. Un nom contenu dans
// l'autre, à partir de quatre lettres, est le même client.
const MOTS_VIDES = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'et', 'aux', 'au', 'a', 'l', 'd'])
const motsUtiles = n => n.split(' ').filter(w => w.length > 1 && !MOTS_VIDES.has(w))

export function matchName(needle, names) {
  const n = normalizeName(needle)
  if (!n) return null
  if (names.has(n)) return n
  if (n.length < 4) return null
  for (const k of names.keys()) {
    if (k.length >= 4 && (k.includes(n) || n.includes(k))) return k
  }
  // « Coopérative Gaïa » et « Coopérative de solidarité Gaïa » : les mots de
  // l'un sont tous dans l'autre, en ignorant les articles. Deux mots utiles au
  // minimum, sinon « Ferme » marierait la moitié des clients.
  const mine = motsUtiles(n)
  if (mine.length < 2) return null
  for (const k of names.keys()) {
    const theirs = motsUtiles(k)
    if (theirs.length < 2) continue
    const [petit, grand] = mine.length <= theirs.length ? [mine, theirs] : [theirs, mine]
    if (petit.every(w => grand.includes(w))) return k
  }
  return null
}

export function groupLedger(lines, factures, directory = new Map()) {
  const byNumber = new Map()
  for (const f of factures) if (f.document_number) byNumber.set(String(f.document_number).toUpperCase(), f)
  const byName = new Map()
  for (const f of factures) {
    const k = normalizeName(f.company_name)
    if (!k) continue
    if (!byName.has(k)) byName.set(k, [])
    byName.get(k).push(f)
  }

  const groups = new Map()
  const openFor = (key, label, facture) => {
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label,
        facture_id: facture?.id || null,
        document_number: facture?.document_number || null,
        company_id: facture?.company_id || null,
        company_name: facture?.company_name || label,
        factures: facture ? [facture] : [],
        lines: [],
      })
    }
    const g = groups.get(key)
    if (facture && !g.factures.some(f => f.id === facture.id)) {
      g.factures.push(facture)
      g.facture_id = g.facture_id || facture.id
      g.document_number = g.document_number || facture.document_number
      g.company_id = g.company_id || facture.company_id
      if (facture.company_name) g.company_name = facture.company_name
    }
    return g
  }

  // Le dossier, c'est le CLIENT : c'est à son échelle que deux versements
  // s'additionnent et qu'une libération répond à un encaissement. Le numéro de
  // facture sert à trouver le client, pas à découper le dossier.
  const keyFor = facture => `c:${facture.company_id || normalizeName(facture.company_name) || facture.id}`

  for (const line of lines) {
    const ref = parseRef(line.memo) || parseRef(line.doc_num)
    let facture = ref ? byNumber.get(ref.toUpperCase()) : null
    if (!facture) {
      const hit = matchName(lineParty(line), byName)
      const candidates = hit ? byName.get(hit) : []
      if (candidates.length) facture = candidates[0]
    }
    // Pas de dossier ouvert pour cette facture, mais son numéro dit chez qui
    // l'écriture est allée : on rejoint le dossier de ce client.
    const known = !facture && ref ? directory.get(ref.toUpperCase()) : null
    const party = lineParty(line)
    const key = facture
      ? keyFor(facture)
      : known?.company_id ? `c:${known.company_id}`
        : normalizeName(party) ? `n:${normalizeName(party)}`
          : ref ? `r:${ref}` : 'n:sans-nom'
    const label = facture?.company_name || known?.company_name || party || ref || 'Sans nom'
    const group = openFor(key, label, facture)
    if (!group.company_id && known?.company_id) {
      group.company_id = known.company_id
      group.company_name = known.company_name || group.company_name
      group.facture_id = group.facture_id || known.id
      group.document_number = group.document_number || known.document_number
    }
    group.lines.push(line)
  }

  // Une facture que l'ERP dit avoir posée sans rien au grand livre doit exister
  // comme dossier : c'est un cas à signaler, pas un silence.
  for (const f of factures) {
    if (!f.deferred_revenue_at) continue
    openFor(keyFor(f), f.company_name, f)
  }

  return mergeLooseNames([...groups.values()]).map(summarize)
}

// Dernier passage : un dossier ouvert sous un simple nom (« Coopérative Gaïa »,
// lu sur un dépôt) rejoint le dossier du client identifié (« Coopérative de
// solidarité Gaïa », retrouvé par le numéro de facture). Sans ce recollage,
// l'encaissement et sa libération restent deux moitiés qui s'accusent l'une
// l'autre.
export function mergeLooseNames(groups) {
  const identified = groups.filter(g => g.company_id)
  if (!identified.length) return groups
  const index = new Map(identified.map(g => [normalizeName(g.company_name), g]))
  const kept = []
  for (const g of groups) {
    if (g.company_id) { kept.push(g); continue }
    const hit = matchName(g.company_name, index)
    const target = hit ? index.get(hit) : null
    if (!target || target === g) { kept.push(g); continue }
    target.lines.push(...g.lines)
    target.factures.push(...g.factures.filter(f => !target.factures.some(t => t.id === f.id)))
  }
  return kept
}

// Le verdict d'un groupe : ce qui est entré, ce qui est sorti, ce qui reste.
export function summarize(group) {
  const credits = group.lines.filter(l => l.credit > 0)
  const debits = group.lines.filter(l => l.debit > 0)
  const encaisse = r2(credits.reduce((s, l) => s + l.credit, 0))
  const libere = r2(debits.reduce((s, l) => s + l.debit, 0))
  const solde = r2(encaisse - libere)
  const dates = group.lines.map(l => l.date).filter(Boolean).sort()

  const expediees = (group.factures || []).filter(f => f.revenue_recognized_at)
  const ouvertes = (group.factures || []).filter(f => !f.revenue_recognized_at)
  const posees = (group.factures || []).filter(f => f.deferred_revenue_at)

  const anomalies = []
  if (solde < -EPS) {
    anomalies.push({
      code: 'libere_en_trop',
      label: debits.length > 1 ? 'Libéré deux fois' : 'Libéré sans encaissement',
      amount: r2(-solde),
      fix: 'remettre',
    })
  } else if (solde > EPS && expediees.length && !ouvertes.length) {
    anomalies.push({
      code: 'jamais_libere',
      label: 'Commande expédiée, passif jamais libéré',
      amount: solde,
      fix: 'liberer',
    })
  }
  if (encaisse === 0 && libere === 0 && posees.length) {
    anomalies.push({ code: 'absent_du_grand_livre', label: 'Rien au grand livre', amount: 0, fix: null })
  }

  return {
    ...group,
    encaisse,
    libere,
    solde,
    factures: (group.factures || []).map(f => ({
      id: f.id, document_number: f.document_number,
      recognized_at: f.revenue_recognized_at, deferred_at: f.deferred_revenue_at,
    })),
    versements: credits.length,
    multi_versements: credits.length > 1,
    first_date: dates[0] || null,
    last_date: dates[dates.length - 1] || null,
    etat: solde > EPS ? 'À constater' : solde < -EPS ? 'Anomalie' : 'Réglé',
    anomalies,
  }
}

// ── L'état complet ──────────────────────────────────────────────────────────

export async function buildState({ end } = {}) {
  const asOf = end || new Date().toISOString().slice(0, 10)
  const factures = erpDeposits()
  const lines = await ledgerLines({ end: asOf })
  const groups = groupLedger(lines, factures, factureDirectory())

  // À constater d'abord, anomalies tout en haut : la page sert à agir.
  groups.sort((a, b) => (b.anomalies.length - a.anomalies.length)
    || (Math.abs(b.solde) - Math.abs(a.solde))
    || String(a.company_name).localeCompare(String(b.company_name)))

  suggestPairs(groups)

  const open = groups.filter(g => Math.abs(g.solde) > EPS)
  const totals = {
    a_constater: r2(open.filter(g => g.solde > 0).reduce((s, g) => s + g.solde, 0)),
    anomalies: r2(open.filter(g => g.solde < 0).reduce((s, g) => s + g.solde, 0)),
    solde: r2(groups.reduce((s, g) => s + g.solde, 0)),
    anomalies_count: groups.filter(g => g.anomalies.length).length,
    multi_versements: groups.filter(g => g.multi_versements).length,
  }

  let balance = null
  let error = null
  try { balance = await qbBalance() } catch (e) { error = e.message }

  return {
    as_of: asOf,
    acctnum: DEFERRAL_ACCTNUM,
    groups,
    totals,
    qb_balance: balance,
    ecart: balance == null ? null : r2(balance - totals.solde),
    qb_error: error,
    corrections: recentCorrections(),
  }
}

// Un encaissement orphelin et une libération orpheline du MÊME montant sont
// presque toujours les deux moitiés d'un dossier que les libellés n'ont pas
// permis de réunir (« Solde d'ouverture » d'un côté, le nom du client de
// l'autre). On le dit plutôt que de crier deux anomalies.
export function suggestPairs(groups) {
  const open = groups.filter(g => Math.abs(g.solde) > EPS)
  for (const g of open) {
    const twin = open.find(o => o !== g && Math.abs(o.solde + g.solde) < EPS)
    if (!twin) continue
    g.pair_with = twin.company_name
    g.anomalies = g.anomalies.map(a => ({
      ...a,
      label: `${a.label} — même montant que « ${twin.company_name} »`,
      fix: null,
    }))
  }
  return groups
}

// ── Correction (préparée ici, envoyée sur clic) ─────────────────────────────

// L'écriture qui remet le dossier à zéro. Deux sens seulement :
//   « remettre » — le passif a été libéré en trop : on le repose (Cr 23900).
//   « libérer »  — l'expédition n'a jamais été passée : on le libère (Dr 23900).
export function correctionFor(group) {
  const anomaly = group.anomalies?.find(a => a.fix)
  if (!anomaly) return null
  const amount = r2(anomaly.amount)
  if (!(amount > 0)) return null
  const who = group.document_number ? `#${group.document_number}` : group.company_name
  return {
    key: group.key,
    code: anomaly.code,
    amount,
    txn_date: new Date().toISOString().slice(0, 10),
    memo: anomaly.fix === 'remettre'
      ? `Correction ${who} — passif 23900 libéré en trop, remis`
      : `Constatation ${who} — passif 23900 libéré (commande expédiée)`,
    lines: anomaly.fix === 'remettre'
      ? [
        { posting: 'Debit', acctnum: SALES_ACCTNUM, amount, label: `Annulation de la libération en double — ${who}` },
        { posting: 'Credit', acctnum: DEFERRAL_ACCTNUM, amount, label: `Passif remis — ${who}` },
      ]
      : [
        { posting: 'Debit', acctnum: DEFERRAL_ACCTNUM, amount, label: `Passif libéré — ${who}` },
        { posting: 'Credit', acctnum: SALES_ACCTNUM, amount, label: `Vente constatée — ${who}` },
      ],
  }
}

export async function prepareCorrection(key, state = null) {
  const s = state || await buildState()
  const group = s.groups.find(g => g.key === key)
  if (!group) throw new Error('Dossier introuvable')
  const correction = correctionFor(group)
  if (!correction) throw new Error('Rien à corriger sur ce dossier')
  return { group, correction }
}

export function recentCorrections() {
  return db.prepare(`
    SELECT * FROM deferred_deposit_corrections ORDER BY created_at DESC LIMIT 50
  `).all()
}

// Publie l'écriture telle qu'elle est affichée. La trace est posée AVANT
// l'envoi et retirée si QuickBooks refuse — on ne veut pas d'une correction
// notée mais jamais partie.
export async function publishCorrection({ key, lines, memo, txn_date, userId = null }) {
  const entries = (lines || []).filter(l => Number(l.amount) > 0)
  if (!entries.length) throw new Error('Aucun montant à envoyer')
  const total = r2(entries.filter(l => l.posting === 'Debit').reduce((s, l) => s + Number(l.amount), 0))
  const credit = r2(entries.filter(l => l.posting === 'Credit').reduce((s, l) => s + Number(l.amount), 0))
  if (total !== credit) throw new Error(`Écriture déséquilibrée : ${total} au débit, ${credit} au crédit`)

  const id = newRecordId()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO deferred_deposit_corrections (id, group_key, amount_cad, memo, txn_date, lines, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, key, total, memo || null, txn_date || now.slice(0, 10), JSON.stringify(entries), userId, now)

  try {
    const qbLines = []
    for (const line of entries) {
      const accountId = await resolveAccountByAcctNum(line.acctnum)
      if (!accountId) throw new Error(`Compte QB #${line.acctnum} introuvable`)
      qbLines.push({
        DetailType: 'JournalEntryLineDetail',
        Amount: r2(line.amount),
        Description: line.label,
        JournalEntryLineDetail: { PostingType: line.posting, AccountRef: { value: accountId } },
      })
    }
    const result = await qbPost('/journalentry', {
      TxnDate: txn_date || now.slice(0, 10),
      PrivateNote: memo,
      Line: qbLines,
    })
    const jeId = result.JournalEntry?.Id
    if (!jeId) throw new Error("QuickBooks n'a pas retourné d'identifiant d'écriture")
    db.prepare('UPDATE deferred_deposit_corrections SET qb_je_id=?, pushed_at=? WHERE id=?')
      .run(String(jeId), now, id)
    logSync('deferred_deposits', 'manual', { status: 'success', modified: 1 })
    return { id, qb_je_id: String(jeId), qb_je_url: qbEntityUrl('journal', String(jeId)), amount: total }
  } catch (e) {
    db.prepare('DELETE FROM deferred_deposit_corrections WHERE id=? AND qb_je_id IS NULL').run(id)
    logSync('deferred_deposits', 'manual', { status: 'error', error: e.message })
    throw e
  }
}
