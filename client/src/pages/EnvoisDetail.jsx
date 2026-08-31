import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Pencil, Printer, Download, Package, Mail, XCircle, FileText, X, Trash2, RefreshCw, AlertTriangle, Truck } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import Spinner from '../components/Spinner.jsx'
import { Modal } from '../components/Modal.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useUndoSend } from '../components/UndoSendProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import NovoxpressLabelModal from '../components/NovoxpressLabelModal.jsx'
import NovoxpressPickupModal from '../components/NovoxpressPickupModal.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { DetailLoadError } from '../components/DetailLoadError.jsx'


function fmtCurrency(v) {
  if (v == null) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(v)
}

function SendTrackingModal({ envoi, onClose, onSent }) {
  const defaultEmail = envoi.address_contact_email || ''
  const [to, setTo] = useState(defaultEmail)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const confirm = useConfirm()
  const scheduleSend = useUndoSend()
  const { addToast } = useToast()

  async function handleSend() {
    const cleanTo = String(to || '').trim()
    if (!cleanTo || !cleanTo.includes('@')) { setError('Adresse courriel invalide'); return }
    setError('')

    // Confirmation explicite du side effect (envoi d'un courriel client-facing).
    setSending(true)
    const ok = await confirm({
      title: "Confirmer l'envoi du courriel",
      message: (
        <>Un courriel contenant le numéro de suivi <strong>{envoi.tracking_number}</strong> sera envoyé à <strong>{cleanTo}</strong>.</>
      ),
      confirmLabel: 'Envoyer',
      danger: false,
    })
    if (!ok) { setSending(false); return }

    // On ferme la modale et on planifie l'envoi avec une fenêtre d'annulation de 10 s.
    onClose()
    scheduleSend({
      message: `Envoi du suivi à ${cleanTo}…`,
      onRun: async () => {
        try {
          await api.shipments.sendTracking(envoi.id, cleanTo)
          addToast({ message: `Courriel de suivi envoyé à ${cleanTo}`, type: 'success' })
          onSent?.()
        } catch (e) {
          addToast({ message: e.message || "Erreur lors de l'envoi", type: 'error' })
        }
      },
      onCancel: () => addToast({ message: 'Envoi annulé', type: 'info' }),
    })
  }

  const contactName = [envoi.address_contact_first_name, envoi.address_contact_last_name].filter(Boolean).join(' ')

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Un courriel contenant le numéro de suivi <span className="font-mono font-semibold text-slate-900">{envoi.tracking_number}</span> sera envoyé au destinataire.
      </p>

      <div>
        <label className="label">Destinataire</label>
        {contactName && (
          <p className="text-xs text-slate-500 mb-1">{contactName}</p>
        )}
        <input
          type="email"
          className="input"
          value={to}
          onChange={e => setTo(e.target.value)}
          placeholder="client@exemple.com"
          autoFocus={!defaultEmail}
        />
        {!defaultEmail && (
          <p className="text-xs text-amber-600 mt-1">Aucun courriel trouvé pour le contact de l'adresse de livraison.</p>
        )}
      </div>

      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{error}</p>}

      <div className="flex justify-end gap-3 pt-2">
        <button onClick={onClose} className="btn-secondary">Annuler</button>
        <button onClick={handleSend} disabled={sending || !to} className="btn-primary flex items-center gap-1.5">
          {sending
            ? <><div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> Envoi…</>
            : <><Mail size={14} /> Envoyer</>
          }
        </button>
      </div>
    </div>
  )
}

function fmtAdresse(addr) {
  return [addr.line1, addr.city, addr.province, addr.postal_code, addr.country]
    .filter(Boolean).join(', ')
}

