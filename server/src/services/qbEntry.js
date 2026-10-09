// L'écriture QuickBooks d'une ligne de relevé, lue et remise en forme comme
// QuickBooks l'affiche — pour confirmer un appariement sans quitter Boréal.
//
// Le rapprochement pose déjà `qb_txn_type` / `qb_txn_id` sur la transaction
// (bankQbSearch.js, bankQbLink.js) ; ce qu'on voyait jusqu'ici, c'était un
// simple lien « Ouvrir dans QuickBooks ». Confirmer demandait donc d'aller
// dans QBO, de lire l'écriture, de revenir. On lit l'entité à sa source et on
// la rend telle qu'elle est : fournisseur, comptes, taxe, total, mémo.
//
// LECTURE SEULE : aucune écriture QuickBooks ne part d'ici.
import { qbGet, qbEntityUrl } from '../connectors/quickbooks.js'

// Entité des URLs QBO (celle qu'on stocke dans qb_txn_type) → ressource de
// l'API v3 et clé de la réponse. Un type absent n'est pas lisible par l'API
// (la taxe de vente, par exemple) : on garde le lien, sans le détail.
const API = {
  expense: ['purchase', 'Purchase'],
  check: ['purchase', 'Purchase'],
  creditcardcredit: ['purchase', 'Purchase'],
  bill: ['bill', 'Bill'],
  billpayment: ['billpayment', 'BillPayment'],
  deposit: ['deposit', 'Deposit'],
  transfer: ['transfer', 'Transfer'],
  journal: ['journalentry', 'JournalEntry'],
  recvpayment: ['payment', 'Payment'],
  salesreceipt: ['salesreceipt', 'SalesReceipt'],
  refundreceipt: ['refundreceipt', 'RefundReceipt'],
  creditcardpayment: ['creditcardpaymenttxn', 'CreditCardPaymentTxn'],
}

const LABEL = {
  expense: 'Dépense',
  check: 'Chèque',
  creditcardcredit: 'Crédit sur carte de crédit',
  bill: 'Facture fournisseur',
  billpayment: 'Paiement de factures',
  deposit: 'Dépôt',
  transfer: 'Virement',
  journal: 'Écriture de journal',
  recvpayment: 'Paiement reçu',
  salesreceipt: 'Reçu de vente',
  refundreceipt: 'Remboursement',
  creditcardpayment: 'Paiement par carte de crédit',
  salestaxpayment: 'Paiement de taxe de vente',
}

const num = (v) => (v == null || v === '' ? null : Number(v))
const ref = (r) => (r ? r.name || r.value || null : null)

// Les lignes ne portent que l'ID du code de taxe (« 8 ») : illisible tel quel.
// Le référentiel est court et ne bouge jamais — un cache de 10 minutes suffit.
let taxCodes = null
let taxCodesAt = 0
async function taxCodeName(id) {
  if (!id) return null
  if (!taxCodes || Date.now() - taxCodesAt > 600000) {
    try {
      const q = encodeURIComponent('SELECT Id, Name FROM TaxCode MAXRESULTS 200')
      const data = await qbGet(`/query?query=${q}`)
      taxCodes = new Map((data.QueryResponse?.TaxCode || []).map((t) => [String(t.Id), t.Name]))
      taxCodesAt = Date.now()
    } catch {
      taxCodes = taxCodes || new Map()
    }
  }
  return taxCodes.get(String(id)) || String(id)
}

