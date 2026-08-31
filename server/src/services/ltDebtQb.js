// Comptabilisation d'un versement de dette LT en Dépense QB (Purchase) :
// AccountRef = banque, lignes Dr dette (capital) + Dr intérêts, fournisseur =
// prêteur. Remplace l'ancienne JE — les écritures de journal sont réservées aux
// cas sans sortie d'argent directe.
import db from '../db/database.js'
import { resolveAccountByAcctNum, findOrCreateVendor } from './quickbooks.js'
import { qbPost, qbGet, qbUploadAttachment } from '../connectors/quickbooks.js'
import { buildDebtSchedulePdf } from './ltDebtSchedulePdf.js'

const round2 = n => Math.round(n * 100) / 100

// Certains prêteurs (ex. Ville de Québec) portent déjà un nom pris par un Client
// dans QuickBooks (les noms sont uniques entre Clients/Fournisseurs/Employés).
// Plutôt que de créer un Fournisseur distinct suffixé, les versements précédents
// de CE prêt ont réutilisé tel quel l'EntityRef (type + Id) du dernier Purchase
// déjà publié pour cette dette — on reproduit fidèlement ce même EntityRef pour
// rester cohérent avec l'historique QB de la dette.
async function resolvePreviousEntityRef(debtId) {
  const prior = db.prepare(`
    SELECT qb_txn_id FROM lt_debt_payments
    WHERE debt_id = ? AND deleted_at IS NULL AND qb_txn_type = 'purchase' AND qb_txn_id IS NOT NULL
    ORDER BY payment_date DESC LIMIT 1
  `).get(debtId)
  if (!prior) return null
  try {
    const r = await qbGet(`/purchase/${prior.qb_txn_id}`)
    const entity = r.Purchase?.EntityRef
    if (entity?.value && entity?.type) return { value: entity.value, type: entity.type }
  } catch { /* purchase introuvable — on retombe sur findOrCreateVendor */ }
  return null
}

export async function publishDebtPaymentExpense(debt, payment) {
  const bankId = await resolveAccountByAcctNum(debt.qb_bank_acctnum)
  if (!bankId) throw new Error(`Compte QB #${debt.qb_bank_acctnum} introuvable`)
  const ref = [debt.label, debt.loan_number].filter(Boolean).join(' ')

  const lines = []
  const addLine = async (acctnum, amount, desc) => {
    const acctId = await resolveAccountByAcctNum(acctnum)
    if (!acctId) throw new Error(`Compte QB #${acctnum} introuvable`)
    lines.push({
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount: round2(amount),
      Description: desc,
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: acctId },
        BillableStatus: 'NotBillable',
      },
    })
  }
  if (payment.principal > 0) await addLine(debt.qb_debt_acctnum, payment.principal, `Remboursement capital — ${ref}`)
  if (payment.interest > 0) await addLine(debt.qb_interest_acctnum, payment.interest, `Intérêts — ${ref}`)

  const entityRef = (await resolvePreviousEntityRef(debt.id))
    || { value: await findOrCreateVendor(debt.lender || debt.label), type: 'Vendor' }
  const purchase = {
    PaymentType: 'Cash',
    AccountRef: { value: bankId },
    EntityRef: entityRef,
    TxnDate: payment.payment_date,
    PrivateNote: `Versement — ${ref}`,
    Line: lines,
  }
  const result = await qbPost('/purchase', purchase)
  const purchaseId = result.Purchase?.Id
  if (!purchaseId) throw new Error("QB n'a pas retourné d'Id pour le Purchase")

  // Pièce justificative : la cédule complète (versement courant surligné).
  // La dépense est déjà créée — un échec ici ne l'annule pas, on remonte un
  // avertissement à l'utilisateur.
  let attachmentWarning = null
  try {
    const schedule = db.prepare(`
      SELECT * FROM lt_debt_payments WHERE debt_id = ? AND deleted_at IS NULL ORDER BY payment_date
    `).all(debt.id)
    const pdf = await buildDebtSchedulePdf({ debt, payments: schedule, highlightPaymentId: payment.id })
    const slug = debt.label.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
    await qbUploadAttachment({
      entityType: 'Purchase', entityId: purchaseId,
      fileBuffer: pdf, fileName: `cedule-${slug}-${payment.payment_date}.pdf`,
      contentType: 'application/pdf',
    })
  } catch (e) {
    attachmentWarning = `Dépense créée, mais la cédule n'a pas pu être jointe : ${e.message}`
  }
  return { purchaseId: String(purchaseId), attachmentWarning }
}
