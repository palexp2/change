// Payer une facture dans Boréal la marque payée dans QuickBooks.
//
// Jusqu'ici le sens était unique : l'ERP publiait la facture (Bill), puis
// QuickBooks seul décidait qu'elle était payée — quelqu'un y saisissait le
// paiement à la main, et l'import relisait `Balance` pour repasser la facture à
// « Payée ». Régler une facture depuis /paiements-emis ne fermait donc rien :
// la facture restait ouverte dans les livres, et la double saisie était le prix
// à payer.
//
// Ici on écrit l'écriture de paiement (BillPayment) au moment où le paiement est
// émis : même fournisseur, même facture, la date d'émission, le compte bancaire
// réellement débité, le montant réellement sorti. La facture se ferme dans
// QuickBooks, et on relit la facture juste après pour que l'ERP l'affiche
// « Payée » sans attendre la sync horaire.
//
// Deux prudences, dans cet ordre :
//   - on ne pousse JAMAIS ce qui n'est pas parfaitement identifié (facture non
//     publiée, devise différente, montant supérieur au solde dû, compte sans
//     correspondance QuickBooks) — le paiement ERP est créé quand même, avec la
//     raison du refus écrite sur la ligne ;
//   - un échec d'envoi ne fait jamais échouer la création du paiement.
import db from '../db/database.js'
import { qbGet, qbPost, qbEntityUrl } from '../connectors/quickbooks.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'

export const BILL_PAYMENT_AUTOMATION_ID = 'sys_bill_payment_qb'

export const BILL_PAYMENT_DEFAULT_CONFIG = {
  // Origines de paiement qui déclenchent l'envoi. `qb` et `import` sont exclus
  // par construction : ces paiements-là existent DÉJÀ dans QuickBooks (ils en
  // viennent), les repousser créerait un doublon.
  enabled_sources: 'manual,schedule,achat,card',
  // 0 = ne rien envoyer quand la facture est réglée par carte de crédit.
  allow_card_accounts: '1',
  // Mise en service. Les paiements émis AVANT cette date ne sont jamais
  // envoyés : leurs factures ont déjà été réglées à la main dans QuickBooks,
  // les repousser créerait des paiements en double. Décision de Charles
  // (2026-09-16) : on ne rattrape pas l'historique, on part de maintenant.
  since_date: '2026-09-16',
}

const r2 = n => Math.round(Number(n) * 100) / 100
const dayOnly = v => String(v || '').slice(0, 10)