// Les lignes, quel que soit le type d'écriture : QuickBooks range le compte
// dans un *LineDetail différent selon l'entité, mais l'utilisateur, lui,
// regarde toujours les mêmes quatre colonnes.
function normalizeLines(e, entity) {
  const out = []
  for (const l of e.Line || []) {
    if (l.DetailType === 'SubTotalLineDetail') continue
    const d = l.AccountBasedExpenseLineDetail || l.ItemBasedExpenseLineDetail
      || l.DepositLineDetail || l.JournalEntryLineDetail || l.SalesItemLineDetail || {}
    const account = ref(d.AccountRef) || ref(d.ItemRef) || null
    const linked = (l.LinkedTxn || []).map((t) => `${t.TxnType} ${t.TxnId}`).join(', ') || null
    out.push({
      account: account || (linked ? `Rattaché à ${linked}` : null),
      description: l.Description || d.Entity?.name || ref(d.CustomerRef) || null,
      tax_code: ref(d.TaxCodeRef) || null,
      posting: d.PostingType || null, // journal : Debit / Credit
      amount: num(l.Amount),
    })
  }
  // Virement et paiement par carte : aucune ligne, juste deux comptes.
  if (!out.length && entity === 'transfer') {
    out.push({ account: ref(e.FromAccountRef), description: 'Compte source', amount: -num(e.Amount) })
    out.push({ account: ref(e.ToAccountRef), description: 'Compte destination', amount: num(e.Amount) })
  }
  if (!out.length && entity === 'creditcardpayment') {
    out.push({ account: ref(e.BankAccountRef), description: 'Payé depuis', amount: -num(e.Amount) })
    out.push({ account: ref(e.CreditCardAccountRef), description: 'Carte remboursée', amount: num(e.Amount) })
  }
  return out
}

function partyOf(e) {
  return ref(e.EntityRef) || ref(e.VendorRef) || ref(e.CustomerRef) || null
}

// Total : les entités de paiement portent TotalAmt, les virements Amount.
// Une écriture de journal annonce TotalAmt = 0 (débits et crédits s'annulent) :
// le montant qui parle à l'humain est la somme des débits.
function totalOf(e, entity) {
  if (entity === 'journal') {
    const debits = (e.Line || [])
      .filter((l) => l.JournalEntryLineDetail?.PostingType === 'Debit')
      .reduce((sum, l) => sum + (num(l.Amount) || 0), 0)
    return Math.round(debits * 100) / 100
  }
  return num(e.TotalAmt) ?? num(e.Amount) ?? null
}

export async function fetchQbEntry(entity, txnId) {
  const url = qbEntityUrl(entity, txnId)
  const known = API[entity]
  const base = {
    entity,
    qb_id: String(txnId),
    type_label: LABEL[entity] || entity,
    url,
  }
  if (!known) return { ...base, readable: false, reason: 'Ce type d\'écriture ne se lit pas par l\'API — ouvrir dans QuickBooks.' }

  const [path, key] = known
  let e
  try {
    // Le paiement de carte ne se lit pas par son URL (« opération non prise
    // en charge ») : seulement par une requête.
    e = entity === 'creditcardpayment'
      ? (await qbGet(`/query?query=${encodeURIComponent(`SELECT * FROM CreditCardPaymentTxn WHERE Id = '${String(txnId).replace(/\D/g, '')}'`)}&minorversion=75`))?.QueryResponse?.CreditCardPaymentTxn?.[0]
      : (await qbGet(`/${path}/${txnId}`))?.[key]
  } catch (err) {
    return { ...base, readable: false, reason: err.message }
  }
  if (!e) return { ...base, readable: false, reason: 'Écriture introuvable dans QuickBooks (supprimée ?)' }

  const taxTotal = num(e.TxnTaxDetail?.TotalTax)
  const lines = normalizeLines(e, entity)
  for (const l of lines) l.tax_code = await taxCodeName(l.tax_code)
  return {
    ...base,
    readable: true,
    doc_number: e.DocNumber || null,
    date: e.TxnDate || null,
    party: partyOf(e),
    payment_account: ref(e.AccountRef) || ref(e.DepositToAccountRef) || ref(e.BankAccountRef) || null,
    payment_type: e.PaymentType || e.PayType || null,
    currency: ref(e.CurrencyRef),
    exchange_rate: num(e.ExchangeRate),
    total: totalOf(e, entity),
    tax_total: taxTotal,
    memo: e.PrivateNote || e.Memo || null,
    lines,
    updated_at: e.MetaData?.LastUpdatedTime || null,
  }
}
