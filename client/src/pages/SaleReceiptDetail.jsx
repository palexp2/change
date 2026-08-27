import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, ChevronLeft, ChevronRight,
  RefreshCw, AlertCircle, CheckCircle, Clock, BookOpen, ReceiptText,
  Plus, Trash2, Archive, ArchiveRestore, Pencil, Mail, Sparkles, FileX, Paperclip,
  ArrowLeftRight,
} from 'lucide-react'
import { api } from '../lib/api.js'
import { fmtDate, fmtDateTime } from '../lib/formatDate.js'
import { Layout } from '../components/Layout.jsx'
import Spinner from '../components/Spinner.jsx'
import { Modal } from '../components/Modal.jsx'
import { CurrencyConversionModal } from '../components/CurrencyConversionModal.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useEntityListRealtime } from '../lib/useRealtimeChannel.js'
import { findBestVendorMatch } from '../lib/vendorMatch.js'

import { fmtCad } from '../utils/formatters.js'
import { DetailLoadError } from '../components/DetailLoadError.jsx'

const round2 = x => Math.round((Number(x) || 0) * 100) / 100

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

function StatusBadge({ status }) {
  if (status === 'done')       return <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full"><CheckCircle size={10} /> Complété</span>
  if (status === 'processing') return <span className="inline-flex items-center gap-1 text-xs text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full"><RefreshCw size={10} className="animate-spin" /> En cours</span>
  if (status === 'error')      return <span className="inline-flex items-center gap-1 text-xs text-red-700 bg-red-100 px-2 py-0.5 rounded-full"><AlertCircle size={10} /> Erreur</span>
  return <span className="inline-flex items-center gap-1 text-xs text-gray-600 bg-gray-100 px-2 py-0.5 rounded-full"><Clock size={10} /> En attente</span>
}

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


