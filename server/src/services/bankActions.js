/**
 * Les deux gestes qui manquaient à une ligne de relevé — ceux que QuickBooks
 * offre sous « Opérations bancaires » et que l'ERP ne savait pas faire :
 *
 *  • AJOUTER  — la ligne n'aura jamais de facture (frais bancaires, achat sans
 *    reçu, prélèvement de service). On crée quand même l'achat qui la
 *    comptabilise, avec le fournisseur, le compte de dépense et le code de taxe
 *    qu'on a l'habitude d'utiliser pour ce libellé — puis on le publie.
 *    L'appariement automatique, lui, ne sait que RELIER un document existant.
 *
 *  • TRANSFERT — la ligne est la moitié d'un mouvement interne. Sa contrepartie
 *    est une ligne d'un AUTRE compte, de signe opposé. Les deux se pointent
 *    l'une l'autre (`transfer_txn_id`) et donnent un `Transfer` QuickBooks.
 *
 * Le fil conducteur des défauts proposés : ne rien inventer. Le profil du
 * fournisseur d'abord (ce que l'utilisateur a déclaré), puis l'HISTORIQUE des
 * achats déjà publiés du même fournisseur (ce qu'on a réellement fait). Quand
 * l'historique se contredit, on le dit au lieu de trancher en silence.
 */
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { findVendorProfile, profileDefaultsForCurrency } from './vendorProfiles.js'
import { resolveVendorFromBankLabel } from './scrapers/vendorFromBankLabel.js'
import { deriveStatus } from './bankReconciliation.js'
import { qbPost } from '../connectors/quickbooks.js'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

// Le sentinel « pas de taxe » des profils fournisseurs : une décision explicite,
// à distinguer d'un profil qui n'a simplement rien appris.
const NO_TAX = '__none__'
const cleanTaxCode = (v) => (!v || v === NO_TAX ? null : v)

export class BankActionError extends Error {
  constructor(message, { status = 400, field = null } = {}) {
    super(message)
    this.status = status
    this.field = field
  }
}

const txnLabel = (t) => (t.details || '').trim() || (t.description || '').trim() || ''

function accountOf(id) {
  return db.prepare('SELECT * FROM bank_accounts WHERE id=? AND deleted_at IS NULL').get(id)
}

// Premier segment de `qb_account_id` : un compte ERP peut couvrir plusieurs
// comptes QB (compte scindé côté QuickBooks), le premier est le principal.
// Même convention que prepaid.js et bankQbLink.js.
const mainQbAccount = (account) =>
  account?.qb_account_id ? String(account.qb_account_id).split(',')[0].trim() : null

// ── Ajouter : ce qu'on propose ───────────────────────────────────────────────

// Comment on a comptabilisé ce fournisseur jusqu'ici. On ne regarde QUE les
// achats réellement publiés dans QuickBooks : un brouillon n'est pas une
// habitude. Renvoie les valeurs par fréquence décroissante, et dit si l'usage
// est constant — c'est cette contradiction que l'utilisateur doit trancher.
export function vendorHistory(vendorName, { limit = 24 } = {}) {
  const name = String(vendorName || '').trim()
  if (!name) return null
  const rows = db.prepare(`
    SELECT expense_account_id, tax_code_id, qb_memo, description, payment_method, lines, date_achat
    FROM achats_fournisseurs
    WHERE LOWER(TRIM(vendor)) = LOWER(TRIM(?)) AND quickbooks_id IS NOT NULL
    ORDER BY date_achat DESC, created_at DESC
    LIMIT ?
  `).all(name, limit)
  if (!rows.length) return null

  // Un achat ancien porte son compte de dépense dans `lines[0].account_id`
  // plutôt que dans la colonne — même repli que prepaid.js.
  const accountOfRow = (r) => {
    if (r.expense_account_id) return r.expense_account_id
    try {
      const first = JSON.parse(r.lines || '[]')[0]
      return first?.account_id || null
    } catch { return null }
  }

  const tally = (values) => {
    const counts = new Map()
    for (const v of values) {
      if (v == null || v === '') continue
      counts.set(v, (counts.get(v) || 0) + 1)
    }
    return [...counts.entries()]
      .map(([value, n]) => ({ value, n }))
      .sort((a, b) => b.n - a.n)
  }

  const expenseAccounts = tally(rows.map(accountOfRow))
  const taxCodes = tally(rows.map((r) => r.tax_code_id || NO_TAX))
  // Un mémo n'est une HABITUDE que s'il s'est répété. Les libellés uniques
  // (titre de produit Amazon, numéro de facture) n'en sont pas : les proposer
  // remplirait le champ d'un texte sans rapport avec la nouvelle dépense.
  const memos = tally(rows.map((r) => (r.qb_memo || r.description || '').trim()))
    .filter((m) => m.n >= 2 && m.value.length <= 80)
  const paymentMethods = tally(rows.map((r) => r.payment_method))

  return {
    count: rows.length,
    last_date: rows[0].date_achat,
    expense_accounts: expenseAccounts,
    tax_codes: taxCodes,
    memos: memos.slice(0, 3),
    payment_methods: paymentMethods,
    // « Constant » = un seul compte de dépense ET un seul code de taxe sur tout
    // l'historique retenu. Sinon l'UI affiche le partage des voix.
    consistent: expenseAccounts.length <= 1 && taxCodes.length <= 1,
  }
}

