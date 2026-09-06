import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom'
import { ArrowLeft, ExternalLink, Plus, FileDown, Trash2, ChevronUp, ChevronDown, X, FileText, PanelRight } from 'lucide-react'
import { api } from '../lib/api.js'

function pdfUrl(id, download = false) {
  const token = localStorage.getItem('erp_token')
  const params = new URLSearchParams()
  if (token) params.set('token', token)
  if (download) params.set('download', '1')
  const qs = params.toString()
  return `/erp/api/documents/soumissions/${id}/pdf${qs ? `?${qs}` : ''}`
}
import { PageTitle } from '../components/PageTitle.jsx'
import Spinner from '../components/Spinner.jsx'
import { Badge, SOUMISSION_STATUS_COLORS as STATUS_COLORS } from '../components/Badge.jsx'
import { DetailLoadError } from '../components/DetailLoadError.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import FactureDetail from './FactureDetail.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import SectionNav, { SECTION_NAV_INSET } from '../components/SectionNav.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { InlineText, InlineTextarea, InlineNumber, InlineDate } from '../components/InlineFields.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useDisabledColumns } from '../lib/useDisabledColumns.js'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { fmtDate } from '../lib/formatDate.js'

import { fmtMoney, fmtNumber } from '../utils/formatters.js'
import { DetailFieldGrid, DetailField } from '../components/DetailFieldGrid.jsx'

const fmtCad = (n) => fmtMoney(n, 'CAD', { maximumFractionDigits: 0 })
const fmtCurrency = (n, currency = 'CAD') => fmtMoney(n, currency, { maximumFractionDigits: 0 })
const STATUS_LABELS = { 'legacy': 'Archivé' }

// Types de projet : même liste que la colonne du tableau (source unique) — un
// type saisi ailleurs qui n'y figure pas reste proposé (voir typeOptions).
const PROJECT_TYPES = TABLE_COLUMN_META.projects.find(c => c.id === 'type')?.options || []

// ── Create soumission modal ───────────────────────────────────────────────────

function blankItem() {
  return { catalog_product_id: '', description_fr: '', description_en: '', qty: 1, unit_price_cad: 0 }
}

