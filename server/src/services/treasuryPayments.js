// Paiements et virements émis — le chaînon manquant entre « la facture est
// payée » et « l'argent est sorti du compte ».
//
// Remplace l'onglet « Pmt_Suivi » du fichier CTB - Suivi, où chaque paiement
// émis était noté à la main et la colonne Montant coloriée en vert une fois
// passée à la banque. L'ERP ignorait complètement cette étape :
//   - une facture marquée « Payée » quittait la projection alors que l'argent
//     était encore au compte (virement Interac du samedi 1er août à Antoine
//     Ratteau pour Les Jardins d'Inverness : invisible partout) ;
//   - un paiement post-daté (émis aujourd'hui, débité dans deux semaines)
//     n'existait nulle part ;
//   - les renflouements du compte (virement Venn → BNC, Desjardins → BNC,
//     Épargne → Chèque) — exactement le « virement suggéré » de la page — non
//     plus, alors qu'ils expliquent les sauts de solde.
//
// Modèle : un paiement porte sa date de sortie réelle (ou prévue) et un état
// binaire — `cleared_at` NULL = pas encore passé à la banque (le vert du
// fichier). Tant qu'il n'est pas passé, il est projeté ; ensuite le relevé
// bancaire prend le relais. L'appariement au relevé (et demain à Plaid) coche
// automatiquement `cleared_at`.
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { qbGet } from '../connectors/quickbooks.js'

export const PAYMENT_METHODS = ['interac', 'cheque', 'carte', 'transfert', 'code_paiement', 'autre']

const r2 = n => Math.round(Number(n) * 100) / 100
const dayOnly = v => String(v || '').slice(0, 10)

// ── Lecture ──────────────────────────────────────────────────────────────────

const LIST_SELECT = `
  SELECT p.*, a.vendor AS achat_vendor, a.status AS achat_status, a.total_cad AS achat_total,
         a.quickbooks_id AS achat_qb_id,
         -- Échéance de la facture réglée : un paiement émis pour une facture
         -- qui n'est pas encore due est le symptôme d'un faux clic dans la
         -- cédule. La ligne ayant quitté la cédule, c'est le seul endroit où
         -- l'erreur peut encore se voir.
         COALESCE(a.due_date, a.date_achat) AS achat_due_date,
         -- Date réelle de la facture réglée : date_achat est la TxnDate
         -- synchronisée depuis QuickBooks (voir services/quickbooks.js) — la
         -- source de vérité, pas une saisie. Écrase invoice_date à la lecture.
         a.date_achat AS achat_invoice_date,
         t.txn_date AS bank_txn_date, t.description AS bank_txn_label
  FROM treasury_payments p
  LEFT JOIN achats_fournisseurs a ON a.id = p.achat_id
  LEFT JOIN bank_transactions t ON t.id = p.bank_txn_id
  WHERE p.deleted_at IS NULL
`

const setInvoiceDateStmt = db.prepare('UPDATE treasury_payments SET invoice_date = ? WHERE id = ?')

// « Date de la facture » n'est éditable à la main que pour un paiement sans
// facture liée (mouvement interne, ou lien jamais établi) : dès qu'un achat_id
// existe, sa date_achat (= TxnDate QuickBooks) prime toujours sur toute valeur
// stockée — persistée en base pour que les autres lecteurs (export, rapports)
// voient la même chose.
function resolveInvoiceDate(row) {
  if (row?.achat_invoice_date && row.achat_invoice_date !== row.invoice_date) {
    setInvoiceDateStmt.run(row.achat_invoice_date, row.id)
    row.invoice_date = row.achat_invoice_date
  }
  return row
}

// status : 'pending' (pas encore passé à la banque) | 'cleared' | 'all'.
export function listPayments({ status = 'all', from = null, to = null, limit = 300 } = {}) {
  const where = []
  const args = []
  if (status === 'pending') where.push('p.cleared_at IS NULL')
  if (status === 'cleared') where.push('p.cleared_at IS NOT NULL')
  if (from) { where.push('p.payment_date >= ?'); args.push(dayOnly(from)) }
  if (to) { where.push('p.payment_date <= ?'); args.push(dayOnly(to)) }
  const sql = `${LIST_SELECT} ${where.length ? `AND ${where.join(' AND ')}` : ''}
    ORDER BY p.payment_date DESC, p.created_at DESC LIMIT ?`
  return db.prepare(sql).all(...args, Math.min(2000, Math.max(1, Number(limit) || 300))).map(resolveInvoiceDate)
}