// Repli quand aucun profil ne reconnaît le libellé : chercher un fournisseur
// déjà utilisé dont le nom apparaît tel quel dans le libellé du relevé.
function vendorFromPastPurchases(label) {
  const l = String(label || '').toLowerCase()
  if (l.length < 3) return null
  const rows = db.prepare(`
    SELECT DISTINCT vendor FROM achats_fournisseurs
    WHERE vendor IS NOT NULL AND TRIM(vendor) <> '' AND quickbooks_id IS NOT NULL
      AND date_achat >= date('now', '-18 months')
  `).all()
  let best = null
  for (const { vendor } of rows) {
    const v = String(vendor).toLowerCase().trim()
    if (v.length < 4) continue
    if (l.includes(v) && (!best || v.length > best.length)) best = String(vendor).trim()
  }
  return best
}

/**
 * Ce que l'ERP propose de mettre dans l'écriture, et pourquoi.
 * Ne touche à rien : c'est le pré-remplissage du formulaire « Ajouter ».
 */
export function suggestAddDefaults(txn, account) {
  const label = txnLabel(txn)
  const currency = account?.currency || 'CAD'
  const hit = resolveVendorFromBankLabel(label)
  let vendor = hit?.profile?.name || null
  let source = hit ? `profil (${hit.via})` : null

  if (!vendor) {
    vendor = vendorFromPastPurchases(label)
    if (vendor) source = 'achat passé du même fournisseur'
  }

  const profile = vendor ? findVendorProfile(vendor) : null
  const defaults = profileDefaultsForCurrency(profile, currency) || {}
  const history = vendor ? vendorHistory(vendor) : null

  // Profil d'abord (déclaré), historique ensuite (constaté).
  const expenseAccountId = defaults.expense_account_id || history?.expense_accounts?.[0]?.value || null
  const taxFromProfile = defaults.tax_code_id || null
  const taxFromHistory = history?.tax_codes?.[0]?.value || null
  const taxCodeId = taxFromProfile || taxFromHistory || null

  return {
    vendor,
    vendor_profile_id: profile?.id || null,
    source,
    label,
    amount: round2(Math.abs(txn.amount)),
    currency,
    expense_account_id: expenseAccountId,
    // `__none__` remonte tel quel : « pas de taxe » est une décision, pas un vide.
    tax_code_id: taxCodeId,
    payment_account_id: defaults.payment_account_id || mainQbAccount(account),
    payment_method: account?.kind === 'card' ? 'Carte de crédit' : 'Comptant',
    memo: history?.memos?.[0]?.value || null,
    history,
  }
}

// ── Ajouter : l'écriture ─────────────────────────────────────────────────────

/**
 * Crée l'achat qui comptabilise la ligne et l'y attache. Ne publie PAS à
 * QuickBooks : la route le fait ensuite, pour qu'un échec côté Intuit laisse
 * quand même l'achat et le lien en place (réessayable depuis /achats).
 *
 * @returns {{ achatId: string }}
 */