function EditEnvoiModal({ envoi, adresses, onSave, onDelete, onClose }) {
  const [form, setForm] = useState({
    tracking_number: envoi.tracking_number || '',
    carrier: envoi.carrier || '',
    shipped_at: envoi.shipped_at ? envoi.shipped_at.slice(0, 10) : '',
    notes: envoi.notes || '',
    address_id: envoi.address_id || '',
  })
  const [fieldSaving, setFieldSaving] = useState({})
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)

  async function saveField(key, value) {
    setForm(f => ({ ...f, [key]: value }))
    setError('')
    setFieldSaving(s => ({ ...s, [key]: true }))
    try {
      await onSave({ [key]: value === '' ? null : value })
    } catch (err) {
      setError(err.message)
    } finally {
      setFieldSaving(s => ({ ...s, [key]: false }))
    }
  }

  const savingLabel = (k) => fieldSaving[k] ? ' (sauvegarde...)' : ''

  return (
    <div className="space-y-4">
      <div>
        <label className="label">Transporteur{savingLabel('carrier')}</label>
        <input
          type="text"
          value={form.carrier}
          onChange={e => setForm(f => ({ ...f, carrier: e.target.value }))}
          onBlur={e => saveField('carrier', e.target.value)}
          className="input"
          placeholder="ex. Purolator, FedEx, UPS…"
        />
      </div>
      <div>
        <label className="label">N° de suivi{savingLabel('tracking_number')}</label>
        <input
          type="text"
          value={form.tracking_number}
          onChange={e => setForm(f => ({ ...f, tracking_number: e.target.value }))}
          onBlur={e => saveField('tracking_number', e.target.value)}
          className="input"
        />
      </div>
      <div>
        <label className="label">Envoyé le{savingLabel('shipped_at')}</label>
        <input
          type="date"
          value={form.shipped_at}
          onChange={e => saveField('shipped_at', e.target.value)}
          className="input"
        />
      </div>
      <div>
        <label className="label">Adresse de livraison{savingLabel('address_id')}</label>
        <LinkedRecordField
          name="address_id"
          value={form.address_id}
          options={adresses}
          labelFn={fmtAdresse}
          placeholder="Adresse"
          onChange={v => saveField('address_id', v)}
        />
      </div>
      <div>
        <label className="label">Notes{savingLabel('notes')}</label>
        <textarea
          value={form.notes}
          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
          onBlur={e => saveField('notes', e.target.value)}
          className="input"
          rows={3}
        />
      </div>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <div className="flex justify-between items-center gap-3 pt-2">
        <button
          type="button"
          onClick={async () => {
            setDeleting(true)
            try { await onDelete() }
            catch (err) { setError(err.message); setDeleting(false) }
          }}
          disabled={deleting}
          className="inline-flex items-center gap-1.5 text-sm text-red-600 hover:text-red-700 hover:bg-red-50 px-3 py-1.5 rounded-lg disabled:opacity-50"
        >
          <Trash2 size={14} /> {deleting ? 'Suppression…' : 'Supprimer'}
        </button>
        <button type="button" onClick={onClose} className="btn-primary">Fermer</button>
      </div>
    </div>
  )
}