export function getPayment(id) {
  return resolveInvoiceDate(db.prepare(`${LIST_SELECT} AND p.id = ?`).get(id) || null)
}

// Recherche QuickBooks (Bill puis Purchase) par n° de facture : sert quand le
// paiement n'a AUCUN achat_id lié (import historique, virement) mais porte un
// n° de facture — on va chercher sa TxnDate directement chez QuickBooks plutôt
// que de la laisser vide. `cap` borne le nombre d'appels par chargement de
// liste : un lookup qui échoue (offline, TxnDate absente) réessaiera au
// prochain chargement, jamais bloquant pour l'utilisateur.
async function fetchQbInvoiceDate(invoiceNumber) {
  const safe = String(invoiceNumber).replace(/'/g, "\\'")
  for (const entity of ['Bill', 'Purchase']) {
    try {
      const q = new URLSearchParams({ query: `SELECT Id, TxnDate FROM ${entity} WHERE DocNumber = '${safe}' MAXRESULTS 1` })
      const data = await qbGet(`/query?${q}`)
      const hit = data.QueryResponse?.[entity]?.[0]
      if (hit?.TxnDate) return hit.TxnDate
    } catch { /* entité suivante, ou capitulation si aucune ne répond */ }
  }
  return null
}

export async function enrichInvoiceDatesFromQb(rows, { cap = 12 } = {}) {
  let calls = 0
  for (const p of rows) {
    if (p.invoice_date || p.achat_id || !p.invoice_number) continue
    if (calls >= cap) break
    calls++
    const date = await fetchQbInvoiceDate(p.invoice_number)
    if (date) { setInvoiceDateStmt.run(date, p.id); p.invoice_date = date }
  }
  return rows
}

// ── Écriture ─────────────────────────────────────────────────────────────────

export const PAYMENT_FIELDS = [
  'payment_date', 'direction', 'amount', 'currency', 'account', 'label',
  'achat_id', 'invoice_date', 'invoice_number', 'reference', 'method', 'notes',
  // Mouvement interne : l'autre compte (transfert, paiement de carte). Virement
  // ou chèque : le bénéficiaire réel (courriel Interac, « à l'ordre de »).
  'counterparty_account', 'recipient',
]

export function validatePayment(body, { partial = false } = {}) {
  if (!partial || 'payment_date' in body) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayOnly(body.payment_date))) return 'payment_date au format YYYY-MM-DD'
  }
  if (!partial || 'amount' in body) {
    const n = Number(body.amount)
    if (!Number.isFinite(n) || n <= 0) return 'amount doit être un nombre positif (le sens vient de direction)'
  }
  if ('direction' in body && body.direction != null && !['in', 'out'].includes(body.direction)) {
    return "direction doit valoir 'in' ou 'out'"
  }
  if ('method' in body && body.method && !PAYMENT_METHODS.includes(body.method)) {
    return `method invalide (${PAYMENT_METHODS.join(', ')})`
  }
  return null
}

export function createPayment(body, userId = null) {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO treasury_payments (
      id, payment_date, direction, amount, currency, account, label, achat_id,
      invoice_date, invoice_number, reference, method, notes, counterparty_account, recipient,
      cleared_at, cleared_source, sheet_seen_at, source, import_key, created_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, dayOnly(body.payment_date), body.direction === 'in' ? 'in' : 'out', r2(body.amount),
    body.currency || 'CAD', body.account || 'BNC CAD', body.label || null, body.achat_id || null,
    body.invoice_date ? dayOnly(body.invoice_date) : null, body.invoice_number || null, body.reference || null, body.method || null, body.notes || null,
    body.counterparty_account || null, body.recipient || null,
    body.cleared_at || null, body.cleared_at ? (body.cleared_source || 'manual') : null,
    body.sheet_seen_at || null, body.source || 'manual', body.import_key || null, userId,
  )
  return getPayment(id)
}