export function addExpenseFromTxn(txn, account, body = {}, userId = null) {
  if (txn.status === 'ignore') throw new BankActionError('Cette ligne est exclue du rapprochement')
  if (txn.matched_id) throw new BankActionError('Cette ligne est déjà liée à un document', { status: 409 })
  if (txn.transfer_txn_id) throw new BankActionError('Cette ligne est déjà liée à un virement', { status: 409 })
  if (txn.pending) throw new BankActionError('Transaction encore en attente à la banque — son montant peut changer')
  if (!(txn.amount < 0)) throw new BankActionError('« Ajouter » ne comptabilise qu\'une sortie d\'argent')

  const vendor = String(body.vendor || '').trim()
  if (!vendor) throw new BankActionError('Fournisseur requis', { field: 'vendor' })
  const expenseAccountId = String(body.expense_account_id || '').trim()
  if (!expenseAccountId) throw new BankActionError('Compte de dépense requis', { field: 'expense_account_id' })

  const total = round2(Math.abs(txn.amount))
  const taxCodeId = cleanTaxCode(body.tax_code_id)
  // Le relevé donne le montant TTC : la taxe vient du formulaire (calculée au
  // taux du code côté client) ; sans elle, l'écriture est simplement sans taxe.
  const taxCad = taxCodeId ? round2(body.tax_cad) : 0
  if (taxCad < 0 || taxCad >= total) throw new BankActionError('Montant de taxe incohérent avec le montant du relevé', { field: 'tax_cad' })
  const amountCad = round2(total - taxCad)

  const memo = String(body.memo || '').trim() || txnLabel(txn) || vendor
  const achatId = newRecordId()

  const run = db.transaction(() => {
    db.prepare(`
      INSERT INTO achats_fournisseurs
        (id, type, date_achat, vendor, description, qb_memo, reference, payment_method,
         amount_cad, tax_cad, total_cad, currency, status,
         expense_account_id, payment_account_id, tax_code_id, created_by)
      VALUES (?, 'purchase', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Approuvé', ?, ?, ?, ?)
    `).run(
      achatId, txn.txn_date, vendor, memo, memo, txn.reference || null,
      account.kind === 'card' ? 'Carte de crédit' : 'Comptant',
      amountCad, taxCad, total, account.currency || 'CAD',
      expenseAccountId,
      String(body.payment_account_id || '').trim() || mainQbAccount(account),
      taxCodeId, userId,
    )

    // La garde `matched_id IS NULL` rejoue la validation au moment de l'écriture :
    // deux clics simultanés ne créent pas deux achats liés à la même ligne.
    const linked = db.prepare(`
      UPDATE bank_transactions
      SET matched_type='achat', matched_id=?, match_method='manuel', match_confidence=1,
          status='facture_recue', updated_at=${NOW}
      WHERE id=? AND matched_id IS NULL AND deleted_at IS NULL
    `).run(achatId, txn.id).changes
    if (linked !== 1) throw new BankActionError('Cette ligne vient d\'être liée ailleurs', { status: 409 })
  })
  run()

  return { achatId }
}

// ── Transfert : trouver la contrepartie ──────────────────────────────────────

// Une conversion de devise ne produit pas deux montants égaux. Bornes reprises
// de bankQbSearch.js : au-delà, ce n'est plus un taux USD/CAD plausible.
const FX_MIN = 1.15
const FX_MAX = 1.65
const DAYS = 5

const dayDiff = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000)

/**
 * Lignes d'AUTRES comptes qui pourraient être l'autre moitié du mouvement.
 * Trié par ressemblance : même montant et même jour d'abord.
 */