export function getBillPaymentConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(BILL_PAYMENT_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch { /* config illisible : défauts */ }
  const merged = { ...BILL_PAYMENT_DEFAULT_CONFIG }
  for (const k of Object.keys(BILL_PAYMENT_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

// Premier segment de `qb_account_id` : un compte ERP peut couvrir plusieurs
// comptes QB (BNC USD porte « 234,168 »), le premier est le principal. Même
// convention que bankActions.js, bankEntryDraft.js et prepaid.js.
export const mainQbAccount = (account) =>
  account?.qb_account_id ? String(account.qb_account_id).split(',')[0].trim() : null

// ── Éligibilité (pure, testée) ───────────────────────────────────────────────
//
// Retourne { ok:true } ou { ok:false, reason } — `reason` est la phrase montrée
// sur la ligne du paiement, elle s'adresse à un humain qui va devoir décider.
export function eligibility(payment, bill, account, { qbBalance = null, config = BILL_PAYMENT_DEFAULT_CONFIG } = {}) {
  if (!payment) return { ok: false, reason: 'Paiement introuvable' }
  if (payment.deleted_at) return { ok: false, reason: 'Paiement supprimé' }
  if (payment.direction !== 'out') return { ok: false, reason: 'Encaissement — rien à régler' }
  if (payment.qb_billpayment_id) return { ok: false, reason: 'Déjà envoyé à QuickBooks' }

  const sources = String(config.enabled_sources || '').split(',').map(s => s.trim()).filter(Boolean)
  const source = payment.source || 'manual'
  if (source === 'qb' || source === 'import') {
    return { ok: false, reason: 'Paiement venu de QuickBooks — déjà dans les livres' }
  }
  if (sources.length && !sources.includes(source)) {
    return { ok: false, reason: `Origine « ${source} » désactivée dans les automatisations` }
  }

  const floor = String(config.since_date || '').trim()
  if (floor && dayOnly(payment.payment_date) < floor) {
    return { ok: false, reason: `Paiement antérieur au ${floor} — réglé à la main dans QuickBooks` }
  }

  if (!payment.achat_id) return { ok: false, reason: 'Aucune facture liée' }
  if (!bill) return { ok: false, reason: 'Facture liée introuvable' }
  if (bill.type !== 'bill') return { ok: false, reason: 'Dépense QuickBooks — déjà payée par construction' }
  if (!bill.quickbooks_id) return { ok: false, reason: 'Facture pas encore publiée dans QuickBooks' }

  const amount = r2(payment.amount)
  if (!(amount > 0)) return { ok: false, reason: 'Montant nul' }

  const payCur = String(payment.currency || 'CAD').toUpperCase()
  const billCur = String(bill.currency || 'CAD').toUpperCase()
  if (payCur !== billCur) {
    return { ok: false, reason: `Facture en ${billCur}, paiement en ${payCur} — aucune conversion automatique` }
  }

  if (!account) return { ok: false, reason: `Compte « ${payment.account || '—'} » inconnu` }
  if (!mainQbAccount(account)) {
    return { ok: false, reason: `Compte « ${account.name} » sans correspondance QuickBooks` }
  }
  if (account.kind === 'card' && String(config.allow_card_accounts) !== '1') {
    return { ok: false, reason: 'Règlement par carte — envoi désactivé' }
  }

  // Solde dû chez QuickBooks : c'est lui qui fait foi, pas la copie ERP.
  if (qbBalance != null) {
    const balance = r2(qbBalance)
    if (!(balance > 0)) return { ok: false, reason: 'Facture déjà soldée dans QuickBooks' }
    if (amount > balance + 0.01) {
      return { ok: false, reason: `Montant (${amount.toFixed(2)}) supérieur au solde dû dans QuickBooks (${balance.toFixed(2)})` }
    }
  }

  return { ok: true, reason: null }
}

// La ligne du paiement doit-elle parler de QuickBooks ? Non pour un virement
// interne, non pour l'historique d'avant la mise en service — sinon la page se
// couvrirait de puces ambre pour des factures déjà réglées à la main.
export function billPaymentApplies(payment, { config = null } = {}) {
  const cfg = config || getBillPaymentConfig()
  if (!payment?.achat_id || payment.direction !== 'out') return false
  if (payment.source === 'qb' || payment.source === 'import') return false
  const floor = String(cfg.since_date || '').trim()
  return !floor || dayOnly(payment.payment_date) >= floor
}

// Mémo lisible dans les livres : nature seulement, court.
export function billPaymentMemo(payment, bill) {
  const parts = []
  const invoice = payment.invoice_number || bill?.vendor_invoice_number || bill?.bill_number
  if (invoice) parts.push(`Facture ${invoice}`)
  if (payment.method) parts.push(String(payment.method).replace(/_/g, ' '))
  if (payment.reference) parts.push(`réf. ${payment.reference}`)
  return parts.join(' · ').slice(0, 1000) || null
}

// ── Charge utile (pure, testée) ──────────────────────────────────────────────
//
// QuickBooks n'a que deux types de paiement de facture : Check et CreditCard.
// C'est le GENRE du compte débité qui tranche — « interac », « transfert » et
// « code de paiement » n'existent pas là-bas, ils restent lisibles dans le mémo.
export function buildBillPaymentPayload({ bill, qbBill, payment, account }) {
  const qbAccountId = mainQbAccount(account)
  const amount = r2(payment.amount)
  const isCard = account?.kind === 'card'
  const payload = {
    VendorRef: { value: String(qbBill.VendorRef?.value) },
    TxnDate: dayOnly(payment.payment_date),
    TotalAmt: amount,
    PayType: isCard ? 'CreditCard' : 'Check',
    Line: [{
      Amount: amount,
      LinkedTxn: [{ TxnId: String(bill.quickbooks_id), TxnType: 'Bill' }],
    }],
  }
  if (isCard) {
    payload.CreditCardPayment = { CCAccountRef: { value: qbAccountId } }
  } else {
    // NotSet : l'ERP ne fabrique pas de chèque à imprimer, il enregistre une
    // sortie déjà émise. « NeedToPrint » remplirait la file d'impression de QB.
    payload.CheckPayment = { BankAccountRef: { value: qbAccountId }, PrintStatus: 'NotSet' }
  }
  if (qbBill.CurrencyRef?.value) payload.CurrencyRef = { value: qbBill.CurrencyRef.value }
  if (Number(qbBill.ExchangeRate) > 0 && Number(qbBill.ExchangeRate) !== 1) {
    payload.ExchangeRate = Number(qbBill.ExchangeRate)
  }
  const memo = billPaymentMemo(payment, bill)
  if (memo) payload.PrivateNote = memo
  return payload
}

// ── Lecture ──────────────────────────────────────────────────────────────────

const paymentRow = id => db.prepare('SELECT * FROM treasury_payments WHERE id = ?').get(id) || null
const billRow = id => (id ? db.prepare('SELECT * FROM achats_fournisseurs WHERE id = ?').get(id) || null : null)
const accountRow = name => (name
  ? db.prepare('SELECT * FROM bank_accounts WHERE name = ? AND deleted_at IS NULL').get(name) || null
  : null)

function noteSkip(paymentId, reason) {
  db.prepare('UPDATE treasury_payments SET qb_billpayment_error = ? WHERE id = ?').run(reason, paymentId)
  return { pushed: false, skipped: true, reason }
}

// Statut ERP d'une facture, tel que l'import QuickBooks le calcule. Recopié ici
// volontairement : quickbooks.js importe la moitié du serveur, et ce service
// doit rester appelable depuis la création d'un paiement.
export function billStatusFromQb(qbBill) {
  const total = qbBill.TotalAmt ?? 0
  const balance = qbBill.Balance ?? total
  if (balance === 0) return 'Payée'
  if (balance < total) return 'Payée partiellement'
  if (qbBill.DueDate && new Date(qbBill.DueDate) < new Date()) return 'En retard'
  return 'Reçue'
}

// Relit la facture chez QuickBooks et réaligne la copie ERP : sans ça la
// facture resterait « à payer » dans l'ERP jusqu'à la prochaine sync.
export async function refreshBillFromQb(achatId) {
  const bill = billRow(achatId)
  if (!bill?.quickbooks_id) return null
  const qbBill = (await qbGet(`/bill/${bill.quickbooks_id}`)).Bill
  if (!qbBill) return null
  const total = qbBill.TotalAmt ?? 0
  const paid = Math.max(0, total - (qbBill.Balance ?? total))
  db.prepare(`
    UPDATE achats_fournisseurs
    SET amount_paid_cad = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(paid, billStatusFromQb(qbBill), achatId)
  return { amount_paid_cad: paid, status: billStatusFromQb(qbBill) }
}

// ── Envoi ────────────────────────────────────────────────────────────────────

export async function pushBillPayment(paymentId, { userId = null, trigger = 'auto' } = {}) {
  const started = Date.now()
  const payment = paymentRow(paymentId)
  const bill = billRow(payment?.achat_id)
  const account = accountRow(payment?.account)
  const config = getBillPaymentConfig()

  const pre = eligibility(payment, bill, account, { config })
  if (!pre.ok) return noteSkip(paymentId, pre.reason)

  // Jeton posé AVANT l'appel : deux chemins simultanés (création + rejeu
  // manuel) ne peuvent pas produire deux écritures pour le même paiement.
  const claimed = db.prepare(`
    UPDATE treasury_payments SET qb_billpayment_pushed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND qb_billpayment_id IS NULL AND qb_billpayment_pushed_at IS NULL
  `).run(paymentId)
  if (claimed.changes === 0) {
    return { pushed: false, skipped: true, reason: 'Envoi déjà en cours' }
  }

  const release = (reason) => {
    db.prepare(`
      UPDATE treasury_payments SET qb_billpayment_pushed_at = NULL, qb_billpayment_error = ?
      WHERE id = ? AND qb_billpayment_id IS NULL
    `).run(reason, paymentId)
  }

  try {
    const qbBill = (await qbGet(`/bill/${bill.quickbooks_id}`)).Bill
    if (!qbBill) throw new Error(`Facture ${bill.quickbooks_id} introuvable dans QuickBooks`)

    // Deuxième passage d'éligibilité, sur le solde RÉEL : la facture a pu être
    // réglée entre-temps dans QuickBooks.
    const post = eligibility(payment, bill, account, { qbBalance: qbBill.Balance ?? qbBill.TotalAmt, config })
    if (!post.ok) { release(post.reason); return { pushed: false, skipped: true, reason: post.reason } }

    const payload = buildBillPaymentPayload({ bill, qbBill, payment, account })
    const result = await qbPost('/billpayment', payload)
    const qbId = result?.BillPayment?.Id
    if (!qbId) throw new Error("QuickBooks n'a pas retourné d'identifiant pour le paiement")

    db.prepare(`
      UPDATE treasury_payments SET qb_billpayment_id = ?, qb_billpayment_error = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(String(qbId), paymentId)

    // Best effort : l'écriture est passée, le rafraîchissement n'est qu'un
    // confort d'affichage.
    await refreshBillFromQb(bill.id).catch(e => console.warn(`refreshBillFromQb ${bill.id}: ${e.message}`))

    logSystemRun(BILL_PAYMENT_AUTOMATION_ID, {
      status: 'success',
      duration_ms: Date.now() - started,
      triggerData: { payment_id: paymentId, achat_id: bill.id, trigger, user_id: userId },
      result: `Facture ${bill.vendor_invoice_number || bill.bill_number || bill.quickbooks_id} `
        + `(${bill.vendor || 'sans fournisseur'}) marquée payée dans QuickBooks : `
        + `${r2(payment.amount).toFixed(2)} ${payment.currency || 'CAD'} depuis ${account.name} `
        + `le ${dayOnly(payment.payment_date)} — écriture ${qbId}.`,
    })

    return { pushed: true, qb_id: String(qbId), qb_url: qbEntityUrl('billpayment', String(qbId)) }
  } catch (e) {
    release(e.message)
    logSystemRun(BILL_PAYMENT_AUTOMATION_ID, {
      status: 'error',
      duration_ms: Date.now() - started,
      triggerData: { payment_id: paymentId, achat_id: bill?.id, trigger, user_id: userId },
      error: e,
    })
    return { pushed: false, error: e.message }
  }
}

// Lancement non bloquant depuis la création d'un paiement : l'utilisateur ne
// doit jamais attendre QuickBooks pour voir sa ligne apparaître, et une panne
// de QuickBooks ne doit jamais empêcher d'enregistrer un paiement.
export function queueBillPaymentPush(paymentId, { userId = null } = {}) {
  if (!paymentId) return
  // Un virement interne, un paiement de carte ou une sortie récurrente ne
  // règlent aucune facture : on ne les regarde même pas, sinon chacun
  // repartirait avec une « raison » inscrite sur sa ligne pour rien.
  const row = db.prepare('SELECT achat_id, direction FROM treasury_payments WHERE id = ?').get(paymentId)
  if (!row?.achat_id || row.direction !== 'out') return
  if (!isSystemAutomationActive(BILL_PAYMENT_AUTOMATION_ID)) return
  setImmediate(() => {
    pushBillPayment(paymentId, { userId, trigger: 'création du paiement' })
      .catch(e => console.warn(`pushBillPayment ${paymentId}: ${e.message}`))
  })
}

// ── Retrait ──────────────────────────────────────────────────────────────────
//
// Supprimer le paiement dans l'ERP doit rouvrir la facture dans QuickBooks,
// sinon elle resterait soldée pour un paiement qui n'existe plus. QuickBooks
// refuse (code 6480) de supprimer une écriture déjà appariée à une ligne
// bancaire téléchargée : on le dit, on ne le force pas.
export async function deleteBillPayment(paymentId) {
  const payment = paymentRow(paymentId)
  if (!payment?.qb_billpayment_id) return { deleted: false }
  const qbId = String(payment.qb_billpayment_id)
  try {
    const existing = (await qbGet(`/billpayment/${qbId}`)).BillPayment
    if (!existing) throw new Error('Écriture introuvable')
    await qbPost('/billpayment?operation=delete', { Id: qbId, SyncToken: existing.SyncToken })
    db.prepare(`
      UPDATE treasury_payments SET qb_billpayment_id = NULL, qb_billpayment_pushed_at = NULL,
             qb_billpayment_error = NULL WHERE id = ?
    `).run(paymentId)
    await refreshBillFromQb(payment.achat_id).catch(() => {})
    return { deleted: true }
  } catch (e) {
    const warning = e.qbCode === '6480' || /6480/.test(String(e.message))
      ? 'QuickBooks refuse de retirer le paiement : il est déjà apparié à une opération bancaire — défaites l’appariement dans QuickBooks.'
      : `Le paiement n’a pas pu être retiré de QuickBooks : ${e.message}`
    db.prepare('UPDATE treasury_payments SET qb_billpayment_error = ? WHERE id = ?').run(warning, paymentId)
    return { deleted: false, refused: true, warning }
  }
}

// ── Rattrapage ───────────────────────────────────────────────────────────────
//
// Les paiements liés à une facture qui n'ont pas d'écriture dans QuickBooks :
// créés pendant que l'automatisation était en pause, ou dont l'envoi a échoué.
// « Simuler » les liste, « Exécuter » les envoie. Borné pour qu'un rattrapage
// n'expédie pas des centaines d'écritures d'un coup.
export async function runPendingBillPayments({ apply = true, limit = 25 } = {}) {
  const rows = db.prepare(`
    SELECT p.id, p.label, p.amount, p.currency, p.payment_date, p.source
    FROM treasury_payments p
    JOIN achats_fournisseurs a ON a.id = p.achat_id
    WHERE p.deleted_at IS NULL AND p.direction = 'out'
      AND p.qb_billpayment_id IS NULL AND p.qb_billpayment_pushed_at IS NULL
      AND a.type = 'bill' AND a.quickbooks_id IS NOT NULL
      AND p.source NOT IN ('qb', 'import')
      AND p.payment_date >= ?
    ORDER BY p.payment_date DESC
    LIMIT ?
  `).all(getBillPaymentConfig().since_date || '0000-01-01', Math.min(200, Math.max(1, Number(limit) || 25)))

  if (!apply) {
    return {
      result: rows.length
        ? `${rows.length} paiement(s) sans écriture dans QuickBooks : `
          + rows.map(r => `${r.payment_date} ${r.label || '—'} ${r2(r.amount).toFixed(2)} ${r.currency || 'CAD'}`).join(' · ')
        : 'Chaque paiement lié à une facture a son écriture dans QuickBooks.',
      pending: rows.length,
    }
  }

  let pushed = 0
  const skipped = []
  for (const row of rows) {
    const out = await pushBillPayment(row.id, { trigger: 'rattrapage' })
    if (out.pushed) pushed += 1
    else skipped.push(`${row.label || '—'} : ${out.reason || out.error}`)
  }
  return {
    result: `${pushed} facture(s) marquée(s) payée(s) dans QuickBooks`
      + (skipped.length ? ` · ${skipped.length} écartée(s) — ${skipped.join(' · ')}` : ''),
    pushed,
    skipped: skipped.length,
  }
}