// Coche / décoche « passé à la banque ». Décocher remet le paiement dans la
// projection : c'est l'échappatoire quand l'appariement automatique s'est trompé
// — il remet aussi sheet_seen_at à NULL pour que la détection par le fichier
// (treasurySoldeSheet) ne re-coche pas par-dessus la décision de l'utilisateur.
// `source` trace qui a coché : manual | bank (relevé) | sheet (fichier de suivi).
export function setCleared(id, cleared, { bankTxnId = null, source = 'manual' } = {}) {
  db.prepare(`
    UPDATE treasury_payments
    SET cleared_at = CASE WHEN ? THEN COALESCE(cleared_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ELSE NULL END,
        cleared_source = CASE WHEN ? THEN COALESCE(cleared_source, ?) ELSE NULL END,
        bank_txn_id = CASE WHEN ? THEN COALESCE(?, bank_txn_id) ELSE NULL END,
        sheet_seen_at = CASE WHEN ? THEN sheet_seen_at ELSE NULL END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND deleted_at IS NULL
  `).run(cleared ? 1 : 0, cleared ? 1 : 0, source, cleared ? 1 : 0, bankTxnId, cleared ? 1 : 0, id)
  return getPayment(id)
}

// ── Facture fournisseur marquée « Payée » → paiement en attente de passage ────
// Sans ça, marquer une facture payée la fait disparaître de la projection alors
// que l'argent est encore au compte. On crée donc un paiement non passé, à la
// date du jour par défaut. Idempotent : une facture n'engendre qu'un paiement.
export function syncFromAchat(achat, userId = null) {
  if (!achat || achat.type !== 'bill' || achat.status !== 'Payée') return null
  if (!(Number(achat.total_cad) > 0)) return null
  const existing = db.prepare(
    'SELECT id FROM treasury_payments WHERE achat_id = ? AND deleted_at IS NULL'
  ).get(achat.id)
  if (existing) return null
  return createPayment({
    payment_date: new Date().toISOString().slice(0, 10),
    direction: 'out',
    amount: achat.total_cad,
    currency: achat.currency || 'CAD',
    label: achat.vendor || 'Facture fournisseur',
    achat_id: achat.id,
    invoice_number: achat.vendor_invoice_number || achat.bill_number || null,
    source: 'achat',
  }, userId)
}

// Facture fournisseur correspondant à un paiement (fournisseur + montant à
// 1 % / 1 $ près sur le total ou le solde dû, facture PAS ENCORE payée). Sert à
// lier un paiement importé ou saisi à la facture qu'il règle : sans lien, la
// facture continue d'être projetée à son échéance EN PLUS du paiement — le même
// dollar sortirait deux fois.
// Les factures payées/annulées sont EXCLUES et la meilleure candidate est
// choisie (montant le plus proche, puis échéance la plus proche de la date du
// paiement) : le paiement Dubois Agrinovation 830,77 $ du 9 août 2026 s'était
// lié à une facture de 2020 déjà payée (837,01 $, première dans la table), ce
// qui laissait la vraie facture ouverte du 9 août se projeter en double.
export function findAchatForPayment({ label, amount, payment_date = null, currency = 'CAD' }) {
  const needle = String(label || '').trim()
  if (!needle || !(Number(amount) > 0)) return null
  const amt = r2(amount)
  const rows = db.prepare(`
    SELECT id, vendor, total_cad, balance_due_cad, due_date FROM achats_fournisseurs
    WHERE type = 'bill' AND status NOT IN ('Payée', 'Annulée', 'Brouillon')
      AND COALESCE(currency, 'CAD') = ?
      AND (ABS(total_cad - ?) <= MAX(1, ? * 0.01)
           OR ABS(COALESCE(balance_due_cad, total_cad) - ?) <= MAX(1, ? * 0.01))
      AND id NOT IN (SELECT achat_id FROM treasury_payments WHERE achat_id IS NOT NULL AND deleted_at IS NULL)
  `).all(currency, amt, amt, amt, amt)
  const hit = pickAchatForPayment(rows, { label: needle, amount: amt, payment_date })
  return hit ? hit.id : null
}