export function findTransferCandidates(txn, { days = DAYS } = {}) {
  const amount = Number(txn.amount)
  if (!amount) return []
  const account = accountOf(txn.account_id)
  const from = new Date(new Date(txn.txn_date).getTime() - days * 86400000).toISOString().slice(0, 10)
  const to = new Date(new Date(txn.txn_date).getTime() + days * 86400000).toISOString().slice(0, 10)

  const rows = db.prepare(`
    SELECT t.id, t.account_id, t.txn_date, t.amount, t.status, t.qb_txn_id,
           COALESCE(NULLIF(t.details, ''), t.description) AS label,
           a.name AS account_name, a.currency, a.qb_account_id
    FROM bank_transactions t
    JOIN bank_accounts a ON a.id = t.account_id
    WHERE t.deleted_at IS NULL AND a.deleted_at IS NULL
      AND t.account_id <> ? AND t.id <> ?
      AND t.transfer_txn_id IS NULL AND t.matched_id IS NULL
      AND t.status <> 'ignore'
      AND t.txn_date BETWEEN ? AND ?
      AND ((? < 0 AND t.amount > 0) OR (? > 0 AND t.amount < 0))
  `).all(txn.account_id, txn.id, from, to, amount, amount)

  const sameCurrency = (r) => String(r.currency || 'CAD') === String(account?.currency || 'CAD')
  const out = []
  for (const r of rows) {
    const mine = Math.abs(amount)
    const theirs = Math.abs(r.amount)
    const gap = dayDiff(r.txn_date, txn.txn_date)
    if (sameCurrency(r)) {
      if (Math.abs(mine - theirs) >= 0.011) continue
      out.push({ ...r, fx: false, confidence: round2(1 - gap * 0.05) })
    } else {
      const ratio = mine > theirs ? mine / theirs : theirs / mine
      if (!(ratio >= FX_MIN && ratio <= FX_MAX)) continue
      out.push({ ...r, fx: true, rate: round2(ratio * 100) / 100, confidence: round2(0.7 - gap * 0.05) })
    }
  }
  out.sort((a, b) => b.confidence - a.confidence || dayDiff(a.txn_date, txn.txn_date) - dayDiff(b.txn_date, txn.txn_date))
  return out.slice(0, 20)
}

// ── Transfert : lier ─────────────────────────────────────────────────────────

function statusAfter(row, patch) {
  const acc = accountOf(row.account_id)
  return deriveStatus({ ...row, ...patch }, { isPlaidAccount: !!acc?.plaid_account_id })
}

/**
 * Marque les deux lignes comme les deux moitiés d'un même virement.
 * N'écrit rien dans QuickBooks — voir pushTransferToQB.
 */
export function linkTransfer(txn, other, { amount = null } = {}) {
  if (!other) throw new BankActionError('Contrepartie introuvable', { status: 404 })
  if (other.account_id === txn.account_id) throw new BankActionError('Un virement relie deux comptes différents')
  if (Math.sign(other.amount) === Math.sign(txn.amount)) throw new BankActionError('Les deux lignes doivent être de sens opposé')
  if (txn.transfer_txn_id || other.transfer_txn_id) throw new BankActionError('Une des deux lignes est déjà liée à un virement', { status: 409 })
  if (txn.matched_id || other.matched_id) throw new BankActionError('Une des deux lignes est déjà liée à un document', { status: 409 })
  if (dayDiff(txn.txn_date, other.txn_date) > DAYS) throw new BankActionError(`Les deux lignes sont à plus de ${DAYS} jours d'écart`)

  const a = accountOf(txn.account_id)
  const b = accountOf(other.account_id)
  const sameCurrency = String(a?.currency || 'CAD') === String(b?.currency || 'CAD')
  const mine = Math.abs(txn.amount)
  const theirs = Math.abs(other.amount)

  let declared = null
  if (sameCurrency) {
    if (Math.abs(mine - theirs) >= 0.011) throw new BankActionError('Les deux montants diffèrent — ce n\'est pas le même mouvement')
  } else {
    // Multidevise : les deux montants diffèrent légitimement. On exige alors que
    // l'utilisateur déclare le montant transféré plutôt que d'en deviner un.
    declared = round2(amount)
    if (!(declared > 0)) throw new BankActionError('Montant du virement requis (comptes de devises différentes)', { field: 'amount' })
    const ratio = mine > theirs ? mine / theirs : theirs / mine
    if (!(ratio >= FX_MIN && ratio <= FX_MAX)) throw new BankActionError('Écart de change implausible entre les deux lignes')
  }

  const set = db.prepare(`
    UPDATE bank_transactions
    SET transfer_txn_id=?, transfer_amount=?, match_method='manuel', status=?, updated_at=${NOW}
    WHERE id=? AND transfer_txn_id IS NULL AND matched_id IS NULL AND deleted_at IS NULL
  `)
  const run = db.transaction(() => {
    const c1 = set.run(other.id, declared, statusAfter(txn, { transfer_txn_id: other.id }), txn.id).changes
    const c2 = set.run(txn.id, declared, statusAfter(other, { transfer_txn_id: txn.id }), other.id).changes
    if (c1 !== 1 || c2 !== 1) throw new BankActionError('Une des deux lignes vient d\'être liée ailleurs', { status: 409 })
  })
  run()
  return { linked: true, amount: declared }
}