function QBPublishForm({ receipt, onSuccess, onUpdate, onOpenConversion }) {
  const { addToast } = useToast()
  const [accounts, setAccounts] = useState([])
  const [vendors, setVendors] = useState([])
  const [taxCodes, setTaxCodes] = useState([])
  const [txTypes, setTxTypes] = useState([])
  const [vendorHistory, setVendorHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  // Champ à corriger signalé par la validation (locale ou serveur) — la section
  // correspondante est encadrée en rouge. Valeurs : vendor, expense_account,
  // payment_account, transaction_type, tax_code, currency.
  const [errorField, setErrorField] = useState(null)
  // Publication tardive : nombre de jours de retard quand le garde-fou des 30 jours
  // bloque. Non nul ⇒ le message rouge propose « Publier quand même » (le retard est
  // souvent légitime — facture comptabilisée après coup — mais doit être vu).
  const [staleDays, setStaleDays] = useState(null)
  // Doublon probable : le serveur refuse la publication tant qu'une anomalie « doublon »
  // est ouverte (cf. transactionAnomalies.js). Le blocage n'est pas une impasse — après
  // avoir LU le message, l'opérateur peut publier quand même en justifiant (la raison est
  // tracée au journal du reçu). Non nul ⇒ le message rouge propose la justification.
  const [anomalyBlocked, setAnomalyBlocked] = useState(false)
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
    Promise.all([api.quickbooks.accounts(), api.quickbooks.vendors(), api.quickbooks.taxCodes(), api.saleReceipts.transactionTypes()])
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
        const draftType = ['purchase', 'bill', 'cc_credit'].includes(receipt.quickbooks_type) ? receipt.quickbooks_type : null
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
        if (draftType) setType(draftType)
        else if (defaults?.qb_type) { setType(defaults.qb_type); fromProfile = true }
        if (draftExpenseId) setExpenseAccountId(draftExpenseId)
        else if (defaults?.expense_account_id) { setExpenseAccountId(defaults.expense_account_id); fromProfile = true }
        if (draftPaymentId) setPaymentAccountId(draftPaymentId)
        else if (defaults?.payment_account_id) { setPaymentAccountId(defaults.payment_account_id); fromProfile = true }
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
    const qbType = ['bill', 'cc_credit'].includes(txn.quickbooks_type) ? txn.quickbooks_type : 'purchase'
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

  const expenseAccounts = accounts.filter(a => ['Expense', 'Other Expense', 'Cost of Goods Sold', 'Other Current Asset'].includes(a.AccountType))
  const paymentAccounts = accounts.filter(a => ['Bank', 'Credit Card'].includes(a.AccountType))
  const accountLabel = a => (a.AcctNum ? `${a.AcctNum} — ${a.Name}` : a.Name)
  const vendorOptions  = vendors.map(v => ({ value: v.Id, label: v.DisplayName }))
  const expenseOptions = expenseAccounts.map(a => ({ value: a.Id, label: accountLabel(a) }))
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
    if (!transactionType) { fail('Sélectionnez le type de transaction (statut fiscal)', 'transaction_type'); return }
    if (!expenseAccountId) { fail('Sélectionnez un compte de dépense', 'expense_account'); return }
    if (type === 'purchase' && !paymentAccountId) { fail('Sélectionnez un compte de paiement', 'payment_account'); return }
    if (type === 'cc_credit') {
      if (!paymentAccountId) { fail('Sélectionnez un compte de carte de crédit', 'payment_account'); return }
      if (!creditCardOptions.some(o => o.value === paymentAccountId)) { fail('Le compte sélectionné n\'est pas un compte de carte de crédit', 'payment_account'); return }
    }
    if (type === 'purchase' && bankChargedTotal !== '') {
      const bank = Number(bankChargedTotal)
      if (!Number.isFinite(bank) || bank <= 0) { fail('Montant passé à la banque invalide', 'bank_charged_total'); return }
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
  async function doPublish(anomalyOverride = null) {
    setSubmitting(true)
    fail(null)
    try {
      await api.saleReceipts.pushToQb(receipt.id, {
        type,
        expenseAccountId,
        paymentAccountId: type !== 'bill' ? paymentAccountId : undefined,
        vendorId: vendorMode === 'existing' ? vendorId : undefined,
        newVendorName: vendorMode === 'new' ? newVendorName.trim() : undefined,
        dueDate: type === 'bill' && dueDate ? dueDate : undefined,
        taxCodeId: taxCodeId === NO_TAX ? null : taxCodeId,
        transactionType,
        forceReason: fiscalOk ? undefined : forceReason.trim(),
        bankChargedTotal: type === 'purchase' && bankChargedTotal !== '' ? Number(bankChargedTotal) : undefined,
        anomalyOverride: anomalyOverride || undefined,
      })
      setShowConfirm(false)
      const updated = await api.saleReceipts.get(receipt.id)
      onSuccess(updated)
    } catch (e) {
      fail(e.message, e.details?.field || null)
      if (e.details?.field === 'anomaly') setAnomalyBlocked(true)
      setShowConfirm(false)
    } finally {
      setSubmitting(false)
    }
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
        <RefreshCw size={14} className="animate-spin" /> Chargement des comptes QuickBooks…
      </div>
    )
  }

  return (
    <div className="mt-3 border border-green-200 bg-green-50 rounded-xl p-4 space-y-4">
      <div>
        <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Type</label>
        <div className="flex gap-4">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="radio" data-testid="qb-type-purchase" checked={type === 'purchase'} onChange={() => touchAndDraft(setType, 'quickbooks_type')('purchase')} />
            <span>Dépense payée (Purchase)</span>
          </label>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="radio" data-testid="qb-type-bill" checked={type === 'bill'} onChange={() => touchAndDraft(setType, 'quickbooks_type')('bill')} />
            <span>Facture à payer (Bill → Comptes fournisseurs)</span>
          </label>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="radio" data-testid="qb-type-cc-credit" checked={type === 'cc_credit'} onChange={() => touchAndDraft(setType, 'quickbooks_type')('cc_credit')} />
            <span>Crédit sur carte de crédit (Credit Card Credit)</span>
          </label>
        </div>
        {profileApplied && (
          <p data-testid="qb-profile-note" className="text-[11px] text-brand-700 bg-brand-50 border border-brand-100 rounded px-2 py-1 mt-1.5 leading-snug">
            Pré-rempli depuis le <Link to="/fournisseurs" className="underline font-medium">profil fournisseur</Link>
            {receipt.vendor_profile?.name ? ` « ${receipt.vendor_profile.name} »` : ''}
            {(receipt.currency || 'CAD').toUpperCase() === 'USD' ? ' (défauts USD)' : ''}. Vérifiez puis publiez.
          </p>
        )}
        {autoAppliedFrom && !userTouchedRef.current && (
          <p data-testid="qb-prefill-note" className="text-[11px] text-brand-700 bg-brand-50 border border-brand-100 rounded px-2 py-1 mt-1.5 leading-snug">
            Pré-rempli depuis la dernière compta de ce fournisseur{autoAppliedFrom.receipt_date ? ` — ${fmtDate(autoAppliedFrom.receipt_date)}` : ''}. Vérifiez puis publiez.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4">
        <div className={fieldFrame('vendor')}>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Fournisseur</label>
          <div className="flex gap-3 mb-1.5">
            <label className="flex items-center gap-1 text-xs cursor-pointer">
              <input type="radio" checked={vendorMode === 'existing'} onChange={() => setVendorMode('existing')} /> Existant
            </label>
            <label className="flex items-center gap-1 text-xs cursor-pointer">
              <input type="radio" checked={vendorMode === 'new'} onChange={() => setVendorMode('new')} /> Nouveau
            </label>
          </div>
          {vendorMode === 'existing' ? (
            <SearchableSelect
              testId="qb-vendor-select"
              value={vendorId}
              options={vendorOptions}
              onChange={v => { setVendorId(v); saveDraft({ vendor_id: v || null }) }}
              placeholder="— Aucun —"
            />
          ) : (
            <input type="text" placeholder="Nom du fournisseur" value={newVendorName} onChange={e => setNewVendorName(e.target.value)} className="input-field text-xs w-full" />
          )}
        </div>

        <div className={fieldFrame('expense_account')}>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Compte de dépense</label>
          <SearchableSelect
            testId="qb-expense-select"
            value={expenseAccountId}
            options={expenseOptions}
            onChange={touchAndDraft(setExpenseAccountId, 'expense_account_id')}
            placeholder="— Sélectionner —"
          />
          {partsApplied && !userTouchedRef.current && (
            <p data-testid="qb-parts-account-note" className="text-[11px] text-brand-700 bg-brand-50 border border-brand-100 rounded px-2 py-1 mt-1.5 leading-snug">
              Compte de <strong>pièces</strong> appliqué automatiquement : des lignes sont rattachées à des achats LIA (entrée au stock).
            </p>
          )}
        </div>

        {type !== 'bill' ? (
          <div className={fieldFrame('payment_account')}>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">
              {type === 'cc_credit' ? 'Compte de carte de crédit' : 'Compte de paiement'}
            </label>
            <SearchableSelect
              testId="qb-payment-select"
              value={paymentAccountId}
              options={type === 'cc_credit' ? creditCardOptions : paymentOptions}
              onChange={touchAndDraft(setPaymentAccountId, 'payment_account_id')}
              placeholder="— Sélectionner —"
            />
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
                      type="number"
                      step="0.01"
                      min="0"
                      data-testid="qb-bank-charged"
                      value={bankChargedTotal}
                      onChange={e => setBankChargedTotal(e.target.value)}
                      onBlur={() => {
                        // Autosave brouillon au blur (pas à chaque frappe — saisie partielle).
                        const v = bankChargedTotal === '' ? null : Number(bankChargedTotal)
                        if (v !== null && (!Number.isFinite(v) || v < 0)) return
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
                      const bank = Number(bankChargedTotal)
                      const vendorCur = vendorMode === 'existing'
                        ? ((vendors.find(v => v.Id === vendorId)?.CurrencyRef?.value) || 'CAD').toUpperCase()
                        : (receipt.currency || 'CAD').toUpperCase()
                      const sameCur = vendorCur === (receipt.currency || 'CAD').toUpperCase()
                      if (!bankChargedTotal || !Number.isFinite(bank) || bank <= 0 || receipt.total == null) {
                        return (
                          <p className="text-[11px] text-slate-400 mt-1.5 leading-snug">
                            L'écart sera ajouté comme article « Frais de conversion » (Exonéré).
                          </p>
                        )
                      }
                      const fee = Math.round((bank - Number(receipt.total)) * 100) / 100
                      if (!sameCur) return null
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
            {(receipt.currency || 'CAD').toUpperCase() !== 'CAD' && (
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
        ) : (
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Échéance</label>
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
        )}

        <div className={fieldFrame('transaction_type')}>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">
            Type de transaction <span className="text-red-500">*</span>
          </label>
          <SearchableSelect
            testId="qb-txtype-select"
            value={transactionType}
            options={txTypeOptions}
            onChange={changeTransactionType}
            placeholder="— Sélectionner le statut fiscal —"
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
              <span className="text-slate-500"> → code QB </span>
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

        <div className={fieldFrame('tax_code')}>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Code de taxe</label>
          <SearchableSelect
            testId="qb-taxcode-select"
            value={taxCodeId}
            options={taxCodeOptions}
            onChange={changeDocCode}
            placeholder="— Aucune taxe —"
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
              Présélectionné d'après les montants TPS/TVQ — changez-le au besoin (ex. <strong>TPS/TVQ repas</strong>, <strong>TPS/TVQ kilométrage</strong>).
            </p>
          )}
        </div>
      </div>

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
                placeholder="Pourquoi ce n'est pas un doublon (facultatif)"
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

      <div className="flex gap-2">
        <button className="btn-primary text-xs py-1.5 px-3" data-testid="qb-publish-open" onClick={() => handlePublish()} disabled={submitting}>
          <BookOpen size={12} /> {submitting ? 'Publication…' : 'Publier sur QuickBooks'}
        </button>
      </div>

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
                  <span className={`shrink-0 px-1.5 py-0.5 rounded-full ${txn.quickbooks_type === 'bill' ? 'bg-purple-100 text-purple-700' : txn.quickbooks_type === 'cc_credit' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}`}>
                    {txn.quickbooks_type === 'bill' ? 'Facture' : txn.quickbooks_type === 'cc_credit' ? 'Crédit CC' : 'Dépense'}
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
              <div>Statut attendu : <strong>{selectedType?.statusLabel || '—'}</strong> → code QB <strong>« {selectedType?.recommendedCode || '—'} »</strong></div>
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
                    placeholder="Ex. cas particulier hors-Sheet, fournisseur avec régime spécifique…"
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
              {submitting ? <><RefreshCw size={12} className="animate-spin" /> Publication…</> : <><BookOpen size={12} /> {fiscalOk ? 'Confirmer et publier' : 'Forcer la publication'}</>}
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
    <div>
      <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">Devise</p>
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
        {saving && <RefreshCw size={12} className="animate-spin text-slate-400" />}
      </div>
    </div>
  )
}

function InfoField({ label, value }) {
  return (
    <div>
      <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">{label}</p>
      <p className="text-sm text-slate-700 mt-0.5">{value || <span className="text-slate-300">—</span>}</p>
    </div>
  )
}

function EditableDateField({ receipt, field, label, onUpdate, testId }) {
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
    <div>
      <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">{label}</p>
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
        {saving && <RefreshCw size={11} className="animate-spin text-slate-400 flex-shrink-0" />}
      </div>
    </div>
  )
}

function EditableTextField({ receipt, field, label, placeholder, onUpdate, testId }) {
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
    <div>
      <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">{label}</p>
      <div className="flex items-center gap-1 mt-0.5">
        <input
          type="text"
          data-testid={testId}
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
          placeholder={placeholder || '—'}
          disabled={saving}
          className="w-full text-sm text-slate-700 bg-transparent border border-transparent hover:border-slate-300 focus:border-brand-500 focus:bg-white rounded px-2 py-0.5 -ml-2 outline-none"
        />
        {saving && <RefreshCw size={11} className="animate-spin text-slate-400 flex-shrink-0" />}
      </div>
    </div>
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
          {savingDesc && <RefreshCw size={11} className="animate-spin text-slate-400" />}
        </div>
        <input
          data-testid="receipt-general-description"
          type="text"
          value={desc}
          onChange={e => setDesc(e.target.value)}
          onBlur={() => commitField('general_description', desc, receipt.general_description, setSavingDesc, () => setDesc(receipt.general_description || ''))}
          placeholder="Objet principal de la facture (ex. « Pièces de plomberie »)"
          disabled={savingDesc}
          className="w-full text-sm text-slate-700 bg-white border border-slate-300 hover:border-slate-400 focus:border-brand-500 rounded px-3 py-2 outline-none placeholder:text-slate-300"
        />
      </div>

    </div>
  )
}

function TotalRow({ label, value, bold }) {
  return (
    <div className="flex justify-between items-center">
      <span className={`text-sm ${bold ? 'font-semibold text-slate-800' : 'text-slate-600'}`}>{label}</span>
      <span className={`tabular-nums text-sm ${bold ? 'font-bold text-slate-900 text-base' : 'text-slate-700'}`}>
        {value != null ? fmtCad(value) : '—'}
      </span>
    </div>
  )
}

// Cellule « Achat LIA » d'une ligne d'article : sélecteur recherchable des achats du
// fournisseur, lien vers la fiche de l'achat rattaché, et — quand l'appariement
// automatique n'était pas assez sûr pour écrire la description — la suggestion à
// accepter d'un clic. Un achat déjà facturé ailleurs (dépôt + solde, facture partielle)
// reste sélectionnable mais est signalé.
function LiaCell({ index, item, options, suggestion, blockedBy, linkedPurchase, onSelect }) {
  const reused = linkedPurchase?.linked_receipts || []
  return (
    <div className="space-y-1">
      <SearchableSelect
        testId={`receipt-item-lia-${index}`}
        value={item.purchase_id || ''}
        options={options}
        emptyOption="— Aucun achat —"
        onChange={val => onSelect(val || null)}
        placeholder="— Aucun achat —"
      />
      {item.purchase_id && (
        <div className="flex items-center gap-1.5 px-1 text-[11px] min-w-0">
          <Link to={`/purchases/${item.purchase_id}`} className="text-brand-600 hover:underline font-medium shrink-0">
            {item.lia_ref || 'Achat'}
          </Link>
          {/* Rappel du nom de la pièce tel qu'il est dans la fiche Achat : c'est ce nom
              qui est recopié derrière le code dans la description de la ligne. */}
          {linkedPurchase?.part_name && (
            <span className="text-slate-500 truncate" title={linkedPurchase.part_name}>{linkedPurchase.part_name}</span>
          )}
          {reused.length > 0 && (
            <span
              className="text-amber-600 shrink-0"
              title={`Déjà rattaché à ${reused.map(r => r.receipt_number || r.receipt_date || r.receipt_id).join(', ')}`}
            >
              · déjà facturé
            </span>
          )}
        </div>
      )}
      {/* Libellé imprimé sur la facture, remplacé par « code LIA + nom de la pièce » dans
          la description : on le garde visible pour que la ligne reste identifiable à l'œil. */}
      {item.purchase_id && item.source_description && (
        <div className="px-1 text-[11px] text-slate-400 truncate" title={item.source_description}>
          Facture : {item.source_description}
        </div>
      )}
      {!item.purchase_id && suggestion && (
        <button
          type="button"
          onClick={() => onSelect(suggestion.purchase_id)}
          data-testid={`receipt-item-lia-suggest-${index}`}
          title={[
            `Confiance ${Math.round(suggestion.score * 100)} %`,
            ...(suggestion.reasons || []),
            // Hors section « À recevoir » : la commande est déjà reçue, sa facture
            // n'était simplement pas encore entrée. On le dit plutôt que de le taire.
            ...(suggestion.pending_reception === false ? ['achat déjà reçu — hors section « À recevoir »'] : []),
          ].join(' · ')}
          className="w-full flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-left text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded"
        >
          <CheckCircle size={11} className="shrink-0" />
          <span className="truncate">{suggestion.lia_ref} · {suggestion.part_name}{suggestion.pending_reception === false && ' · reçu'}</span>
          <span className="ml-auto shrink-0 tabular-nums opacity-70">{Math.round(suggestion.score * 100)}%</span>
        </button>
      )}
      {/* Aucune proposition parce que l'achat qui correspond le mieux est déjà facturé :
          on le dit plutôt que de proposer un code libre moins pertinent. Il reste
          sélectionnable dans la liste (dépôt + solde, correction d'un rattachement). */}
      {!item.purchase_id && !suggestion && blockedBy && (
        <div
          data-testid={`receipt-item-lia-blocked-${index}`}
          title={[`${blockedBy.lia_ref} — ${blockedBy.reason}`, ...(blockedBy.receipts || []).map(r => r.receipt_number || r.receipt_date || r.receipt_id)].join(' · ')}
          className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded"
        >
          <span className="truncate">{blockedBy.lia_ref} correspond, mais est déjà facturé</span>
        </div>
      )}
    </div>
  )
}

function EditableItems({ receipt, onUpdate, taxCodes = [] }) {
  const { addToast } = useToast()
  const [items, setItems] = useState(receipt.items || [])
  const [saving, setSaving] = useState(false)
  const initialJsonRef = useRef(JSON.stringify(receipt.items || []))
  // Achats LIA du même fournisseur + suggestion par ligne (lecture seule côté serveur).
  const [lia, setLia] = useState({ candidates: [], lines: [] })
  // Sélecteur d'achat LIA cadré sur la section « À recevoir » ; l'historique complet du
  // fournisseur est derrière ce dépliant (correction, dépôt + solde, facture partielle).
  const [showAllLia, setShowAllLia] = useState(false)
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
      total:       parseNum(it.total),
      tax_code_id: it.tax_code_id || null,
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
    setItems(prev => [...prev, { description: '', total: null, tax_code_id: null }])
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

  // Achats LIA proposés dans le sélecteur. Par défaut, la liste est celle de la section
  // « À recevoir » d'Airtable : les commandes sans date de réception complète, c'est-à-dire
  // celles dont la facture est attendue. L'historique du fournisseur (des centaines de
  // codes déjà facturés) n'est pas une aide, il noie la liste — il reste accessible d'un
  // clic (« Tous les achats du fournisseur ») pour les cas de correction ou de facture
  // partielle. Les achats déjà rattachés à une ligne du reçu et ceux que le moteur
  // propose restent toujours dans la liste, même hors « À recevoir ».
  const liaLinkedIds = new Set(items.map(it => it.purchase_id).filter(Boolean))
  const liaSuggestedIds = new Set(lia.lines.map(l => l.match?.purchase_id).filter(Boolean))
  const liaVisible = liaCandidates.filter(c =>
    showAllLia || c.pending_reception || liaLinkedIds.has(c.id) || liaSuggestedIds.has(c.id))
  const liaHiddenCount = liaCandidates.length - liaVisible.length
  const liaOptions = liaVisible.map(c => ({
    value: c.id,
    label: `${c.lia_ref} · ${c.part_name || '(pièce non liée)'}${c.qty_ordered ? ` — ${c.qty_ordered} u.` : ''}${c.order_date ? ` — ${c.order_date}` : ''}`
      + (c.consumed ? ' · déjà facturé' : c.pending_reception ? ' · à recevoir' : ' · reçu')
      // Filet « autre fournisseur » : le fournisseur est alors l'information décisive,
      // puisque ces achats ne viennent pas du fournisseur du reçu.
      + (c.other_vendor && c.supplier ? ` · ${c.supplier}` : ''),
  }))
  // Aucun achat rattaché à ce fournisseur : le serveur a ouvert la liste à tous les
  // achats encore à recevoir (cf. listCandidatePurchases). Rien n'est proposé d'office
  // dans ce cas — la sélection est manuelle, d'où la mention.
  const liaOtherVendorOnly = liaCandidates.length > 0 && liaCandidates.every(c => c.other_vendor)
  const suggestionFor = i => (lia.lines.find(l => l.index === i)?.match) || null
  const blockedFor = i => (lia.lines.find(l => l.index === i)?.blocked_by) || null
  const candidateById = id => liaCandidates.find(c => c.id === id) || null

  // Aperçu de la ligne « Frais de conversion » que le push QB ajoutera (voir
  // computeConversionFee côté serveur) — écart entre le total du reçu et le
  // montant réellement débité à la banque. Le champ n'est saisissable que pour
  // les Purchase, donc bank_charged_total n'est jamais renseigné pour un Bill.
  const conversionFee = (() => {
    if (receipt.bank_charged_total == null) return 0
    const bank = Number(receipt.bank_charged_total)
    const total = Number(receipt.total) || 0
    if (!Number.isFinite(bank) || bank <= 0) return 0
    const fee = Math.round((bank - total) * 100) / 100
    return Math.abs(fee) < 0.005 ? 0 : fee
  })()
  const exemptCodeName = taxCodes.find(c => c.Name === 'Exonéré')?.Name || 'Exonéré'

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-slate-700">Articles</h3>
        <div className="flex items-center gap-2">
          {saving && <RefreshCw size={12} className="animate-spin text-slate-400" />}
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
      {/* Une ligne = un bloc de DEUX rangées, pas une rangée de tableau : la fiche vit
          dans une demi-largeur d'écran (aperçu du document à gauche), où quatre colonnes
          côte à côte rendaient la description illisible (~15 caractères visibles).
          Rangée 1 : description pleine largeur + montant. Rangée 2 : achat LIA + code de
          taxe, chacun avec assez de place pour montrer son libellé complet. */}
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
                placeholder="Description"
                title={item.description || ''}
                className="flex-1 min-w-0 px-2 py-1 text-sm bg-transparent border border-transparent hover:border-slate-300 focus:border-brand-500 focus:bg-white rounded outline-none"
              />
              <input
                type="text"
                inputMode="decimal"
                value={item.total ?? ''}
                onChange={e => updateItem(i, { total: e.target.value })}
                onBlur={() => commit()}
                placeholder="—"
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
            <div className="flex items-start gap-2 mt-1 pl-2 pr-[2.375rem]">
              <div className="flex-1 min-w-0">
                <span className="block text-[10px] uppercase tracking-wide text-slate-400 mb-0.5">Achat LIA</span>
                <LiaCell
                  index={i}
                  item={item}
                  options={liaOptions}
                  suggestion={suggestionFor(i)}
                  blockedBy={blockedFor(i)}
                  linkedPurchase={candidateById(item.purchase_id)}
                  onSelect={id => setLiaPurchase(i, id)}
                />
              </div>
              <div className="w-44 shrink-0">
                <span className="block text-[10px] uppercase tracking-wide text-slate-400 mb-0.5">Code de taxe</span>
                <SearchableSelect
                  testId={`receipt-item-taxcode-${i}`}
                  value={item.tax_code_id || ''}
                  options={taxCodeOptions}
                  emptyOption="— Code du document —"
                  onChange={val => setTaxCode(i, val)}
                  placeholder="— Code du document —"
                />
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
      {liaOtherVendorOnly && (
        <p className="text-[11px] text-slate-500 mt-1.5 leading-snug">
          Aucun achat n'est rattaché à ce fournisseur dans Achats : la liste est ouverte à
          <strong> tous les achats à recevoir</strong>, tous fournisseurs confondus. Aucune
          suggestion automatique dans ce cas — le fournisseur affiché est celui de l'achat.
        </p>
      )}
      {liaCandidates.length > 0 && (liaHiddenCount > 0 || showAllLia) && (
        <p className="text-[11px] mt-1.5 leading-snug">
          <button
            type="button"
            data-testid="lia-show-all"
            onClick={() => setShowAllLia(v => !v)}
            className="text-brand-600 hover:underline"
          >
            {showAllLia ? 'Revenir à « À recevoir »' : 'Tous les achats du fournisseur'}
          </button>
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
        {saving && <RefreshCw size={11} className="animate-spin text-slate-400" />}
        <input
          type="text"
          inputMode="decimal"
          data-testid={`receipt-amount-${field}`}
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
          placeholder="—"
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
        {saving && <RefreshCw size={11} className="animate-spin text-slate-400" />}
        <input
          type="text"
          inputMode="decimal"
          data-testid="receipt-total-taxes"
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
          placeholder="—"
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
// l'anomalie), le lien vers la transaction QB existante pour vérifier d'un clic, et
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
// quand le serveur détecte ce type de document (receipt.prepaid_statement) : le
// fournisseur est un compte prépayé, donc la dépense du mois est DÉJÀ comptabilisée
// par les recharges. Rien à publier — un clic joint le document en pièce jointe aux
// transactions QuickBooks du mois couvert. Le mois détecté reste modifiable.
function PrepaidStatementBanner({ receipt, onDone }) {
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
      onDone?.()
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
            {busy ? 'Rattachement…' : sameMonth ? 'Rejoindre aux transactions' : 'Joindre aux transactions QB'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function SaleReceiptDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { addToast } = useToast()
  const confirm = useConfirm()
  const [receipt, setReceipt] = useState(null)
  const [conversionOpen, setConversionOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [fileUrl, setFileUrl] = useState(null)
  const [allIds, setAllIds] = useState([])
  const [acting, setActing] = useState(false)
  const [tab, setTab] = useState('details')
  const [history, setHistory] = useState(null)
  // Codes de taxe QB partagés par le sélecteur de ligne (Articles) et l'indicateur de
  // réconciliation (Montants). Une seule requête ; échec (QB non connecté) → liste vide.
  const [taxCodes, setTaxCodes] = useState([])

  useEffect(() => {
    let cancelled = false
    api.quickbooks.taxCodes()
      .then(codes => { if (!cancelled) setTaxCodes(codes || []) })
      .catch(() => { if (!cancelled) setTaxCodes([]) })
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
      if (updated.archived_at) navigate('/sale-receipts')
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
      navigate('/sale-receipts')
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      setActing(false)
    }
  }

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    api.saleReceipts.get(id)
      .then(setReceipt)
      .catch((e) => { setReceipt(null); setLoadError(e?.message || 'Erreur de chargement') })
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => { load() }, [load])

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
      navigate('/sale-receipts')
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
    const token = localStorage.getItem('erp_token')
    fetch(`/erp/api/sale-receipts/${receipt.id}/file`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(r => r.ok ? r.blob() : Promise.reject())
      .then(blob => { url = URL.createObjectURL(blob); setFileUrl(url) })
      .catch(() => setFileUrl(null))
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [receipt?.id])

  const currentIdx = allIds.indexOf(String(id))
  const prevId = currentIdx > 0 ? allIds[currentIdx - 1] : null
  const nextId = currentIdx >= 0 && currentIdx < allIds.length - 1 ? allIds[currentIdx + 1] : null

  if (loading) {
    return (
      <Layout>
        <Spinner center />
      </Layout>
    )
  }

  if (loadError && !receipt) {
    return <Layout><DetailLoadError message={loadError} onRetry={load} /></Layout>
  }

  if (!receipt) {
    return (
      <Layout>
        <div className="p-6 max-w-4xl mx-auto">
          <button onClick={() => navigate('/sale-receipts')} className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700">
            <ArrowLeft size={16} /> Retour à la liste
          </button>
          <div className="mt-6 text-slate-500">Reçu introuvable.</div>
        </div>
      </Layout>
    )
  }

  const isPdf = receipt.file_type === '.pdf'
  const items = receipt.items || []

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-start gap-4 mb-4">
          <button
            onClick={() => navigate('/sale-receipts')}
            className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg"
            title="Retour à la liste"
            aria-label="Retour"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <ReceiptText size={20} className="text-slate-400" />
              <h1 className="text-2xl font-bold text-slate-900 truncate">{receipt.company || receipt.original_name}</h1>
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
                    <BookOpen size={10} /> QB #{receipt.quickbooks_id}
                  </a>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
                    <BookOpen size={10} /> QB #{receipt.quickbooks_id}
                  </span>
                )
              )}
            </div>
            {receipt.address && <p className="text-slate-500 text-sm mt-1">{receipt.address}</p>}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => prevId && navigate(`/sale-receipts/${prevId}`)}
              disabled={!prevId}
              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              data-testid="receipt-prev"
              title="Reçu précédent"
              aria-label="Reçu précédent"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => nextId && navigate(`/sale-receipts/${nextId}`)}
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
                <RefreshCw size={14} className={acting ? 'animate-spin' : ''} />
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
        <PrepaidStatementBanner receipt={receipt} onDone={load} />

        {/* Onglets */}
        <div className="flex items-center gap-1 border-b border-slate-200 mb-5">
          <TabButton active={tab === 'details'} onClick={() => setTab('details')} testId="tab-details">Détails</TabButton>
          <TabButton active={tab === 'history'} onClick={() => setTab('history')} testId="tab-history">Historique</TabButton>
        </div>

        {tab === 'history' && <HistoryTab events={history} loading={history === null} />}

        {tab === 'details' && (receipt.status === 'processing' ? (
          <div className="flex flex-col items-center justify-center py-20 text-blue-500 gap-3">
            <RefreshCw size={48} strokeWidth={1} className="animate-spin" />
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
              <RefreshCw size={14} className={acting ? 'animate-spin' : ''} />
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
                  receipt={receipt}
                  onUpdate={setReceipt}
                  onOpenConversion={() => setConversionOpen(true)}
                  onSuccess={(updated) => {
                    setReceipt(updated)
                    addToast({ message: 'Reçu publié sur QuickBooks', type: 'success' })
                    // Enchaînement : on file directement au document suivant de la liste
                    // (même ordre que les flèches ‹ › — vue filtrée/triée mémorisée au clic
                    // sur la ligne) pour traiter la pile sans repasser par le menu. Dernier
                    // document de la liste → retour à l'interface Extraction de données.
                    navigate(nextId ? `/sale-receipts/${nextId}` : '/sale-receipts')
                  }}
                />
              )}

              <div className="grid grid-cols-2 gap-4">
                <EditableTextField receipt={receipt} field="company" label="Entreprise" placeholder="Nom du fournisseur" onUpdate={setReceipt} testId="receipt-company" />
                <EditableDateField receipt={receipt} field="receipt_date" label="Date" onUpdate={setReceipt} testId="receipt-date" />
                <EditableTextField receipt={receipt} field="receipt_number" label="N° de reçu" onUpdate={setReceipt} testId="receipt-number" />
                <EditableTextField receipt={receipt} field="payment_method" label="Mode de paiement" onUpdate={setReceipt} testId="receipt-payment-method" />
                <CurrencyField receipt={receipt} onUpdate={setReceipt} />
                <InfoField label="Fichier" value={receipt.original_name} />
              </div>

              <EditableItems receipt={receipt} onUpdate={setReceipt} taxCodes={taxCodes} />

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
      </div>

      <CurrencyConversionModal
        isOpen={conversionOpen}
        onClose={() => setConversionOpen(false)}
        receipt={receipt}
        onApplied={updated => {
          setReceipt(updated)
          addToast({ message: 'Montants convertis', type: 'success' })
        }}
      />
    </Layout>
  )
}