export default function EnvoisDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [envoi, setEnvoi] = useState(null)
  const [adresses, setAdresses] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [showEdit, setShowEdit] = useState(false)
  const [showLabel, setShowLabel] = useState(false)
  const [showPickup, setShowPickup] = useState(false)
  const [showSendTracking, setShowSendTracking] = useState(false)
  const [cancellingPickup, setCancellingPickup] = useState(false)
  const [novoxConfigured, setNovoxConfigured] = useState(false)
  const [purolatorConfigured, setPurolatorConfigured] = useState(false)
  const [generatingPdf, setGeneratingPdf] = useState(false)
  const [showPdf, setShowPdf] = useState(false)
  const [retryingPdf, setRetryingPdf] = useState(false)
  const [refreshingTracking, setRefreshingTracking] = useState(false)
  const confirm = useConfirm()
  const { addToast } = useToast()

  useEffect(() => {
    api.adresses.lookup().then(setAdresses).catch(() => {})
    api.novoxpress.status().then(r => setNovoxConfigured(!!r.configured)).catch(() => {})
    api.purolator.status().then(r => setPurolatorConfigured(!!r.configured)).catch(() => {})
  }, [])

  function load() {
    setLoading(true)
    setLoadError(null)
    api.shipments.get(id)
      .then(data => setEnvoi(data))
      .catch((e) => { setEnvoi(null); setLoadError(e?.message || 'Erreur de chargement') })
      .finally(() => setLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [id])

  useRealtimeChannel(id ? `shipment:${id}` : null, (msg) => {
    if (msg.type === 'shipment:updated') setEnvoi(e => e ? { ...e, ...msg.payload } : e)
    else if (msg.type === 'shipment:deleted') navigate('/envois')
  })

  async function handleCancelPickup() {
    if (!(await confirm('Annuler le ramassage planifié ?'))) return
    setCancellingPickup(true)
    try {
      await api.novoxpress.cancelPickup(id)
      load()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setCancellingPickup(false)
    }
  }

  async function handleUpdate(form) {
    await api.shipments.update(id, form)
    load()
  }

  async function handleDelete() {
    const ok = await confirm({
      title: 'Supprimer cet envoi ?',
      message: envoi.tracking_number
        ? `L'envoi ${envoi.tracking_number} sera supprimé. Cette action est irréversible.`
        : 'Cet envoi sera supprimé. Cette action est irréversible.',
      confirmLabel: 'Supprimer',
    })
    if (!ok) return
    await api.shipments.delete(id)
    addToast({ message: 'Envoi supprimé', type: 'success' })
    navigate('/envois')
  }

  // Re-télécharge le PDF d'une étiquette déjà achetée (achat OK mais PDF non
  // récupéré, ex. 403 du CDN). Ne re-facture pas — réutilise le shipment Novoxpress.
  async function handleRetryLabelPdf() {
    setRetryingPdf(true)
    try {
      await api.novoxpress.retryLabelPdf(id)
      addToast({ message: 'Étiquette PDF récupérée', type: 'success' })
      load()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setRetryingPdf(false)
    }
  }

  // Rafraîchit le statut du colis via la Tracking API UPS et le stocke sur
  // l'envoi. Erreur UPS → toast avec le message brut de l'API (jamais muet).
  async function handleRefreshTracking() {
    setRefreshingTracking(true)
    try {
      const t = await api.ups.trackShipment(id)
      addToast({ message: t.status ? `Statut UPS : ${t.status}` : 'UPS n\'a retourné aucun statut pour ce suivi', type: t.status ? 'success' : 'info' })
      load()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setRefreshingTracking(false)
    }
  }

  async function handleGenerateBonLivraison() {
    setGeneratingPdf(true)
    try { await api.shipments.generateBonLivraison(id); await load() }
    finally { setGeneratingPdf(false) }
  }

  if (loading) {
    return (
      <Layout>
        <Spinner center />
      </Layout>
    )
  }
  if (loadError && !envoi) return <Layout><DetailLoadError message={loadError} onRetry={load} /></Layout>
  if (!envoi) return <Layout><div className="p-6 text-slate-500">Envoi introuvable.</div></Layout>

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <button
            onClick={() => navigate('/envois')}
            className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900">
                {envoi.tracking_number ? `Envoi ${envoi.tracking_number}` : 'Envoi'}
              </h1>
            </div>
            {envoi.company_name && envoi.company_id && (
              <div className="text-sm text-slate-500 mt-1">
                <Link to={`/companies/${envoi.company_id}`} className="text-brand-600 hover:underline">
                  {envoi.company_name}
                </Link>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Étiquette déjà achetée mais PDF non récupéré (ex. 403 du CDN) :
                proposer la récupération du PDF, PAS un nouvel achat. */}
            {novoxConfigured && envoi.novoxpress_shipment_id && !envoi.label_pdf_path ? (
              <button onClick={handleRetryLabelPdf} disabled={retryingPdf} className="btn-primary flex items-center gap-1.5 text-sm">
                <RefreshCw size={14} className={retryingPdf ? 'animate-spin' : ''} />
                {retryingPdf ? 'Récupération…' : 'Récupérer le PDF'}
              </button>
            ) : (novoxConfigured || purolatorConfigured) && envoi.address_id && (
              <button onClick={() => setShowLabel(true)} className="btn-primary flex items-center gap-1.5 text-sm">
                <Printer size={14} />
                {envoi.label_pdf_path ? 'Réimprimer' : 'Créer étiquette'}
              </button>
            )}
            {novoxConfigured && envoi.novoxpress_shipment_id && !envoi.novoxpress_pickup_id && (
              <button onClick={() => setShowPickup(true)} className="btn-secondary flex items-center gap-1.5 text-sm">
                <Package size={14} /> Commander un ramassage
              </button>
            )}
            {envoi.tracking_number && (
              <button onClick={() => setShowSendTracking(true)} className="btn-secondary flex items-center gap-1.5 text-sm">
                <Mail size={14} /> Envoyer le suivi
              </button>
            )}
            {envoi.tracking_number && (
              <button
                onClick={handleRefreshTracking}
                disabled={refreshingTracking}
                className="btn-secondary flex items-center gap-1.5 text-sm"
                data-testid="ups-refresh-tracking"
              >
                <Truck size={14} className={refreshingTracking ? 'animate-pulse' : ''} />
                {refreshingTracking ? 'Suivi UPS…' : 'Rafraîchir le suivi UPS'}
              </button>
            )}
            <button onClick={handleGenerateBonLivraison} disabled={generatingPdf} className="btn-secondary flex items-center gap-1.5 text-sm">
              <FileText size={14} />
              {generatingPdf ? 'Génération...' : envoi.bon_livraison_path ? 'Régénérer BL' : 'Bon de livraison'}
            </button>
            <button onClick={() => setShowEdit(true)} className="btn-secondary flex items-center gap-1.5">
              <Pencil size={14} /> Modifier
            </button>
          </div>
        </div>

        {/* Informations */}
        <div className="card p-5 mb-4">
          <h2 className="font-semibold text-slate-900 mb-4">Informations</h2>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Commande</dt>
              <dd>
                {envoi.order_id
                  ? <Link to={`/orders/${envoi.order_id}`} className="text-brand-600 hover:underline font-medium">#{envoi.order_number}</Link>
                  : <span className="text-slate-400">—</span>
                }
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Transporteur</dt>
              <dd className="text-slate-700">{envoi.carrier || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">N° de suivi</dt>
              <dd className="font-mono text-slate-700">{envoi.tracking_number || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Envoyé le</dt>
              <dd className="text-slate-700">{fmtDate(envoi.shipped_at)}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Créé le</dt>
              <dd className="text-slate-700">{fmtDate(envoi.created_at)}</dd>
            </div>
            {envoi.ups_tracking_status && (
              <div className="col-span-2 md:col-span-3" data-testid="ups-tracking-status">
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Statut UPS</dt>
                <dd className="text-slate-700">
                  {envoi.ups_tracking_status}
                  {envoi.ups_tracking_last_activity && (
                    <span className="text-slate-500"> — {envoi.ups_tracking_last_activity}</span>
                  )}
                  {envoi.ups_tracking_checked_at && (
                    <span className="text-xs text-slate-400 block mt-0.5">Vérifié le {fmtDate(envoi.ups_tracking_checked_at)}</span>
                  )}
                </dd>
              </div>
            )}
            {(envoi.address_line1 || envoi.address_city) && (
              <div className="col-span-2 md:col-span-3">
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Adresse de livraison</dt>
                <dd className="text-slate-700 space-y-0.5">
                  {(envoi.address_contact_first_name || envoi.address_contact_last_name) && (
                    <div className="font-medium">
                      {[envoi.address_contact_first_name, envoi.address_contact_last_name].filter(Boolean).join(' ')}
                    </div>
                  )}
                  <div>{envoi.address_line1 || [envoi.address_city, envoi.address_province, envoi.address_postal_code, envoi.address_country].filter(Boolean).join(', ')}</div>
                  {(envoi.address_contact_email || envoi.address_contact_phone || envoi.address_contact_mobile) && (
                    <div className="text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
                      {envoi.address_contact_email && <span>{envoi.address_contact_email}</span>}
                      {(envoi.address_contact_phone || envoi.address_contact_mobile) && (
                        <span>{envoi.address_contact_phone || envoi.address_contact_mobile}</span>
                      )}
                    </div>
                  )}
                </dd>
              </div>
            )}
            {envoi.notes && (
              <div className="col-span-2 md:col-span-3">
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Notes</dt>
                <dd className="text-slate-700 whitespace-pre-wrap">{envoi.notes}</dd>
              </div>
            )}
            {envoi.label_pdf_path ? (
              <div>
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Étiquette</dt>
                <dd>
                  <a
                    href={`/erp/api/novoxpress/labels/${envoi.label_pdf_path}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:underline font-medium"
                  >
                    <Download size={13} /> Télécharger PDF
                  </a>
                </dd>
              </div>
            ) : envoi.novoxpress_shipment_id && (
              <div className="col-span-2 md:col-span-3">
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Étiquette</dt>
                <dd className="inline-flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <AlertTriangle size={15} className="text-amber-600 mt-0.5 shrink-0" />
                  <span>
                    Étiquette <span className="font-medium">achetée</span> (Novoxpress {envoi.novoxpress_shipment_id}),
                    mais le PDF n'a pas pu être téléchargé. Utilisez « Récupérer le PDF » — aucune nouvelle facturation.
                  </span>
                </dd>
              </div>
            )}
            {envoi.novoxpress_pickup_id && (
              <div className="col-span-2 md:col-span-3">
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Ramassage</dt>
                <dd className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 text-sm text-brand-700 bg-brand-50 border border-brand-200 rounded-lg px-2.5 py-1">
                    <Package size={13} /> Planifié · {envoi.novoxpress_pickup_id}
                  </span>
                  <button
                    onClick={handleCancelPickup}
                    disabled={cancellingPickup}
                    className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-700 hover:underline disabled:opacity-50"
                  >
                    <XCircle size={12} /> {cancellingPickup ? 'Annulation…' : 'Annuler le ramassage'}
                  </button>
                </dd>
              </div>
            )}
          </dl>
        </div>

        {/* Articles de la commande */}
        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200">
            <h2 className="font-semibold text-slate-900">
              {envoi.items_fallback ? 'Articles de la commande' : "Articles de l'envoi"} ({envoi.order_items?.length || 0})
            </h2>
          </div>
          {!envoi.order_items?.length ? (
            <p className="text-center py-10 text-slate-400">Aucun article sur cette commande</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Produit</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">SKU</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500">Qté</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell">Coût unitaire</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500">Poids (lbs)</th>
                </tr>
              </thead>
              <tbody>
                {envoi.order_items.map((item, i) => {
                  const lineWeight = (item.weight_lbs || 0) * (item.qty || 0)
                  return (
                    <tr key={item.id || i} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-900">
                        {item.product_id
                          ? <Link to={`/products/${item.product_id}`} className="text-brand-600 hover:underline">{item.product_name || 'Produit'}</Link>
                          : (item.product_name || '—')}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-500">{item.sku || '—'}</td>
                      <td className="px-4 py-3 text-right text-slate-700">{item.qty ?? '—'}</td>
                      <td className="px-4 py-3 text-right text-slate-500 hidden sm:table-cell">{fmtCurrency(item.unit_cost)}</td>
                      <td className="px-4 py-3 text-right text-slate-500">
                        {item.weight_lbs ? `${lineWeight.toFixed(2)} lbs` : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-200 bg-slate-50">
                  <td colSpan={4} className="px-4 py-3 text-xs font-semibold text-slate-500 text-right hidden sm:table-cell">Poids total</td>
                  <td colSpan={4} className="px-4 py-3 text-xs font-semibold text-slate-500 text-right sm:hidden">Poids total</td>
                  <td className="px-4 py-3 text-right font-semibold text-slate-700">
                    {(() => {
                      const total = envoi.order_items.reduce((sum, item) => sum + (item.weight_lbs || 0) * (item.qty || 0), 0)
                      return total > 0 ? `${total.toFixed(2)} lbs` : '—'
                    })()}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        {/* Bon de livraison */}
        {envoi.bon_livraison_path && (() => {
          const pdfUrl = `/erp/api/bons-livraison/${envoi.bon_livraison_path.replace('bons-livraison/', '')}`
          return (
            <div className="card p-5 mt-4">
              <h2 className="font-semibold text-slate-900 text-sm mb-3">Bon de livraison</h2>
              <button onClick={() => setShowPdf(true)} className="group relative w-40 h-52 bg-white border border-slate-200 rounded-lg overflow-hidden hover:border-brand-400 hover:shadow-md transition-all">
                <iframe src={`${pdfUrl}#toolbar=0&navpanes=0&scrollbar=0`} className="w-[200%] h-[200%] origin-top-left scale-50 pointer-events-none" title="Aperçu bon de livraison" />
                <div className="absolute inset-0 bg-transparent group-hover:bg-brand-600/5 transition-colors flex items-center justify-center">
                  <span className="opacity-0 group-hover:opacity-100 bg-brand-600 text-white text-xs px-3 py-1.5 rounded-lg shadow-lg transition-opacity">Ouvrir</span>
                </div>
              </button>
            </div>
          )
        })()}
      </div>

      {/* PDF viewer modal */}
      {showPdf && envoi.bon_livraison_path && (() => {
        const pdfUrl = `/erp/api/bons-livraison/${envoi.bon_livraison_path.replace('bons-livraison/', '')}`
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/60" onClick={() => setShowPdf(false)} />
            <div className="relative bg-white rounded-xl shadow-2xl w-[95vw] max-w-6xl h-[92vh] flex flex-col overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
                <span className="text-sm font-semibold text-slate-900">Bon de livraison — Commande #{envoi.order_number}</span>
                <div className="flex items-center gap-2">
                  <a href={pdfUrl} download className="btn-secondary btn-sm flex items-center gap-1.5"><Download size={13} /> Télécharger</a>
                  <button onClick={() => setShowPdf(false)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded"><X size={16} /></button>
                </div>
              </div>
              <iframe src={pdfUrl} className="flex-1 w-full" title="Bon de livraison" />
            </div>
          </div>
        )
      })()}

      <Modal isOpen={showEdit} onClose={() => setShowEdit(false)} title="Modifier l'envoi">
        <EditEnvoiModal envoi={envoi} adresses={adresses} onSave={handleUpdate} onDelete={handleDelete} onClose={() => setShowEdit(false)} />
      </Modal>

      <Modal isOpen={showLabel} onClose={() => setShowLabel(false)} title="Créer une étiquette postale">
        <NovoxpressLabelModal
          envoi={envoi}
          orderItemsTotalWeight={
            (envoi.order_items || [])
              .filter(item => item.shipment_id === envoi.id)
              .reduce((sum, item) => sum + (item.weight_lbs || 0) * (item.qty || 0), 0)
          }
          onClose={() => { setShowLabel(false); load() }}
          onDone={() => { load() }}
        />
      </Modal>

      <Modal isOpen={showPickup} onClose={() => setShowPickup(false)} title="Commander un ramassage">
        <NovoxpressPickupModal
          envoi={envoi}
          defaultWeight={
            (envoi.order_items || [])
              .filter(item => item.shipment_id === envoi.id)
              .reduce((sum, item) => sum + (item.weight_lbs || 0) * (item.qty || 0), 0)
          }
          onClose={() => { setShowPickup(false); load() }}
          onDone={() => { load() }}
        />
      </Modal>

      <Modal isOpen={showSendTracking} onClose={() => setShowSendTracking(false)} title="Envoyer le courriel de suivi">
        <SendTrackingModal envoi={envoi} onClose={() => setShowSendTracking(false)} onSent={load} />
      </Modal>
    </Layout>
  )
}