// Choix de la meilleure candidate parmi les factures au bon montant — pur,
// testé à part. Libellés qui se contiennent (même normalisation que les profils
// fournisseurs), puis montant le plus proche (solde dû ou total), puis échéance
// la plus proche de la date du paiement.
export function pickAchatForPayment(rows, { label, amount, payment_date = null }) {
  const l = vendorKey(label)
  if (!l) return null
  const candidates = (rows || []).filter(a => {
    const v = vendorKey(a.vendor)
    return v && (v.includes(l) || l.includes(v))
  })
  if (candidates.length <= 1) return candidates[0] || null
  const amountGap = a => r2(Math.min(
    Math.abs(Number(a.total_cad) - amount),
    Math.abs(Number(a.balance_due_cad ?? a.total_cad) - amount),
  ))
  const dateGap = a => (payment_date && a.due_date)
    ? Math.abs(new Date(`${dayOnly(a.due_date)}T12:00:00Z`) - new Date(`${dayOnly(payment_date)}T12:00:00Z`))
    : Number.MAX_SAFE_INTEGER
  return [...candidates].sort((a, b) => (amountGap(a) - amountGap(b)) || (dateGap(a) - dateGap(b)))[0]
}

// ── Mémoire par fournisseur : « comment on paie celui-là » ───────────────────
// Le commentaire d'un paiement dit toujours la même chose pour un fournisseur
// donné — « Virement Interac », « Virement entre comptes », « Chèque post-daté ».
// Le retaper à chaque fois est du travail perdu : on le rappelle dès que le nom
// du fournisseur est saisi. La mémoire a deux étages :
//   1. le dernier paiement réellement saisi (fraîcheur, couvre l'historique
//      importé de Pmt_Suivi) ;
//   2. `vendor_profiles.payment_note` (curable à la main dans /fournisseurs),
//      qui prend le relais quand aucun paiement n'existe encore.
// Les deux convergent : une note saisie manuellement est apprise sur le profil.

// Clé de rapprochement des libellés : minuscules, sans accents ni ponctuation
// (même normalisation que les profils fournisseurs).
export const vendorKey = s => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '')

// « De quel compte on paie ce fournisseur » — le profil fournisseur le note en
// texte libre (`payment_method` : « Master », « BNC USD », « Visa USD »,
// « Desjardins »…, hérité du répertoire Fournisseurs_Particularités). C'est la
// seule information qu'on ait pour un fournisseur jamais encore payé depuis
// l'ERP, et elle couvre la grande majorité des profils : on la traduit en nom de
// compte réel pour pré-remplir le formulaire de paiement.
//
// Traduction par recouvrement de mots, pas par table figée : chaque mot de la
// note doit se retrouver dans le nom d'un compte (« master » ⊂ « MasterCard
// BNC »), et le compte qui ajoute le moins de mots gagne (« Desjardins » →
// « Desjardins CAD », pas « VISA Desjardins CAD »). Une note ambiguë (« BNC
// Venn ») ne matche rien — mieux vaut le défaut que le mauvais compte.
const CURRENCY_TOKENS = new Set(['cad', 'usd', 'can', 'dollars', 'dollar'])
const TOKEN_ALIASES = { master: 'mastercard', mc: 'mastercard' }
const noteTokens = s => String(s || '')
  .split(/\s+ou\s+/i)[0]                 // « Visa USD ou Chèque USD » → première option
  .replace(/\([^)]*\)/g, ' ')            // « Master (par tél.) » → « Master »
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  .map(t => TOKEN_ALIASES[t] || t)

export function resolveAccountsFromNote(note, accounts) {
  const tokens = noteTokens(note)
  const wanted = tokens.filter(t => !CURRENCY_TOKENS.has(t))
  if (!wanted.length) return {}
  // Devise nommée dans la note (« BNC USD ») : elle restreint le résultat.
  const namedCurrency = tokens.includes('usd') ? 'USD' : (tokens.includes('cad') ? 'CAD' : null)
  const out = {}
  for (const currency of ['CAD', 'USD']) {
    if (namedCurrency && namedCurrency !== currency) continue
    let best = null
    for (const a of accounts) {
      if ((a.currency || 'CAD') !== currency) continue
      const names = noteTokens(a.name).filter(t => !CURRENCY_TOKENS.has(t))
      if (!wanted.every(w => names.some(n => n.startsWith(w) || w.startsWith(n)))) continue
      const extra = names.length - wanted.length
      if (!best || extra < best.extra) best = { name: a.name, extra }
    }
    if (best) out[currency] = best.name
  }
  return out
}