function CreateSoumissionModal({ project, onClose, onCreated }) {
  const { addToast } = useToast()
  const [catalog, setCatalog] = useState([])
  const [form, setForm] = useState({
    language: project.contact_language || 'French',
    currency: 'CAD',
    // Pas de « Notes » à la création : la soumission naît sans note, elle
    // s'ajoute au besoin depuis la fiche de la soumission.
    discount_pct: 0,
    discount_amount: 0,
  })
  const [items, setItems] = useState([blankItem()])
  const [saving, setSaving] = useState(false)
  const [step, setStep] = useState(1)

  useEffect(() => { api.catalog.list().then(setCatalog).catch(console.error) }, [])

  const isFr = form.language !== 'English'
  const _fmt = (n) => fmtMoney(n) // CAD/USD handled by currency field but fmtMoney is CAD; we'll show currency label

  const removeItem = (idx) => setItems(prev => prev.filter((_, i) => i !== idx))
  const updateItem = (idx, key, val) => setItems(prev => prev.map((it, i) => i === idx ? { ...it, [key]: val } : it))
  const moveItem = (idx, dir) => {
    setItems(prev => {
      const arr = [...prev]
      const t = idx + dir
      if (t < 0 || t >= arr.length) return arr
      ;[arr[idx], arr[t]] = [arr[t], arr[idx]]
      return arr
    })
  }
  const selectProduct = (idx, productId) => {
    const product = catalog.find(p => p.id === productId)
    if (!product) { updateItem(idx, 'catalog_product_id', ''); return }
    const price = form.currency === 'USD' ? (product.price_usd || 0) : (product.price_cad || 0)
    setItems(prev => prev.map((it, i) => i === idx ? {
      ...it, catalog_product_id: product.id,
      description_fr: product.name_fr, description_en: product.name_en,
      unit_price_cad: price,
    } : it))
  }
  const changeCurrency = (newCurrency) => {
    setForm(f => ({ ...f, currency: newCurrency }))
    setItems(prev => prev.map(it => {
      if (!it.catalog_product_id) return { ...it, unit_price_cad: 0 }
      const product = catalog.find(p => p.id === it.catalog_product_id)
      if (!product) return it
      return { ...it, unit_price_cad: newCurrency === 'USD' ? (product.price_usd || 0) : (product.price_cad || 0) }
    }))
  }

  const subtotal = items.reduce((s, it) => s + (it.qty || 1) * (it.unit_price_cad || 0), 0)
  const discPct = parseFloat(form.discount_pct) || 0
  const discAmt = parseFloat(form.discount_amount) || 0
  const totalDiscount = Math.min(subtotal, subtotal * discPct / 100 + discAmt)
  const netTotal = Math.max(0, subtotal - totalDiscount)
  const fmtP = (n) => fmtMoney(n || 0, form.currency, { locale: form.currency === 'USD' ? 'en-US' : 'fr-CA' })

  const inp = 'border border-slate-200 rounded px-2 py-1 text-sm focus:outline-none focus:border-brand-400'

  const save = async () => {
    setSaving(true)
    try {
      // Trim des champs texte au submit pour éviter des records pollués par des espaces seuls.
      const result = await api.documents.soumissions.create({
        ...form,
        project_id: project.id,
        company_id: project.company_id || null,
        items: items
          .map(it => ({
            ...it,
            description_fr: (it.description_fr || '').trim(),
            description_en: (it.description_en || '').trim(),
          }))
          .filter(it => it.description_fr || it.description_en || it.catalog_product_id)
          .map(it => ({
            catalog_product_id: it.catalog_product_id || null,
            qty: it.qty, unit_price_cad: it.unit_price_cad,
            description_fr: it.description_fr, description_en: it.description_en,
          })),
      })
      onCreated(result)
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title="Nouvelle soumission" size="xl">
      <div className="flex gap-3 mb-5">
        {[{ n: 1, label: 'Informations' }, { n: 2, label: 'Articles' }].map(s => (
          <button key={s.n} onClick={() => setStep(s.n)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${step === s.n ? 'bg-brand-100 text-brand-700' : 'text-slate-500 hover:text-slate-700'}`}>
            {s.n}. {s.label}
          </button>
        ))}
      </div>

      {step === 1 && (
        <div className="space-y-4">
          <div className="flex gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Langue du client</label>
              <select className="border rounded-lg px-3 py-2 text-sm"
                value={form.language} onChange={e => setForm(f => ({ ...f, language: e.target.value }))}>
                <option value="French">Français</option>
                <option value="English">English</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Devise</label>
              <select className="border rounded-lg px-3 py-2 text-sm font-mono font-semibold"
                value={form.currency} onChange={e => changeCurrency(e.target.value)}>
                <option value="CAD">CAD</option>
                <option value="USD">USD</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end">
            <button onClick={() => setStep(2)} className="bg-brand-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-brand-700">
              Suivant : Articles →
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b text-xs text-slate-500">
                  <th className="px-2 py-2 text-left" style={{minWidth:200}}>Produit</th>
                  <th className="px-2 py-2 text-center" style={{width:56}}>Qté</th>
                  <th className="px-2 py-2 text-right" style={{width:110}}>Prix ({form.currency})</th>
                  <th className="px-2 py-2 text-right" style={{width:90}}>Total</th>
                  <th style={{width:56}}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => (
                  <tr key={idx} className="border-b last:border-0">
                    <td className="px-2 py-1.5">
                      <LinkedRecordField
                        name={`project_item_${idx}`}
                        value={it.catalog_product_id || ''}
                        options={catalog}
                        labelFn={p => isFr ? p.name_fr : (p.name_en || p.name_fr)}
                        getHref={p => `/products/${p.id}`}
                        onChange={v => selectProduct(idx, v)}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input type="number" min="1" className={`${inp} w-12 text-center`}
                        value={it.qty} onChange={e => updateItem(idx, 'qty', parseInt(e.target.value) || 1)} />
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-600 text-sm">
                      {fmtP(it.unit_price_cad)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono font-medium text-slate-900 text-sm">
                      {fmtP((it.qty || 1) * (it.unit_price_cad || 0))}
                    </td>
                    <td className="px-1 py-1.5">
                      <div className="flex items-center gap-0.5">
                        <button onClick={() => moveItem(idx, -1)} className="p-0.5 text-slate-300 hover:text-slate-500"><ChevronUp size={12} /></button>
                        <button onClick={() => moveItem(idx, 1)} className="p-0.5 text-slate-300 hover:text-slate-500"><ChevronDown size={12} /></button>
                        <button onClick={() => removeItem(idx)} className="p-0.5 text-slate-300 hover:text-red-500"><Trash2 size={12} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-3 py-2 border-t">
              <button onClick={() => setItems(prev => [...prev, blankItem()])}
                className="flex items-center gap-1.5 text-sm text-brand-600 hover:text-brand-800 font-medium">
                <Plus size={13} /> Ajouter une ligne
              </button>
            </div>
          </div>

          {/* Global discount + totals */}
          <div className="flex items-start justify-between gap-6 pt-1">
            <div className="space-y-2">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Rabais global</p>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <label className="text-xs text-slate-500">%</label>
                  <div className="relative">
                    <input type="number" min="0" max="100" step="0.1"
                      className={`${inp} w-20 text-right pr-5`}
                      value={form.discount_pct}
                      onChange={e => setForm(f => ({ ...f, discount_pct: parseFloat(e.target.value) || 0 }))} />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">%</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-xs text-slate-500">$</label>
                  <input type="number" min="0" step="0.01"
                    className={`${inp} w-28 text-right`}
                    value={form.discount_amount}
                    onChange={e => setForm(f => ({ ...f, discount_amount: parseFloat(e.target.value) || 0 }))} />
                </div>
              </div>
            </div>

            <div className="space-y-1 text-sm min-w-44">
              <div className="flex justify-between gap-4 text-slate-500">
                <span>{isFr ? 'Sous-total' : 'Subtotal'}</span>
                <span className="font-mono">{fmtP(subtotal)}</span>
              </div>
              {totalDiscount > 0 && (
                <div className="flex justify-between gap-4 text-red-500">
                  <span>{isFr ? 'Rabais' : 'Discount'}</span>
                  <span className="font-mono">-{fmtP(totalDiscount)}</span>
                </div>
              )}
              <div className="flex justify-between gap-4 font-bold text-brand-700 border-t pt-1">
                <span>{isFr ? 'Total' : 'Total'}</span>
                <span className="font-mono">{fmtP(netTotal)}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <button onClick={() => setStep(1)} className="text-slate-500 text-sm hover:text-slate-700">← Retour</button>
            <button onClick={save} disabled={saving}
              className="flex items-center gap-2 bg-brand-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50">
              {saving ? 'Génération du PDF…' : 'Créer et générer PDF'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

const SECTION_LABELS = {
  info: 'Informations',
  soumissions: 'Soumissions',
  factures: 'Factures',
  commissions: 'Commissions',
}

// Taux Airtable stocké en fraction (0,025 = 2,5 %).
const fmtPct = (n) => (n === null || n === undefined || Number.isNaN(Number(n)))
  ? '—'
  : `${fmtNumber(Number(n) * 100, { maximumFractionDigits: 2 })} %`

// Les sous-tableaux étant empilés, chacun est borné en hauteur selon son nombre
// de lignes (32 px/ligne + l'en-tête collant) pour éviter les grands vides sous
// une table de deux lignes. Même règle que la fiche entreprise.
function stackedTableHeight(rows) {
  if (!rows) return '190px'
  return `${Math.min(520, Math.max(160, 44 + rows * 32))}px`
}

// Bloc de section : ancre pour le scroll-spy + titre et action optionnelle.
function Section({ id, label, count, action, registerRef, children }) {
  return (
    <section ref={registerRef} data-section={id} className="pt-1 pb-8 scroll-mt-16">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-slate-400">
          {label}
          {count > 0 && (
            <span className="bg-slate-100 text-slate-500 text-[11px] font-medium px-1.5 py-0.5 rounded-full leading-none normal-case tracking-normal">{count}</span>
          )}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

// `recordId` + `embedded` permettent de monter cette fiche dans le side-peek
// (RecordPeekDrawer) de la liste des projets : pas de Layout, pas de bouton
// retour ni de titre (le drawer fournit le sien). `onClose` ferme le drawer
// (utilisé quand le projet est supprimé pendant que le drawer est ouvert).
export default function ProjectDetail({ recordId, embedded = true, onClose }) {
  const { id: paramId } = useParams()
  const id = recordId ?? paramId
  const navigate = useNavigate()
  const location = useLocation()
  const { addToast } = useToast()
  const confirm = useConfirm()
  const [deleting, setDeleting] = useState(false)
  // Toutes les sections sont affichées d'un coup (empilées) : `activeSection`
  // sert uniquement à surligner l'entrée du sélecteur latéral en fonction de la
  // position de défilement (scroll-spy), cf. useEffect plus bas.
  const [activeSection, setActiveSection] = useState('info')
  const [soumissions, setSoumissions] = useState([])
  const [factures, setFactures] = useState([])
  // Commissions : lues en direct dans Airtable (table hors miroir), donc elles
  // peuvent échouer indépendamment du reste de la fiche — d'où leur propre état
  // d'erreur, affiché à la place du tableau.
  const [commissions, setCommissions] = useState([])
  const [commissionsError, setCommissionsError] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showPdf, setShowPdf] = useState(null) // { id, title }
  const [vendeurOptions, setVendeurOptions] = useState([])
  const [companies, setCompanies] = useState([])
  // { [colonne]: true } pendant l'aller-retour serveur d'UN champ — chaque champ
  // affiche son propre témoin d'enregistrement.
  const [fieldSaving, setFieldSaving] = useState({})
  const disabledCols = useDisabledColumns('projects')

  const { record: project, setRecord: setProject, loading, loadError, reload: load } =
    useDetailRecord(() => api.projects.get(id), [id], { clearOnError: true })

  // Suppression du projet : soft delete côté serveur (deleted_at), donc le
  // record sort des listes sans perdre l'historique. Le drawer se ferme (ou on
  // retourne au pipeline) sans attendre l'événement realtime.
  async function handleDelete() {
    const label = project?.name || 'ce projet'
    const ok = await confirm({
      title: 'Supprimer ce projet ?',
      message: `« ${label} » sera retiré du pipeline et des listes. Les soumissions et factures liées ne sont pas supprimées.`,
      confirmLabel: 'Supprimer',
      danger: true,
    })
    if (!ok) return
    setDeleting(true)
    try {
      await api.projects.delete(id)
      addToast({ message: 'Projet supprimé', type: 'success' })
      if (embedded) onClose?.()
      else navigate('/pipeline')
    } catch (e) {
      addToast({ message: `Erreur lors de la suppression : ${e.message}`, type: 'error' })
      setDeleting(false)
    }
  }

  useRealtimeChannel(id ? `project:${id}` : null, (msg) => {
    if (msg.type === 'project:updated') setProject(p => p ? { ...p, ...msg.payload } : p)
    else if (msg.type === 'project:deleted') { if (embedded) onClose?.(); else navigate('/pipeline') }
  })

  useEffect(() => {
    api.projects.vendeurOptions()
      .then(r => setVendeurOptions(r.data || []))
      .catch(() => setVendeurOptions([]))
  }, [])

  // Liste minimale (id + nom) pour le picker Entreprise du panneau Informations.
  useEffect(() => {
    api.companies.lookup()
      .then(d => setCompanies(Array.isArray(d) ? d : (d?.data || [])))
      .catch(() => setCompanies([]))
  }, [])

  // Options du picker Entreprise. On y injecte toujours l'entreprise déjà liée :
  // `/companies/lookup` exclut les entreprises archivées (deleted_at) et n'est
  // pas encore chargé au premier rendu — sans cette injection, LinkedRecordField
  // ne trouverait pas l'option correspondant à company_id et afficherait un
  // champ vide alors que le projet EST lié.
  const companyOptions = useMemo(() => {
    if (!project?.company_id) return companies
    if (companies.some(c => String(c.id) === String(project.company_id))) return companies
    return [{ id: project.company_id, name: project.company_name || 'Entreprise liée' }, ...companies]
  }, [companies, project?.company_id, project?.company_name])

  // Types proposés par le sélecteur. Un type déjà posé sur le projet mais absent
  // de la liste (import Airtable, ancien libellé) reste proposé — sinon le
  // champ paraîtrait vide et un simple coup d'œil l'effacerait.
  const typeOptions = useMemo(() => {
    const opts = PROJECT_TYPES.map(t => ({ value: t, label: t }))
    if (project?.type && !PROJECT_TYPES.includes(project.type)) {
      opts.unshift({ value: project.type, label: project.type })
    }
    return opts
  }, [project?.type])

  // Autosave champ par champ (règle CLAUDE.md : pas de bouton Enregistrer).
  // La valeur part au blur / au changement ; la réponse du PUT ramène les
  // colonnes recalculées (company_name, vendeur_label…), donc l'entête et les
  // champs restent cohérents sans recharger la fiche. En cas d'échec, la valeur
  // précédente est remise à l'écran — l'utilisateur ne repart pas avec une
  // valeur qui n'a pas été enregistrée.
  //
  // Marche aussi pour les colonnes cf_ des champs personnalisés : PUT
  // /api/projects/:id accepte les champs custom éditables.
  async function saveField(key, value) {
    if (!project) return
    const previous = project[key]
    const next = value === '' ? null : value
    if ((previous ?? '') === (next ?? '')) return
    setFieldSaving(s => ({ ...s, [key]: true }))
    setProject(p => (p ? { ...p, [key]: next } : p))
    try {
      const updated = await api.projects.update(id, { [key]: next })
      setProject(p => ({ ...p, ...updated, orders: p.orders }))
    } catch (e) {
      setProject(p => (p ? { ...p, [key]: previous } : p))
      addToast({ message: e.message, type: 'error' })
    } finally {
      setFieldSaving(s => {
        const rest = { ...s }
        delete rest[key]
        return rest
      })
    }
  }

  const loadSoumissions = () => {
    api.documents.soumissions.list({ project_id: id, limit: 'all' })
      .then(r => setSoumissions(r.data || []))
      .catch(() => {})
  }

  const loadFactures = () => {
    api.factures.list({ project_id: id, limit: 'all' })
      .then(r => setFactures(r.data || []))
      .catch(() => {})
  }

  const loadCommissions = () => {
    setCommissionsError(null)
    api.projects.commissions(id)
      .then(r => setCommissions(r.data || []))
      .catch(e => { setCommissions([]); setCommissionsError(e.message) })
  }

  // Colonnes DataTable pour les soumissions liées. Construites ici (et non au
  // niveau module) parce que le render des liens a besoin de setShowPdf.
  const soumissionColumns = useMemo(() => {
    const RENDERS = {
      at_id: row => row.at_id
        ? <span className="text-slate-500 text-xs font-mono">{row.at_id}</span>
        : <span className="text-slate-300">—</span>,
      status: row => row.status
        ? <Badge color={STATUS_COLORS[row.status] || 'gray'}>{STATUS_LABELS[row.status] || row.status}</Badge>
        : <span className="text-slate-400">—</span>,
      created_at: row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
      expiration_date: row => <span className="text-slate-500">{fmtDate(row.expiration_date)}</span>,
      purchase_price: row => <span className="font-medium text-slate-700">{fmtCurrency(row.purchase_price, row.currency)}</span>,
      subscription_price: row => <span className="font-medium text-slate-700">{fmtCurrency(row.subscription_price, row.currency)}</span>,
      currency: row => (
        <span className="text-slate-500 text-xs" title={row.shipping_country ? `Adresse de livraison : ${row.shipping_country}` : 'Devise par défaut'}>
          {row.currency || 'CAD'}
        </span>
      ),
      links: row => (
        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
          {row.generated_pdf_path && (
            <button
              onClick={() => setShowPdf({ id: row.id, title: row.title })}
              className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline px-2 py-1 bg-brand-50 rounded">
              <FileText size={11} /> PDF
            </button>
          )}
          {row.quote_url && (
            <a href={row.quote_url} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline px-2 py-1 bg-brand-50 rounded">
              <ExternalLink size={11} /> Soumission
            </a>
          )}
          {row.pdf_url && (
            <button
              onClick={() => setShowPdf({ url: row.pdf_url, title: row.title, external: true })}
              className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline px-2 py-1 bg-brand-50 rounded">
              <FileText size={11} /> PDF Airtable
            </button>
          )}
          {!row.generated_pdf_path && !row.quote_url && !row.pdf_url && <span className="text-slate-400">—</span>}
        </div>
      ),
    }
    return TABLE_COLUMN_META.project_soumissions.map(meta => ({ ...meta, render: RENDERS[meta.id] }))
  }, [])

  const FACTURE_STATUS_COLORS = { 'Payée': 'green', 'Partielle': 'yellow', 'En retard': 'red', 'Envoyée': 'blue', 'Brouillon': 'gray', 'Annulée': 'red' }
  const factureColumns = useMemo(() => {
    const RENDERS = {
      document_number: row => <span className="font-mono font-medium text-slate-900">{row.document_number || '—'}</span>,
      status: row => row.status
        ? <Badge color={FACTURE_STATUS_COLORS[row.status] || 'gray'}>{row.status}</Badge>
        : <span className="text-slate-400">—</span>,
      document_date: row => <span className="text-slate-500">{fmtDate(row.document_date)}</span>,
      due_date: row => <span className="text-slate-500">{fmtDate(row.due_date)}</span>,
      total_amount: row => <span className="font-medium text-slate-700">{fmtCad(row.total_amount)}</span>,
      balance_due: row => (
        <span className={row.balance_due > 0 ? 'font-semibold text-red-600' : 'text-green-600'}>
          {fmtCad(row.balance_due)}
        </span>
      ),
    }
    return TABLE_COLUMN_META.project_factures.map(meta => ({ ...meta, render: RENDERS[meta.id] }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const commissionColumns = useMemo(() => {
    const RENDERS = {
      at_id: row => <span className="font-mono text-xs text-slate-500">{row.at_id}</span>,
      // Bénéficiaire = employé ou partenaire : lien vers sa fiche quand
      // l'enregistrement existe dans Boréal (règle des champs référence).
      beneficiary_label: row => row.beneficiary_label
        ? (row.beneficiary_href
          ? <Link to={row.beneficiary_href} className="text-brand-600 hover:underline">{row.beneficiary_label}</Link>
          : <span className="text-slate-700">{row.beneficiary_label}</span>)
        : <span className="text-slate-300">—</span>,
      rate: row => <span className="text-slate-600">{fmtPct(row.rate)}</span>,
      amount: row => <span className="font-medium text-slate-900">{fmtMoney(row.amount)}</span>,
      paid_invoices: row => <span className="text-slate-600">{fmtMoney(row.paid_invoices)}</span>,
      close_date: row => <span className="text-slate-500">{fmtDate(row.close_date)}</span>,
    }
    return TABLE_COLUMN_META.project_commissions.map(meta => ({ ...meta, render: RENDERS[meta.id] }))
  }, [])

  const commissionsTotal = useMemo(
    () => commissions.reduce((s, c) => s + (Number(c.amount) || 0), 0),
    [commissions])

  // Toutes les sections étant visibles simultanément, tout est chargé au montage
  // (plus de chargement paresseux à la sélection d'un onglet).
  useEffect(() => {
    loadSoumissions()
    loadFactures()
    loadCommissions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // ── Sections empilées + scroll-spy ──────────────────────────────────────────
  // Le sélecteur latéral n'affiche plus/ne masque plus les sections : tout est
  // rendu à la suite et l'entrée surlignée suit le défilement.
  const sections = useMemo(() => ['info', 'soumissions', 'factures', 'commissions'], [])

  const sectionEls = useRef(new Map())
  const spyMutedUntil = useRef(0)
  // Callbacks de ref mémoïsés par section : sinon React les rejouerait
  // (null puis el) à chaque rendu.
  const sectionRefCbs = useRef(new Map())
  const registerSection = (key) => {
    if (!sectionRefCbs.current.has(key)) {
      sectionRefCbs.current.set(key, (el) => {
        if (el) sectionEls.current.set(key, el)
        else sectionEls.current.delete(key)
      })
    }
    return sectionRefCbs.current.get(key)
  }

  // Le conteneur de défilement diffère selon le contexte : <main> en pleine page,
  // le panneau du side-peek en mode embedded. On le retrouve en remontant le DOM.
  function scrollParentOf(el) {
    let p = el?.parentElement
    while (p) {
      if (/(auto|scroll|overlay)/.test(getComputedStyle(p).overflowY)) return p
      p = p.parentElement
    }
    return document.scrollingElement
  }

  // Hauteur visible du conteneur de défilement (l'écran en pleine page).
  function viewportHeightOf(root) {
    if (!root || root === document.scrollingElement) return window.innerHeight
    return root.clientHeight || window.innerHeight
  }

  useEffect(() => {
    if (loading || !project) return
    const first = sectionEls.current.get(sections[0])
    const root = scrollParentOf(first)
    if (!root) return
    const target = root === document.scrollingElement ? window : root
    let raf = 0
    const compute = () => {
      raf = 0
      if (Date.now() < spyMutedUntil.current) return
      const rootTop = root === document.scrollingElement ? 0 : root.getBoundingClientRect().top
      // Sonde à mi-hauteur : même repère que goToSection(), qui centre la section
      // visée. Sinon le surlignage retomberait sur la section précédente juste
      // après le clic.
      const probe = rootTop + viewportHeightOf(root) / 2
      let current = sections[0]
      for (const key of sections) {
        const el = sectionEls.current.get(key)
        if (!el) continue
        if (el.getBoundingClientRect().top <= probe) current = key
      }
      // Bas de page : la dernière section est forcément « celle où on est rendu »,
      // même si son haut n'a pas franchi la ligne de sonde.
      // Le test ne vaut que si la fiche défile vraiment : au montage, tant que
      // les sous-tableaux ne sont pas peints, le contenu tient dans le panneau
      // et ce raccourci surlignait « Factures » alors qu'on est tout en haut.
      const scrollable = root.scrollHeight > root.clientHeight + 4
      if (scrollable && root.scrollHeight - root.scrollTop - root.clientHeight < 6) current = sections[sections.length - 1]
      setActiveSection(prev => (prev === current ? prev : current))
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(compute) }
    target.addEventListener('scroll', onScroll, { passive: true })
    compute()
    return () => {
      target.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
    // Les longueurs des sous-tableaux sont dans les dépendances pour recalculer
    // le surlignage quand les sections grandissent après leur chargement.
  }, [loading, project, sections, soumissions.length, factures.length, commissions.length])

  function goToSection(key) {
    setActiveSection(key)
    const el = sectionEls.current.get(key)
    if (!el) return
    // On coupe le scroll-spy pendant l'animation, sinon les sections traversées
    // feraient sauter le surlignage.
    spyMutedUntil.current = Date.now() + 900
    const root = scrollParentOf(el)
    const height = el.getBoundingClientRect().height
    if (!root || root === document.scrollingElement) {
      // Une section plus haute que l'écran est calée en haut : la centrer
      // pousserait son titre hors du champ.
      const fits = height < window.innerHeight
      el.scrollIntoView({ behavior: 'smooth', block: fits ? 'center' : 'start' })
      return
    }
    const viewport = viewportHeightOf(root)
    // Marge haute qui centre la section dans la zone visible (8 px si elle est
    // trop haute pour tenir).
    const offset = height < viewport ? Math.max(SECTION_NAV_INSET, (viewport - height) / 2) : SECTION_NAV_INSET
    const delta = el.getBoundingClientRect().top - root.getBoundingClientRect().top
    root.scrollTo({ top: Math.max(0, root.scrollTop + delta - offset), behavior: 'smooth' })
  }

  // Arrivée depuis une soumission (« ← Projet ») : on ouvrait auparavant l'onglet
  // demandé ; on défile maintenant jusqu'à la section correspondante.
  const requestedSection = location.state?.tab
  const scrolledToRequested = useRef(false)
  useEffect(() => {
    if (loading || !project) return
    if (!requestedSection || scrolledToRequested.current) return
    if (!sections.includes(requestedSection)) return
    scrolledToRequested.current = true
    // Laisse un tick au navigateur pour poser les sous-tableaux avant de mesurer.
    const t = setTimeout(() => goToSection(requestedSection), 60)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, project, requestedSection, sections])

  // Le cadre vient toujours du panneau latéral : une fiche ne s'affiche jamais
  // en pleine page (voir components/RecordRoutePanel.jsx).
  const shell = (content) => content

  if (loading) return shell(<Spinner center />)
  if (loadError && !project) return shell(<DetailLoadError message={loadError} onRetry={load} />)
  if (!project) return shell(<div className="p-6 text-slate-500">Projet introuvable.</div>)

  const sectionCounts = {
    soumissions: soumissions.length || undefined,
    factures: factures.length || undefined,
    commissions: commissions.length || undefined,
  }

  return shell(
    <>
      <div className={embedded ? 'px-5 py-4' : 'p-6 max-w-5xl mx-auto'}>
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          {!embedded && (
            <button onClick={() => navigate('/pipeline')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="flex-1">
            {!embedded && (
              <div className="flex items-center gap-3 flex-wrap">
                <PageTitle>{project.name}</PageTitle>
              </div>
            )}
            <div className="text-sm text-slate-500 mt-1">
              {project.company_name && project.company_id && (
                <LinkedRecordField
                  name="company_id"
                  value={project.company_id}
                  options={[{ id: project.company_id, name: project.company_name }]}
                  getHref={c => `/companies/${c.id}`}
                  disabled
                  allowClear={false}
                />
              )}
            </div>
          </div>
          {!embedded && (
            /* Chemin inverse du panneau latéral : retourne à la
               liste avec ce projet ouvert en panneau latéral. */
            <button
              onClick={() => navigate('/pipeline', { state: { peekId: id } })}
              className="mt-1 p-1.5 text-slate-400 hover:text-brand-600 hover:bg-slate-100 rounded-lg"
              title="Revenir à la liste avec ce projet en panneau latéral"
              aria-label="Ouvrir en panneau latéral"
              data-testid="project-open-as-peek"
            >
              <PanelRight size={16} />
            </button>
          )}
        </div>

        {/* Sélecteur de section (barre du haut, collante) + sections empilées */}
        <SectionNav
          sections={sections}
          labels={SECTION_LABELS}
          counts={sectionCounts}
          active={activeSection}
          onSelect={goToSection}
          embedded={embedded}
          testId="project-section-nav"
        />

        {/* Sections */}
        <div className="min-w-0">

        <Section id="info" label={SECTION_LABELS.info} registerRef={registerSection('info')}>
          {/* Même carte de champs que la fiche d'envoi : l'ordre des champs et
              ceux qu'on garde se règlent depuis la fiche elle-même
              (« Personnaliser les champs » : bouton dans l'en-tête du panneau
              latéral). Deux colonnes comme la fiche entreprise — le sélecteur de
              section mange la largeur, une troisième colonne écraserait les
              champs.
              Tous les champs s'éditent sur place, avec autosave (règle de design
              CLAUDE.md). Restent en lecture seule ce qui n'est pas une valeur
              saisissable : les commandes liées (des liens vers d'autres fiches)
              et les champs alimentés par Airtable en sens « import ».
              Les champs personnalisés rejoignent la carte tout seuls, et sont
              modifiables (PUT /api/projects accepte les colonnes cf_
              éditables). */}
          <DetailFieldGrid
            entityType="projects"
            record={project}
            onSaveCustom={saveField}
            savingKeys={fieldSaving}
            className="card p-6"
            testId="project-fields"
          >
            <DetailField id="name" label="Nom du projet" span2 saving={!!fieldSaving.name}>
              <InlineText
                value={project.name}
                required
                saving={!!fieldSaving.name}
                onSave={v => saveField('name', v.trim())}
                testId="project-field-name"
              />
            </DetailField>
            {/* Entreprise : champ référence à part entière (picker recherchable
                + lien vers la fiche), et non plus seulement un sous-titre —
                sans lui, un projet sans entreprise n'affichait rien et il n'y
                avait aucun moyen d'en lier une depuis la fiche. */}
            <DetailField id="company_name" label="Entreprise" saving={!!fieldSaving.company_id} testId="project-company-field">
              <LinkedRecordField
                name="project_company_id"
                value={project.company_id}
                options={companyOptions}
                labelFn={c => c.name}
                getHref={c => `/companies/${c.id}`}
                saving={!!fieldSaving.company_id}
                onChange={v => saveField('company_id', v || '')}
              />
            </DetailField>
            <DetailField id="type" label="Type" saving={!!fieldSaving.type}>
              <SearchableSelect
                value={project.type || ''}
                options={typeOptions}
                emptyOption="—"
                onChange={v => saveField('type', v)}
                className="input text-sm w-full"
                size="sm"
                disabled={!!fieldSaving.type}
                testId="project-field-type"
              />
            </DetailField>
            <DetailField id="probability" label="Probabilité" saving={!!fieldSaving.probability}>
              <InlineNumber
                value={project.probability}
                min={0}
                max={100}
                step={5}
                suffix="%"
                saving={!!fieldSaving.probability}
                onSave={v => saveField('probability', v)}
                testId="project-field-probability"
              />
            </DetailField>
            <DetailField id="close_date" label="Date de clôture" saving={!!fieldSaving.close_date}>
              <InlineDate
                value={project.close_date}
                saving={!!fieldSaving.close_date}
                onSave={v => saveField('close_date', v)}
                testId="project-field-close-date"
              />
            </DetailField>
            {project.orders?.length > 0 && (
              <DetailField id="orders" label="Commandes" span2>
                <div className="flex flex-wrap gap-2">
                  {project.orders.map(o => (
                    <Link key={o.id} to={`/orders/${o.id}`}
                      className="inline-flex items-center gap-1 font-mono text-xs text-brand-600 hover:underline bg-brand-50 px-2 py-1 rounded">
                      #{o.order_number}
                      {o.status && <span className="text-slate-500 font-sans">· {o.status}</span>}
                    </Link>
                  ))}
                </div>
              </DetailField>
            )}
            <DetailField id="vendeur_label" label="Vendeur" saving={!!fieldSaving.vendeur_ref}>
              <VendeurPicker
                value={project.vendeur_ref || ''}
                options={vendeurOptions}
                // Vendeur importé d'Airtable dont le nom ne correspond à aucun
                // employé ni entreprise : le serveur renvoie le nom brut dans
                // `vendeur_label` — on l'affiche plutôt que « Aucun ».
                fallbackLabel={project.vendeur_label || ''}
                onChange={v => saveField('vendeur_ref', v || '')}
                disabled={!!fieldSaving.vendeur_ref}
              />
            </DetailField>
            {/* « Vendeur AT » : miroir d'un champ Airtable dont l'import est
                coupé — le serveur refuse toute écriture dessus, il reste donc
                affiché tel quel (et masqué tant que l'import est désactivé). */}
            {project.nom_du_vendeur && !disabledCols?.has('nom_du_vendeur') && (
              <DetailField id="nom_du_vendeur" label="Vendeur AT">
                <div className="text-sm text-slate-700">{project.nom_du_vendeur}</div>
              </DetailField>
            )}
            {/* « Raison du refus » n'est plus déclarée ici : le champ natif a
                été détruit au profit du champ personnalisé homonyme
                (`raison_du_refus`, liste de choix miroir d'Airtable), que la
                carte ajoute d'elle-même — la migration 025 lui a gardé sa place
                dans la disposition de la fiche. */}
            {/* Notes s'affiche même vide : sans ça, il n'y avait aucun endroit
                pour la SAISIR depuis la fiche. */}
            <DetailField id="notes" label="Notes" span2 saving={!!fieldSaving.notes}>
              <InlineTextarea
                value={project.notes}
                saving={!!fieldSaving.notes}
                onSave={v => saveField('notes', v)}
                testId="project-field-notes"
              />
            </DetailField>
          </DetailFieldGrid>
        </Section>

        <Section
          id="soumissions"
          label={SECTION_LABELS.soumissions}
          count={sectionCounts.soumissions}
          registerRef={registerSection('soumissions')}
          action={
            <button
              onClick={() => setShowCreate(true)}
              className="btn-primary btn-sm"
            >
              <Plus size={14} /> Nouvelle soumission
            </button>
          }
        >
          <DataTable
            table="project_soumissions"
            columns={soumissionColumns}
            data={soumissions}
            searchFields={['at_id', 'title', 'status', 'currency']}
            height={stackedTableHeight(soumissions.length)}
            onRowClick={row => { if (row.status !== 'legacy' && row.id) navigate(`/soumissions/${row.id}`) }}
          />
        </Section>

        <Section
          id="factures"
          label={SECTION_LABELS.factures}
          count={sectionCounts.factures}
          registerRef={registerSection('factures')}
        >
          <DataTable
            table="project_factures"
            columns={factureColumns}
            data={factures}
            searchFields={['document_number', 'status', 'total_amount', 'balance_due']}
            height={stackedTableHeight(factures.length)}
            peek={{
              title: row => row.document_number || `Facture #${row.id}`,
              subtitle: () => project?.name,
              to: row => `/factures/${row.id}`,
              width: 780,
              render: (row, { close }) => <FactureDetail recordId={row.id} embedded onClose={close} />,
            }}
          />
        </Section>

        <Section
          id="commissions"
          label={SECTION_LABELS.commissions}
          count={sectionCounts.commissions}
          registerRef={registerSection('commissions')}
          action={commissions.length > 0
            ? <span className="text-sm font-semibold text-slate-700">{fmtMoney(commissionsTotal)}</span>
            : null}
        >
          {commissionsError ? (
            <div className="card p-4 text-sm text-slate-500 flex items-center justify-between gap-3">
              <span>Commissions indisponibles.</span>
              <button onClick={loadCommissions} className="btn-secondary btn-sm">Réessayer</button>
            </div>
          ) : (
            <DataTable
              table="project_commissions"
              columns={commissionColumns}
              data={commissions}
              searchFields={['at_id', 'beneficiary_label']}
              height={stackedTableHeight(commissions.length)}
            />
          )}
        </Section>

        <div className="flex justify-start mt-5">
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="flex items-center gap-1.5 text-sm text-red-500 hover:text-red-700 hover:underline disabled:opacity-50"
            data-testid="project-delete"
          >
            <Trash2 size={14} />
            {deleting ? 'Suppression…' : 'Supprimer ce projet'}
          </button>
        </div>

        </div>
      </div>

      {showCreate && (
        <CreateSoumissionModal
          project={project}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadSoumissions() }}
        />
      )}

      {showPdf && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowPdf(null)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-[95vw] max-w-5xl h-[92vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 flex-shrink-0">
              <span className="text-sm font-semibold text-slate-900 truncate">{showPdf.title || 'Soumission'}</span>
              <div className="flex items-center gap-2 flex-shrink-0">
                <a
                  href={showPdf.external ? showPdf.url : pdfUrl(showPdf.id, true)}
                  download
                  target={showPdf.external ? '_blank' : undefined}
                  rel={showPdf.external ? 'noreferrer' : undefined}
                  className="inline-flex items-center gap-1.5 btn-secondary btn-sm">
                  <FileDown size={13} /> Télécharger
                </a>
                <button onClick={() => setShowPdf(null)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded">
                  <X size={16} />
                </button>
              </div>
            </div>
            <iframe src={showPdf.external ? showPdf.url : pdfUrl(showPdf.id)} className="flex-1 w-full" title="Soumission PDF" />
          </div>
        </div>
      )}
    </>
  )
}

// Picker pour le champ Vendeur d'un projet — fusionne employés salesperson
// actifs et entreprises avec is_vendeur_orisha=1. Recherche live, kind affiché
// pour distinguer un employé d'une entreprise partenaire.
function VendeurPicker({ value, options, onChange, disabled, fallbackLabel }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const selected = options.find(o => o.ref === value)
    || (value && fallbackLabel ? { ref: value, label: fallbackLabel, kind: null } : null)
  const q = query.trim().toLowerCase()
  const filtered = q
    ? options.filter(o => o.label.toLowerCase().includes(q))
    : options

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        className={`w-full text-left text-sm rounded-lg border border-slate-200 bg-white px-3 py-1.5 hover:border-slate-300 flex items-center justify-between gap-2 ${disabled ? 'opacity-50' : ''}`}
      >
        <span className={selected ? 'text-slate-900 truncate' : 'text-slate-400'}>
          {selected ? selected.label : '— Aucun —'}
        </span>
        <span className="text-xs text-slate-400 flex-shrink-0">
          {!selected ? '▾' : selected.kind === 'employee' ? 'Employé' : selected.kind === 'company' ? 'Partenaire' : ''}
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => { setOpen(false); setQuery('') }} />
          <div className="absolute left-0 right-0 mt-1 z-20 bg-white border border-slate-200 rounded-lg shadow-lg max-h-72 flex flex-col">
            <div className="p-2 border-b border-slate-100">
              <input
                autoFocus
                value={query}
                onChange={e => setQuery(e.target.value)}
                className="w-full text-sm focus:outline-none"
              />
            </div>
            <div className="overflow-y-auto py-1">
              <button
                type="button"
                onClick={() => { onChange(null); setOpen(false); setQuery('') }}
                className="w-full text-left px-3 py-1.5 text-sm text-slate-400 italic hover:bg-slate-50"
              >— Aucun —</button>
              {filtered.length === 0 ? (
                <div className="px-3 py-2 text-xs text-slate-400">Aucun résultat</div>
              ) : filtered.map(o => (
                <button
                  key={o.ref}
                  type="button"
                  onClick={() => { onChange(o.ref); setOpen(false); setQuery('') }}
                  className={`w-full text-left px-3 py-1.5 text-sm hover:bg-brand-50 flex items-center justify-between gap-2 ${value === o.ref ? 'text-brand-700 bg-brand-50' : 'text-slate-700'}`}
                >
                  <span className="truncate">{o.label}</span>
                  <span className="text-xs text-slate-400 flex-shrink-0">{o.kind === 'employee' ? 'Employé' : 'Partenaire'}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