/** Défait le lien des deux côtés. L'écriture QuickBooks, elle, reste. */
export function unlinkTransfer(txn) {
  if (!txn.transfer_txn_id) throw new BankActionError('Cette ligne n\'est pas liée à un virement')
  const other = db.prepare('SELECT * FROM bank_transactions WHERE id=?').get(txn.transfer_txn_id)
  const clear = db.prepare(`
    UPDATE bank_transactions
    SET transfer_txn_id=NULL, transfer_amount=NULL, match_method=NULL, status=?, updated_at=${NOW}
    WHERE id=?
  `)
  const run = db.transaction(() => {
    clear.run(statusAfter(txn, { transfer_txn_id: null, match_method: null }), txn.id)
    if (other) clear.run(statusAfter(other, { transfer_txn_id: null, match_method: null }), other.id)
  })
  run()
  return { unlinked: true, qb_txn_id: txn.qb_txn_id || null }
}

// ── Transfert : l'écriture QuickBooks ────────────────────────────────────────

/**
 * Crée le `Transfer` QuickBooks correspondant au virement.
 * `post` est injectable pour les tests (par défaut : qbPost).
 *
 * Ne crée rien et le dit (`skipped`) quand un des deux comptes n'est pas mappé
 * à QuickBooks, ou quand une écriture a déjà été retrouvée pour l'une des deux
 * lignes — le grand livre a déjà le mouvement, en ajouter un le doublerait.
 */
export async function pushTransferToQB(txn, other, { post = null } = {}) {
  const fromRow = txn.amount < 0 ? txn : other
  const toRow = txn.amount < 0 ? other : txn
  const fromAcct = accountOf(fromRow.account_id)
  const toAcct = accountOf(toRow.account_id)
  const fromQb = mainQbAccount(fromAcct)
  const toQb = mainQbAccount(toAcct)

  if (!fromQb || !toQb) return { skipped: 'un des deux comptes n\'est pas mappé à QuickBooks' }
  if (txn.qb_txn_id || other.qb_txn_id) return { skipped: 'écriture QuickBooks déjà retrouvée pour ce mouvement' }

  const fromCcy = String(fromAcct?.currency || 'CAD')
  const toCcy = String(toAcct?.currency || 'CAD')
  const amount = round2(Math.abs(fromRow.amount))

  const payload = {
    Amount: amount,
    FromAccountRef: { value: fromQb },
    ToAccountRef: { value: toQb },
    TxnDate: fromRow.txn_date,
    PrivateNote: `Virement ${fromAcct?.name || ''} → ${toAcct?.name || ''}`.trim().slice(0, 4000),
  }
  // Devise du compte source ≠ dollar canadien : QuickBooks veut la devise de la
  // transaction et le taux. Le taux est celui que la banque a réellement
  // appliqué (les deux montants du relevé), pas un taux de référence.
  let fxNote = null
  if (fromCcy !== 'CAD') {
    payload.CurrencyRef = { value: fromCcy }
    payload.ExchangeRate = round2((Math.abs(toRow.amount) / amount) * 10000) / 10000
  } else if (toCcy !== 'CAD') {
    // Source en CAD, destination en devise : QuickBooks applique SON taux du
    // jour au compte destinataire, qu'on ne contrôle pas depuis ce payload.
    fxNote = 'Compte destinataire en devise : vérifier le taux appliqué dans QuickBooks.'
  }

  const send = post || qbPost
  const result = await send('/transfer', payload)
  const qbId = result?.Transfer?.Id
  if (!qbId) return { skipped: 'QuickBooks n\'a pas renvoyé d\'identifiant' }

  // `qb_txn_type` est stocké en minuscules : c'est l'entité d'URL que
  // storedQbUrl() rend en lien cliquable (voir bankQbLink.js).
  db.prepare(`
    UPDATE bank_transactions
    SET qb_txn_type='transfer', qb_txn_id=?, qb_match_method='manuel', qb_match_delta=NULL,
        status='comptabilise', updated_at=${NOW}
    WHERE id IN (?, ?)
  `).run(String(qbId), txn.id, other.id)

  return { quickbooks_id: String(qbId), fx_note: fxNote }
}