export function vendorPaymentHints() {
  const byKey = new Map()
  const accounts = db.prepare(
    'SELECT name, currency, kind FROM bank_accounts WHERE deleted_at IS NULL AND active = 1'
  ).all()
  const rows = db.prepare(`
    SELECT label, notes, method, account, counterparty_account, recipient,
           direction, currency, payment_date
    FROM treasury_payments
    WHERE deleted_at IS NULL AND label IS NOT NULL AND TRIM(label) != ''
    ORDER BY payment_date DESC, created_at DESC
    LIMIT 2000
  `).all()
  for (const r of rows) {
    const key = vendorKey(r.label)
    if (!key) continue
    // Première occurrence = la plus récente : elle donne le nom et les défauts.
    let hint = byKey.get(key)
    if (!hint) {
      hint = {
        key,
        name: String(r.label).trim(),
        note: null,
        method: r.method || null,
        account: r.account || null,
        counterparty_account: r.counterparty_account || null,
        recipient: r.recipient || null,
        direction: r.direction || 'out',
        currency: r.currency || 'CAD',
        last_date: dayOnly(r.payment_date),
        source: 'payment',
        particularites: null,
        profile_id: null,
        // Compte noté sur le profil (« Master », « Venn USD »…), traduit en noms
        // de comptes réels par devise — le seul indice pour un fournisseur
        // jamais encore payé depuis l'ERP.
        account_note: null,
        account_by_currency: {},
      }
      byKey.set(key, hint)
    }
    // La note, elle, peut venir d'un paiement plus ancien (le dernier n'en a pas
    // forcément) — on garde la plus récente non vide.
    if (!hint.note && r.notes && String(r.notes).trim()) hint.note = String(r.notes).trim()
  }

  // Profils fournisseurs : la note curée à la main comble les trous et fait
  // exister le fournisseur dans les suggestions avant son premier paiement.
  // Les particularités du profil (« inscrire le n° de document comme réponse »…)
  // remontent aussi : le formulaire de paiement les affiche en avertissement dès
  // que le nom du fournisseur est saisi — c'est au moment de payer qu'on doit y penser.
  const profiles = db.prepare(`
    SELECT id, name, aliases, payment_note, particularites, payment_method
    FROM vendor_profiles WHERE deleted_at IS NULL
  `).all()
  for (const p of profiles) {
    const note = p.payment_note && String(p.payment_note).trim()
    const partic = p.particularites && String(p.particularites).trim()
    // « De quel compte on paie ce fournisseur » : texte libre du profil, traduit
    // en comptes réels par devise (vide si la note ne désigne rien de sûr).
    const accountNote = p.payment_method && String(p.payment_method).trim()
    const accountByCurrency = accountNote ? resolveAccountsFromNote(accountNote, accounts) : {}
    let aliases = []
    try { const a = JSON.parse(p.aliases || '[]'); if (Array.isArray(a)) aliases = a } catch { /* aliases illisibles */ }
    for (const name of [p.name, ...aliases]) {
      const key = vendorKey(name)
      if (!key) continue
      const hint = byKey.get(key)
      if (hint) {
        if (!hint.note && note) { hint.note = note; hint.source = 'profile' }
        if (!hint.particularites && partic) hint.particularites = partic
        if (!hint.profile_id) hint.profile_id = p.id
        if (!hint.account_note && accountNote) {
          hint.account_note = accountNote
          hint.account_by_currency = accountByCurrency
        }
      } else if (note || partic || accountNote) {
        byKey.set(key, {
          key, name: String(p.name).trim(), note: note || null, method: null, account: null,
          counterparty_account: null, recipient: null, direction: 'out',
          currency: 'CAD', last_date: null, source: 'profile',
          particularites: partic || null, profile_id: p.id,
          account_note: accountNote || null, account_by_currency: accountByCurrency,
        })
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'))
}

// ── Factures fournisseurs à payer ────────────────────────────────────────────
// Factures ouvertes (ni payées, ni annulées, ni brouillon) pas encore couvertes
// par un paiement émis : la liste dans laquelle on pioche pour saisir un paiement
// pré-rempli (fournisseur, montant, n° de facture, lien achat_id). Le lien évite
// le double-compte dans la projection : la facture cède sa place au paiement.
// Échues d'abord (échéance croissante, la date d'achat fait foi à défaut).
export function openBills({ limit = 300 } = {}) {
  return db.prepare(`
    SELECT id, vendor, vendor_invoice_number, bill_number, due_date, date_achat,
           total_cad, balance_due_cad, currency, status
    FROM achats_fournisseurs
    WHERE type = 'bill' AND status NOT IN ('Payée', 'Annulée', 'Brouillon')
      AND COALESCE(balance_due_cad, total_cad) > 0
      AND id NOT IN (SELECT achat_id FROM treasury_payments WHERE achat_id IS NOT NULL AND deleted_at IS NULL)
    ORDER BY COALESCE(due_date, date_achat) ASC, vendor COLLATE NOCASE ASC
    LIMIT ?
  `).all(Math.min(1000, Math.max(1, Number(limit) || 300)))
}

// ── Modèles : « refaire le même paiement » ───────────────────────────────────
// Un paiement émis est presque toujours la répétition d'un précédent : même
// bénéficiaire, même moyen, mêmes comptes, même note. Seuls la date, le montant,
// le n° de confirmation de la banque et le n° de facture changent. On expose donc
// les combinaisons déjà utilisées pour les rejouer d'un clic — les retaper à la
// main à chaque paiement récurrent était du travail perdu (et une source d'écarts
// de libellé qui cassait l'appariement au relevé).
//
// Pas de table dédiée : l'historique EST le catalogue de modèles. Rien à
// entretenir, et un modèle disparaît naturellement quand on ne l'utilise plus.
export function paymentTemplates({ limit = 60 } = {}) {
  const rows = db.prepare(`
    SELECT label, notes, method, account, counterparty_account, recipient,
           direction, currency, amount, payment_date
    FROM treasury_payments
    WHERE deleted_at IS NULL AND label IS NOT NULL AND TRIM(label) != ''
    ORDER BY payment_date DESC, created_at DESC
    LIMIT 2000
  `).all()
  const byKey = new Map()
  for (const r of rows) {
    const vkey = vendorKey(r.label)
    if (!vkey) continue
    const key = [vkey, r.method || 'autre', r.account || '', r.counterparty_account || '', r.direction || 'out'].join('|')
    let t = byKey.get(key)
    if (!t) {
      // Première occurrence = la plus récente : elle donne la forme de référence.
      t = {
        key,
        label: String(r.label).trim(),
        method: r.method || 'autre',
        account: r.account || 'BNC CAD',
        counterparty_account: r.counterparty_account || null,
        recipient: r.recipient || null,
        direction: r.direction || 'out',
        currency: r.currency || 'CAD',
        notes: r.notes ? String(r.notes).trim() : null,
        last_amount: r2(r.amount),
        last_date: dayOnly(r.payment_date),
        uses: 0,
      }
      byKey.set(key, t)
    }
    t.uses++
    // Note et bénéficiaire peuvent venir d'un paiement plus ancien : le plus
    // récent ne les porte pas forcément.
    if (!t.notes && r.notes && String(r.notes).trim()) t.notes = String(r.notes).trim()
    if (!t.recipient && r.recipient) t.recipient = r.recipient
  }
  return [...byKey.values()]
    .sort((a, b) => String(b.last_date || '').localeCompare(String(a.last_date || '')) || b.uses - a.uses)
    .slice(0, Math.min(300, Math.max(1, Number(limit) || 60)))
}

// Apprentissage inverse : une note saisie à la main sur un paiement devient la
// note de paiement du profil fournisseur. Ne CRÉE pas de profil (les libellés de
// virement ne sont pas tous des fournisseurs) — met seulement à jour l'existant.
export function learnPaymentNote(label, note) {
  const key = vendorKey(label)
  const text = String(note || '').trim()
  if (!key || !text) return null
  const rows = db.prepare('SELECT id, name, aliases FROM vendor_profiles WHERE deleted_at IS NULL').all()
  const hit = rows.find(r => {
    if (vendorKey(r.name) === key) return true
    try { const a = JSON.parse(r.aliases || '[]'); return Array.isArray(a) && a.some(x => vendorKey(x) === key) }
    catch { return false }
  })
  if (!hit) return null
  db.prepare(`UPDATE vendor_profiles SET payment_note=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
    .run(text, hit.id)
  return hit.id
}

// ── Appariement au relevé bancaire ───────────────────────────────────────────
// Un paiement passé au compte apparaît au relevé : dès que le relevé est importé
// (et demain dès que Plaid pousse la transaction), on coche automatiquement.
// Tolérance : 1 % ou 1 $ sur le montant, ±5 jours sur la date (un Interac émis
// le samedi est débité le lundi). Une transaction ne sert qu'une fois.
const CLEAR_DAY_WINDOW = 5
const amountsMatch = (a, b) => Math.abs(Math.abs(a) - Math.abs(b)) <= Math.max(1, Math.abs(b) * 0.01)

export function autoClearFromBank({ accountName = null } = {}) {
  const pending = db.prepare(`
    SELECT * FROM treasury_payments
    WHERE deleted_at IS NULL AND cleared_at IS NULL
      AND (? IS NULL OR account = ?)
  `).all(accountName, accountName)
  if (!pending.length) return { cleared: 0 }
  let cleared = 0
  const used = new Set(
    db.prepare('SELECT bank_txn_id FROM treasury_payments WHERE bank_txn_id IS NOT NULL AND deleted_at IS NULL')
      .all().map(r => r.bank_txn_id)
  )
  for (const p of pending) {
    const sign = p.direction === 'in' ? 1 : -1
    const rows = db.prepare(`
      SELECT t.id, t.amount, t.txn_date FROM bank_transactions t
      JOIN bank_accounts b ON b.id = t.account_id
      WHERE t.deleted_at IS NULL AND b.deleted_at IS NULL AND b.name = ?
        AND t.txn_date >= date(?, '-${CLEAR_DAY_WINDOW} days') AND t.txn_date <= date(?, '+${CLEAR_DAY_WINDOW} days')
    `).all(p.account || 'BNC CAD', p.payment_date, p.payment_date)
    const hit = rows.find(t => !used.has(t.id)
      && Math.sign(t.amount) === sign && amountsMatch(t.amount, p.amount * sign))
    if (!hit) continue
    used.add(hit.id)
    setCleared(p.id, true, { bankTxnId: hit.id, source: 'bank' })
    cleared++
  }
  return { cleared }
}

// ── Alimentation de la projection ────────────────────────────────────────────

// Paiements non passés à la banque, dans la fenêtre demandée, en événements de
// projection ({date, amount signé, label, kind:'payment', ref}). Seul le compte
// projeté (BNC CAD) et sa devise comptent — un paiement Venn USD ne touche pas
// le solde BNC.
export function paymentEvents({ fromIso, toIso, account = 'BNC CAD', currency = 'CAD' }) {
  const rows = db.prepare(`
    SELECT p.id, p.payment_date, p.direction, p.amount, p.label, p.achat_id, p.reference
    FROM treasury_payments p
    WHERE p.deleted_at IS NULL AND p.cleared_at IS NULL
      AND COALESCE(p.account, 'BNC CAD') = ? AND COALESCE(p.currency, 'CAD') = ?
      AND p.payment_date >= ? AND p.payment_date <= ?
  `).all(account, currency, dayOnly(fromIso), dayOnly(toIso))
  return rows.map(p => ({
    date: dayOnly(p.payment_date),
    amount: p.direction === 'in' ? r2(p.amount) : -r2(p.amount),
    label: p.label || (p.direction === 'in' ? 'Virement entrant' : 'Paiement'),
    kind: 'payment', ref: p.id, achat_id: p.achat_id || null,
  }))
}

// Factures fournisseurs déjà couvertes par un paiement émis : la facture ne doit
// plus être projetée à son échéance, le paiement (avec sa vraie date) la remplace.
export function achatIdsWithPayment() {
  return new Set(db.prepare(
    'SELECT DISTINCT achat_id FROM treasury_payments WHERE achat_id IS NOT NULL AND deleted_at IS NULL'
  ).all().map(r => r.achat_id))
}

// ── Filet anti double-compte : facture ouverte couverte par un paiement ──────
// Même sans lien achat_id (paiement importé avant l'ingestion de la facture) ou
// avec un lien erroné (paiement lié à une vieille facture déjà payée), un
// paiement émis en attente qui porte le même fournisseur, le même montant
// (1 % / 1 $) et une date proche d'une facture ouverte est presque toujours son
// règlement : projeter les deux compte le même dollar deux fois — Dubois
// Agrinovation, 830,77 $ le 9 août 2026, sortait en double.
export const BILL_COVER_DAY_WINDOW = 10

const labelsOverlap = (a, b) => {
  const ka = vendorKey(a), kb = vendorKey(b)
  return !!ka && !!kb && (ka.includes(kb) || kb.includes(ka))
}
const closeAmounts = (a, b) => Math.abs(Number(a) - Number(b)) <= Math.max(1, Math.abs(Number(b)) * 0.01)
const daysApart = (a, b) =>
  Math.abs(Math.round((new Date(`${dayOnly(a)}T12:00:00Z`) - new Date(`${dayOnly(b)}T12:00:00Z`)) / 86400000))

// bills : factures ouvertes projetées (sans lien achat_id — déjà filtrées par
// achatIdsWithPayment). payments : paiements 'out' en attente, hors ceux liés à
// une autre facture ouverte (ils couvrent déjà la leur). Retourne
// Map bill_id → { payment_id, payment_label, payment_date } ; un paiement ne
// couvre qu'UNE facture. Pur — testé dans treasuryPayments.test.js.
export function coveredBillIds(bills, payments, { windowDays = BILL_COVER_DAY_WINDOW } = {}) {
  const used = new Set()
  const covered = new Map()
  for (const b of bills || []) {
    if (!b.due_date) continue
    const hit = (payments || []).find(p => !used.has(p.id)
      && labelsOverlap(p.label, b.vendor)
      && closeAmounts(p.amount, b.balance_due_cad)
      && daysApart(p.payment_date, b.due_date) <= windowDays)
    if (!hit) continue
    used.add(hit.id)
    covered.set(b.id, { payment_id: hit.id, payment_label: hit.label || null, payment_date: dayOnly(hit.payment_date) })
  }
  return covered
}

// Une récurrente peut être la doublure d'un vrai fournisseur (le « Loyer » et
// les factures « Les Jardins d'Inverness »). Quand une facture ou un paiement de
// ce fournisseur tombe près de l'occurrence, c'est lui qui compte.
export const COVERAGE_DAY_WINDOW = 12

export function recurringCoverage(vendorMatch, dateIso, windowDays = COVERAGE_DAY_WINDOW) {
  const needle = `%${String(vendorMatch || '').trim().toLowerCase()}%`
  if (!String(vendorMatch || '').trim()) return null
  const pmt = db.prepare(`
    SELECT id, payment_date AS date, amount, label FROM treasury_payments
    WHERE deleted_at IS NULL AND LOWER(COALESCE(label, '')) LIKE ?
      AND payment_date >= date(?, '-' || ? || ' days') AND payment_date <= date(?, '+' || ? || ' days')
    ORDER BY ABS(julianday(payment_date) - julianday(?)) LIMIT 1
  `).get(needle, dateIso, windowDays, dateIso, windowDays, dateIso)
  if (pmt) return { by: 'payment', ...pmt }
  const bill = db.prepare(`
    SELECT id, COALESCE(due_date, date_achat) AS date, total_cad AS amount, vendor AS label
    FROM achats_fournisseurs
    WHERE type = 'bill' AND status NOT IN ('Annulée', 'Brouillon') AND LOWER(COALESCE(vendor, '')) LIKE ?
      AND COALESCE(due_date, date_achat) >= date(?, '-' || ? || ' days')
      AND COALESCE(due_date, date_achat) <= date(?, '+' || ? || ' days')
    ORDER BY ABS(julianday(COALESCE(due_date, date_achat)) - julianday(?)) LIMIT 1
  `).get(needle, dateIso, windowDays, dateIso, windowDays, dateIso)
  return bill ? { by: 'bill', ...bill } : null
}
