import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import {
  ChevronLeft, ChevronRight, ChevronDown,
  RefreshCw, AlertCircle, AlertTriangle, CheckCircle, Clock, BookOpen, ReceiptText,
  Plus, Trash2, Archive, ArchiveRestore, Pencil, Mail, Sparkles, FileX, Paperclip,
  ArrowLeftRight, Landmark,
} from 'lucide-react'
import { api } from '../lib/api.js'
import { fmtDate, fmtDateTime } from '../lib/formatDate.js'
import { PageTitle } from '../components/PageTitle.jsx'
import { Modal } from '../components/Modal.jsx'
import { CurrencyConversionModal } from '../components/CurrencyConversionModal.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { PeekFooter } from '../components/PeekFooter.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useEntityListRealtime } from '../lib/useRealtimeChannel.js'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { findBestVendorMatch } from '../lib/vendorMatch.js'

import { fmtCad, fmtMoney } from '../utils/formatters.js'

const round2 = x => Math.round((Number(x) || 0) * 100) / 100

// Saisie d'un montant : la virgule décimale (clavier FR/QC) vaut le point.
// Retourne null si la saisie est vide ou n'est pas un nombre.
function parseAmountInput(x) {
  const s = String(x ?? '').trim().replace(/\s/g, '').replace(',', '.')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// Montants synchronisés avec le total : toute édition de l'un de ces champs doit
// recalculer `total` dans le même PATCH pour rester cohérent en DB.
const TOTAL_SYNC_FIELDS = new Set(['subtotal', 'tps', 'tvq', 'other_taxes'])

// Sous-total effectif : somme des lignes d'articles si au moins une porte un
// montant (le sous-total est alors en lecture seule), sinon le sous-total saisi.
function effectiveSubtotal(receipt) {
  const withTotals = (receipt.items || []).filter(it => it && it.total != null)
  if (withTotals.length) return round2(withTotals.reduce((s, it) => s + (Number(it.total) || 0), 0))
  return round2(receipt.subtotal || 0)
}

// Total = sous-total (articles) + TPS + TVQ + autres taxes. Toujours DÉRIVÉ, jamais
// saisi à la main — règle métier : « le total doit correspondre aux articles et aux
// taxes ». Affiché en lecture seule et persisté à chaque édition de montant.
function computedTotal(receipt) {
  return round2(effectiveSubtotal(receipt) + (receipt.tps || 0) + (receipt.tvq || 0) + (receipt.other_taxes || 0))
}

// Enrichit un patch de montants du total recalculé pour garder `total` cohérent en DB.
function withRecomputedTotal(receipt, patch) {
  return { ...patch, total: computedTotal({ ...receipt, ...patch }) }
}

import { ReceiptStatusBadge as StatusBadge } from '../components/Badge.jsx'
import { DetailFieldGrid, DetailField } from '../components/DetailFieldGrid.jsx'
import { ReceiptAttachment } from '../components/ReceiptAttachment.jsx'
import ThinkingOrb from '../components/ThinkingOrb'

// Code de taxe QB déduit par défaut selon les montants TPS/TVQ extraits — sert de
// présélection. Doit rester aligné avec la déduction serveur (pushSaleReceiptToQB).
const NO_TAX = '__none__'

// Compte d'imputation des PIÈCES. Une facture dont les lignes sont rattachées à des
// achats LIA (table Achats) entre au STOCK — ce n'est pas une dépense de la période.
// Historique QuickBooks : 100 des 101 lignes « LIA-… » publiées depuis mars sont
// imputées à 14000 « Stock de Pièces ». On présélectionne donc ce compte dès qu'une
// ligne porte un achat LIA, au lieu de le faire ressaisir à chaque facture.
// Repéré par NUMÉRO de compte (stable, lisible) et non par Id QB.
const PARTS_ACCT_NUM = '14000'

// Comptes QB proposés comme compte de DÉPENSE — au niveau du document (formulaire de
// publication) comme au niveau d'une LIGNE d'article (section Articles), d'où le
// partage. « Other Current Asset » couvre le stock de pièces (14000).
const EXPENSE_ACCOUNT_TYPES = ['Expense', 'Other Expense', 'Cost of Goods Sold', 'Other Current Asset']
const accountLabel = a => (a.AcctNum ? `${a.AcctNum} — ${a.Name}` : a.Name)
// Comptes qu'un dépôt peut créditer : revenus d'abord (intérêts, subventions…),
// puis bilan, puis dépenses.
const depositTypeRank = t => ['Other Income', 'Income'].includes(t) ? 0
  : ['Other Current Asset', 'Other Asset', 'Fixed Asset', 'Accounts Receivable'].includes(t) ? 1
  : ['Other Current Liability', 'Long Term Liability', 'Equity'].includes(t) ? 2 : 3
const depositAccountOptions = accounts => (accounts || [])
  .filter(a => !['Bank', 'Credit Card', 'Accounts Payable'].includes(a.AccountType))
  .sort((a, b) => depositTypeRank(a.AccountType) - depositTypeRank(b.AccountType) || accountLabel(a).localeCompare(accountLabel(b), 'fr', { numeric: true }))
  .map(a => ({ value: a.Id, label: accountLabel(a) }))
const expenseAccountOptions = accounts => (accounts || [])
  .filter(a => EXPENSE_ACCOUNT_TYPES.includes(a.AccountType))
  .map(a => ({ value: a.Id, label: accountLabel(a) }))

// Une ligne « pièce » = rattachée à un achat LIA (lien explicite) ou décrite par un
// code LIA (saisie manuelle, extraction).
const hasLiaLines = items => (items || []).some(it => it?.purchase_id || /^\s*lia-\d+/i.test(it?.description || ''))

function deducedTaxName(tps, tvq) {
  if (tps > 0 && tvq > 0) return 'TPS/TVQ QC - 9,975'
  if (tps > 0) return 'TPS'
  if (tvq > 0) return 'TVQ QC - 9,975'
  return null
}

// Signature de montants attendue par code de taxe QB — miroir client de
// CODE_SIGNATURES (server/services/fiscalDetection.js). Sert à choisir, parmi les
// codes acceptés d'un type de transaction, celui qui colle aux montants DU document
// (ex. « Achat local taxable » + TPS seule → « TPS », pas « TPS/TVQ QC - 9,975 »).
const CODE_AMOUNT_SIGNS = {
  'TPS/TVQ QC - 9,975': { tps: true, tvq: true },
  'TPS/TVQ repas':      { tps: true, tvq: true },
  'TPS':                { tps: true, tvq: false },
  'TVQ QC - 9,975':     { tps: false, tvq: true },
  'Détaxé':             { tps: false, tvq: false },
  'Exonéré':            { tps: false, tvq: false },
  'Hors champ':         { tps: false, tvq: false },
}

function bestCodeForType(type, tps, tvq) {
  if (!type) return null
  const hasTps = (Number(tps) || 0) > 0
  const hasTvq = (Number(tvq) || 0) > 0
  const match = (type.codes || []).find(c => {
    const s = CODE_AMOUNT_SIGNS[c]
    return s && s.tps === hasTps && s.tvq === hasTvq
  })
  return match || type.recommendedCode
}

// Taux de taxe d'ACHAT par NOM de code QB (codes vérifiés en prod — cf. fiscalStatus.js).
// Sert à l'indicateur de réconciliation (compare la taxe impliquée par les codes par
// ligne aux taxes saisies du document) et à repérer les lignes explicitement à 0 % pour
// les exclure de la base taxable au recalcul. Un nom absent = taux inconnu → la
// réconciliation est marquée « partielle » plutôt que de conclure à tort.
const TAX_RATE_BY_NAME = new Map([
  ['TPS', 5],
  ['TVQ QC - 9,975', 9.975],
  ['TPS/TVQ QC - 9,975', 14.975],
  ['TPS/TVQ repas', 14.975],
  ['Détaxé', 0],
  ['Exonéré', 0],
  ['Hors champ', 0],
])

// Ventilation TPS/TVQ par NOM de code QB — pour le recalcul AUTOMATIQUE des taxes du
// document à partir des codes (mode « piloté par les codes »). Le taux est le taux PLEIN
// de taxe facturée (le crédit partiel des repas est géré au posting QB, pas au taux).
const TAX_SPLIT_BY_NAME = new Map([
  ['TPS', { tps: 5, tvq: 0 }],
  ['TVQ QC - 9,975', { tps: 0, tvq: 9.975 }],
  ['TPS/TVQ QC - 9,975', { tps: 5, tvq: 9.975 }],
  ['TPS/TVQ repas', { tps: 5, tvq: 9.975 }],
  ['Détaxé', { tps: 0, tvq: 0 }],
  ['Exonéré', { tps: 0, tvq: 0 }],
  ['Hors champ', { tps: 0, tvq: 0 }],
])

// Types d'écriture QB proposés en tête du formulaire de comptabilisation. Libellés
// COURTS : le nom exact de l'entité QuickBooks est en infobulle. Les trois libellés
// longs d'origine (« Dépense payée (Purchase) », « Facture à payer (Bill → Comptes
// fournisseurs) »…) débordaient sur trois lignes dans la colonne étroite du panneau.
const QB_ENTRY_TYPES = [
  { key: 'purchase', label: 'Dépense payée', testId: 'qb-type-purchase', hint: 'Purchase — dépense déjà réglée' },
  { key: 'bill', label: 'Facture à payer', testId: 'qb-type-bill', hint: 'Bill — portée aux Comptes fournisseurs' },
  { key: 'cc_credit', label: 'Crédit carte', testId: 'qb-type-cc-credit', hint: 'Credit Card Credit — remboursement porté sur la carte' },
  { key: 'deposit', label: 'Dépôt', testId: 'qb-type-deposit', hint: 'Deposit — argent reçu au compte bancaire (crédit d’impôt, subvention…)' },
]

// Ventilation TPS/TVQ d'un code (Id QB ou sentinel NO_TAX). null si taux inconnu.
function taxSplitForCode(codeId, taxNameById) {
  if (!codeId) return undefined
  if (codeId === NO_TAX) return { tps: 0, tvq: 0 }
  const name = taxNameById.get(codeId)
  return name != null ? TAX_SPLIT_BY_NAME.get(name) : undefined
}

// Recalcule TPS/TVQ à partir des codes : chaque ligne est taxée selon SON code, ou le
// code du DOCUMENT (defaultCodeId) si la ligne n'a pas de code propre.
// taxNameById : Map(Id QB → Nom). Retourne { tps, tvq } ou null si non calculable
// (une ligne sans code et sans défaut, ou un code au taux inconnu) → l'appelant garde
// alors les taxes manuelles.
function computeTaxesFromCodes(items, defaultCodeId, taxNameById) {
  let tps = 0, tvq = 0
  for (const it of (items || [])) {
    const ht = Number(it && it.total) || 0
    const code = (it && it.tax_code_id != null && it.tax_code_id !== '') ? it.tax_code_id : defaultCodeId
    const split = taxSplitForCode(code, taxNameById)
    if (!split) return null
    tps += ht * split.tps / 100
    tvq += ht * split.tvq / 100
  }
  return { tps: round2(tps), tvq: round2(tvq) }
}

// Patch des montants après changement du code du document ou d'un code d'article.
// Mode « piloté par les codes » (code du document défini ET taxes calculables) → TPS/TVQ
// dérivées des codes, other_taxes remis à 0, total = sous-total + taxes. Deux cas :
//  - lignes chiffrées → taxe par ligne (code de ligne sinon code document) ;
//  - aucune ligne chiffrée → tout le sous-total au code du document.
// Sinon → retombe sur le comportement manuel (mise à l'échelle proportionnelle).
function recomputeAmounts(receipt, items, defaultCodeId, taxNameById) {
  const lineTotals = (items || []).map(it => it && it.total).filter(n => n != null)
  if (defaultCodeId) {
    if (lineTotals.length) {
      const t = computeTaxesFromCodes(items, defaultCodeId, taxNameById)
      if (t) {
        const subtotal = round2(lineTotals.reduce((a, b) => a + (Number(b) || 0), 0))
        return { subtotal, tps: t.tps, tvq: t.tvq, other_taxes: 0, total: round2(subtotal + t.tps + t.tvq) }
      }
    } else {
      // Aucune ligne chiffrée : taxer le sous-total saisi au code du document.
      const split = taxSplitForCode(defaultCodeId, taxNameById)
      const subtotal = round2(receipt.subtotal || 0)
      if (split && subtotal > 0) {
        const tps = round2(subtotal * split.tps / 100)
        const tvq = round2(subtotal * split.tvq / 100)
        return { subtotal, tps, tvq, other_taxes: 0, total: round2(subtotal + tps + tvq) }
      }
    }
  }
  return recalcAmountsFromItems(items, receipt, taxNameById)
}

// Taxe impliquée par les codes de taxe PAR LIGNE (réconciliation, lecture seule — ne
// modifie jamais les taxes du document, qui restent la vérité de la facture).
// taxNameById : Map(Id QB → Nom). Retourne :
//  - applicable : au moins une ligne porte un code explicite (réel ou « aucune taxe »).
//  - allExplicit : toutes les lignes portent un code explicite. Sinon on ne peut pas
//    conclure — une ligne « code du document » dépend du code choisi à la publication.
//  - unknown : un code explicite a un taux inconnu (hors table) → réconciliation partielle.
//  - implied : somme des HT × taux des lignes à code explicite.
function impliedTaxFromLineCodes(receipt, taxNameById) {
  const items = receipt.items || []
  let implied = 0, explicitCount = 0, followCount = 0, unknown = false
  for (const it of items) {
    const code = it && it.tax_code_id
    const ht = Number(it && it.total) || 0
    if (code == null || code === '') { followCount++; continue }
    explicitCount++
    let rate
    if (code === NO_TAX) rate = 0
    else {
      const name = taxNameById.get(code)
      rate = name != null ? TAX_RATE_BY_NAME.get(name) : undefined
    }
    if (rate == null) { unknown = true; continue }
    implied += ht * rate / 100
  }
  return {
    applicable: explicitCount > 0,
    allExplicit: explicitCount > 0 && followCount === 0,
    unknown,
    implied: round2(implied),
  }
}


// Publications en cours (hors fenêtre) et dernier refus par reçu : rouvrir le
// document pendant l'envoi le montre « Publication… » ; après un refus, le
// message rouge (et « Publier quand même ») y attend l'utilisateur.
const publishing = new Set()
const publishErrors = new Map()

function QBPublishForm({ receipt, onLeave, onUpdate, onOpenConversion }) {
  const { addToast } = useToast()
  const navigate = useNavigate()
  const lastError = publishErrors.get(receipt.id)
  const [accounts, setAccounts] = useState([])
  const [vendors, setVendors] = useState([])
  const [taxCodes, setTaxCodes] = useState([])
  const [txTypes, setTxTypes] = useState([])
  const [vendorHistory, setVendorHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(() => publishing.has(receipt.id))
  const [error, setError] = useState(lastError?.message || null)
  // Champ à corriger signalé par la validation (locale ou serveur) — la section
  // correspondante est encadrée en rouge. Valeurs : vendor, expense_account,
  // payment_account, transaction_type, tax_code, currency.
  const [errorField, setErrorField] = useState(lastError?.field || null)
  // Publication tardive : nombre de jours de retard quand le garde-fou des 30 jours
  // bloque. Non nul ⇒ le message rouge propose « Publier quand même » (le retard est
  // souvent légitime — facture comptabilisée après coup — mais doit être vu).
  const [staleDays, setStaleDays] = useState(null)
  // Doublon probable : le serveur refuse la publication tant qu'une anomalie « doublon »
  // est ouverte (cf. transactionAnomalies.js). Le blocage n'est pas une impasse — après
  // avoir LU le message, l'opérateur peut publier quand même en justifiant (la raison est
  // tracée au journal du reçu). Non nul ⇒ le message rouge propose la justification.
  const [anomalyBlocked, setAnomalyBlocked] = useState(lastError?.field === 'anomaly')
  const [anomalyReason, setAnomalyReason] = useState('')
  const fail = (msg, field = null) => { setError(msg); setErrorField(field); setStaleDays(null); setAnomalyBlocked(false) }
  const fieldFrame = f => (errorField === f ? 'ring-2 ring-red-400 rounded-lg bg-red-50 p-2 -m-2' : '')

  // Vérification du statut fiscal avant publication. transactionType détermine le
  // code de taxe QB attendu (cf. server/services/fiscalStatus.js). showConfirm ouvre
  // la modale récapitulative ; forceReason = justification pour publier malgré un écart.
  const [transactionType, setTransactionType] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [forceReason, setForceReason] = useState('')

  const [type, setType] = useState('purchase')
  const [expenseAccountId, setExpenseAccountId] = useState('')
  const [paymentAccountId, setPaymentAccountId] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [vendorMode, setVendorMode] = useState('existing')
  const [vendorId, setVendorId] = useState('')
  const [newVendorName, setNewVendorName] = useState(receipt.company || '')
  const [taxCodeId, setTaxCodeId] = useState(NO_TAX)
  // Montant réellement débité à la banque quand il diffère du total de la facture
  // (conversion de devise — ex. AWS facture en USD mais charge la carte en CAD, que
  // Desjardins reconvertit à son taux). Paramètre de publication, pas une donnée du
  // reçu : l'écart devient une ligne « Frais de conversion » (Exonéré) côté serveur.
  const [bankChargedTotal, setBankChargedTotal] = useState(
    receipt.bank_charged_total != null ? String(receipt.bank_charged_total) : ''
  )
  // Champ rarement utilisé — replié par défaut, ouvert seulement si déjà rempli.
  const [bankFieldOpen, setBankFieldOpen] = useState(receipt.bank_charged_total != null)

  // BROUILLON de comptabilisation : chaque choix du formulaire (type, fournisseur,
  // comptes, statut fiscal, montant banque) est autosauvegardé sur le reçu dès la
  // saisie — on peut quitter la fiche en cours de route et retrouver ses choix tels
  // quels au retour pour finaliser. Best effort : un échec réseau ne bloque pas la
  // saisie (toast d'erreur), la publication revalide tout de toute façon.
  function saveDraft(patch) {
    api.saleReceipts.update(receipt.id, patch)
      .then(u => onUpdate?.(u))
      .catch(e => addToast({ message: 'Brouillon non sauvegardé : ' + e.message, type: 'error' }))
  }

  // Pré-remplissage auto depuis le PROFIL fournisseur (défauts appris/édités —
  // prioritaire) puis, à défaut, depuis la dernière compta du même fournisseur.
  // autoAppliedRef : applique une seule fois ; userTouchedRef : ne jamais écraser
  // une édition manuelle de type/dépense/paiement ; autoAppliedFrom : txn source (note).
  const autoAppliedRef = useRef(false)
  const userTouchedRef = useRef(false)
  const [autoAppliedFrom, setAutoAppliedFrom] = useState(null)
  const [profileApplied, setProfileApplied] = useState(false)
  const [partsApplied, setPartsApplied] = useState(false)
  // Édition manuelle + autosave brouillon en un geste (type, comptes).
  const touchAndDraft = (fn, field) => v => { userTouchedRef.current = true; fn(v); saveDraft({ [field]: v || null }) }

  useEffect(() => {
    // Tous les comptes actifs : un dépôt crédite des revenus, des actifs ou des passifs
    // (les listes dépense/paiement filtrent leurs types elles-mêmes).
    Promise.all([api.quickbooks.accounts({ all: 1 }), api.quickbooks.vendors(), api.quickbooks.taxCodes(), api.saleReceipts.transactionTypes()])
      .then(([accs, vends, codes, types]) => {
        setAccounts(accs)
        setVendors(vends)
        setTaxCodes(codes)
        setTxTypes(types.data || [])
        // Défauts du profil fournisseur, déjà résolus pour LA devise du reçu
        // (vendor QB CAD vs USD, compte de paiement par devise, code de taxe par devise).
        const defaults = receipt.vendor_defaults || null
        // Type de transaction : choix confirmé déjà en DB, sinon DÉTECTION fiscale
        // serveur (profil → historique → IA du document → règles, chaque signal validé
        // contre les montants — cf. services/fiscalDetection.js), sinon défaut brut du
        // profil. Toujours à confirmer (obligatoire à la publication).
        setTransactionType(receipt.transaction_type || receipt.fiscal_detection?.transaction_type || defaults?.transaction_type || receipt.suggested_transaction_type || '')
        // BROUILLON persisté par un passage précédent dans le formulaire (autosave) :
        // les choix déjà faits priment sur le profil fournisseur, l'historique et le
        // rapprochement flou — on retrouve la facture exactement là où on l'a laissée.
        // Chaque valeur est validée contre les référentiels QB chargés (compte ou
        // vendor supprimé depuis → on retombe sur les défauts).
        const draftType = ['purchase', 'bill', 'cc_credit', 'deposit'].includes(receipt.quickbooks_type) ? receipt.quickbooks_type : null
        const draftVendorId = receipt.vendor_id && vends.some(v => v.Id === receipt.vendor_id) ? receipt.vendor_id : null
        const draftExpenseId = receipt.expense_account_id && accs.some(a => a.Id === receipt.expense_account_id) ? receipt.expense_account_id : null
        const draftPaymentId = receipt.payment_account_id && accs.some(a => a.Id === receipt.payment_account_id) ? receipt.payment_account_id : null
        // Fournisseur : le brouillon prime, puis le vendor QB du profil pour cette
        // devise. Sinon, rapprochement flou DEVISE D'ABORD (un fournisseur bi-devise a
        // deux vendors QB — on cherche parmi ceux de la devise du reçu avant les
        // autres), et en dernier recours on propose d'en créer un nouveau — évite les doublons.
        const recCur = (receipt.currency || 'CAD').toUpperCase()
        const profileVendor = defaults?.qb_vendor_id && vends.find(v => v.Id === defaults.qb_vendor_id)
        if (draftVendorId) {
          setVendorId(draftVendorId); setVendorMode('existing')
        } else if (profileVendor) {
          setVendorId(profileVendor.Id); setVendorMode('existing')
        } else if (receipt.company) {
          const sameCur = vends.filter(v => ((v.CurrencyRef?.value || 'CAD').toUpperCase()) === recCur)
          const match = findBestVendorMatch(receipt.company, sameCur) || findBestVendorMatch(receipt.company, vends)
          if (match) { setVendorId(match.Id); setVendorMode('existing') }
          else setVendorMode('new')
        }
        // Type d'entité + comptes : brouillon d'abord, sinon défauts du profil (le
        // panneau « dernière compta » ne s'applique ensuite que si le profil n'avait
        // pas de compte de dépense).
        let fromProfile = false
        // L'ARGENT EST DÉJÀ SORTI DU COMPTE : ce n'est plus une facture à payer,
        // c'est une dépense. Le fait du relevé prime sur l'habitude du profil —
        // publier un « à payer » sur une somme déjà débitée créerait une dette
        // fantôme au grand livre. Un brouillon (choix déjà fait) le garde.
        const bankSaysExpense = Number(receipt.bank_txn?.amount) < 0
        if (draftType) setType(draftType)
        else if (bankSaysExpense) setType('purchase')
        else if (defaults?.qb_type) { setType(defaults.qb_type); fromProfile = true }
        if (draftExpenseId) setExpenseAccountId(draftExpenseId)
        else if (defaults?.expense_account_id) { setExpenseAccountId(defaults.expense_account_id); fromProfile = true }
        // LA LIGNE DU RELEVÉ prime sur le profil : le compte qui a RÉELLEMENT payé
        // est un fait, pas une habitude. Un brouillon (choix déjà fait) le garde.
        const bankPaymentId = receipt.bank_txn?.qb_account_id && accs.some(a => a.Id === receipt.bank_txn.qb_account_id)
          ? receipt.bank_txn.qb_account_id : null
        // LA CARTE LUE SUR LE DOCUMENT est un fait elle aussi : les 4 derniers
        // chiffres imprimés désignent le compte payeur — carte de l'entreprise, ou
        // compte « rembourser à » quand un employé a avancé la dépense.
        const cardPaymentId = receipt.card_match?.qb_account_id && accs.some(a => a.Id === receipt.card_match.qb_account_id)
          ? receipt.card_match.qb_account_id : null
        if (draftPaymentId) setPaymentAccountId(draftPaymentId)
        else if (bankPaymentId) setPaymentAccountId(bankPaymentId)
        else if (cardPaymentId) setPaymentAccountId(cardPaymentId)
        else if (defaults?.payment_account_id) { setPaymentAccountId(defaults.payment_account_id); fromProfile = true }
        // Montant réellement débité : lu au relevé quand la banque a converti la
        // facture (facture en USD, compte en CAD).
        if (receipt.bank_charged_total == null && receipt.bank_txn
            && (receipt.bank_txn.currency || 'CAD').toUpperCase() !== recCur) {
          const charged = Math.abs(Number(receipt.bank_txn.amount) || 0)
          if (charged > 0) { setBankChargedTotal(String(charged)); setBankFieldOpen(true) }
        }
        // Un brouillon type/comptes = des choix DÉJÀ faits par l'opérateur : on les
        // traite comme des éditions manuelles pour que ni l'auto-apply « dernière
        // compta » ni le compte de pièces LIA ne viennent les écraser au retour.
        if (draftType || draftExpenseId || draftPaymentId) {
          userTouchedRef.current = true
          autoAppliedRef.current = true
        }
        // Échéance : extraite du document (ou calculée depuis ses termes), sinon
        // recalculée depuis les termes par défaut du profil (Net N jours).
        if (receipt.due_date) setDueDate(receipt.due_date)
        else {
          const terms = receipt.payment_terms_days ?? defaults?.payment_terms_days
          if (terms > 0 && receipt.receipt_date) {
            const d = new Date(receipt.receipt_date.slice(0, 10) + 'T00:00:00')
            d.setDate(d.getDate() + Number(terms))
            setDueDate(d.toISOString().slice(0, 10))
          }
        }
        // Présélection du code de taxe : code du document (section Montants), sinon
        // défaut du profil pour cette devise (sentinel __none__ = aucune taxe), sinon
        // déduction automatique par les montants TPS/TVQ.
        // Le défaut du profil est écarté quand les montants du document le CONTREDISENT
        // (verdict serveur code_amount_verdicts) : le profil Amazon.ca porte le code
        // groupé « TPS/TVQ QC - 9,975 », mais un livre n'est facturé qu'à 5 % (TVH ON
        // remise) — publier le groupé sans TVQ faisait refuser QB (« erreur lors du
        // calcul de la taxe »). On retombe alors sur le code recommandé par la détection.
        const verdicts = receipt.fiscal_detection?.code_amount_verdicts || {}
        const defaultCodeName = defaults?.tax_code_id && defaults.tax_code_id !== NO_TAX
          ? (codes.find(c => c.Id === defaults.tax_code_id)?.Name || null)
          : null
        const defaultContradicted = defaultCodeName ? verdicts[defaultCodeName] === false : false
        if (receipt.tax_code_id) {
          setTaxCodeId(receipt.tax_code_id)
        } else if (!defaultContradicted && defaults?.tax_code_id
          && (defaults.tax_code_id === NO_TAX || codes.some(c => c.Id === defaults.tax_code_id))) {
          setTaxCodeId(defaults.tax_code_id)
          fromProfile = true
        } else {
          // Code recommandé par la détection fiscale (adapté au type ET aux montants),
          // sinon déduction brute par les montants TPS/TVQ.
          const wantName = receipt.fiscal_detection?.tax_code_name || deducedTaxName(receipt.tps || 0, receipt.tvq || 0)
          const taxMatch = wantName && codes.find(c => c.Name === wantName)
          if (taxMatch) setTaxCodeId(taxMatch.Id)
        }
        if (fromProfile && !receipt.quickbooks_id) {
          setProfileApplied(true)
          if (defaults?.expense_account_id) autoAppliedRef.current = true // court-circuite l'auto-apply « dernière compta »
        }
      })
      .catch(() => setError('Impossible de charger les données QuickBooks'))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Transactions passées du même fournisseur déjà comptabilisées — rechargées si
  // le nom du fournisseur change.
  useEffect(() => {
    let cancelled = false
    api.saleReceipts.vendorHistory(receipt.id)
      .then(r => { if (!cancelled) setVendorHistory(r.data || []) })
      .catch(() => { if (!cancelled) setVendorHistory([]) })
    return () => { cancelled = true }
  }, [receipt.id, receipt.company])

  // Applique les réglages de comptabilisation d'une transaction passée.
  // withTax=true (bouton « Utiliser » manuel) copie aussi le code de taxe + toast ;
  // withTax=false (auto-apply silencieux) laisse la déduction TPS/TVQ du reçu courant.
  function applyAccountingFields(txn, { withTax } = { withTax: true }) {
    const qbType = ['bill', 'cc_credit', 'deposit'].includes(txn.quickbooks_type) ? txn.quickbooks_type : 'purchase'
    setType(qbType)
    if (txn.expense_account_id) setExpenseAccountId(txn.expense_account_id)
    if (txn.payment_account_id) setPaymentAccountId(txn.payment_account_id)
    if (withTax) {
      setTaxCodeId(txn.tax_code_id || NO_TAX)
      if (txn.transaction_type) setTransactionType(txn.transaction_type)
      fail(null)
      // Copie MANUELLE (bouton « Utiliser ») = choix de l'opérateur → persistée en
      // brouillon, comme une saisie directe. L'auto-apply silencieux (withTax=false),
      // lui, ne persiste rien : il est recalculé à chaque visite.
      userTouchedRef.current = true
      saveDraft({
        quickbooks_type: qbType,
        ...(txn.expense_account_id ? { expense_account_id: txn.expense_account_id } : {}),
        ...(txn.payment_account_id ? { payment_account_id: txn.payment_account_id } : {}),
        ...(txn.transaction_type ? { transaction_type: txn.transaction_type } : {}),
      })
      addToast({ message: 'Réglages copiés depuis la transaction passée — vérifiez puis publiez.', type: 'success' })
    }
  }

  // Auto-pré-sélection au chargement : reprend type/compte de dépense/compte de
  // paiement de la dernière transaction comptabilisée du même fournisseur. Ne touche
  // ni au fournisseur ni au code de taxe (gérés par l'effet QB ci-dessus). Une seule
  // fois, jamais sur un reçu déjà publié, jamais après une édition manuelle.
  useEffect(() => {
    if (loading || autoAppliedRef.current || userTouchedRef.current) return
    if (receipt.quickbooks_id || vendorHistory.length === 0) return
    const txn = vendorHistory[0] // route triée récent → ancien
    if (!txn.expense_account_id) return
    applyAccountingFields(txn, { withTax: false })
    autoAppliedRef.current = true
    setAutoAppliedFrom(txn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, vendorHistory])

  // Facture de PIÈCES : dès qu'une ligne est rattachée à un achat LIA, le compte de
  // dépense est le compte de pièces (#14000) — un achat LIA entre au stock. Ce signal
  // est plus fort que les défauts du profil fournisseur ou de la dernière compta : il
  // vient du contenu de CETTE facture, il les écrase donc. Jamais après une édition
  // manuelle (userTouchedRef), jamais sur un reçu déjà publié. Re-évalué si l'opérateur
  // rattache un achat après coup dans la section Articles.
  const liaLines = hasLiaLines(receipt.items)
  useEffect(() => {
    if (loading || receipt.quickbooks_id || userTouchedRef.current || !liaLines) return
    const partsAcct = accounts.find(a => String(a.AcctNum) === PARTS_ACCT_NUM)
    if (!partsAcct || expenseAccountId === partsAcct.Id) return
    setExpenseAccountId(partsAcct.Id)
    setPartsApplied(true)
    autoAppliedRef.current = true // court-circuite l'auto-apply « dernière compta »
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, liaLines, accounts])

  const paymentAccounts = accounts.filter(a => ['Bank', 'Credit Card'].includes(a.AccountType))
  // Lignes qui portent leur propre compte de dépense (ventilation multi-comptes).
  const lineAccountCount = (receipt.items || []).filter(it => it?.expense_account_id).length
  const vendorOptions  = vendors.map(v => ({ value: v.Id, label: v.DisplayName }))
  const expenseOptions = expenseAccountOptions(accounts)
  // La devise est affichée pour les comptes non-CAD : QB refuse un Purchase dont le
  // compte de paiement n'est pas dans la devise de la transaction (fournisseur USD →
  // compte USD obligatoire) — le badge évite de choisir un compte incompatible.
  const paymentOptions = paymentAccounts.map(a => {
    const cur = a.CurrencyRef?.value
    return { value: a.Id, label: `${accountLabel(a)} (${a.AccountType}${cur && cur !== 'CAD' ? ` · ${cur}` : ''})` }
  })
  // Un crédit sur carte de crédit ne peut viser qu'un compte de type Carte de crédit
  // (même filtre que QB côté serveur) — on masque les comptes bancaires.
  const creditCardOptions = paymentAccounts
    .filter(a => a.AccountType === 'Credit Card')
    .map(a => {
      const cur = a.CurrencyRef?.value
      return { value: a.Id, label: `${accountLabel(a)}${cur && cur !== 'CAD' ? ` (${cur})` : ''}` }
    })
  // Dépôt bancaire : l'argent entre dans un compte bancaire et vient créditer
  // n'importe quel compte (revenu, crédit d'impôt à recevoir…).
  const isDeposit = type === 'deposit'
  const bankOptions = paymentOptions.filter(o => accounts.find(a => a.Id === o.value)?.AccountType === 'Bank')
  const depositCreditOptions = depositAccountOptions(accounts)
  const taxCodeOptions = [{ value: NO_TAX, label: '— Aucune taxe —' }, ...taxCodes.map(c => ({ value: c.Id, label: c.Name }))]
  const accountById = new Map(accounts.map(a => [a.Id, a]))
  const taxNameById = new Map(taxCodes.map(c => [c.Id, c.Name]))
  const taxIdByName = new Map(taxCodes.map(c => [c.Name, c.Id]))

  // ── Vérification du statut fiscal (live) ──────────────────────────────────────
  // Type de transaction « achat »/« both » en tête (la section comptabilise des
  // dépenses), ventes ensuite, avec un séparateur de libellé.
  const txTypeOptions = [...txTypes]
    .sort((a, b) => (a.side === 'vente' ? 1 : 0) - (b.side === 'vente' ? 1 : 0))
    .map(t => ({ value: t.key, label: t.side === 'vente' ? `Vente · ${t.label}` : t.label }))
  const selectedType = txTypes.find(t => t.key === transactionType) || null
  // Détection fiscale serveur (type + code probables, source, confiance, conflits).
  const detection = receipt.fiscal_detection || null
  const selectedTaxName = taxCodeId === NO_TAX ? null : (taxNameById.get(taxCodeId) || null)
  const fiscalOk = selectedType ? (!!selectedTaxName && selectedType.codes.includes(selectedTaxName)) : false
  // Id QB du code recommandé pour le bouton « Corriger » (null si absent du fichier QB).
  const recommendedCodeId = selectedType ? (taxIdByName.get(selectedType.recommendedCode) || null) : null

  // Clic sur « Publier » : on valide les champs, puis on publie. Si le statut fiscal
  // est conforme (fiscalOk), la publication part DIRECTEMENT — pas d'étape de
  // confirmation. En cas d'ÉCART fiscal, on ouvre la modale : c'est le seul endroit où
  // l'utilisateur peut corriger le code de taxe ou saisir une justification (le serveur
  // BLOQUE la publication sans forceReason — cf. services/fiscalStatus.js), donc on ne
  // peut pas la sauter.
  // ignoreStaleDate : l'utilisateur a lu l'avertissement de publication tardive et
  // confirmé (bouton « Publier quand même »). Passé en argument plutôt qu'en état pour
  // que la reprise soit immédiate, sans attendre un re-render.
  function handlePublish(ignoreStaleDate = false) {
    if (receipt.receipt_date) {
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const [y, m, d] = receipt.receipt_date.slice(0, 10).split('-').map(Number)
      const rDate = new Date(y, (m || 1) - 1, d || 1)
      const diffDays = Math.round((today - rDate) / 86400000)
      if (diffDays < 0) { fail('Impossible de publier une facture datée dans le futur.'); return }
      if (diffDays > 30 && !ignoreStaleDate) {
        fail(`Facture datée de plus de 30 jours dans le passé (${diffDays} jours) — vérifiez la date avant de publier.`)
        setStaleDays(diffDays)
        return
      }
    }
    if (isDeposit) {
      if (!expenseAccountId) { fail('Sélectionnez le compte à créditer', 'expense_account'); return }
      if (!paymentAccountId || !bankOptions.some(o => o.value === paymentAccountId)) { fail('Sélectionnez un compte bancaire', 'payment_account'); return }
      if (vendorMode === 'new' && !newVendorName.trim()) { fail('Entrez le nom du payeur', 'vendor'); return }
      fail(null)
      doPublish()
      return
    }
    if (!transactionType) { fail('Sélectionnez le type de transaction (statut fiscal)', 'transaction_type'); return }
    if (!expenseAccountId) { fail('Sélectionnez un compte de dépense', 'expense_account'); return }
    if (type === 'purchase' && !paymentAccountId) { fail('Sélectionnez un compte de paiement', 'payment_account'); return }
    if (type === 'cc_credit') {
      if (!paymentAccountId) { fail('Sélectionnez un compte de carte de crédit', 'payment_account'); return }
      if (!creditCardOptions.some(o => o.value === paymentAccountId)) { fail('Le compte sélectionné n\'est pas un compte de carte de crédit', 'payment_account'); return }
    }
    if (type === 'purchase' && bankChargedTotal.trim() !== '') {
      const bank = parseAmountInput(bankChargedTotal)
      if (bank == null || bank <= 0) { fail('Montant passé à la banque invalide', 'bank_charged_total'); return }
    }
    if (vendorMode === 'existing' && !vendorId) { fail('Sélectionnez un fournisseur', 'vendor'); return }
    if (vendorMode === 'new' && !newVendorName.trim()) { fail('Entrez le nom du fournisseur', 'vendor'); return }
    fail(null)
    if (fiscalOk) { doPublish(); return }
    setForceReason('')
    setShowConfirm(true)
  }

  // Étape 2 : publication effective. forceReason n'est transmis (et requis) que si le
  // code de taxe ne correspond pas au statut fiscal attendu — échappatoire tracée.
  // anomalyOverride : justification saisie après un blocage « doublon probable ».
  // Comme Dext : on quitte le document tout de suite, l'envoi continue en
  // arrière-plan et une notification dit « publié » ou l'erreur (avec « Ouvrir »).
  function doPublish(anomalyOverride = null) {
    const id = receipt.id
    const label = [receipt.company, receipt.total != null ? fmtCad(receipt.total) : null].filter(Boolean).join(' · ') || 'Reçu'
    const payload = {
      type,
      expenseAccountId,
      paymentAccountId: type !== 'bill' ? paymentAccountId : undefined,
      vendorId: vendorMode === 'existing' ? vendorId : undefined,
      newVendorName: vendorMode === 'new' ? newVendorName.trim() : undefined,
      dueDate: type === 'bill' && dueDate ? dueDate : undefined,
      taxCodeId: taxCodeId === NO_TAX ? null : taxCodeId,
      transactionType,
      forceReason: fiscalOk || isDeposit ? undefined : forceReason.trim(),
      bankChargedTotal: type === 'purchase' ? (parseAmountInput(bankChargedTotal) ?? undefined) : undefined,
      anomalyOverride: anomalyOverride || undefined,
    }
    publishing.add(id)
    publishErrors.delete(id)
    setSubmitting(true)
    fail(null)
    setShowConfirm(false)
    onLeave?.()
    api.saleReceipts.pushToQb(id, payload)
      .then(() => {
        addToast({ message: `Publié sur QuickBooks — ${label}`, type: 'success' })
      })
      .catch(e => {
        publishErrors.set(id, { message: e.message, field: e.details?.field || null })
        addToast({
          message: `Non publié — ${label} : ${e.message}`,
          type: 'error',
          duration: 0,
          action: { label: 'Ouvrir', onClick: () => navigate(`/sale-receipts/${id}`) },
        })
      })
      .finally(() => { publishing.delete(id); setSubmitting(false) })
  }

  // Changement du code de taxe DU DOCUMENT : met à jour la sélection locale (pour la
  // publication) ET persiste le code + recalcule les taxes du reçu en direct (chaque
  // ligne suit son code, ou ce code par défaut). La section Montants se met ainsi à jour
  // sans sélecteur séparé. NO_TAX (— Aucune taxe —) ⇒ pas de code document → taxes manuelles.
  // extraPatch : champs additionnels à persister dans le MÊME PATCH (ex. le type de
  // transaction quand sa sélection applique aussi le code recommandé) — évite deux
  // requêtes concurrentes dont les réponses pourraient se doubler.
  async function changeDocCode(val, extraPatch = null) {
    setTaxCodeId(val)
    const defaultCode = val === NO_TAX ? null : (val || null)
    const taxNameById = new Map(taxCodes.map(c => [c.Id, c.Name]))
    const patch = { tax_code_id: defaultCode, ...(extraPatch || {}) }
    if (defaultCode) Object.assign(patch, recomputeAmounts(receipt, receipt.items || [], defaultCode, taxNameById))
    try {
      const updated = await api.saleReceipts.update(receipt.id, patch)
      onUpdate?.(updated)
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
    }
  }

  // Sélection du type de transaction : applique AUTOMATIQUEMENT le code de taxe QB
  // recommandé pour ce type (fiscalStatus.recommendedCode → Détaxé, TPS/TVQ QC…),
  // via changeDocCode qui persiste le code et recalcule les taxes du reçu. Si le code
  // recommandé n'existe pas dans le fichier QB (taxIdByName vide), on laisse le code
  // courant — l'UI signale alors l'écart et propose « Corriger ».
  function changeTransactionType(key) {
    setTransactionType(key)
    const type = txTypes.find(t => t.key === key)
    // Le type choisi est persisté immédiatement (brouillon) — avec le code de taxe
    // recommandé dans le même PATCH quand la sélection en applique un.
    if (!type) { saveDraft({ transaction_type: key || null }); return }
    // Parmi les codes acceptés du type, celui qui colle aux montants du document
    // (« Achat local taxable » + TPS seule → « TPS ») ; sinon le recommandé générique.
    const codeId = taxIdByName.get(bestCodeForType(type, receipt.tps, receipt.tvq))
    if (codeId && codeId !== taxCodeId) changeDocCode(codeId, { transaction_type: key })
    else saveDraft({ transaction_type: key })
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-400 text-sm mt-3 py-2">
        <ThinkingOrb size={14} ink /> Chargement des comptes QuickBooks…
      </div>
    )
  }

  return (
    <div className="mt-3 border border-green-200 bg-green-50 rounded-xl p-3.5 space-y-3">
      {/* En-tête : titre du bloc + type d'écriture en segments. Le type occupait une
          ligne de champ entière (libellé à gauche + 3 radios à libellés longs) qui se
          cassait sur trois lignes dans la colonne étroite du panneau latéral. */}
      <div className="flex items-center justify-between gap-x-3 gap-y-2 flex-wrap">
        <h3 className="text-sm font-semibold text-green-800 flex items-center gap-1.5">
          <BookOpen size={14} /> Comptabiliser
        </h3>
        <div className="flex items-center gap-0.5 bg-white/70 border border-green-200 rounded-lg p-0.5">
          {QB_ENTRY_TYPES.map(t => (
            <label
              key={t.key}
              title={t.hint}
              className={`flex items-center gap-1.5 text-xs cursor-pointer rounded-md px-2 py-1 transition-colors ${
                type === t.key ? 'bg-white ring-1 ring-green-400 text-green-900 font-medium' : 'text-slate-500 hover:bg-white/70'
              }`}
            >
              <input
                type="radio"
                data-testid={t.testId}
                className="accent-green-700"
                checked={type === t.key}
                onChange={() => touchAndDraft(setType, 'quickbooks_type')(t.key)}
              />
              {t.label}
            </label>
          ))}
        </div>
      </div>

      {/* VU AU RELEVÉ : le jour où l'argent est sorti. C'est cette date qui sera
          comptabilisée (et non celle imprimée sur la facture), et c'est ce compte
          qui a payé. */}
      {receipt.bank_txn && (
        <p data-testid="qb-bank-note" className="text-[11px] text-brand-700 bg-brand-50 border border-brand-100 rounded px-2 py-1 leading-snug">
          Passé au compte {receipt.bank_txn.account_name} le <strong>{fmtDate(receipt.bank_txn.txn_date)}</strong>
          {' — '}c'est cette date qui sera comptabilisée{type === 'purchase' && Number(receipt.bank_txn.amount) < 0 ? ', en dépense' : ''}
          {(receipt.bank_txn.currency || 'CAD').toUpperCase() !== (receipt.currency || 'CAD').toUpperCase()
            ? `, et ${fmtMoney(Math.abs(receipt.bank_txn.amount), receipt.bank_txn.currency)} a été débité.`
            : '.'}
        </p>
      )}
      {profileApplied && (
        <p data-testid="qb-profile-note" className="text-[11px] text-brand-700 bg-brand-50 border border-brand-100 rounded px-2 py-1 leading-snug">
          Pré-rempli depuis le <Link to="/fournisseurs" className="underline font-medium">profil fournisseur</Link>
          {receipt.vendor_profile?.name ? ` « ${receipt.vendor_profile.name} »` : ''}
          {(receipt.currency || 'CAD').toUpperCase() === 'USD' ? ' (défauts USD)' : ''}.
        </p>
      )}
      {autoAppliedFrom && !userTouchedRef.current && (
        <p data-testid="qb-prefill-note" className="text-[11px] text-brand-700 bg-brand-50 border border-brand-100 rounded px-2 py-1 leading-snug">
          Pré-rempli depuis la dernière compta de ce fournisseur{autoAppliedFrom.receipt_date ? ` — ${fmtDate(autoAppliedFrom.receipt_date)}` : ''}.
        </p>
      )}

      {/* ⚠ Chaque champ n'a que DEUX enfants : le libellé, puis UN conteneur qui porte
          le contrôle ET ses notes. En panneau latéral, `index.css` met le libellé dans
          une colonne de 140 px et la valeur dans l'autre : un 3e enfant (une note)
          retombait dans la colonne du libellé et s'affichait sur 140 px de large. */}
      <div className="grid grid-cols-1 gap-3">
        <div className={fieldFrame('vendor')}>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">{isDeposit ? 'Payeur' : 'Fournisseur'}</label>
          {/* « Existant / Nouveau » tenait une ligne de radios au-dessus du champ ;
              c'est maintenant une bascule posée à côté du champ lui-même. */}
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              {vendorMode === 'existing' ? (
                <SearchableSelect
                  testId="qb-vendor-select"
                  value={vendorId}
                  options={vendorOptions}
                  onChange={v => { setVendorId(v); saveDraft({ vendor_id: v || null }) }}
                />
              ) : (
                <input type="text" value={newVendorName} onChange={e => setNewVendorName(e.target.value)} className="input-field text-xs w-full" />
              )}
            </div>
            <button
              type="button"
              data-testid="qb-vendor-mode-toggle"
              onClick={() => setVendorMode(m => (m === 'existing' ? 'new' : 'existing'))}
              className="shrink-0 text-[11px] text-slate-400 hover:text-brand-600 underline decoration-dotted"
              title={vendorMode === 'existing' ? 'Créer un fournisseur qui n’existe pas encore dans QuickBooks' : 'Choisir un fournisseur existant'}
            >
              {vendorMode === 'existing' ? 'Nouveau' : 'Existant'}
            </button>
          </div>
        </div>

        <div className={fieldFrame('expense_account')}>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">{isDeposit ? 'Compte crédité' : 'Compte de dépense'}</label>
          <div>
          <SearchableSelect
            testId="qb-expense-select"
            value={expenseAccountId}
            options={isDeposit ? depositCreditOptions : expenseOptions}
            onChange={touchAndDraft(setExpenseAccountId, 'expense_account_id')}
          />
          {!isDeposit && partsApplied && !userTouchedRef.current && (
            <p data-testid="qb-parts-account-note" className="text-[11px] text-brand-700 bg-brand-50 border border-brand-100 rounded px-2 py-1 mt-1.5 leading-snug">
              Compte de <strong>pièces</strong> appliqué automatiquement : des lignes sont rattachées à des achats LIA (entrée au stock).
            </p>
          )}
          {/* Exceptions par ligne (section Articles) : ce compte ne s'applique alors
              qu'aux lignes sans compte propre — visible ici pour éviter la surprise
              au moment de publier. */}
          {!isDeposit && lineAccountCount > 0 && (
            <p data-testid="qb-line-accounts-note" className="text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded px-2 py-1 mt-1.5 leading-snug">
              {lineAccountCount === 1 ? '1 ligne d’article a' : `${lineAccountCount} lignes d’articles ont`} leur
              <strong> propre compte de dépense</strong> (section Articles) — ce compte-ci s’applique aux autres lignes.
            </p>
          )}
          </div>
        </div>

        {type !== 'bill' ? (
          <div className={fieldFrame('payment_account')}>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">
              {type === 'cc_credit' ? 'Compte de carte de crédit' : isDeposit ? 'Compte bancaire' : 'Compte de paiement'}
            </label>
            <div>
            <SearchableSelect
              testId="qb-payment-select"
              value={paymentAccountId}
              options={type === 'cc_credit' ? creditCardOptions : isDeposit ? bankOptions : paymentOptions}
              onChange={touchAndDraft(setPaymentAccountId, 'payment_account_id')}
            />
            {!isDeposit && receipt.card_match && (
              <p className="text-[11px] text-slate-500 mt-1.5 leading-snug" data-testid="qb-card-match">
                Carte ••{receipt.card_match.last4} — {receipt.card_match.holder}
                {receipt.card_match.ownership === 'personal' ? ' (à rembourser)' : ''}
              </p>
            )}
            {type === 'cc_credit' && (
              <p className="text-[11px] text-slate-500 mt-1.5 leading-snug">
                Le montant sera crédité (remboursé) sur ce compte de carte de crédit — saisissez les montants du reçu en positif.
              </p>
            )}
            {type === 'purchase' && (
              <div className={`mt-3 ${fieldFrame('bank_charged_total')}`}>
                {!bankFieldOpen ? (
                  <button
                    type="button"
                    data-testid="qb-bank-charged-toggle"
                    onClick={() => setBankFieldOpen(true)}
                    className="text-[11px] text-slate-400 hover:text-brand-600 underline decoration-dotted"
                  >
                    Montant débité différent du total de la facture ?
                  </button>
                ) : (
                  <>
                    <label className="text-[11px] text-slate-500 block mb-1.5">
                      Montant passé à la banque
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      data-testid="qb-bank-charged"
                      value={bankChargedTotal}
                      onChange={e => setBankChargedTotal(e.target.value)}
                      onBlur={() => {
                        // Autosave brouillon au blur (pas à chaque frappe — saisie partielle).
                        const v = parseAmountInput(bankChargedTotal)
                        if (bankChargedTotal.trim() !== '' && v === null) return
                        if (v !== null && v < 0) return
                        if (v === (receipt.bank_charged_total ?? null)) return
                        saveDraft({ bank_charged_total: v })
                      }}
                      placeholder={receipt.total != null ? Number(receipt.total).toFixed(2) : ''}
                      className="input-field text-xs w-full"
                    />
                    {(() => {
                      // Aperçu de l'écart : seulement quand la devise du reçu est celle de la
                      // transaction (fournisseur QB) — sinon le serveur convertit d'abord et
                      // l'écart exact est calculé là-bas.
                      const bank = parseAmountInput(bankChargedTotal)
                      const vendorCur = vendorMode === 'existing'
                        ? ((vendors.find(v => v.Id === vendorId)?.CurrencyRef?.value) || 'CAD').toUpperCase()
                        : (receipt.currency || 'CAD').toUpperCase()
                      const sameCur = vendorCur === (receipt.currency || 'CAD').toUpperCase()
                      // Facture USD, fournisseur CAD : le débit sert de taux de
                      // conversion — chaque montant est converti, aucun frais ajouté.
                      if (!sameCur) {
                        return (
                          <p className="text-[11px] text-slate-400 mt-1.5 leading-snug" data-testid="qb-bank-charged-hint">
                            Converti en {vendorCur} au taux du débit, sans frais.
                          </p>
                        )
                      }
                      if (bank == null || bank <= 0 || receipt.total == null) {
                        return (
                          <p className="text-[11px] text-slate-400 mt-1.5 leading-snug">
                            L'écart sera ajouté comme article « Frais de conversion » (Exonéré).
                          </p>
                        )
                      }
                      const fee = Math.round((bank - Number(receipt.total)) * 100) / 100
                      if (fee === 0) {
                        return (
                          <p className="text-[11px] text-slate-400 mt-1.5 leading-snug" data-testid="qb-bank-charged-hint">
                            Identique au total — aucun frais ajouté.
                          </p>
                        )
                      }
                      return (
                        <p className="text-[11px] text-brand-700 bg-brand-50 border border-brand-100 rounded px-2 py-1 mt-1.5 leading-snug" data-testid="qb-bank-charged-hint">
                          Écart de <strong>{fee > 0 ? '+' : ''}{fee.toFixed(2)} {(receipt.currency || 'CAD').toUpperCase()}</strong> — voir
                          l'article « Frais de conversion » ajouté ci-dessous.
                        </p>
                      )
                    })()}
                  </>
                )}
              </div>
            )}
            {/* Aiguillage : une facture libellée en devise étrangère ne se règle PAS
                avec le champ ci-dessus (qui ajoute des frais) mais par une conversion
                de tous les montants — d'où le raccourci vers le calculateur. */}
            {!isDeposit && (receipt.currency || 'CAD').toUpperCase() !== 'CAD' && (
              <button
                type="button"
                onClick={onOpenConversion}
                data-testid="qb-open-currency-conversion"
                className="mt-3 text-[11px] text-slate-400 hover:text-brand-600 underline decoration-dotted"
              >
                Facture en {(receipt.currency || '').toUpperCase()} à comptabiliser en CAD ? Convertir les montants
              </button>
            )}
            </div>
          </div>
        ) : (
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Échéance</label>
            <div>
            <input
              type="date"
              value={dueDate}
              onChange={e => {
                const v = e.target.value
                setDueDate(v)
                // Autosave : l'échéance (extraite ou corrigée) est persistée sur le reçu.
                api.saleReceipts.update(receipt.id, { due_date: v || null }).then(u => onUpdate?.(u)).catch(() => {})
              }}
              className="input-field text-xs w-full"
            />
            {receipt.payment_terms_days > 0 && (
              <p className="text-[11px] text-slate-500 mt-1 leading-snug">
                Termes détectés sur la facture : <strong>Net {receipt.payment_terms_days} jours</strong>.
              </p>
            )}
            <p className="text-[11px] text-slate-500 mt-1.5 leading-snug">
              Le crédit est posté automatiquement au compte <strong>Comptes fournisseurs</strong> du vendor — aucun compte de paiement à choisir.
            </p>
            </div>
          </div>
        )}

        {!isDeposit && <>
        <div className={fieldFrame('transaction_type')}>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">
            Type de transaction <span className="text-red-500">*</span>
          </label>
          <div>
          <SearchableSelect
            testId="qb-txtype-select"
            value={transactionType}
            options={txTypeOptions}
            onChange={changeTransactionType}
          />
          {!transactionType && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1.5 leading-snug" data-testid="qb-txtype-missing">
              Obligatoire — détermine le statut fiscal et le code de taxe attendu.
            </p>
          )}
          {/* Détection fiscale serveur (fiscalDetection.js) : type + code probables,
              signal gagnant et niveau de confiance ; les signaux écartés parce qu'ils
              contredisent les montants du document sont affichés comme conflits.
              Une seule boîte affichée : la détection quand elle concorde avec le type
              sélectionné (ou qu'aucun type n'est encore choisi), sinon le statut fiscal
              attendu pour le type choisi manuellement. */}
          {detection?.transaction_type && !receipt.quickbooks_id && (!selectedType || detection.transaction_type === transactionType) ? (
            <div className="text-[11px] mt-1.5 leading-snug bg-slate-50 border border-slate-200 rounded px-2 py-1.5 flex items-start gap-1.5" data-testid="fiscal-detection">
              <Sparkles size={11} className="text-brand-600 shrink-0 mt-0.5" />
              <span className="min-w-0">
                <span className="text-slate-500">Détection : </span>
                <strong className="text-slate-700">{detection.type_label}</strong>
                {detection.tax_code_name && <span className="text-slate-500"> → « {detection.tax_code_name} »</span>}
                <span className="text-slate-400"> · {detection.source_label}</span>
                <span className={`ml-1 px-1.5 py-px rounded-full font-medium ${
                  detection.confidence === 'haute' ? 'bg-green-100 text-green-700'
                    : detection.confidence === 'moyenne' ? 'bg-amber-100 text-amber-700'
                    : 'bg-slate-200 text-slate-600'
                }`}>confiance {detection.confidence}</span>
              </span>
            </div>
          ) : selectedType && (
            <div className="text-[11px] mt-1.5 leading-snug bg-white border border-slate-200 rounded px-2 py-1.5" data-testid="qb-fiscal-expected">
              <span className="text-slate-500">Statut fiscal attendu : </span>
              <strong className="text-slate-700">{selectedType.statusLabel}</strong>
              <span className="text-slate-500"> → code QuickBooks </span>
              <strong className="text-slate-700">« {selectedType.recommendedCode} »</strong>
              {selectedType.note && <span className="block text-slate-400 mt-0.5">{selectedType.note}</span>}
            </div>
          )}
          {!detection?.transaction_type && (detection?.conflicts?.length || 0) > 0 && !receipt.quickbooks_id && (
            <p className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded px-2 py-1 mt-1.5 leading-snug" data-testid="fiscal-detection-none">
              Aucun type détecté de façon fiable ({detection.signature?.label}) — choisissez manuellement.
            </p>
          )}
          {!receipt.quickbooks_id && (detection?.conflicts || []).map((c, i) => (
            <p key={`c${i}`} className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1.5 leading-snug flex items-start gap-1" data-testid="fiscal-detection-conflict">
              <AlertCircle size={11} className="shrink-0 mt-0.5" /> <span>{c.message}</span>
            </p>
          ))}
          {!receipt.quickbooks_id && (detection?.warnings || []).map((w, i) => (
            <p key={`w${i}`} className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1.5 leading-snug flex items-start gap-1" data-testid="fiscal-detection-warning">
              <AlertCircle size={11} className="shrink-0 mt-0.5" /> <span>{w}</span>
            </p>
          ))}
          </div>
        </div>

        <div className={fieldFrame('tax_code')}>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Code de taxe</label>
          <div>
          <SearchableSelect
            testId="qb-taxcode-select"
            value={taxCodeId}
            options={taxCodeOptions}
            onChange={changeDocCode}
          />
          {selectedType ? (
            fiscalOk ? (
              <p className="text-[11px] text-green-700 bg-green-100 rounded px-2 py-1 mt-1.5 leading-snug flex items-center gap-1" data-testid="qb-fiscal-ok">
                <CheckCircle size={11} /> Conforme au statut fiscal « {selectedType.statusLabel} ».
              </p>
            ) : (
              <p className="text-[11px] text-red-700 bg-red-100 rounded px-2 py-1 mt-1.5 leading-snug flex items-center gap-1" data-testid="qb-fiscal-mismatch">
                <AlertCircle size={11} /> Écart : « {selectedType.label} » attend « {selectedType.recommendedCode} », pas « {selectedTaxName || 'Aucune taxe'} ».
              </p>
            )
          ) : (
            <p className="text-[11px] text-slate-500 mt-1.5 leading-snug">
              Présélectionné d'après les montants TPS/TVQ — changez-le au besoin.
            </p>
          )}
          </div>
        </div>
        </>}
      </div>

      {/* Publication : erreurs et bouton vivent dans la bande épinglée au bas du
          panneau — l'action reste sous la main même en bas de la fiche, et un
          échec s'affiche là où l'on vient de cliquer. */}
      <PeekFooter>
      <div className="border-t border-green-200 bg-white/95 backdrop-blur px-5 py-3 space-y-2 shadow-[0_-10px_28px_-20px_rgba(15,23,42,0.45)]">
      {error && (
        <div className="text-xs text-red-600 bg-red-100 rounded-lg px-3 py-2" data-testid="qb-publish-error">
          <p>{error}</p>
          {staleDays != null && (
            <button
              type="button"
              data-testid="qb-publish-stale-override"
              onClick={() => handlePublish(true)}
              disabled={submitting}
              className="mt-1.5 inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-red-700 bg-white border border-red-300 rounded hover:bg-red-50 transition-colors disabled:opacity-50"
            >
              <BookOpen size={11} /> Publier quand même
            </button>
          )}
          {anomalyBlocked && (
            <div className="mt-2 space-y-1.5" data-testid="qb-anomaly-override">
              <input
                type="text"
                value={anomalyReason}
                onChange={e => setAnomalyReason(e.target.value)}
                data-testid="qb-anomaly-reason"
                className="input-field text-[11px] w-full bg-white"
              />
              <button
                type="button"
                data-testid="qb-anomaly-override-publish"
                onClick={() => doPublish(anomalyReason.trim() || 'Doublon vérifié par l\'opérateur — publication confirmée')}
                disabled={submitting}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-red-700 bg-white border border-red-300 rounded hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                <BookOpen size={11} /> Publier quand même
              </button>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        data-testid="qb-publish-open"
        onClick={() => handlePublish()}
        disabled={submitting}
        className="group w-full inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white bg-gradient-to-b from-brand-500 to-brand-600 ring-1 ring-inset ring-white/25 shadow-lg shadow-brand-700/25 transition-all duration-150 hover:from-brand-400 hover:to-brand-500 hover:shadow-brand-700/35 hover:-translate-y-px active:translate-y-0 active:scale-[0.985] active:shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-400 focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:active:scale-100"
      >
        {submitting
          ? <ThinkingOrb size={15} ink />
          : <BookOpen size={15} className="transition-transform duration-150 group-active:scale-90" />}
        {submitting ? 'Publication…' : 'Publier sur QuickBooks'}
      </button>
      </div>
      </PeekFooter>

      {vendorHistory.length > 0 && (
        <div className="border-t border-green-200 pt-2" data-testid="vendor-history">
          <button
            type="button"
            onClick={() => setShowHistory(v => !v)}
            data-testid="vendor-history-toggle"
            className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600 transition-colors"
          >
            <ChevronRight size={11} className={`transition-transform ${showHistory ? 'rotate-90' : ''}`} />
            Comptabilisations passées de « {receipt.company} » ({vendorHistory.length}) — modèles à réutiliser
          </button>
          {showHistory && (<>
          <ul className="space-y-1.5 mt-2">
            {vendorHistory.map(txn => {
              const acc = txn.expense_account_id ? accountById.get(txn.expense_account_id) : null
              const taxName = txn.tax_code_id ? taxNameById.get(txn.tax_code_id) : null
              return (
                <li key={txn.id} className="flex items-center gap-2 text-xs bg-white border border-slate-200 rounded-lg px-2.5 py-1.5">
                  <span className="text-slate-500 w-24 shrink-0">{txn.receipt_date ? fmtDate(txn.receipt_date) : '—'}</span>
                  <span className="tabular-nums font-medium text-slate-700 w-20 shrink-0 text-right">{fmtCad(txn.total)}</span>
                  <span className={`shrink-0 px-1.5 py-0.5 rounded-full ${txn.quickbooks_type === 'bill' ? 'bg-purple-100 text-purple-700' : txn.quickbooks_type === 'cc_credit' || txn.quickbooks_type === 'deposit' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}`}>
                    {txn.quickbooks_type === 'bill' ? 'Facture' : txn.quickbooks_type === 'cc_credit' ? 'Crédit CC' : txn.quickbooks_type === 'deposit' ? 'Dépôt' : 'Dépense'}
                  </span>
                  <span className="text-slate-500 truncate flex-1 min-w-0" title={acc ? accountLabel(acc) : ''}>
                    {acc ? accountLabel(acc) : <span className="text-slate-300">compte non enregistré</span>}
                    {taxName && <span className="text-slate-400"> · {taxName}</span>}
                  </span>
                  {txn.quickbooks_url && (
                    <a href={txn.quickbooks_url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-green-700 hover:text-green-800" title="Voir dans QuickBooks">
                      <BookOpen size={12} />
                    </a>
                  )}
                  <Link to={`/sale-receipts/${txn.id}`} className="shrink-0 text-slate-400 hover:text-slate-600" title="Ouvrir le reçu">
                    <ReceiptText size={12} />
                  </Link>
                  {acc && (
                    <button
                      type="button"
                      onClick={() => { userTouchedRef.current = true; applyAccountingFields(txn, { withTax: true }) }}
                      data-testid="use-template"
                      className="shrink-0 text-[11px] font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded px-2 py-0.5"
                    >
                      Utiliser
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="text-[11px] text-slate-400 mt-1.5">« Utiliser » copie le type, le compte de dépense et le code de taxe dans le formulaire ci-dessus.</p>
          </>)}
        </div>
      )}

      <Modal isOpen={showConfirm} onClose={() => !submitting && setShowConfirm(false)} title="Confirmer la publication sur QuickBooks" size="lg">
        <div className="space-y-4 text-sm" data-testid="qb-confirm-modal">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Ce qui va se passer</p>
            <ul className="space-y-1.5 text-slate-700 text-[13px]">
              <li className="flex gap-2"><span className="text-slate-400">•</span>
                {type === 'bill'
                  ? <span>Une <strong>facture fournisseur (Bill)</strong> sera créée dans QuickBooks (compte fournisseurs).</span>
                  : type === 'cc_credit'
                    ? <span>Un <strong>crédit sur carte de crédit (Credit Card Credit)</strong> sera enregistré dans QuickBooks — le montant réduit le solde de la carte.</span>
                    : <span>Une <strong>dépense (Purchase)</strong> sera enregistrée dans QuickBooks.</span>}
              </li>
              {vendorMode === 'new' && newVendorName.trim() && (
                <li className="flex gap-2"><span className="text-slate-400">•</span>
                  <span>Un <strong>nouveau fournisseur</strong> « {newVendorName.trim()} » sera créé dans QuickBooks.</span></li>
              )}
              <li className="flex gap-2"><span className="text-slate-400">•</span>
                <span>Montant : <strong className="tabular-nums">{fmtCad(receipt.total)}</strong>{receipt.currency && receipt.currency !== 'CAD' ? ` (${receipt.currency})` : ''}.</span></li>
              <li className="flex gap-2"><span className="text-slate-400">•</span>
                <span>La <strong>pièce justificative</strong> (image/PDF) sera jointe à la transaction.</span></li>
            </ul>
          </div>

          <div className="border-t border-slate-200 pt-3">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Vérification du statut fiscal</p>
            <div className="text-[13px] text-slate-700 space-y-0.5">
              <div>Type : <strong>{selectedType?.label || '—'}</strong></div>
              <div>Statut attendu : <strong>{selectedType?.statusLabel || '—'}</strong> → code QuickBooks <strong>« {selectedType?.recommendedCode || '—'} »</strong></div>
              <div>Code sélectionné : <strong>« {selectedTaxName || 'Aucune taxe'} »</strong></div>
            </div>

            {fiscalOk ? (
              <p className="text-[13px] text-green-700 bg-green-100 rounded-lg px-3 py-2 mt-2 flex items-center gap-1.5" data-testid="qb-confirm-fiscal-ok">
                <CheckCircle size={14} /> Le code de taxe correspond au statut fiscal attendu.
              </p>
            ) : (
              <div className="mt-2 space-y-2" data-testid="qb-confirm-fiscal-mismatch">
                <p className="text-[13px] text-red-700 bg-red-100 rounded-lg px-3 py-2 flex items-start gap-1.5">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  <span>Écart : ce type de transaction attend <strong>« {selectedType?.recommendedCode} »</strong>, mais le code sélectionné est <strong>« {selectedTaxName || 'Aucune taxe'} »</strong>. Corrigez le code, ou justifiez pour forcer la publication.</span>
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="qb-fiscal-correct"
                    disabled={!recommendedCodeId}
                    onClick={() => { if (recommendedCodeId) changeDocCode(recommendedCodeId) }}
                    className="text-xs font-medium text-green-700 bg-green-50 hover:bg-green-100 border border-green-300 rounded px-2.5 py-1 disabled:opacity-50"
                  >
                    Corriger → utiliser « {selectedType?.recommendedCode} »
                  </button>
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Justification pour forcer (obligatoire)</label>
                  <textarea
                    data-testid="qb-force-reason"
                    value={forceReason}
                    onChange={e => setForceReason(e.target.value)}
                    rows={2}
                    className="input-field text-xs w-full"
                  />
                </div>
              </div>
            )}
          </div>

          {error && <p className="text-xs text-red-600 bg-red-100 rounded-lg px-3 py-2">{error}</p>}

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
            <button type="button" className="btn-secondary text-xs py-1.5 px-3" onClick={() => setShowConfirm(false)} disabled={submitting}>Annuler</button>
            <button
              type="button"
              data-testid="qb-confirm-publish"
              className="btn-primary text-xs py-1.5 px-3"
              disabled={submitting || (!fiscalOk && !forceReason.trim())}
              onClick={() => doPublish()}
            >
              {submitting ? <><ThinkingOrb size={12} ink /> Publication…</> : <><BookOpen size={12} /> {fiscalOk ? 'Confirmer et publier' : 'Forcer la publication'}</>}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function CurrencyField({ receipt, onUpdate }) {
  const { addToast } = useToast()
  const [value, setValue] = useState(receipt.currency || '')
  const [saving, setSaving] = useState(false)

  useEffect(() => { setValue(receipt.currency || '') }, [receipt.id, receipt.currency])

  async function commit(next) {
    const normalized = (next || '').trim().toUpperCase() || null
    if (normalized === (receipt.currency || null)) return
    setSaving(true)
    try {
      const updated = await api.saleReceipts.update(receipt.id, { currency: normalized })
      onUpdate?.(updated)
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      setValue(receipt.currency || '')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 mt-0.5">
        <select
          className="input-field text-sm py-1 px-2"
          data-testid="receipt-currency"
          value={value}
          onChange={e => { setValue(e.target.value); commit(e.target.value) }}
          disabled={saving}
        >
          <option value="">—</option>
          <option value="CAD">CAD</option>
          <option value="USD">USD</option>
          <option value="EUR">EUR</option>
        </select>
        {saving && <ThinkingOrb size={12} ink className="text-slate-400" />}
      </div>
      {/* Les montants du dossier ont été convertis : ils ne sont plus ceux du document.
          Remettre ici la devise de la facture ferait reconvertir à la publication — la
          publication le refuse, et on le dit avant d'en arriver là. */}
      {receipt.fx_converted_to && (
        receipt.fx_converted_to !== (receipt.currency || '').toUpperCase() ? (
          <p className="mt-1 text-[11px] text-red-700" data-testid="receipt-fx-mismatch">
            Montants convertis en {receipt.fx_converted_to} — remettez la devise à {receipt.fx_converted_to}.
          </p>
        ) : (
          <p className="mt-1 text-[11px] text-slate-400">
            Montants convertis de {receipt.fx_converted_from} @ {receipt.fx_rate}
          </p>
        )
      )}
    </>
  )
}

function InfoField({ value }) {
  return (
    <>
      <p className="text-sm text-slate-700 mt-0.5">{value || <span className="text-slate-300">—</span>}</p>
    </>
  )
}

function EditableDateField({ receipt, field, onUpdate, testId }) {
  const { addToast } = useToast()
  // Normalise vers YYYY-MM-DD pour l'input type=date (la valeur peut arriver en ISO complet).
  const toDateInput = v => (v ? String(v).slice(0, 10) : '')
  // Affichage lisible (« 31 déc. 2025 ») par défaut ; on bascule sur l'input type=date
  // — qui, lui, rend l'ISO YYYY-MM-DD natif du navigateur — uniquement à l'édition.
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(toDateInput(receipt[field]))
  const [saving, setSaving] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => { setValue(toDateInput(receipt[field])) }, [receipt.id, receipt[field], field])
  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])

  async function commit(next) {
    const normalized = next || null
    if (normalized === (toDateInput(receipt[field]) || null)) return
    setSaving(true)
    try {
      const updated = await api.saleReceipts.update(receipt.id, { [field]: normalized })
      onUpdate?.(updated)
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      setValue(toDateInput(receipt[field]))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-1 mt-0.5">
        {editing ? (
          <input
            ref={inputRef}
            type="date"
            data-testid={testId}
            value={value}
            onChange={e => { setValue(e.target.value); commit(e.target.value) }}
            onBlur={() => setEditing(false)}
            disabled={saving}
            className="text-sm text-slate-700 bg-transparent border border-transparent hover:border-slate-300 focus:border-brand-500 focus:bg-white rounded px-2 py-0.5 -ml-2 outline-none"
          />
        ) : (
          <button
            type="button"
            data-testid={testId ? `${testId}-display` : undefined}
            onClick={() => setEditing(true)}
            className="text-sm text-slate-700 hover:bg-slate-100 rounded px-2 py-0.5 -ml-2 text-left outline-none"
          >
            {receipt[field] ? fmtDate(receipt[field]) : <span className="text-slate-300">—</span>}
          </button>
        )}
        {saving && <ThinkingOrb size={11} ink className="text-slate-400 flex-shrink-0" />}
      </div>
    </>
  )
}

function EditableTextField({ receipt, field, onUpdate, testId }) {
  const { addToast } = useToast()
  const [value, setValue] = useState(receipt[field] || '')
  const [saving, setSaving] = useState(false)

  useEffect(() => { setValue(receipt[field] || '') }, [receipt.id, receipt[field], field])

  async function commit() {
    const normalized = value.trim() || null
    if (normalized === (receipt[field] || null)) return
    setSaving(true)
    try {
      const updated = await api.saleReceipts.update(receipt.id, { [field]: normalized })
      onUpdate?.(updated)
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      setValue(receipt[field] || '')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-1 mt-0.5">
        <input
          type="text"
          data-testid={testId}
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
          disabled={saving}
          className="w-full text-sm text-slate-700 bg-transparent border border-transparent hover:border-slate-300 focus:border-brand-500 focus:bg-white rounded px-2 py-0.5 -ml-2 outline-none"
        />
        {saving && <ThinkingOrb size={11} ink className="text-slate-400 flex-shrink-0" />}
      </div>
    </>
  )
}

function EditableMemoField({ receipt, onUpdate }) {
  const { addToast } = useToast()
  const [desc, setDesc] = useState(receipt.general_description || '')
  const [savingDesc, setSavingDesc] = useState(false)

  useEffect(() => { setDesc(receipt.general_description || '') }, [receipt.id, receipt.general_description])

  async function commitField(field, value, current, setSaving, reset) {
    const normalized = value.trim() || null
    if (normalized === (current || null)) return
    setSaving(true)
    try {
      const updated = await api.saleReceipts.update(receipt.id, { [field]: normalized })
      onUpdate?.(updated)
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      reset()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-sm font-semibold text-slate-700">Description principale</h3>
          {savingDesc && <ThinkingOrb size={11} ink className="text-slate-400" />}
        </div>
        <input
          data-testid="receipt-general-description"
          type="text"
          value={desc}
          onChange={e => setDesc(e.target.value)}
          onBlur={() => commitField('general_description', desc, receipt.general_description, setSavingDesc, () => setDesc(receipt.general_description || ''))}
          disabled={savingDesc}
          className="w-full text-sm text-slate-700 bg-white border border-slate-300 hover:border-slate-400 focus:border-brand-500 rounded px-3 py-2 outline-none placeholder:text-slate-300"
        />
      </div>

    </div>
  )
}

// Cellule « Achat LIA » d'une ligne d'article : sélecteur recherchable des achats du
// fournisseur, lien vers la fiche de l'achat rattaché, et — quand l'appariement
// automatique n'était pas assez sûr pour écrire la description — la suggestion à
// accepter d'un clic. Un achat déjà facturé ailleurs (dépôt + solde, facture partielle)
// reste sélectionnable mais est signalé.
// Résumé compact de l'achat — nom, quantité, prix unitaire, date, fournisseur — pour
// vérifier la suggestion sans aller consulter Airtable. Même contenu que le tooltip
// (title) et affiché en dessous, tenu court par la règle « le moins de texte possible ».
function liaPurchaseSummary(p) {
  if (!p) return ''
  const bits = []
  if (p.qty_ordered) bits.push(`${p.qty_ordered} u.`)
  // Le coût unitaire d'Airtable est une MOYENNE sur les achats de la pièce : il ne
  // retombe presque jamais sur le prix facturé. Annoncé comme tel, il informe sans
  // inviter à une comparaison qui n'a pas de sens.
  if (p.unit_cost) bits.push(`~${fmtCad(Number(p.unit_cost))}/u`)
  if (p.order_date) bits.push(fmtDate(p.order_date))
  if (p.supplier) bits.push(p.supplier)
  return bits.join(' · ')
}

function numOrNull(v) {
  const n = Number(v)
  return v != null && v !== '' && Number.isFinite(n) ? n : null
}

// Quantités : elles doivent concorder EXACTEMENT (une unité d'écart est déjà un
// signal). null si l'une des deux manque — rien à comparer, pas d'alerte.
function liaMismatch(a, b) {
  if (a == null || b == null) return null
  return a !== b
}

// Normalisation légère (accents/casse/ponctuation) pour comparer deux libellés sans
// dépendance serveur — repli quand le verdict d'identité du serveur n'est pas
// disponible (achat hors des candidats renvoyés).
function normalizeLiaText(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// true = vraiment différent (aucun mot significatif commun), false = ok, null = rien à comparer.
function nameLooksOff(invName, atName) {
  const a = normalizeLiaText(invName), b = normalizeLiaText(atName)
  if (!a || !b) return null
  if (a.includes(b) || b.includes(a)) return false
  const wordsA = a.split(' ').filter(w => w.length >= 3)
  const wordsB = new Set(b.split(' ').filter(w => w.length >= 3))
  if (!wordsA.length || !wordsB.size) return null
  return !wordsA.some(w => wordsB.has(w))
}

// Concordance entre la ligne de facture et l'achat Airtable.
//
// CE QUI NE SE COMPARE PAS : le prix unitaire. Airtable porte un coût MOYEN sur les
// achats de la pièce, la facture porte le prix du jour — ils diffèrent presque toujours,
// et l'écart affiché n'était que du bruit. Le nom non plus ne se compare pas
// littéralement : le fournisseur emploie son propre vocabulaire, jamais le nom Orisha
// de la pièce.
//
// CE QUI IDENTIFIE VRAIMENT la pièce, c'est le verdict du serveur (purchaseLiaMatch.js,
// champ `identity`) : référence fabricant / n° de catalogue imprimé sur la facture, SKU,
// ou libellé DÉJÀ EMPLOYÉ par ce fournisseur pour cette pièce sur une facture passée
// (vocabulaire appris). Reste comparable côté chiffres : la quantité.
const IDENTITY_TEXT = {
  ref: ({ label }) => `réf. ${label} sur la facture`,
  sku: ({ label }) => `SKU ${label} sur la facture`,
  alias: () => 'libellé déjà vu chez ce fournisseur',
  name: () => 'nom concordant',
  qty: () => 'seule commande à cette quantité',
}

function LiaCompare({ item, purchase, identity }) {
  if (!purchase) return null
  const invQty = numOrNull(item.quantity)
  const atQty = numOrNull(purchase.qty_ordered)
  // Le libellé IMPRIMÉ par le fournisseur : après rattachement, `description` est
  // devenue « LIA-xxxx⇥Nom de la pièce », le libellé d'origine vit dans
  // `source_description`. C'est lui qu'il faut montrer et confronter.
  const invName = item.source_description || item.description || ''
  const atName = purchase.part_name || purchase.part_name_en || ''
  const qtyOff = liaMismatch(invQty, atQty)
  // Verdict du serveur si disponible ; sinon repli sur une comparaison de texte (achat
  // hors des candidats renvoyés : autre fournisseur, achat archivé).
  const kind = identity?.kind || null
  const nameOff = kind ? kind === 'none' : nameLooksOff(invName, atName) === true
  const anyOff = qtyOff || nameOff
  const detail = `Facture ${invName || '—'}${invQty != null ? ` · ${invQty} u.` : ''} · Airtable ${atName || '—'}${atQty != null ? ` · ${atQty} u.` : ''}`
  // Quantité facturée / quantité commandée, TOUJOURS affichée : c'est le seul chiffre
  // encore comparable entre la facture et Airtable (le prix y est une moyenne). Un tiret
  // dit « non lue sur la facture » plutôt que de faire disparaître la comparaison.
  const qtyPair = `qté ${invQty ?? '—'}/${atQty ?? '—'}`

  if (!anyOff) {
    const why = kind && IDENTITY_TEXT[kind] ? IDENTITY_TEXT[kind](identity) : null
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-green-700" title={detail}>
        <CheckCircle size={10} className="shrink-0" />
        <span className="truncate">
          {why ? `même pièce — ${why}` : 'même pièce'}
          {` · ${qtyPair}`}
        </span>
      </span>
    )
  }

  return (
    <div className="mt-0.5 border border-slate-200 rounded overflow-hidden text-[11px]">
      <div className="flex items-center gap-1 px-1.5 py-0.5 bg-red-50 text-red-600">
        <AlertTriangle size={10} className="shrink-0" />
        <span>
          {nameOff ? 'rien n’identifie la même pièce' : ''}
          {nameOff && qtyOff ? ' · ' : ''}
          {qtyOff ? 'quantité différente' : ''}
        </span>
      </div>
      <div className="grid grid-cols-[2.75rem_1fr_1fr] gap-x-1 px-1.5 py-0.5 bg-slate-50 text-slate-400 border-t border-slate-100">
        <span></span>
        <span>Facture</span>
        <span>Airtable</span>
      </div>
      <div className="grid grid-cols-[2.75rem_1fr_1fr] gap-x-1 px-1.5 py-0.5 items-center border-t border-slate-100">
        <span className="text-slate-400 shrink-0">Nom</span>
        <span className={`truncate ${nameOff ? 'text-red-600 font-semibold' : 'text-slate-600'}`} title={invName || undefined}>{invName || '—'}</span>
        <span className={`truncate ${nameOff ? 'text-red-600 font-semibold' : 'text-slate-600'}`} title={atName || undefined}>{atName || '—'}</span>
      </div>
      <div className="grid grid-cols-[2.75rem_1fr_1fr] gap-x-1 px-1.5 py-0.5 items-center border-t border-slate-100">
        <span className="text-slate-400 shrink-0">Qté</span>
        <span className={`tabular-nums ${qtyOff ? 'text-red-600 font-semibold' : 'text-slate-600'}`}>{invQty ?? '—'}</span>
        <span className={`tabular-nums ${qtyOff ? 'text-red-600 font-semibold' : 'text-slate-600'}`}>{atQty ?? '—'}</span>
      </div>
    </div>
  )
}

// Menu d'achat en petit tableau : Code | Pièce | Fournisseur | Qté | Cmd.
const LIA_GRID = 'grid grid-cols-[3.75rem_minmax(0,1fr)_5.25rem_2rem_3rem] gap-x-1.5 items-baseline'
// « 30.0 » → « 30 » ; les vraies décimales restent (2.5).
const liaQty = v => {
  if (v == null || v === '') return ''
  const n = Number(v)
  return Number.isFinite(n) ? String(n) : String(v)
}
const liaShortDate = d => {
  const day = String(d || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return ''
  const [y, m, dd] = day.split('-').map(Number)
  return new Date(y, m - 1, dd).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' }).replace('.', '')
}
const LIA_MENU_HEADER = (
  <div className={`${LIA_GRID} px-3 py-1 text-[10px] font-medium text-slate-400`}>
    <span>Code</span><span>Pièce</span><span>Fournisseur</span><span className="text-right">Qté</span><span>Cmd</span>
  </div>
)
const liaFilter = (o, q) => [o.lia_ref, o.part_name, o.supplier].some(v => String(v || '').toLowerCase().includes(q))

function LiaCell({ index, item, options, suggestion, blockedBy, linkedPurchase, linkCheck, linked, review, onSelect }) {
  const reused = linkedPurchase?.linked_receipts || []
  // Tout ce qui ne sert PAS à trancher « est-ce le bon achat ? » passe au survol :
  // date de commande, fournisseur (toujours celui de la facture — les candidats sont
  // filtrés dessus), coût moyen Airtable, nom de la pièce déjà recopié dans la
  // description. Ne reste à l'écran que le code, la preuve d'identité et la quantité.
  const linkedSummary = liaPurchaseSummary(linkedPurchase)
  const suggestionSummary = liaPurchaseSummary(suggestion)
  // La ligne est rattachée à un achat que le serveur n'a pas renvoyé dans les
  // candidats (autre fournisseur, achat archivé…) : sans option correspondante,
  // le sélecteur affichait « — », c'est-à-dire « aucun achat », alors que la ligne
  // EST rattachée. On ajoute l'achat rattaché à la liste pour qu'il s'affiche.
  // Ordre du menu : la suggestion de la ligne, les autres achats du fournisseur, puis
  // « Autres fournisseurs » (choix manuel seulement). L'achat rattaché hors « à
  // recevoir » reste la valeur affichée, sans revenir dans la liste.
  const suggestedId = !item.purchase_id && suggestion ? String(suggestion.purchase_id) : null
  const ordered = [
    ...options.filter(o => String(o.value) === suggestedId),
    ...options.filter(o => !o.other_vendor && String(o.value) !== suggestedId),
    ...options.filter(o => o.other_vendor && String(o.value) !== suggestedId),
  ]
  const selectOptions = item.purchase_id && !options.some(o => String(o.value) === String(item.purchase_id))
    ? [{ value: item.purchase_id, label: [item.lia_ref || 'Achat rattaché', linkedPurchase?.part_name].filter(Boolean).join(' · '), hidden: true }, ...ordered]
    : ordered
  return (
    <div className="space-y-0.5">
      <SearchableSelect
        testId={`receipt-item-lia-${index}`}
        value={item.purchase_id || ''}
        options={selectOptions}
        emptyOption="— Aucun achat —"
        onChange={val => onSelect(val || null)}
        hideOption={o => o.hidden}
        filterOption={liaFilter}
        getOptionGroup={o => (o.other_vendor ? 'Autres fournisseurs' : null)}
        optionClassName={o => (String(o.value) === suggestedId ? 'bg-emerald-50 hover:bg-emerald-100' : '')}
        searchAside={`${options.filter(o => !o.other_vendor).length || options.length} à recevoir`}
        listHeader={LIA_MENU_HEADER}
        hideCheck
        quietSelection={!!suggestedId}
        menuClassName="ring-[6px] ring-white"
        minMenuWidth={420}
        renderOption={o => (
          <span className={LIA_GRID}>
            {/* La pastille de confiance vit sous le code : elle ne prend plus
                de place au nom de la pièce. */}
            <span className="flex flex-col items-start gap-0.5 min-w-0">
              <span className="font-semibold text-slate-800 truncate max-w-full">{o.lia_ref}</span>
              {String(o.value) === suggestedId && (
                <span className="px-1 rounded-full bg-emerald-600 text-white text-[10px] leading-4 tabular-nums">
                  {Math.round(suggestion.score * 100)} %
                </span>
              )}
            </span>
            <span className="truncate" title={o.part_name || undefined}>{o.part_name || '—'}</span>
            <span className="truncate text-slate-500" title={o.supplier || undefined}>{o.supplier || '—'}</span>
            <span className="text-right tabular-nums">{liaQty(o.qty_ordered)}</span>
            <span className="text-slate-500 whitespace-nowrap">{liaShortDate(o.order_date)}</span>
          </span>
        )}
      />
      {item.purchase_id && (
        <div className="px-1 text-[11px] text-slate-500 flex items-baseline gap-x-1.5 gap-y-0.5 flex-wrap min-w-0">
          <Link
            to={`/purchases/${item.purchase_id}`}
            className="link-record font-medium shrink-0"
            title={[linkedPurchase?.part_name, linkedSummary, item.source_description && `Facture : ${item.source_description}`]
              .filter(Boolean).join(' · ') || undefined}
          >
            {item.lia_ref || 'Achat'}
          </Link>
          <LiaCompare item={item} purchase={linkedPurchase} identity={linkCheck?.identity} />
          {linked && (
            <span
              data-testid={`receipt-item-lia-date-${index}`}
              className={linked.pending_at_expense === false ? 'text-amber-700 font-medium' : 'text-slate-400'}
              title={linked.pending_at_expense === false ? 'Déjà reçu — hors « À recevoir »' : undefined}
            >
              {linked.pending_at_expense === false && '⚠ '}cmd {linked.order_date ? fmtDate(linked.order_date) : '?'}
            </span>
          )}
          {reused.length === 0 && linked?.other_links?.length > 0 && (
            <span
              className="text-amber-600"
              title={linked.other_links.map(o => [o.reference, o.date, o.vendor].filter(Boolean).join(' · ')).join('\n')}
            >
              déjà facturé ailleurs
            </span>
          )}
          {reused.length > 0 && (
            <span
              className="text-amber-600"
              title={`Déjà rattaché à ${reused.map(r => r.receipt_number || r.receipt_date || r.receipt_id).join(', ')}`}
            >
              déjà facturé ailleurs
            </span>
          )}
        </div>
      )}
      {!item.purchase_id && suggestion && (
        <button
          type="button"
          onClick={() => onSelect(suggestion.purchase_id)}
          data-testid={`receipt-item-lia-suggest-${index}`}
          title={[
            `Confiance ${Math.round(suggestion.score * 100)} %`,
            suggestionSummary,
            ...(suggestion.reasons || []),
            // Hors section « À recevoir » : la commande est déjà reçue, sa facture
            // n'était simplement pas encore entrée. On le dit plutôt que de le taire.
            ...(suggestion.pending_reception === false ? ['achat déjà reçu — hors section « À recevoir »'] : []),
          ].filter(Boolean).join(' · ')}
          className="w-full flex flex-col gap-0.5 px-1.5 py-1 text-xs text-left text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded"
        >
          <span className="flex items-baseline gap-1.5 flex-wrap w-full">
            <CheckCircle size={11} className="shrink-0 relative top-px" />
            <span className="font-medium">{suggestion.lia_ref}</span>
            <span className="break-words">{suggestion.part_name}</span>
            {suggestion.pending_reception === false && <span>· reçu</span>}
            <span className="ml-auto shrink-0 tabular-nums opacity-70">{Math.round(suggestion.score * 100)}%</span>
          </span>
        </button>
      )}
      {!item.purchase_id && suggestion && (
        <div className="pl-px">
          <LiaCompare item={item} purchase={suggestion} identity={suggestion.identity} />
        </div>
      )}
      {/* Aucune proposition parce que l'achat qui correspond le mieux est déjà facturé :
          on le dit plutôt que de proposer un code libre moins pertinent. Il reste
          sélectionnable dans la liste (dépôt + solde, correction d'un rattachement). */}
      {!item.purchase_id && !suggestion && !blockedBy && review && (
        <div
          data-testid={`receipt-item-lia-review-${index}`}
          title={`Achats à égalité : ${review.lia_refs.join(', ')}`}
          className="px-1.5 py-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded"
        >
          À vérifier · {review.lia_refs.join(', ')}
        </div>
      )}
      {!item.purchase_id && !suggestion && blockedBy && (
        <div
          data-testid={`receipt-item-lia-blocked-${index}`}
          title={[`${blockedBy.lia_ref} — ${blockedBy.reason}`, ...(blockedBy.receipts || []).map(r => r.receipt_number || r.receipt_date || r.receipt_id)].join(' · ')}
          className="flex items-baseline gap-1 px-1.5 py-1 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded"
        >
          <span className="break-words">{blockedBy.lia_ref} correspond, mais est déjà facturé</span>
        </div>
      )}
    </div>
  )
}

function EditableItems({ receipt, onUpdate, taxCodes = [], accounts = [] }) {
  const { addToast } = useToast()
  const [items, setItems] = useState(receipt.items || [])
  const [saving, setSaving] = useState(false)
  const initialJsonRef = useRef(JSON.stringify(receipt.items || []))
  // Achats LIA du même fournisseur + suggestion par ligne (lecture seule côté serveur).
  const [lia, setLia] = useState({ candidates: [], lines: [] })
  const liaCandidates = lia.candidates

  // Sync depuis le serveur uniquement quand on change de reçu — sinon les
  // updates optimistes locaux (ajout/suppression/édition en cours) seraient
  // écrasés par le re-render qui suit le PATCH.
  useEffect(() => {
    setItems(receipt.items || [])
    initialJsonRef.current = JSON.stringify(receipt.items || [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.id])

  // Suggestions d'achats LIA — best effort : indisponibles, l'éditeur fonctionne
  // normalement (l'appariement reste une aide, jamais un prérequis).
  const loadLia = useCallback(async () => {
    try {
      const d = await api.saleReceipts.liaMatches(receipt.id)
      setLia({ candidates: d.candidates || [], lines: d.lines || [] })
    } catch { /* pas bloquant */ }
  }, [receipt.id])
  useEffect(() => { loadLia() }, [loadLia])

  // Montant de ligne SIGNÉ : une ligne de crédit (crédit de proration « Unused time
  // on… », remise, retour) retranche du sous-total et doit rester négative.
  function parseNum(x) {
    if (x === '' || x == null) return null
    const n = Number(String(x).replace(',', '.'))
    return Number.isFinite(n) ? n : null
  }

  function normalizeItems(list) {
    return list.map(it => ({
      description: it.description || '',
      // Quantité et prix unitaire lus sur la facture : la fiche ne les édite pas, mais
      // elle doit les CONSERVER. Omis ici, ils étaient remis à vide au premier
      // enregistrement (rattacher un achat, changer un code de taxe…) — et la
      // quantité facturée, seule donnée vraiment comparable à la commande, disparaissait.
      quantity:    parseNum(it.quantity),
      unit_price:  parseNum(it.unit_price),
      total:       parseNum(it.total),
      tax_code_id: it.tax_code_id || null,
      // Compte de dépense QB de la ligne — null = suit le compte du document.
      expense_account_id: it.expense_account_id || null,
      // Achat LIA rattaché (purchases.id) + son code, dupliqué pour l'affichage.
      purchase_id: it.purchase_id || null,
      lia_ref:     it.lia_ref || null,
      // Libellé d'origine du fournisseur, conservé quand la description devient le code.
      source_description: it.source_description || null,
    }))
  }

  function updateItem(i, patch) {
    setItems(prev => prev.map((it, idx) => idx === i ? { ...it, ...patch } : it))
  }

  function removeItem(i) {
    setItems(prev => prev.filter((_, idx) => idx !== i))
  }

  function addItem() {
    setItems(prev => [...prev, { description: '', total: null, tax_code_id: null, expense_account_id: null }])
  }

  // Rattachement d'une ligne à un achat LIA : la description devient « LIA-1991⇥Nom de
  // la pièce » (`label` du candidat) — c'est ce qui est publié sur la ligne QuickBooks,
  // et ce qui rend le grand livre du compte 14000 lisible sans ouvrir la table Achats.
  // Persiste immédiatement (le SearchableSelect n'émet pas de blur).
  function setLiaPurchase(i, purchaseId) {
    const p = purchaseId ? liaCandidates.find(c => c.id === purchaseId) : null
    const next = items.map((it, idx) => {
      if (idx !== i) return it
      if (!p) return { ...it, purchase_id: null, lia_ref: null }
      return {
        ...it,
        purchase_id: p.id,
        lia_ref: p.lia_ref,
        // Libellé imprimé par le fournisseur, mémorisé avant d'être remplacé par le
        // libellé LIA : il apprend au moteur d'appariement comment CE fournisseur nomme
        // CETTE pièce (côté serveur, learnLineAliases).
        source_description: it.source_description || it.description || null,
        // « LIA-1991⇥Nom de la pièce » : le code ET le nom, recopiés de la fiche Achat
        // (p.label, cf. buildLiaLabel côté serveur). Airtable n'est pas touché.
        description: p.label || p.lia_ref,
      }
    })
    setItems(next)
    commit(next)
  }

  // Sélection d'un code de taxe par ligne : persiste immédiatement (le SearchableSelect
  // n'émet pas de blur). On commit la liste calculée pour ne pas dépendre du setState async.
  function setTaxCode(i, val) {
    const next = items.map((it, idx) => idx === i ? { ...it, tax_code_id: val || null } : it)
    setItems(next)
    commit(next)
  }

  // Compte de dépense par ligne : même mécanique que le code de taxe (persistance
  // immédiate). Vide = la ligne suit le compte de dépense du document.
  function setLineExpenseAccount(i, val) {
    const next = items.map((it, idx) => idx === i ? { ...it, expense_account_id: val || null } : it)
    setItems(next)
    commit(next)
  }

  async function commit(list = items) {
    const normalized = normalizeItems(list)
    const nextJson = JSON.stringify(normalized)
    if (nextJson === initialJsonRef.current) return
    setSaving(true)
    try {
      // Cascade : le sous-total suit la somme des lignes. Si un code par défaut du
      // document est défini, les taxes sont recalculées à partir des codes (par ligne
      // + défaut) ; sinon elles gardent leur taux effectif (mise à l'échelle).
      const taxNameById = new Map((taxCodes || []).map(c => [c.Id, c.Name]))
      const payload = { items: normalized, ...recomputeAmounts(receipt, normalized, receipt.tax_code_id, taxNameById) }
      const updated = await api.saleReceipts.update(receipt.id, payload)
      onUpdate?.(updated)
      initialJsonRef.current = JSON.stringify(updated.items || [])
      // Les suggestions dépendent des lignes et des achats déjà consommés : on les
      // recalcule après chaque enregistrement.
      loadLia()
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      setItems(receipt.items || [])
    } finally {
      setSaving(false)
    }
  }

  // Sauvegarde à chaque suppression / ajout (la modification d'un champ texte
  // déclenche commit sur blur via l'input lui-même).
  useEffect(() => {
    const json = JSON.stringify(normalizeItems(items))
    if (json !== initialJsonRef.current && items.length !== (receipt.items || []).length) {
      commit()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length])

  // « Aucune taxe » (sentinel NO_TAX) en tête : force une ligne sans code de taxe,
  // distinct de « Code du document » (emptyOption) qui hérite du code global à la publication.
  // (Sans mention « exonéré » : Exonéré/Hors champ/Détaxé sont des codes QB distincts,
  // disponibles ci-dessous — à choisir explicitement si c'est le bon statut.)
  const taxCodeOptions = [
    { value: NO_TAX, label: '— Aucune taxe (sans code) —' },
    ...taxCodes.map(c => ({ value: c.Id, label: c.Name })),
  ]

  // Comptes de dépense proposés par ligne — mêmes types que le sélecteur du document.
  // Vide (emptyOption) = la ligne suit le compte de dépense choisi à la publication ;
  // un choix ici l'emporte, pour les achats qui touchent plus d'un compte.
  const lineAccountOptions = receipt.quickbooks_type === 'deposit' ? depositAccountOptions(accounts) : expenseAccountOptions(accounts)

  // Achats LIA du menu : la section « À recevoir » d'Airtable seulement — ni reçus, ni
  // déjà facturés. Ceux des autres fournisseurs suivent, pour un choix manuel.
  const liaOptions = liaCandidates
    .filter(c => c.pending_reception && !c.consumed)
    .map(c => ({
      value: c.id,
      label: `${c.lia_ref} · ${c.part_name || '(pièce non liée)'}`,
      lia_ref: c.lia_ref,
      part_name: c.part_name,
      supplier: c.supplier,
      qty_ordered: c.qty_ordered,
      order_date: c.order_date,
      other_vendor: !!c.other_vendor,
    }))
  const suggestionFor = i => (lia.lines.find(l => l.index === i)?.match) || null
  const blockedFor = i => (lia.lines.find(l => l.index === i)?.blocked_by) || null
  // Contrôle du rattachement DÉJÀ posé sur la ligne : sur quoi le serveur fonde
  // l'identification de la pièce (référence, SKU, libellé appris).
  const linkCheckFor = i => (lia.lines.find(l => l.index === i)?.link_check) || null
  const linkedFor = i => (lia.lines.find(l => l.index === i)?.linked) || null
  const reviewFor = i => (lia.lines.find(l => l.index === i)?.review) || null
  const candidateById = id => liaCandidates.find(c => c.id === id) || null

  // Aperçu de la ligne « Frais de conversion » que le push QB ajoutera (voir
  // computeConversionFee côté serveur) — écart entre le total du reçu et le
  // montant réellement débité à la banque. Le champ n'est saisissable que pour
  // les Purchase, donc bank_charged_total n'est jamais renseigné pour un Bill.
  const conversionFee = (() => {
    if (receipt.bank_charged_total == null) return 0
    // Débit dans une autre devise que la facture : c'est une conversion, pas un frais.
    if (receipt.bank_txn && (receipt.bank_txn.currency || 'CAD').toUpperCase() !== (receipt.currency || 'CAD').toUpperCase()) return 0
    const bank = Number(receipt.bank_charged_total)
    const total = Number(receipt.total) || 0
    if (!Number.isFinite(bank) || bank <= 0) return 0
    const fee = Math.round((bank - total) * 100) / 100
    return Math.abs(fee) < 0.005 ? 0 : fee
  })()
  const exemptCodeName = taxCodes.find(c => c.Name === 'Exonéré')?.Name || 'Exonéré'

  // Transport/escompte global extrait par l'IA (raw_data), déjà réparti au prorata dans
  // le `total` de chaque ligne par reconcileDiscountFreightProrata côté serveur — rien à
  // calculer ici, juste rappeler discrètement que les montants ci-dessus l'incluent déjà
  // (sans ça, aucune trace de ce prorata n'est visible dans la fiche).
  const prorata = (() => {
    if (!receipt.raw_data || items.length <= 1) return null
    let parsed
    try { parsed = JSON.parse(receipt.raw_data) } catch { return null }
    // `prorata` : trace posée par le serveur (lignes de frais sorties comprises).
    const p = parsed.prorata
    const freight = round2(Number(p ? p.freight : parsed.freight_amount) || 0)
    const discount = round2(Number(p ? p.discount : parsed.discount_amount) || 0)
    if (!freight && !discount) return null
    return { freight, discount, lines: p?.lines || [] }
  })()

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-slate-700">Articles</h3>
        <div className="flex items-center gap-2">
          {saving && <ThinkingOrb size={12} ink className="text-slate-400" />}
          <button
            type="button"
            onClick={addItem}
            data-testid="receipt-item-add"
            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-brand-600 hover:bg-brand-50 rounded"
          >
            <Plus size={12} /> Ajouter une ligne
          </button>
        </div>
      </div>
      {/* Une ligne = un bloc de rangées, pas une rangée de tableau : la fiche vit dans une
          demi-largeur d'écran (aperçu du document à gauche), où quatre colonnes côte à côte
          rendaient la description illisible (~15 caractères visibles).
          Rangée 1 : description pleine largeur + montant. Rangée 2 : achat LIA sur toute la
          largeur (son menu reprend la largeur du bouton — un sélecteur étroit rendrait les
          libellés d'achats illisibles). Rangée 3 : taxe et compte de dépense, deux valeurs
          courtes qui se partagent la rangée.
          ⚠ Aucun libellé ne porte `uppercase tracking-wide` : dans un panneau latéral, ce
          couple de classes est le crochet des règles `.peek-panel` d'index.css, qui
          transforme le bloc en grille « libellé 140 px | champ » — les trois sélecteurs se
          retrouvaient écrasés dans la moitié droite, sous un libellé démesuré. */}
      <div className="border border-slate-200 rounded-lg divide-y divide-slate-200 overflow-hidden">
        {items.length === 0 && (
          <div className="px-3 py-4 text-center text-slate-400 text-xs">
            Aucun article — cliquez « Ajouter une ligne ».
          </div>
        )}
        {items.map((item, i) => (
          <div key={i} className="p-2 hover:bg-slate-50/70" data-testid={`receipt-item-row-${i}`}>
            <div className="flex items-start gap-2">
              <input
                type="text"
                value={item.description || ''}
                onChange={e => updateItem(i, { description: e.target.value })}
                onBlur={() => commit()}
                title={item.description || ''}
                className="flex-1 min-w-0 px-2 py-1 text-sm bg-transparent border border-transparent hover:border-slate-300 focus:border-brand-500 focus:bg-white rounded outline-none"
              />
              <input
                type="text"
                inputMode="decimal"
                value={item.total ?? ''}
                onChange={e => updateItem(i, { total: e.target.value })}
                onBlur={() => commit()}
                aria-label="Total de la ligne"
                className="w-28 shrink-0 px-2 py-1 text-sm text-right tabular-nums font-medium bg-transparent border border-transparent hover:border-slate-300 focus:border-brand-500 focus:bg-white rounded outline-none"
              />
              <button
                type="button"
                onClick={() => removeItem(i)}
                data-testid={`receipt-item-remove-${i}`}
                title="Supprimer cette ligne"
                aria-label="Supprimer cette ligne"
                className="shrink-0 p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
              >
                <Trash2 size={12} />
              </button>
            </div>
            <div className="flex items-start gap-1.5 mt-1 pl-2 pr-[2.375rem]">
              <span className="shrink-0 pt-1 text-[11px] text-slate-400">Achat</span>
              <div className="flex-1 min-w-0">
                <LiaCell
                  index={i}
                  item={item}
                  options={liaOptions}
                  suggestion={suggestionFor(i)}
                  blockedBy={blockedFor(i)}
                  linkedPurchase={candidateById(item.purchase_id)}
                  linkCheck={linkCheckFor(i)}
                  linked={linkedFor(i)}
                  review={reviewFor(i)}
                  onSelect={id => setLiaPurchase(i, id)}
                />
              </div>
            </div>
            {/* Taxe et compte de dépense : deux valeurs courtes, donc côte à côte sur une
                seule rangée, libellé À GAUCHE du sélecteur (au-dessus, chacun coûtait une
                rangée de plus). Facture qui touche plusieurs comptes → on ventile ici,
                ligne par ligne. */}
            <div className="flex items-center gap-3 mt-1 pl-2 pr-[2.375rem]">
              <div className="flex-1 min-w-0 flex items-center gap-1.5">
                <span className="shrink-0 text-[11px] text-slate-400">Taxe</span>
                <div className="flex-1 min-w-0">
                  <SearchableSelect
                    testId={`receipt-item-taxcode-${i}`}
                    value={item.tax_code_id || ''}
                    options={taxCodeOptions}
                    emptyOption="— Code du document —"
                    onChange={val => setTaxCode(i, val)}
                  />
                </div>
              </div>
              <div className="flex-1 min-w-0 flex items-center gap-1.5">
                <span className="shrink-0 text-[11px] text-slate-400">Compte</span>
                <div className="flex-1 min-w-0">
                  <SearchableSelect
                    testId={`receipt-item-account-${i}`}
                    value={item.expense_account_id || ''}
                    options={lineAccountOptions}
                    emptyOption="— Compte du document —"
                    onChange={val => setLineExpenseAccount(i, val)}
                  />
                </div>
              </div>
            </div>
          </div>
        ))}
        {conversionFee !== 0 && (
          <div className="p-2 bg-slate-50/60" data-testid="receipt-item-conversion-fee">
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0 px-2 py-1 text-sm text-slate-600 truncate">Frais de conversion</span>
              <span className="w-28 shrink-0 px-2 py-1 text-sm text-right tabular-nums font-medium text-slate-600">
                {conversionFee > 0 ? '+' : ''}{conversionFee.toFixed(2)}
              </span>
              <span className="shrink-0 w-[26px]" />
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5 pl-2">
              Ajouté automatiquement à la publication (montant passé à la banque) — code de taxe <strong>{exemptCodeName}</strong>.
            </p>
          </div>
        )}
      </div>
      {prorata && (
        <p className="text-[11px] text-slate-500 mt-1 leading-snug flex items-center gap-1" data-testid="receipt-freight-prorata-hint">
          <span className="inline-flex items-center rounded bg-green-50 text-green-700 px-1.5 py-0.5 font-medium">✓ Prorata</span>
          {prorata.lines.length
            ? prorata.lines.map(l => `${l.label} ${fmtCad(l.amount)}`).join(' · ')
            : [prorata.freight > 0 && `transport ${fmtCad(prorata.freight)}`, prorata.discount > 0 && `escompte ${fmtCad(prorata.discount)}`].filter(Boolean).join(' · ')}
          {' '}réparti sur les lignes
        </p>
      )}
    </div>
  )
}

function EditableAmountRow({ receipt, field, label, bold, onUpdate, readOnly, hint }) {
  const { addToast } = useToast()
  const initial = receipt[field] != null ? String(receipt[field]) : ''
  const [value, setValue] = useState(initial)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setValue(receipt[field] != null ? String(receipt[field]) : '') }, [receipt.id, receipt[field], field])

  // Champ dérivé (ex. sous-total = somme des lignes) : affichage seul, non éditable.
  if (readOnly) {
    const v = receipt[field]
    return (
      <div className="flex justify-between items-center gap-2">
        <span className={`text-sm ${bold ? 'font-semibold text-slate-800' : 'text-slate-600'}`}>
          {label}
          {hint && <span className="text-[11px] text-slate-400 ml-1">{hint}</span>}
        </span>
        <span
          data-testid={`receipt-amount-${field}`}
          className={`tabular-nums text-right px-2 py-0.5 w-28 text-sm ${bold ? 'font-bold text-slate-900 text-base' : 'text-slate-700'}`}
        >
          {v != null ? fmtCad(v) : '—'}
        </span>
      </div>
    )
  }

  async function commit() {
    const trimmed = value.trim()
    const parsed = trimmed === '' ? null : Number(trimmed.replace(',', '.'))
    if (parsed != null && (!Number.isFinite(parsed) || parsed < 0)) {
      addToast({ message: 'Montant invalide', type: 'error' })
      setValue(receipt[field] != null ? String(receipt[field]) : '')
      return
    }
    const current = receipt[field] ?? null
    if (parsed === current) return
    setSaving(true)
    try {
      // Pour un champ de montant (sous-total / taxes), recompose `total` dans le
      // même PATCH afin que « total = articles + taxes » reste vrai en DB.
      const patch = TOTAL_SYNC_FIELDS.has(field)
        ? withRecomputedTotal(receipt, { [field]: parsed })
        : { [field]: parsed }
      const updated = await api.saleReceipts.update(receipt.id, patch)
      onUpdate?.(updated)
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      setValue(receipt[field] != null ? String(receipt[field]) : '')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex justify-between items-center gap-2">
      <span className={`text-sm ${bold ? 'font-semibold text-slate-800' : 'text-slate-600'}`}>{label}</span>
      <div className="flex items-center gap-1">
        {saving && <ThinkingOrb size={11} ink className="text-slate-400" />}
        <input
          type="text"
          inputMode="decimal"
          data-testid={`receipt-amount-${field}`}
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
          disabled={saving}
          className={`tabular-nums text-right bg-transparent border border-transparent hover:border-slate-300 focus:border-brand-500 focus:bg-white rounded px-2 py-0.5 w-28 text-sm outline-none ${
            bold ? 'font-bold text-slate-900 text-base' : 'text-slate-700'
          }`}
        />
      </div>
    </div>
  )
}

// Recalcule sous-total / taxes / total à partir des lignes d'articles.
// - Le sous-total devient la somme des totaux de lignes.
// - Les taxes conservent leur taux effectif actuel : chaque composante est mise
//   à l'échelle par le ratio (nouveau sous-total / ancien sous-total). Ça préserve
//   les cas particuliers (TPS seule, taux mixte, partiellement exonéré, 0 taxe).
// - Le total = sous-total + taxes.
// - Le ratio se calcule sur la BASE TAXABLE, pas sur le sous-total complet : une ligne
//   qui porte un code de taxe explicite à 0 % (« Hors champ », « Détaxé », « Exonéré »,
//   « aucune taxe ») est exclue des deux côtés du ratio. Sinon, ajouter un pourboire
//   hors champ de 10 $ à un repas de 56 $ gonflerait la TPS/TVQ de 18 % — une taxe
//   réclamée sur un montant jamais taxé.
// Si aucune ligne ne porte de montant, on ne touche à rien (objet vide).
// Si l'ancienne base taxable est nulle/absente, on ne peut pas déduire de taux : les
// taxes existantes sont laissées telles quelles.
function recalcAmountsFromItems(items, receipt, taxNameById) {
  const lineTotals = items.map(it => it.total).filter(n => n != null)
  if (lineTotals.length === 0) return {}
  const r = x => Math.round(x * 100) / 100
  const newSubtotal = r(lineTotals.reduce((a, b) => a + b, 0))
  // Montant des lignes explicitement à 0 % (à retirer de la base taxable).
  const zeroRated = list => (list || []).reduce((sum, it) => {
    const code = it && it.tax_code_id
    if (code == null || code === '') return sum
    const rate = code === NO_TAX
      ? 0
      : TAX_RATE_BY_NAME.get(taxNameById ? taxNameById.get(code) : undefined)
    return rate === 0 ? sum + (Number(it.total) || 0) : sum
  }, 0)
  const newTaxable = r(newSubtotal - zeroRated(items))
  const oldSubtotal = receipt.subtotal || 0
  const oldTaxable = r(Math.max(0, oldSubtotal - zeroRated(receipt.items)))
  let tps = receipt.tps || 0, tvq = receipt.tvq || 0, other = receipt.other_taxes || 0
  if (oldTaxable > 0) {
    const f = newTaxable / oldTaxable
    tps = r(tps * f); tvq = r(tvq * f); other = r(other * f)
  } else if (newTaxable <= 0) {
    tps = 0; tvq = 0; other = 0
  }
  return {
    subtotal: newSubtotal,
    tps, tvq, other_taxes: other,
    total: r(newSubtotal + tps + tvq + other),
  }
}

// Répartit un total de taxes sur TPS / TVQ / Autres taxes au prorata des valeurs
// actuelles. Sans ventilation existante (tout à 0), applique les taux du Québec
// (TPS 5 % / TVQ 9,975 %). L'écart d'arrondi est reporté sur la plus grosse part.
function splitTaxTotal(newTotal, { tps = 0, tvq = 0, other_taxes = 0 }) {
  const t = tps || 0, v = tvq || 0, o = other_taxes || 0
  const sum = t + v + o
  let parts
  if (sum > 0) {
    parts = { tps: newTotal * t / sum, tvq: newTotal * v / sum, other_taxes: newTotal * o / sum }
  } else {
    const RT = 5, RV = 9.975
    parts = { tps: newTotal * RT / (RT + RV), tvq: newTotal * RV / (RT + RV), other_taxes: 0 }
  }
  const r = x => Math.round(x * 100) / 100
  const rounded = { tps: r(parts.tps), tvq: r(parts.tvq), other_taxes: r(parts.other_taxes) }
  const diff = r(newTotal - (rounded.tps + rounded.tvq + rounded.other_taxes))
  if (diff !== 0) {
    const k = ['tps', 'tvq', 'other_taxes'].reduce((a, b) => (rounded[b] >= rounded[a] ? b : a))
    rounded[k] = r(rounded[k] + diff)
  }
  return rounded
}

// À quelle ligne du sommaire rattacher un label de taxe tel qu'imprimé sur la
// facture (« TPS », « T.P.S. (5%) », « GST », « TVQ », « QST », « HST ON »,
// « PST BC »…). Miroir de transportInvoice.js (serveur) : TPS/GST → tps,
// TVQ/QST → tvq, TVH/HST → other_taxes (récupérable). Une PST provinciale ou une
// taxe inconnue n'est PAS récupérable : le serveur la replie dans le coût, donc
// elle n'apparaît dans aucun champ de taxe du dossier mais dans le sous-total.
function taxFieldForLabel(label) {
  const l = (label || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z]/g, '')
  if (l.includes('TVQ') || l.includes('QST')) return 'tvq'
  if (l.includes('TVH') || l.includes('HST')) return 'other_taxes'
  if (l.includes('PST') || l.includes('RST') || l.includes('TVP')) return 'non_recoverable'
  if (l.includes('TPS') || l.includes('GST')) return 'tps'
  return 'non_recoverable'
}

const TAX_FIELD_LABEL = {
  tps: 'TPS / GST',
  tvq: 'TVQ / QST',
  other_taxes: 'TVH',
  non_recoverable: 'Taxe non récupérable',
}

// Une ligne du sommaire extrait : libellé + montant, ✓/⚠️ selon qu'elle retombe
// sur le montant retenu au dossier. Les libellés exacts imprimés (« TPS »,
// « TVH ON »…) ne sont détaillés QUE si la ligne en regroupe plusieurs — sinon
// c'est le même montant écrit deux fois.
function ExtractedSummaryLine({ label, amount, documented, labels, strong }) {
  const ok = documented == null || Math.abs(round2(documented - amount)) < 0.02
  return (
    <div>
      <div className={`flex justify-between gap-2 ${strong ? 'text-sm font-semibold text-slate-800' : 'text-xs text-slate-700'}`}>
        <span className="inline-flex items-center gap-1.5 min-w-0">
          {documented == null
            ? <span className="w-3 shrink-0" />
            : ok
              ? <CheckCircle size={12} className="text-green-600 shrink-0" />
              : <AlertCircle size={12} className="text-amber-500 shrink-0" />}
          <span className="truncate">{label}</span>
        </span>
        <span className="tabular-nums shrink-0">{fmtCad(amount)}</span>
      </div>
      {labels && labels.length > 1 && labels.map(([l, amt], i) => (
        <div key={i} className="flex justify-between gap-2 pl-[22px] text-[11px] text-slate-400">
          <span className="truncate">{l}</span>
          <span className="tabular-nums shrink-0">{fmtCad(amt)}</span>
        </div>
      ))}
      {!ok && (
        <p className="pl-[22px] text-[11px] text-amber-600">Au dossier : {fmtCad(documented)}</p>
      )}
    </div>
  )
}

// ── Validation contre le PAPIER ───────────────────────────────────────────────
// Le sommaire imprimé de la facture (relu du PDF côté serveur, sans IA) posé en regard
// du dossier. Objectif : valider une facture de transport SANS dérouler le PDF — une
// ligne verte quand tout concorde, le détail des écarts sinon.
function usePrintedInvoiceSummary(receiptId) {
  const [paper, setPaper] = useState(null)
  useEffect(() => {
    if (!receiptId) { setPaper(null); return }
    let alive = true
    api.saleReceipts.invoiceSummary(receiptId)
      .then(r => { if (alive) setPaper(r?.available ? r : null) })
      .catch(() => { if (alive) setPaper(null) })
    return () => { alive = false }
  }, [receiptId])
  return paper
}

const sameMoney = (a, b) => a == null || b == null || Math.abs(round2(a) - round2(b)) < 0.02

// Une ligne de la confrontation papier ↔ dossier.
function PaperRow({ label, paper, filed, off }) {
  return (
    <div className={`grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 items-baseline px-1.5 py-0.5 ${off ? 'bg-red-50' : ''}`}>
      <span className={`truncate text-[11px] ${off ? 'text-red-700' : 'text-slate-500'}`}>{label}</span>
      <span className={`tabular-nums text-xs text-right w-24 ${off ? 'text-red-700 font-semibold' : 'text-slate-600'}`}>{paper}</span>
      <span className={`tabular-nums text-xs text-right w-24 ${off ? 'text-red-700 font-semibold' : 'text-slate-800'}`}>{filed}</span>
    </div>
  )
}

// Confrontation compacte : quand tout concorde (le cas courant), une seule ligne verte
// qui récapitule ce qui a été vérifié — rien à lire de plus. Au moindre écart, la
// grille « Facture | Dossier » s'ouvre d'office sur la ligne fautive.
function PrintedInvoiceCheck({ receipt, paper, shipmentCount }) {
  const [open, setOpen] = useState(false)
  const filedTotal = computedTotal(receipt)
  const filedSubtotal = effectiveSubtotal(receipt)
  const rows = []

  if (paper.invoice_number) {
    const off = String(receipt.receipt_number || '').trim() !== String(paper.invoice_number).trim()
    rows.push({ key: 'num', label: 'N° de facture', paper: paper.invoice_number, filed: receipt.receipt_number || '—', off })
  }
  if (paper.invoice_date) {
    // La date du dossier suit le débit bancaire quand il y en a un : c'est la
    // date LUE sur le document (`document_date`) qu'on confronte au papier.
    const read = receipt.document_date || receipt.receipt_date
    const off = (read || '').slice(0, 10) !== paper.invoice_date
    rows.push({ key: 'date', label: 'Date', paper: fmtDate(paper.invoice_date), filed: read ? fmtDate(read) : '—', off })
  }
  if (shipmentCount != null && paper.shipment_count) {
    const off = shipmentCount !== paper.shipment_count
    rows.push({ key: 'ship', label: 'Expéditions', paper: paper.shipment_count, filed: shipmentCount, off })
  }
  rows.push({ key: 'sub', label: 'Sous-total', paper: fmtCad(paper.subtotal), filed: fmtCad(filedSubtotal), off: !sameMoney(paper.subtotal, filedSubtotal) })
  // Une taxe ABSENTE du papier n'est pas une taxe à zéro : si la facture
  // n'imprime aucune ligne de taxe nommée, il n'y a rien à confronter — on ne
  // transforme pas un « pas lu » en écart.
  const paperHasTaxes = (paper.taxes || []).length > 0
  for (const [field, label] of [['tps', 'TPS'], ['tvq', 'TVQ'], ['other_taxes', 'TVH']]) {
    const p = paper[field] || 0, f = round2(receipt[field] || 0)
    if (!p && !f) continue
    if (!paperHasTaxes) continue
    rows.push({ key: field, label, paper: fmtCad(p), filed: fmtCad(f), off: !sameMoney(p, f) })
  }
  if (paper.total_due != null) {
    rows.push({ key: 'total', label: 'Total dû', paper: fmtCad(paper.total_due), filed: fmtCad(filedTotal), off: !sameMoney(paper.total_due, filedTotal), strong: true })
  }

  const offCount = rows.filter(r => r.off).length
  const show = open || offCount > 0

  return (
    <div
      data-testid="receipt-paper-check"
      data-status={offCount ? 'mismatch' : 'ok'}
      className={`rounded-md border p-2 ${offCount ? 'border-red-300 bg-red-50/40' : 'border-green-300 bg-green-50/50'}`}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-baseline gap-1.5 text-left"
        title="Sommaire imprimé sur la facture, relu du PDF — comparé au dossier"
      >
        {offCount
          ? <AlertCircle size={13} className="text-red-600 shrink-0 relative top-px" />
          : <CheckCircle size={13} className="text-green-600 shrink-0 relative top-px" />}
        <span className={`text-xs font-semibold ${offCount ? 'text-red-700' : 'text-green-800'}`}>
          {offCount
            ? (offCount === 1 ? `Écart — ${rows.find(r => r.off).label}` : `${offCount} écarts avec la facture`)
            : 'Conforme à la facture'}
        </span>
        {!offCount && (
          <span className="text-[11px] text-green-700/80 truncate">
            {[paper.invoice_number && `n° ${paper.invoice_number}`,
              paper.invoice_date && fmtDate(paper.invoice_date),
              paper.shipment_count && `${paper.shipment_count} exp.`,
              paper.total_due != null && fmtCad(paper.total_due)].filter(Boolean).join(' · ')}
          </span>
        )}
        <ChevronDown size={12} className={`ml-auto shrink-0 text-slate-400 transition-transform ${show ? 'rotate-180' : ''}`} />
      </button>
      {show && (
        <div className="mt-1.5 border-t border-slate-200 pt-1">
          {/* `dt-caps` et non `uppercase tracking-wide` : en panneau latéral, ce couple
              de classes est le crochet qui reflow toute la grille (voir index.css). */}
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 px-1.5 text-[10px] dt-caps text-slate-400">
            <span></span>
            <span className="text-right w-24">Facture</span>
            <span className="text-right w-24">Dossier</span>
          </div>
          {rows.map(r => <PaperRow key={r.key} {...r} />)}
        </div>
      )}
    </div>
  )
}

// Sommaire de la facture reconstruit à partir des expéditions extraites, présenté
// DANS L'ORDRE du sommaire imprimé en haut des factures de transport multi-régions
// (Novoxpress & co.) — sous-total, taxes par type, total dû — pour se comparer à
// l'œil au papier sans rouvrir le PDF. Un ⚠️ marque la ligne qui ne retombe pas sur
// le montant retenu au dossier. Toujours visible dès que `raw_data` contient des
// `shipments` ; n'existe pas autrement.
function ExtractedTaxDetail({ receipt }) {
  const paper = usePrintedInvoiceSummary(receipt.id)
  const shipments = (() => {
    if (!receipt.raw_data) return null
    try {
      const parsed = JSON.parse(receipt.raw_data)
      return Array.isArray(parsed.shipments) && parsed.shipments.length ? parsed.shipments : null
    } catch { return null }
  })()
  // Le sommaire IMPRIMÉ, quand il est lisible, remplace la reconstruction : c'est la
  // facture elle-même qui valide le dossier, il n'y a plus rien à aller vérifier dans
  // le PDF. La reconstruction reste le repli (facture scannée, sans couche texte).
  if (paper) return <PrintedInvoiceCheck receipt={receipt} paper={paper} shipmentCount={shipments ? shipments.length : null} />
  if (!shipments) return null

  // Regroupe TOUTES les taxes de TOUTES les expéditions par label exact imprimé
  // (« TPS », « TVH ON »…), puis par ligne de sommaire.
  const byLabel = new Map()
  let shipTotal = 0
  for (const sh of shipments) {
    shipTotal = round2(shipTotal + (Number(sh.total) || 0))
    for (const t of (sh.taxes || [])) {
      if (!t || !t.label) continue
      byLabel.set(t.label, round2((byLabel.get(t.label) || 0) + (Number(t.amount) || 0)))
    }
  }
  const byField = { tps: 0, tvq: 0, other_taxes: 0, non_recoverable: 0 }
  const labelsByField = { tps: [], tvq: [], other_taxes: [], non_recoverable: [] }
  for (const [label, amount] of byLabel) {
    const field = taxFieldForLabel(label)
    byField[field] = round2(byField[field] + amount)
    labelsByField[field].push([label, amount])
  }

  // Sous-total = total des expéditions moins les taxes récupérables. La taxe non
  // récupérable reste dedans (elle est repliée dans le coût à la publication).
  const recoverable = round2(byField.tps + byField.tvq + byField.other_taxes)
  const subtotal = round2(shipTotal - recoverable)

  const taxRows = ['tps', 'tvq', 'other_taxes']
    .filter(f => labelsByField[f].length)
    .map(f => ({ field: f, amount: byField[f], documented: round2(receipt[f] || 0), labels: labelsByField[f] }))

  return (
    <div
      data-testid="receipt-extracted-tax-summary"
      className="rounded-md border border-slate-300 bg-white p-3 space-y-1"
    >
      <div className="flex items-baseline justify-between gap-2 pb-1">
        <span className="text-xs font-semibold text-slate-700">Sommaire de la facture</span>
        <span className="text-[11px] text-slate-400">
          {shipments.length} expédition{shipments.length > 1 ? 's' : ''}
        </span>
      </div>
      <ExtractedSummaryLine
        label="Sous-total"
        amount={subtotal}
        documented={round2(receipt.subtotal || 0)}
      />
      {byField.non_recoverable > 0 && (
        <ExtractedSummaryLine
          label={`dont ${labelsByField.non_recoverable.map(([l]) => l).join(', ')} — non récupérable`}
          amount={byField.non_recoverable}
          documented={null}
        />
      )}
      {taxRows.map(row => (
        <ExtractedSummaryLine
          key={row.field}
          label={TAX_FIELD_LABEL[row.field]}
          amount={row.amount}
          documented={row.documented}
          labels={row.labels}
        />
      ))}
      <div className="border-t border-slate-200 pt-1.5 mt-1.5">
        <ExtractedSummaryLine
          label="Total dû"
          amount={shipTotal}
          documented={round2(receipt.total || 0)}
          strong
        />
      </div>
    </div>
  )
}

function EditableTotalTaxesRow({ receipt, onUpdate }) {
  const { addToast } = useToast()
  const currentTotal = Math.round(((receipt.tps || 0) + (receipt.tvq || 0) + (receipt.other_taxes || 0)) * 100) / 100
  const [value, setValue] = useState(currentTotal ? String(currentTotal) : '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const ct = Math.round(((receipt.tps || 0) + (receipt.tvq || 0) + (receipt.other_taxes || 0)) * 100) / 100
    setValue(ct ? String(ct) : '')
  }, [receipt.id, receipt.tps, receipt.tvq, receipt.other_taxes])

  async function commit() {
    const trimmed = value.trim()
    const parsed = trimmed === '' ? 0 : Number(trimmed.replace(',', '.'))
    if (!Number.isFinite(parsed) || parsed < 0) {
      addToast({ message: 'Montant invalide', type: 'error' })
      setValue(currentTotal ? String(currentTotal) : '')
      return
    }
    if (Math.round(parsed * 100) === Math.round(currentTotal * 100)) return
    const parts = splitTaxTotal(parsed, receipt)
    setSaving(true)
    try {
      // Le total des taxes change → le total global suit (sous-total + nouvelles taxes).
      const updated = await api.saleReceipts.update(receipt.id, withRecomputedTotal(receipt, parts))
      onUpdate?.(updated)
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      setValue(currentTotal ? String(currentTotal) : '')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex justify-between items-center gap-2 border-t border-slate-200 pt-2 mt-2">
      <span className="text-sm text-slate-600">Total des taxes</span>
      <div className="flex items-center gap-1">
        {saving && <ThinkingOrb size={11} ink className="text-slate-400" />}
        <input
          type="text"
          inputMode="decimal"
          data-testid="receipt-total-taxes"
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
          disabled={saving}
          title="Modifier le total des taxes — réparti au prorata sur TPS / TVQ / Autres taxes"
          className="tabular-nums text-right bg-transparent border border-transparent hover:border-slate-300 focus:border-brand-500 focus:bg-white rounded px-2 py-0.5 w-28 text-sm font-medium text-slate-700 outline-none"
        />
      </div>
    </div>
  )
}

// Total dérivé, lecture seule : sous-total (articles) + TPS + TVQ + autres taxes.
// Affiche un repère discret si le total imprimé sur le reçu (receipt.total stocké)
// diverge — signe que les lignes ne sont pas encore HT (ex. prix Amazon taxes
// incluses), pour inviter l'utilisateur à corriger l'article plutôt que de fausser
// la compta.
// Contrôle du total contre le DOCUMENT : le serveur relit le texte du PDF et dit si
// le montant affiché figure sur une ligne « total » du papier (aucun appel IA).
// Rien pour les photos et les PDF scannés (pas de couche texte) — l'indicateur
// n'apparaît que quand la vérification est possible.
function useDocumentAmountCheck(receipt, amount) {
  const [check, setCheck] = useState(null)
  const id = receipt?.id
  const hasPdf = (receipt?.pages || []).some(p => p?.file_type === '.pdf')
  useEffect(() => {
    if (!id || !hasPdf || !amount) { setCheck(null); return }
    let alive = true
    // Le total suit les éditions de lignes/taxes : on laisse retomber la poussière.
    const t = setTimeout(() => {
      api.saleReceipts.amountCheck(id, amount)
        .then(r => { if (alive) setCheck(r) })
        .catch(() => { if (alive) setCheck(null) })
    }, 500)
    return () => { alive = false; clearTimeout(t) }
  }, [id, hasPdf, amount])
  return check
}

const CURRENCY_SIGNS = { EUR: '€', GBP: '£', CHF: 'CHF', USD: '$ US', CAD: '$' }

function DocumentAmountBadge({ receipt, amount }) {
  const check = useDocumentAmountCheck(receipt, amount)
  if (!check || !check.text_available || check.status === 'unknown') return null
  if (check.status === 'confirmed') {
    return (
      <span
        data-testid="receipt-amount-doc-check"
        data-status="confirmed"
        className="inline-flex items-center text-green-600"
        title={`Montant retrouvé sur le document${check.matched_label ? ` — « ${check.matched_label.replace(/\s+/g, ' ').trim()} »` : ''}`}
      >
        <CheckCircle size={12} />
      </span>
    )
  }
  const cur = check.document_currency && check.document_currency !== (receipt.currency || 'CAD')
    ? CURRENCY_SIGNS[check.document_currency] || check.document_currency
    : null
  return (
    <span
      data-testid="receipt-amount-doc-check"
      data-status="mismatch"
      className="inline-flex items-center gap-1 text-[11px] text-red-700"
      title={check.document_total != null
        ? `Le document imprime un autre montant${check.matched_label ? ` — « ${check.matched_label.replace(/\s+/g, ' ').trim()} »` : ''}. Vérifiez le total avant de publier.`
        : 'Ce montant n’apparaît pas sur le document. Vérifiez le total avant de publier.'}
    >
      <AlertCircle size={12} />
      {check.document_total != null
        ? `doc : ${cur ? `${check.document_total.toFixed(2).replace('.', ',')} ${cur}` : fmtCad(check.document_total)}`
        : 'absent du doc'}
    </span>
  )
}

function DerivedTotalRow({ receipt }) {
  const total = computedTotal(receipt)
  const printed = receipt.total
  const drift = printed != null && Math.abs(round2(printed) - total) > 0.01
  return (
    <div className="flex justify-between items-center gap-2">
      <span className="text-sm font-semibold text-slate-800">
        Total
        <span className="text-[11px] text-slate-400 ml-1 font-normal">(articles + taxes)</span>
      </span>
      <div className="flex items-center gap-2">
        <DocumentAmountBadge receipt={receipt} amount={total} />
        {drift && (
          <span
            className="text-[11px] text-amber-600"
            data-testid="receipt-total-drift"
            title="Le reçu indique un total différent — vérifiez que les lignes d'articles sont hors taxes"
          >
            reçu : {fmtCad(printed)}
          </span>
        )}
        <span
          data-testid="receipt-amount-total"
          className="tabular-nums text-right px-2 py-0.5 w-28 text-base font-bold text-slate-900"
        >
          {fmtCad(total)}
        </span>
      </div>
    </div>
  )
}

// Indicateur de réconciliation (lecture seule) : compare la taxe IMPLIQUÉE par les codes
// de taxe par ligne au total des taxes du document. Ne s'affiche que si au moins une ligne
// porte un code explicite. Ne modifie jamais les taxes du document.
function TaxReconciliationRow({ receipt, taxCodes = [] }) {
  const taxNameById = new Map((taxCodes || []).map(c => [c.Id, c.Name]))
  const rec = impliedTaxFromLineCodes(receipt, taxNameById)
  if (!rec.applicable) return null

  const documentTax = round2((receipt.tps || 0) + (receipt.tvq || 0) + (receipt.other_taxes || 0))
  const diff = round2(rec.implied - documentTax)
  // Réconciliation concluante seulement si toutes les lignes ont un code connu.
  const conclusive = rec.allExplicit && !rec.unknown
  const matches = conclusive && Math.abs(diff) <= 0.02

  let badge
  if (!conclusive) {
    badge = <span className="text-slate-400">vérification partielle{rec.unknown ? ' (taux inconnu)' : ' (lignes au code du document)'}</span>
  } else if (matches) {
    badge = <span className="inline-flex items-center gap-1 text-green-700"><CheckCircle size={11} /> correspond</span>
  } else {
    badge = <span className="inline-flex items-center gap-1 text-red-700"><AlertCircle size={11} /> écart {fmtCad(Math.abs(diff))}</span>
  }

  return (
    <div className="flex justify-between items-center gap-2 text-[11px]" data-testid="receipt-tax-reconciliation">
      <span className="text-slate-500" title="Taxe calculée à partir des codes de taxe choisis sur chaque ligne — sert à vérifier qu'ils correspondent aux taxes saisies.">
        Selon les codes par ligne
      </span>
      <div className="flex items-center gap-2">
        {badge}
        <span className="tabular-nums text-right px-2 w-28 text-slate-600">{fmtCad(rec.implied)}</span>
      </div>
    </div>
  )
}

function TabButton({ active, onClick, children, testId }) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active ? 'border-brand-500 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700'
      }`}
    >
      {children}
    </button>
  )
}

const HISTORY_ACTION_META = {
  created:    { label: 'Document ajouté',       Icon: Plus,           color: 'text-green-700 bg-green-100' },
  updated:    { label: 'Modifié',               Icon: Pencil,         color: 'text-blue-700 bg-blue-100' },
  archived:   { label: 'Archivé',               Icon: Archive,        color: 'text-amber-700 bg-amber-100' },
  unarchived: { label: 'Désarchivé',            Icon: ArchiveRestore, color: 'text-slate-700 bg-slate-200' },
  published:  { label: 'Publié sur QuickBooks', Icon: BookOpen,       color: 'text-green-700 bg-green-100' },
  month_attached: { label: 'Joint aux transactions du mois', Icon: Paperclip, color: 'text-indigo-700 bg-indigo-100' },
  qb_auto_matched: { label: 'Appariée par QuickBooks (apparaît payée)', Icon: AlertCircle, color: 'text-amber-700 bg-amber-100' },
  anomaly_override: { label: 'Doublon ignoré (justifié)', Icon: AlertCircle, color: 'text-amber-700 bg-amber-100' },
  fiscal_override: { label: 'Écart fiscal forcé', Icon: AlertCircle, color: 'text-amber-700 bg-amber-100' },
}

function HistoryTab({ events, loading }) {
  if (loading) return <div className="py-10 text-center text-slate-400 text-sm">Chargement de l'historique…</div>
  if (!events || events.length === 0) return <div className="py-10 text-center text-slate-400 text-sm">Aucun historique.</div>

  const created = events.find(e => e.action === 'created')
  return (
    <div className="max-w-2xl" data-testid="history-tab">
      {created && (
        <div className="mb-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-400 font-medium">Ajouté par</p>
          <p className="text-sm text-slate-800 mt-0.5">
            <span className="font-medium" data-testid="history-creator">{created.user_name || 'Utilisateur inconnu'}</span>
            <span className="text-slate-400"> · {fmtDateTime(created.created_at)}</span>
          </p>
        </div>
      )}
      <ol className="relative border-l border-slate-200 ml-3">
        {events.map(ev => {
          const meta = HISTORY_ACTION_META[ev.action] || { label: ev.action, Icon: Clock, color: 'text-slate-600 bg-slate-100' }
          const { Icon } = meta
          return (
            <li key={ev.id} className="mb-6 ml-6">
              <span className={`absolute -left-3 flex items-center justify-center w-6 h-6 rounded-full ring-4 ring-white ${meta.color}`}>
                <Icon size={12} />
              </span>
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm text-slate-800">
                  {meta.label}
                  {ev.detail && <span className="text-slate-500"> — {ev.detail}</span>}
                </p>
                <span className="text-xs text-slate-400 whitespace-nowrap">{fmtDateTime(ev.created_at)}</span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">par {ev.user_name || 'Utilisateur inconnu'}</p>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// Kinds bloquants pour la publication QB (server/services/transactionAnomalies.js).
// `already_in_qb` / `possible_duplicate_in_qb` = la pièce existe déjà au grand livre
// QuickBooks : la comptabiliser de nouveau créerait une seconde dette fournisseur.
const BLOCKING_ANOMALY_KINDS = new Set(['duplicate_number', 'duplicate_amount', 'already_in_qb', 'possible_duplicate_in_qb'])

// Bandeau « document obsolète » : la pièce n'a rien à apporter à la comptabilité —
// soit un document à 0 $ (facture soldée / confirmation de débit automatique), soit
// la copie d'un document déjà publié sur QuickBooks. On montre POURQUOI (message de
// l'anomalie), le lien vers la transaction QuickBooks existante pour vérifier d'un clic, et
// l'archivage en un clic. « À comptabiliser quand même » rejette l'anomalie source.
function ObsoleteBanner({ receipt, acting, onArchive, onDismissed }) {
  const { addToast } = useToast()
  const ob = receipt?.obsolete
  if (!ob) return null
  const isZero = ob.reason === 'zero_total'

  async function dismiss() {
    try {
      await api.anomalies.dismiss(ob.anomaly_id, isZero
        ? 'Document à 0 $ à traiter quand même (depuis la fiche du reçu)'
        : 'Confirmé non-doublon depuis la fiche du reçu')
      addToast({ message: 'Statut obsolète levé — le document redevient à traiter.', type: 'success' })
      onDismissed?.()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3" data-testid="receipt-obsolete-banner">
      <div className="flex items-start gap-3 py-1">
        <FileX size={16} className="text-amber-600 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-900">
            {isZero
              ? 'Document sans objet comptable — rien à payer ni à comptabiliser'
              : 'Document obsolète — déjà comptabilisé dans QuickBooks'}
          </p>
          <p className="text-sm text-amber-800 leading-snug mt-0.5">{ob.message}</p>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            {ob.qb_url && (
              <a href={ob.qb_url} target="_blank" rel="noopener noreferrer" data-testid="receipt-obsolete-qb-link"
                className="inline-flex items-center gap-1 text-xs text-amber-900 underline hover:no-underline">
                <BookOpen size={11} /> Voir la transaction dans QuickBooks (#{ob.qb_id})
              </a>
            )}
            {ob.other_receipt_id && (
              <Link to={`/sale-receipts/${ob.other_receipt_id}`} className="text-xs text-amber-900 underline hover:no-underline">
                Ouvrir le document original
              </Link>
            )}
            {ob.achat_id && (
              <Link to="/fournisseurs/achats" className="text-xs text-amber-900 underline hover:no-underline">
                Voir dans les achats fournisseurs
              </Link>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={dismiss}
            data-testid="receipt-obsolete-dismiss"
            title="Ce document doit bien être traité — lever le statut obsolète"
            className="text-xs font-medium text-amber-800 border border-amber-300 bg-white rounded-lg px-2.5 py-1.5 hover:bg-amber-100"
          >
            À comptabiliser quand même
          </button>
          <button
            onClick={onArchive}
            disabled={acting}
            data-testid="receipt-obsolete-archive"
            title="Classer ce document sans le comptabiliser"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-white bg-amber-600 rounded-lg px-2.5 py-1.5 hover:bg-amber-700 disabled:opacity-50"
          >
            <Archive size={12} /> Archiver ce document
          </button>
        </div>
      </div>
    </div>
  )
}

// Bandeau anti-double-comptabilisation. Visible avant toute action sur le document :
// la mise en garde ne doit pas attendre le clic sur « Publier ».
// `excludeId` : anomalie déjà présentée par le bandeau « obsolète » — pas de doublon d'affichage.
function DuplicateBanner({ receiptId, excludeId }) {
  const [rows, setRows] = useState([])
  const { addToast } = useToast()

  const load = useCallback(() => {
    if (!receiptId) return
    api.anomalies.list({ status: 'open', entity_id: receiptId })
      .then(out => setRows((out.data || []).filter(a => BLOCKING_ANOMALY_KINDS.has(a.kind) && a.id !== excludeId)))
      .catch(() => setRows([]))
  }, [receiptId, excludeId])

  useEffect(() => { load() }, [load])

  async function dismiss(a) {
    try {
      await api.anomalies.dismiss(a.id, 'Confirmé non-doublon depuis la fiche du reçu')
      setRows(rs => rs.filter(r => r.id !== a.id))
      addToast({ message: 'Alerte levée — la publication est débloquée.', type: 'success' })
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }

  if (!rows.length) return null
  return (
    <div className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3" data-testid="receipt-duplicate-banner">
      {rows.map(a => (
        <div key={a.id} className="flex items-start gap-3 py-1">
          <AlertCircle size={16} className="text-red-600 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-red-800">
              {a.kind === 'already_in_qb' ? 'Facture déjà comptabilisée — ne pas republier'
                : a.kind === 'possible_duplicate_in_qb' ? 'Peut-être déjà comptabilisée — à vérifier'
                  : 'Doublon probable — à vérifier'}
            </p>
            <p className="text-sm text-red-700 leading-snug mt-0.5">{a.message}</p>
            {a.details?.achat_id && (
              <Link to="/fournisseurs/achats" className="text-xs text-red-800 underline hover:no-underline">Voir dans les achats fournisseurs</Link>
            )}
            {a.details?.other_receipt_id && (
              <Link to={`/sale-receipts/${a.details.other_receipt_id}`} className="text-xs text-red-800 underline hover:no-underline">Ouvrir l'autre reçu</Link>
            )}
          </div>
          <button
            onClick={() => dismiss(a)}
            data-testid="receipt-duplicate-dismiss"
            title="Lever l'alerte et autoriser la publication"
            className="shrink-0 text-xs font-medium text-red-700 border border-red-300 bg-white rounded-lg px-2.5 py-1.5 hover:bg-red-100"
          >
            Ce n'est pas un doublon
          </button>
        </div>
      ))}
    </div>
  )
}

// Bandeau « relevé mensuel de fournisseur prépayé » (Twilio). Visible seulement
// Sortie d'argent au relevé qui porte cette facture (receipt.bank_txn, posé par
// le rapprochement bancaire dans un sens ou dans l'autre). Une ligne, pas un
// bandeau : c'est une information de contexte, pas une action à faire.
function BankTxnLine({ receipt }) {
  const t = receipt?.bank_txn
  if (!t) return null
  return (
    <div className="mb-3 flex items-center gap-1.5 text-xs text-slate-500" data-testid="receipt-bank-txn">
      <Landmark size={13} className="text-slate-400 shrink-0" />
      <span>Débité le {fmtDate(t.txn_date)}</span>
      <span className="text-slate-300">·</span>
      <Link to={`/rapprochement?compte=${t.account_id}`} className="text-blue-600 hover:underline">
        {t.account_name}
      </Link>
      <span className="text-slate-300">·</span>
      <span>{fmtCad(Math.abs(t.amount))}</span>
      {t.match_method === 'auto' && <span className="text-slate-400">(auto)</span>}
    </div>
  )
}

// quand le serveur détecte ce type de document (receipt.prepaid_statement) : le
// fournisseur est un compte prépayé, donc la dépense du mois est DÉJÀ comptabilisée
// par les recharges. Rien à publier — un clic joint le document en pièce jointe aux
// transactions QuickBooks du mois couvert. Le mois détecté reste modifiable.
function PrepaidStatementBanner({ receipt, onDone, onArchive }) {
  const { addToast } = useToast()
  const st = receipt?.prepaid_statement
  const [month, setMonth] = useState(st?.month || '')
  const [busy, setBusy] = useState(false)

  useEffect(() => { setMonth(st?.month || '') }, [st?.month])

  if (!st) return null
  const last = st.attached_result
  const sameMonth = st.attached_at && st.attached_month === month

  async function attach() {
    setBusy(true)
    try {
      const r = await api.saleReceipts.attachToMonthQb(receipt.id, month)
      const ledgerNote = r.ledger_entry ? ` — facture de ${fmtCad(r.ledger_entry.amount)} enregistrée au solde prépayé` : ''
      addToast({
        message: r.transactions.length
          ? `Joint à ${r.transactions.length} transaction(s) QuickBooks — ${r.attached} fichier(s) téléversé(s)${r.skipped ? `, ${r.skipped} déjà présent(s)` : ''}${ledgerNote}`
          : 'Aucune transaction QuickBooks trouvée pour ce fournisseur dans ce mois',
        type: r.transactions.length ? 'success' : 'error',
      })
      // Rattachement réussi : rien d'autre à comptabiliser pour ce document,
      // on l'archive comme les autres reçus déjà traités — il sort de la file
      // « À publier » (mêmes toast + retour liste que l'archivage manuel).
      if (r.transactions.length && !receipt.archived_at) await onArchive?.()
      else onDone?.()
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-indigo-300 bg-indigo-50 px-4 py-3" data-testid="prepaid-statement-banner">
      <div className="flex items-start gap-3 py-1">
        <Paperclip size={16} className="text-indigo-600 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-indigo-900">
            Relevé mensuel {st.vendor} — {st.month_label}
          </p>
          <p className="text-sm text-indigo-800 leading-snug mt-0.5">
            Récapitulatif du mois : la dépense est déjà comptabilisée dans QuickBooks par les recharges de la période, rien à publier.
            Ce document se joint en pièce jointe aux transactions QuickBooks du mois couvert
            <span className="text-indigo-600"> (mois détecté d'après la {st.month_source})</span>.
            {' '}S'il s'agit de la facture d'usage (pas du reçu de paiement), son montant met aussi à jour le solde du compte prépayé dans l'ERP.
          </p>
          {st.attached_at && (
            <p className="text-xs text-indigo-700 mt-1" data-testid="prepaid-statement-last">
              Dernier rattachement : {fmtDateTime(st.attached_at)} — {last?.transactions?.length || 0} transaction(s) de {st.attached_month}
              {last?.ledger_entry && ` — facture de ${fmtCad(last.ledger_entry.amount)} enregistrée au solde prépayé`}
              {(last?.transactions || []).map(t => t.qb_url && (
                <a key={t.qb_txn_id} href={t.qb_url} target="_blank" rel="noopener noreferrer"
                  className="ml-2 underline hover:no-underline">
                  {t.entry_date} · {fmtCad(t.amount)}
                </a>
              ))}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input
            type="month"
            value={month}
            onChange={e => setMonth(e.target.value)}
            data-testid="prepaid-statement-month"
            title="Mois des transactions QuickBooks visées"
            className="text-xs border border-indigo-300 rounded-lg px-2 py-1.5 bg-white text-indigo-900"
          />
          <button
            onClick={attach}
            disabled={busy || !month}
            data-testid="prepaid-statement-attach"
            title="Joindre ce document aux transactions QuickBooks du mois"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-white bg-indigo-600 rounded-lg px-2.5 py-1.5 hover:bg-indigo-700 disabled:opacity-50"
          >
            <Paperclip size={12} />
            {busy ? 'Rattachement…' : sameMonth ? 'Rejoindre aux transactions' : 'Joindre aux transactions QuickBooks'}
          </button>
        </div>
      </div>
    </div>
  )
}

// Fiche d'un reçu / facture fournisseur. Panneau latéral large : le PDF et
// l'extraction cohabitent.
export default function SaleReceiptDetail({ recordId, onClose }) {
  const id = recordId
  const navigate = useNavigate()
  const leave = () => onClose?.()
  const { addToast } = useToast()
  const confirm = useConfirm()
  const { record: receipt, setRecord: setReceipt, loading, loadError, reload: load } =
    useDetailRecord(() => api.saleReceipts.get(id), [id], { clearOnError: true })
  const [conversionOpen, setConversionOpen] = useState(false)
  const [fileUrl, setFileUrl] = useState(null)
  const [allIds, setAllIds] = useState([])
  const [acting, setActing] = useState(false)
  const [tab, setTab] = useState('details')
  const [history, setHistory] = useState(null)
  // Codes de taxe QB partagés par le sélecteur de ligne (Articles) et l'indicateur de
  // réconciliation (Montants). Une seule requête ; échec (QB non connecté) → liste vide.
  const [taxCodes, setTaxCodes] = useState([])
  // Comptes QB — le sélecteur de compte de dépense PAR LIGNE (Articles) en a besoin
  // même quand le formulaire de publication n'est pas affiché (reçu déjà publié).
  const [accounts, setAccounts] = useState([])

  useEffect(() => {
    let cancelled = false
    api.quickbooks.taxCodes()
      .then(codes => { if (!cancelled) setTaxCodes(codes || []) })
      .catch(() => { if (!cancelled) setTaxCodes([]) })
    api.quickbooks.accounts({ all: 1 })
      .then(accs => { if (!cancelled) setAccounts(accs || []) })
      .catch(() => { if (!cancelled) setAccounts([]) })
    return () => { cancelled = true }
  }, [])

  // Charge l'historique à la demande quand l'onglet est ouvert (et au changement de reçu).
  useEffect(() => {
    if (tab !== 'history' || !receipt?.id) return
    let cancelled = false
    setHistory(null)
    api.saleReceipts.history(receipt.id)
      .then(r => { if (!cancelled) setHistory(r.data || []) })
      .catch(() => { if (!cancelled) setHistory([]) })
    return () => { cancelled = true }
  }, [tab, receipt?.id])

  async function handleArchiveToggle() {
    if (!receipt) return
    setActing(true)
    try {
      const updated = receipt.archived_at
        ? await api.saleReceipts.unarchive(receipt.id)
        : await api.saleReceipts.archive(receipt.id)
      setReceipt(updated)
      addToast({ message: updated.archived_at ? 'Reçu archivé' : 'Reçu désarchivé', type: 'success' })
      // À l'archivage, on sort du document et on revient à l'interface Extraction de données.
      if (updated.archived_at) leave()
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
    } finally {
      setActing(false)
    }
  }

  // `ask` : demande confirmation avant de relancer. Depuis l'état d'erreur il n'y a
  // rien à perdre (aucune donnée extraite) → appel direct. Depuis l'en-tête d'un
  // document déjà lu, la relecture ÉCRASE les données extraites ET les corrections
  // manuelles : on confirme, l'action n'est pas réversible.
  async function handleReExtract({ ask = false } = {}) {
    if (!receipt) return
    if (ask) {
      const ok = await confirm({
        title: 'Relire le document ?',
        message: receipt.quickbooks_id
          ? "L'IA relira le document et remplacera les données extraites — les corrections manuelles seront perdues. L'écriture déjà publiée dans QuickBooks n'est pas modifiée."
          : "L'IA relira le document et remplacera les données extraites — les corrections manuelles seront perdues.",
        confirmLabel: 'Relire',
        danger: false,
      })
      if (!ok) return
    }
    setActing(true)
    try {
      const updated = await api.saleReceipts.reExtract(receipt.id)
      setReceipt(updated)
      addToast({ message: 'Relance de l\'extraction…', type: 'success' })
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
    } finally {
      setActing(false)
    }
  }

  async function handleDelete() {
    if (!receipt) return
    const ok = await confirm({
      title: 'Supprimer ce reçu ?',
      message: `Le reçu « ${receipt.company || receipt.original_name} » et son fichier seront supprimés. Cette action est irréversible.`,
      confirmLabel: 'Supprimer',
      danger: true,
    })
    if (!ok) return
    setActing(true)
    try {
      await api.saleReceipts.delete(receipt.id)
      addToast({ message: 'Reçu supprimé', type: 'success' })
      leave()
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      setActing(false)
    }
  }

  // Ouvrir un reçu le marque lu (comme un courriel Gmail) — couvre aussi
  // l'arrivée directe par URL et la navigation prev/next.
  useEffect(() => {
    if (id) api.saleReceipts.markRead(id).catch(() => {})
  }, [id])

  async function handleMarkUnread() {
    if (!receipt) return
    try {
      await api.saleReceipts.markUnread(receipt.id)
      addToast({ message: 'Marqué non lu', type: 'success' })
      leave()
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
    }
  }

  useEffect(() => {
    // Priorité à l'ordre de la vue mémorisé dans sessionStorage (set par
    // SaleReceipts.jsx au clic sur une ligne). Fallback : ordre DB complet
    // si l'utilisateur arrive directement par URL.
    try {
      const stored = sessionStorage.getItem('sale_receipts:nav_ids')
      if (stored) {
        const arr = JSON.parse(stored)
        if (Array.isArray(arr) && arr.length) {
          setAllIds(arr.map(String))
          return
        }
      }
    } catch {}
    api.saleReceipts.list({ limit: 'all' })
      .then(res => setAllIds((res.data || []).map(r => String(r.id))))
      .catch(() => {})
  }, [])

  useEntityListRealtime('sale_receipt', (updater) => {
    setReceipt(prev => {
      if (!prev) return prev
      const next = typeof updater === 'function' ? updater([prev]) : updater
      if (Array.isArray(next)) {
        const found = next.find(r => String(r.id) === String(id))
        return found || prev
      }
      return prev
    })
  })

  // Poll while the extraction is in progress, just like the old page.
  useEffect(() => {
    if (!receipt || (receipt.status !== 'processing' && receipt.status !== 'pending')) return
    const t = setInterval(async () => {
      try {
        const fresh = await api.saleReceipts.get(id)
        setReceipt(fresh)
        if (fresh.status !== 'processing' && fresh.status !== 'pending') clearInterval(t)
      } catch {}
    }, 2000)
    return () => clearInterval(t)
  }, [receipt?.status, id])

  useEffect(() => {
    setFileUrl(null)
    if (!receipt?.id) return
    let url = null
    api.saleReceipts.fileBlob(receipt.id)
      .then(blob => { url = URL.createObjectURL(blob); setFileUrl(url) })
      .catch(() => setFileUrl(null))
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [receipt?.id])

  const currentIdx = allIds.indexOf(String(id))
  const prevId = currentIdx > 0 ? allIds[currentIdx - 1] : null
  const nextId = currentIdx >= 0 && currentIdx < allIds.length - 1 ? allIds[currentIdx + 1] : null

  const pending = detailPending({ loading, loadError, onRetry: load, record: receipt, notFound: 'Reçu introuvable.' })
  if (pending) return pending

  const isPdf = receipt.file_type === '.pdf'

  return (
    <>
      <DetailShell className="p-6">
        {/* En-tête collé en haut : les actions (Relire, Archiver…) restent
            visibles quand on descend dans la fiche. */}
        <div className="sticky top-0 z-30 -mx-6 px-6 -mt-6 pt-6 pb-3 mb-4 bg-slate-50/95 backdrop-blur-sm border-b border-slate-200 flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <PageTitle className="min-w-0" titleClassName="text-2xl font-bold text-slate-900 truncate">
                {receipt.company || receipt.original_name}
              </PageTitle>
              <StatusBadge status={receipt.status} />
              {receipt.quickbooks_id && (
                receipt.quickbooks_url ? (
                  <a
                    href={receipt.quickbooks_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="qb-link"
                    className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 hover:bg-green-200 px-2 py-0.5 rounded-full"
                  >
                    <BookOpen size={10} /> QuickBooks #{receipt.quickbooks_id}
                  </a>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
                    <BookOpen size={10} /> QuickBooks #{receipt.quickbooks_id}
                  </span>
                )
              )}
            </div>
            {receipt.address && <p className="text-slate-500 text-sm mt-1">{receipt.address}</p>}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => prevId && navigate(`/sale-receipts/${prevId}`, { replace: true })}
              disabled={!prevId}
              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              data-testid="receipt-prev"
              title="Reçu précédent"
              aria-label="Reçu précédent"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => nextId && navigate(`/sale-receipts/${nextId}`, { replace: true })}
              disabled={!nextId}
              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              data-testid="receipt-next"
              title="Reçu suivant"
              aria-label="Reçu suivant"
            >
              <ChevronRight size={16} />
            </button>

            <div className="w-px h-5 bg-slate-200 mx-1" />

            {receipt.status !== 'processing' && receipt.status !== 'pending' && (
              <button
                onClick={() => handleReExtract({ ask: true })}
                disabled={acting}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                data-testid="receipt-reread"
                title="Relire le document par l'IA et réextraire les données (les corrections manuelles seront écrasées)"
              >
                {acting ? <ThinkingOrb state="working" size={14} ink /> : <RefreshCw size={14} />}
                Relire
              </button>
            )}
            <button
              onClick={handleMarkUnread}
              disabled={acting}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
              data-testid="receipt-mark-unread"
              title="Remettre en gras dans la liste et y retourner"
            >
              <Mail size={14} />
              Marquer non lu
            </button>
            <button
              onClick={handleArchiveToggle}
              disabled={acting}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
              data-testid="receipt-archive"
              title={receipt.archived_at ? 'Désarchiver' : 'Archiver'}
            >
              {receipt.archived_at ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              {receipt.archived_at ? 'Désarchiver' : 'Archiver'}
            </button>
            <button
              onClick={handleDelete}
              disabled={acting}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
              data-testid="receipt-delete"
              title="Supprimer"
            >
              <Trash2 size={14} />
              Supprimer
            </button>
          </div>
        </div>

        <ObsoleteBanner receipt={receipt} acting={acting} onArchive={handleArchiveToggle} onDismissed={load} />
        <DuplicateBanner receiptId={receipt.id} excludeId={receipt.obsolete?.anomaly_id} />
        <PrepaidStatementBanner receipt={receipt} onDone={load} onArchive={handleArchiveToggle} />
        <BankTxnLine receipt={receipt} />

        {/* Onglets */}
        <div className="flex items-center gap-1 border-b border-slate-200 mb-5">
          <TabButton active={tab === 'details'} onClick={() => setTab('details')} testId="tab-details">Détails</TabButton>
          <TabButton active={tab === 'history'} onClick={() => setTab('history')} testId="tab-history">Historique</TabButton>
        </div>

        {tab === 'history' && <HistoryTab events={history} loading={history === null} />}

        {tab === 'details' && (receipt.status === 'processing' ? (
          <div className="flex flex-col items-center justify-center py-20 text-blue-500 gap-3">
            <ThinkingOrb state="working" size={64} />
            <p className="font-medium">Extraction en cours…</p>
            <p className="text-slate-400 text-sm">Les données seront disponibles dans quelques secondes</p>
          </div>
        ) : receipt.status === 'error' ? (
          <div className="flex flex-col items-center justify-center py-20 text-red-500 gap-3">
            <AlertCircle size={48} strokeWidth={1} />
            <p className="font-medium">Erreur d'extraction</p>
            {receipt.error_message && <p className="text-slate-500 text-sm text-center max-w-sm">{receipt.error_message}</p>}
            <button
              onClick={() => handleReExtract()}
              disabled={acting}
              className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 disabled:opacity-50"
              data-testid="receipt-re-extract"
              title="Relancer l'extraction sur le fichier déjà téléversé"
            >
              {acting ? <ThinkingOrb state="working" size={14} ink /> : <RefreshCw size={14} />}
              Relancer l'extraction
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Original file preview */}
            {fileUrl && (
              <div className="bg-slate-100 rounded-xl border border-slate-200 overflow-auto p-3 flex items-start justify-center min-h-[400px]">
                {isPdf ? (
                  <iframe src={fileUrl} title="Reçu original" className="w-full h-full min-h-[600px] rounded shadow" />
                ) : (
                  <img src={fileUrl} alt="Reçu original" className="max-w-full object-contain rounded shadow" />
                )}
              </div>
            )}

            {/* Extracted data */}
            <div className="space-y-6">
              {receipt.status === 'done' && !receipt.quickbooks_id && (
                <QBPublishForm
                  key={receipt.id}
                  receipt={receipt}
                  onUpdate={setReceipt}
                  onOpenConversion={() => setConversionOpen(true)}
                  onLeave={() => {
                    // Enchaînement : on file directement au document suivant de la liste
                    // (même ordre que les flèches ‹ › — vue filtrée/triée mémorisée au clic
                    // sur la ligne) pour traiter la pile sans repasser par le menu. Dernier
                    // document de la liste → retour à l'interface Extraction de données.
                    if (nextId) navigate(`/sale-receipts/${nextId}`, { replace: true }); else leave()
                  }}
                />
              )}

              {/* Carte de champs commune : une seule liste, réordonnable et
                  masquable depuis la fiche (bouton « Personnaliser les
                  champs »). Les champs personnalisés de la table s'y posent
                  seuls — d'où `record`. */}
              <DetailFieldGrid
                entityType="sale_receipts"
                record={receipt}
                className=""
                testId="receipt-fields"
              >
                <DetailField id="company" label="Entreprise">
                  <EditableTextField receipt={receipt} field="company" onUpdate={setReceipt} testId="receipt-company" />
                </DetailField>
                <DetailField id="receipt_date" label="Date">
                  <EditableDateField receipt={receipt} field="receipt_date" onUpdate={setReceipt} testId="receipt-date" />
                </DetailField>
                <DetailField id="receipt_number" label="N° de reçu">
                  <EditableTextField receipt={receipt} field="receipt_number" onUpdate={setReceipt} testId="receipt-number" />
                </DetailField>
                <DetailField id="payment_method" label="Mode de paiement">
                  <EditableTextField receipt={receipt} field="payment_method" onUpdate={setReceipt} testId="receipt-payment-method" />
                </DetailField>
                <DetailField id="currency" label="Devise">
                  <CurrencyField receipt={receipt} onUpdate={setReceipt} />
                </DetailField>
                {/* Le nom du fichier nu attend dans « Ajouter un champ » : la
                    pièce justificative ci-dessous le porte déjà, en cliquable. */}
                <DetailField id="original_name" label="Fichier" defaultHidden>
                  <InfoField value={receipt.original_name} />
                </DetailField>
                <DetailField id="justificatif" label="Pièce justificative">
                  <ReceiptAttachment receipt={receipt} compact={false} />
                </DetailField>
              </DetailFieldGrid>

              <EditableItems receipt={receipt} onUpdate={setReceipt} taxCodes={taxCodes} accounts={accounts} />

              {(() => {
                // Mode « piloté par les codes » : un code de taxe par défaut est défini
                // et le reçu n'est pas encore publié → TPS/TVQ recalculées des codes
                // (lecture seule). Sinon, saisie manuelle classique.
                const codeDriven = !!receipt.tax_code_id && !receipt.quickbooks_id
                const codeHint = codeDriven ? '(selon les codes)' : undefined
                return (
              <div>
                <div className="flex items-baseline justify-between mb-2">
                  <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
                    Montants
                    {/* Conversion de devise (ex-onglet USD_CAD du sheet CTB) : facture en USD
                        payée sur une carte CAD → ventilation au taux réellement subi. */}
                    <button
                      type="button"
                      onClick={() => setConversionOpen(true)}
                      data-testid="open-currency-conversion"
                      title="Conversion de devise — facture dans une devise, carte chargée dans une autre"
                      aria-label="Conversion de devise"
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-normal text-slate-400 hover:text-brand-600 hover:bg-slate-100 transition-colors"
                    >
                      <ArrowLeftRight size={12} />
                      {(receipt.currency || 'CAD').toUpperCase() === 'CAD' ? 'Convertir' : `Convertir en CAD`}
                    </button>
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    {codeDriven ? 'Taxes calculées d’après le code de taxe (document + exceptions par ligne).' : 'Cliquez pour modifier.'}
                  </p>
                </div>
                <div className="bg-slate-50 rounded-lg p-4 space-y-2">
                  {/* Facture de transport multi-expéditions : le sommaire extrait
                      (miroir de celui imprimé en haut de la facture) précède les
                      montants du dossier, pour comparaison directe avec le papier. */}
                  <ExtractedTaxDetail receipt={receipt} />
                  <EditableAmountRow receipt={receipt} field="subtotal"    label="Sous-total (avant taxes)" onUpdate={setReceipt} readOnly={(receipt.items || []).some(it => it && it.total != null)} hint={(receipt.items || []).some(it => it && it.total != null) ? '(somme des lignes)' : undefined} />
                  <EditableAmountRow receipt={receipt} field="tps"         label="TPS / GST"                onUpdate={setReceipt} readOnly={codeDriven} hint={codeHint} />
                  <EditableAmountRow receipt={receipt} field="tvq"         label="TVQ / QST / PST"          onUpdate={setReceipt} readOnly={codeDriven} hint={codeHint} />
                  <EditableAmountRow receipt={receipt} field="other_taxes" label="Autres taxes"             onUpdate={setReceipt} readOnly={codeDriven} hint={codeHint} />
                  {!codeDriven && <EditableTotalTaxesRow receipt={receipt} onUpdate={setReceipt} />}
                  {!codeDriven && <TaxReconciliationRow receipt={receipt} taxCodes={taxCodes} />}
                  <div className="border-t border-slate-200 pt-2 mt-2">
                    <DerivedTotalRow receipt={receipt} />
                  </div>
                </div>
              </div>
                )
              })()}

              <EditableMemoField receipt={receipt} onUpdate={setReceipt} />
            </div>
          </div>
        ))}
      </DetailShell>

      <CurrencyConversionModal
        isOpen={conversionOpen}
        onClose={() => setConversionOpen(false)}
        receipt={receipt}
        onApplied={updated => {
          setReceipt(updated)
          addToast({ message: 'Montants convertis', type: 'success' })
        }}
      />
    </>
  )
}
