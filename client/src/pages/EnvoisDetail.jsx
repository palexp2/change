import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Printer, Package, Mail, FileText, Trash2, RefreshCw, AlertTriangle, Truck, ExternalLink } from 'lucide-react'
import api from '../lib/api.js'
import { PageTitle } from '../components/PageTitle.jsx'
import Spinner from '../components/Spinner.jsx'
import { Modal } from '../components/Modal.jsx'
import EmailComposerModal from '../components/EmailComposerModal.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { Badge } from '../components/Badge.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { DetailFieldGrid, DetailField } from '../components/DetailFieldGrid.jsx'
import { SaveStatus, useSaveStatus } from '../components/SaveStatus.jsx'
import NovoxpressLabelModal from '../components/NovoxpressLabelModal.jsx'
import NovoxpressPickupModal from '../components/NovoxpressPickupModal.jsx'
import NovoxpressPickupDetails from '../components/NovoxpressPickupDetails.jsx'
import AttachmentPreview from '../components/AttachmentPreview.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { DetailLoadError } from '../components/DetailLoadError.jsx'
import { fmtAddress as fmtAdresse } from '../utils/formatters.js'
import { trackingUrl } from '../lib/trackingUrl.js'
import { shipmentTitle } from '../lib/shipmentLabel.js'


const FULFILLMENT_COLORS = {
  'À prélever': 'slate',
  'Prélevé': 'emerald',
  "Dans l'envoi": 'indigo',
  'Envoyé': 'green',
  'En attente': 'amber',
}

// Colonnes du DataTable « Articles » de la fiche envoi. Méta partagée
// (tableDefs.shipment_items) + renders spécifiques à la page. Lecture seule :
// les lignes s'éditent sur la fiche commande.
const ITEM_RENDERS = {
  // Colonne « Produit » : le champ est `product_id` (comme sur la fiche commande),
  // affiché par le nom du produit, cliquable vers sa fiche.
  product_id: item => (item.product_id
    ? <Link to={`/products/${item.product_id}`} onClick={e => e.stopPropagation()} className="font-medium text-brand-600 hover:underline">{item.product_name || 'Produit'}</Link>
    : <span className="font-medium text-slate-900">{item.product_name || '—'}</span>),
  sku: item => item.sku
    ? <span className="font-mono text-xs text-slate-500">{item.sku}</span>
    : <span className="text-slate-300">—</span>,
  line_weight_lbs: item => (item.line_weight_lbs
    ? <span className="tabular-nums">{item.line_weight_lbs.toFixed(2)}</span>
    : <span className="text-slate-300">—</span>),
  weight_lbs: item => (item.weight_lbs
    ? <span className="tabular-nums">{Number(item.weight_lbs).toFixed(2)}</span>
    : <span className="text-slate-300">—</span>),
  fulfillment_status: item => (item.fulfillment_status
    ? <Badge color={FULFILLMENT_COLORS[item.fulfillment_status] || 'gray'}>{item.fulfillment_status}</Badge>
    : <span className="text-slate-300">—</span>),
}
const ITEM_COLUMNS = TABLE_COLUMN_META.shipment_items.map(meta => ({ ...meta, render: ITEM_RENDERS[meta.id] }))

// Éditeurs en ligne de la carte « Informations » : pas de modale, pas de bouton
// « Enregistrer » — la valeur part au blur (règle autosave du CLAUDE.md).
function InlineText({ value, saving, onSave, className = '', testId }) {
  const [local, setLocal] = useState(value ?? '')
  useEffect(() => { setLocal(value ?? '') }, [value])
  return (
    <input
      type="text"
      value={local}
      onChange={e => setLocal(e.target.value)}
      onBlur={e => { if (e.target.value !== (value ?? '')) onSave(e.target.value) }}
      className={`input text-sm w-full ${className}`}
      disabled={saving}
      data-testid={testId}
    />
  )
}

function InlineTextarea({ value, saving, onSave, testId }) {
  const [local, setLocal] = useState(value ?? '')
  const ref = useRef(null)
  useEffect(() => { setLocal(value ?? '') }, [value])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [local])
  return (
    <textarea
      ref={ref}
      value={local}
      onChange={e => setLocal(e.target.value)}
      onBlur={e => { if (e.target.value !== (value ?? '')) onSave(e.target.value) }}
      className="input text-sm w-full resize-none overflow-hidden"
      rows={2}
      disabled={saving}
      data-testid={testId}
    />
  )
}

// `recordId` + `embedded` : monte la fiche dans un RecordPeekDrawer (side-peek)
// sans le chrome de page (Layout, bouton retour). `onClose` ferme le panneau
// après suppression du record.
export default function EnvoisDetail({ recordId, embedded = true, onClose }) {
  const { id: paramId } = useParams()
  const id = recordId ?? paramId
  const navigate = useNavigate()
  // Le cadre vient toujours du panneau latéral : une fiche ne s'affiche jamais
  // en pleine page (voir components/RecordRoutePanel.jsx).
  const shell = (content) => content
  const { record: envoi, setRecord: setEnvoi, loading, loadError, reload: load } =
    useDetailRecord(() => api.shipments.get(id), [id], { clearOnError: true })
  const [adresses, setAdresses] = useState([])
  const [commandes, setCommandes] = useState([])
  const [fieldSaving, setFieldSaving] = useState({})
  const { status: saveState, save } = useSaveStatus()
  const [showLabel, setShowLabel] = useState(false)
  const [showPickup, setShowPickup] = useState(false)
  const [showPickupDetails, setShowPickupDetails] = useState(false)
  const [showSendTracking, setShowSendTracking] = useState(false)
  const [cancellingPickup, setCancellingPickup] = useState(false)
  const [novoxConfigured, setNovoxConfigured] = useState(false)
  const [generatingPdf, setGeneratingPdf] = useState(false)
  const [retryingPdf, setRetryingPdf] = useState(false)
  // La fiche pointe un PDF d'étiquette, mais le fichier n'est plus sur le
  // serveur (vieux envois importés) : la vignette nous le dit, on retombe alors
  // sur le même parcours que « PDF jamais téléchargé ».
  const [labelFileMissing, setLabelFileMissing] = useState(false)
  const confirm = useConfirm()
  const { addToast } = useToast()

  useEffect(() => { setLabelFileMissing(false) }, [id])

  useEffect(() => {
    api.adresses.lookup().then(setAdresses).catch(() => {})
    api.orders.lookup().then(setCommandes).catch(() => {})
    api.novoxpress.status().then(r => setNovoxConfigured(!!r.configured)).catch(() => {})
  }, [])

  useRealtimeChannel(id ? `shipment:${id}` : null, (msg) => {
    if (msg.type === 'shipment:updated') setEnvoi(e => e ? { ...e, ...msg.payload } : e)
    else if (msg.type === 'shipment:deleted') { if (embedded) onClose?.(); else navigate('/envois') }
  })

  // Retourne true si le ramassage a bien été annulé, pour que l'appelant
  // (modale de détails) puisse se refermer.
  async function handleCancelPickup() {
    if (!(await confirm('Annuler le ramassage planifié ?'))) return false
    setCancellingPickup(true)
    try {
      await api.novoxpress.cancelPickup(id)
      load()
      return true
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
      return false
    } finally {
      setCancellingPickup(false)
    }
  }

  // Autosave d'un champ de la carte « Informations ». Le PATCH renvoie la ligne
  // complète (adresse jointe comprise) : on la fusionne plutôt que de recharger,
  // pour ne pas faire clignoter la fiche à chaque blur.
  async function saveField(key, value) {
    const clean = value === '' ? null : value
    setFieldSaving(s => ({ ...s, [key]: true }))
    try {
      await save(async () => {
        const updated = await api.shipments.update(id, { [key]: clean })
        setEnvoi(e => (e ? { ...e, ...updated } : e))
      })
    } finally {
      setFieldSaving(s => ({ ...s, [key]: false }))
    }
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
    if (embedded) onClose?.()
    else navigate('/envois')
  }

  // Re-télécharge le PDF d'une étiquette déjà achetée (achat OK mais PDF non
  // récupéré, ex. 403 du CDN). Ne re-facture pas — réutilise l'expédition déjà
  // créée chez Novoxpress.
  async function handleRetryLabelPdf() {
    setRetryingPdf(true)
    try {
      await api.novoxpress.retryLabelPdf(id)
      addToast({ message: 'Étiquette PDF récupérée', type: 'success' })
      // Le nom du fichier ne change pas : sans ce reset, la vignette resterait
      // masquée alors que le PDF est de nouveau là.
      setLabelFileMissing(false)
      load()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setRetryingPdf(false)
    }
  }

  async function handleGenerateBonLivraison() {
    setGeneratingPdf(true)
    try { await api.shipments.generateBonLivraison(id); await load() }
    catch (e) { addToast({ message: e.message || 'Génération impossible', type: 'error' }) }
    finally { setGeneratingPdf(false) }
  }

  if (loading) return shell(<Spinner center />)
  if (loadError && !envoi) return shell(<DetailLoadError message={loadError} onRetry={load} />)
  if (!envoi) return shell(<div className="p-6 text-slate-500">Envoi introuvable.</div>)

  // Étiquette achetée chez Novoxpress mais PDF pas récupéré (403 du CDN) ou
  // fichier disparu du serveur : dans les deux cas, il est re-téléchargeable.
  const missingLabelPdf = !envoi.label_pdf_path || labelFileMissing
  const pendingPdfLabel = missingLabelPdf && novoxConfigured && envoi.novoxpress_shipment_id

  // Suivi sur le site du transporteur (null si transporteur inconnu / pas de numéro).
  const trackingLink = trackingUrl(envoi.carrier, envoi.tracking_number)

  // Lignes du DataTable Articles : poids de ligne pré-calculé pour qu'il soit
  // triable / filtrable / totalisable comme un vrai champ.
  const itemRows = (envoi.order_items || []).map(item => ({
    ...item,
    line_weight_lbs: (item.weight_lbs || 0) * (item.qty || 0),
  }))
  const totalWeight = itemRows.reduce((sum, item) => sum + item.line_weight_lbs, 0)

  return shell(
    <>
      <div className={embedded ? 'p-6' : 'p-6 max-w-5xl mx-auto'}>
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          {!embedded && (
            <button
              onClick={() => navigate('/envois')}
              className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg"
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              {/* En panneau, l'en-tête du drawer porte déjà le titre : on ne le
                  répète pas. Hors panneau, l'envoi se nomme par son # d'envoi. */}
              {!embedded && <PageTitle>{shipmentTitle(envoi)}</PageTitle>}
              <SaveStatus status={saveState} />
            </div>
            {envoi.company_name && envoi.company_id && (
              <div className="text-sm text-slate-500 mt-1">
                <LinkedRecordField
                  name="company_id"
                  value={envoi.company_id}
                  options={[{ id: envoi.company_id, name: envoi.company_name }]}
                  getHref={c => `/companies/${c.id}`}
                  disabled
                  allowClear={false}
                />
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Suivi chez le transporteur : seulement si on sait construire
                l'URL à partir du libellé du transporteur (sinon le numéro
                reste consultable dans la carte « Informations »). */}
            {trackingLink && (
              <a
                href={trackingLink}
                target="_blank"
                rel="noreferrer"
                className="btn-secondary flex items-center gap-1.5 text-sm"
                title={`Suivre ${envoi.tracking_number} sur le site de ${envoi.carrier}`}
                data-testid="envoi-track-link"
              >
                <Truck size={14} /> Suivre l'envoi
                <ExternalLink size={12} className="text-slate-400" />
              </a>
            )}
            {/* Étiquette déjà achetée mais PDF non récupéré (ex. 403 du CDN) :
                proposer la récupération du PDF, PAS un nouvel achat. */}
            {pendingPdfLabel ? (
              <button
                onClick={() => handleRetryLabelPdf()}
                disabled={retryingPdf}
                className="btn-primary flex items-center gap-1.5 text-sm"
                data-testid="retry-label-pdf"
              >
                <RefreshCw size={14} className={retryingPdf ? 'animate-spin' : ''} />
                {retryingPdf ? 'Récupération…' : 'Récupérer le PDF'}
              </button>
            ) : novoxConfigured && envoi.address_id && !envoi.label_pdf_path && (
              /* Pas de bouton une fois l'étiquette achetée : la modale est un
                 achat (elle refacture), et le PDF déjà obtenu s'ouvre depuis la
                 vignette « Étiquette » plus bas dans la fiche. */
              <button onClick={() => setShowLabel(true)} className="btn-primary flex items-center gap-1.5 text-sm">
                <Printer size={14} /> Créer étiquette
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
            {/* Plus de bouton « Bon de livraison » ici : le BL est une pièce
                jointe de la fiche (comme l'étiquette) — la vignette et la
                génération vivent dans le champ « Bon de livraison ». */}
            {/* Plus de bouton « Modifier » : les champs de la fiche s'éditent
                directement en ligne. Reste la suppression, qui n'est pas une
                édition de champ. */}
            <button
              onClick={handleDelete}
              className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
              title="Supprimer l'envoi"
              aria-label="Supprimer l'envoi"
              data-testid="envoi-delete"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>

        {/* Informations — édition en ligne (autosave au blur). L'ordre des
            champs et ceux qu'on garde se règlent dans la fiche elle-même
            (« Personnaliser les champs » : en-tête du panneau latéral, ou au
            survol de la carte sur la page pleine). */}
        <DetailFieldGrid entityType="shipments" record={envoi} className="card p-5 mb-4" testId="envoi-fields">
          <DetailField id="order_id" label="Commande" saving={fieldSaving.order_id}>
            {/* Rattachement modifiable ET déliable, synchronisé dans les deux
                sens avec Airtable (« Commande lié »). Changer de commande
                détache les lignes qui n'en font pas partie — la fiche retombe
                alors sur les articles de la nouvelle commande ; délier détache
                toutes les lignes et laisse l'envoi sans commande (son bon de
                livraison ne peut plus être généré jusqu'au rattachement). */}
            <LinkedRecordField
              name="order_id"
              value={envoi.order_id || ''}
              /* Avant le chargement de la liste, la commande courante suffit à
                 afficher le lien — sinon la fiche clignote sur « Commande ». */
              options={commandes.length ? commandes : (envoi.order_id
                ? [{ id: envoi.order_id, order_number: envoi.order_number, company_name: envoi.company_name }]
                : [])}
              labelFn={o => `#${o.order_number}${o.company_name ? ` — ${o.company_name}` : ''}`}
              saving={!!fieldSaving.order_id}
              /* Rechargement après coup : le PATCH renvoie la ligne de l'envoi,
                 pas ses articles — sans ça le tableau « Articles » resterait
                 celui de l'ancienne commande. */
              onChange={async v => { await saveField('order_id', v); load() }}
              getHref={o => `/orders/${o.id}`}
            />
          </DetailField>
          <DetailField id="carrier" label="Transporteur" saving={fieldSaving.carrier}>
            <InlineText
              value={envoi.carrier}
              saving={!!fieldSaving.carrier}
              onSave={v => saveField('carrier', v)}
              testId="envoi-field-carrier"
            />
          </DetailField>
          <DetailField id="tracking_number" label="N° de suivi" saving={fieldSaving.tracking_number}>
            <InlineText
              value={envoi.tracking_number}
              saving={!!fieldSaving.tracking_number}
              onSave={v => saveField('tracking_number', v)}
              className="font-mono"
              testId="envoi-field-tracking_number"
            />
          </DetailField>
          <DetailField id="shipped_at" label="Envoyé le" saving={fieldSaving.shipped_at}>
            <input
              type="date"
              value={envoi.shipped_at ? envoi.shipped_at.slice(0, 10) : ''}
              onChange={e => saveField('shipped_at', e.target.value)}
              className="input text-sm w-full"
              disabled={!!fieldSaving.shipped_at}
              data-testid="envoi-field-shipped_at"
            />
          </DetailField>
          <DetailField id="created_at" label="Créé le">
            <div className="text-sm text-slate-700">{fmtDate(envoi.created_at)}</div>
          </DetailField>
          <DetailField id="address_id" label="Adresse de livraison" span2 saving={fieldSaving.address_id}>
            <div className="space-y-1.5">
              <LinkedRecordField
                name="address_id"
                value={envoi.address_id || ''}
                options={adresses}
                labelFn={fmtAdresse}
                saving={!!fieldSaving.address_id}
                onChange={v => saveField('address_id', v)}
                getHref={a => `/adresses/${a.id}`}
              />
              {(envoi.address_contact_first_name || envoi.address_contact_last_name || envoi.address_contact_email || envoi.address_contact_phone || envoi.address_contact_mobile) && (
                <div className="text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5">
                  {(envoi.address_contact_first_name || envoi.address_contact_last_name) && (
                    <span className="font-medium text-slate-600">
                      {[envoi.address_contact_first_name, envoi.address_contact_last_name].filter(Boolean).join(' ')}
                    </span>
                  )}
                  {envoi.address_contact_email && <span>{envoi.address_contact_email}</span>}
                  {(envoi.address_contact_phone || envoi.address_contact_mobile) && (
                    <span>{envoi.address_contact_phone || envoi.address_contact_mobile}</span>
                  )}
                </div>
              )}
            </div>
          </DetailField>
          <DetailField id="notes" label="Notes" span2 saving={fieldSaving.notes}>
            <InlineTextarea
              value={envoi.notes}
              saving={!!fieldSaving.notes}
              onSave={v => saveField('notes', v)}
              testId="envoi-field-notes"
            />
          </DetailField>
          {envoi.ups_tracking_status && (
            <DetailField id="ups_tracking_status" label="Statut UPS" span2 testId="ups-tracking-status">
              <div className="text-sm text-slate-700">
                {envoi.ups_tracking_status}
                {envoi.ups_tracking_last_activity && (
                  <span className="text-slate-500"> — {envoi.ups_tracking_last_activity}</span>
                )}
                {envoi.ups_tracking_checked_at && (
                  <span className="text-xs text-slate-400 block mt-0.5">Vérifié le {fmtDate(envoi.ups_tracking_checked_at)}</span>
                )}
              </div>
            </DetailField>
          )}
          {envoi.label_pdf_path && !labelFileMissing ? (
            <DetailField id="label_pdf_path" label="Étiquette">
              {/* Vignette du PDF plutôt qu'un lien : on voit l'étiquette sans
                  quitter la fiche, un clic l'ouvre en grand. Si le fichier a
                  disparu du serveur, la vignette le signale et on bascule sur
                  l'encadré de récupération ci-dessous. */}
              <AttachmentPreview
                url={`/erp/api/novoxpress/labels/${envoi.label_pdf_path}`}
                fileName={envoi.label_pdf_path}
                downloadName={`etiquette-${envoi.tracking_number || envoi.id}.pdf`}
                title="Étiquette d'expédition"
                kind="pdf"
                testId="envoi-label-attachment"
                onUnavailable={reason => { if (reason === 'missing') setLabelFileMissing(true) }}
              />
            </DetailField>
          ) : envoi.novoxpress_shipment_id ? (
            <DetailField id="label_pdf_path" label="Étiquette" span2>
              <div className="inline-flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <AlertTriangle size={15} className="text-amber-600 mt-0.5 shrink-0" />
                <span>
                  Étiquette <span className="font-medium">achetée</span> (Novoxpress {envoi.novoxpress_shipment_id}),
                  {labelFileMissing
                    ? " mais le PDF n'est plus sur le serveur."
                    : " mais le PDF n'a pas pu être téléchargé."}
                  {' '}Utilisez « Récupérer le PDF » — aucune nouvelle facturation.
                </span>
              </div>
            </DetailField>
          ) : labelFileMissing ? (
            <DetailField id="label_pdf_path" label="Étiquette" span2>
              <div className="inline-flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <AlertTriangle size={15} className="text-amber-600 mt-0.5 shrink-0" />
                <span>Le PDF de l'étiquette n'est plus sur le serveur.</span>
              </div>
            </DetailField>
          ) : null}
          {/* Bon de livraison — pièce jointe de la fiche, au même titre que
              l'étiquette : la vignette remplace l'ancien bouton d'en-tête.
              Tant que le PDF n'existe pas, l'emplacement vide sert lui-même
              de déclencheur de génération. */}
          <DetailField id="bon_livraison_path" label="Bon de livraison">
            {envoi.bon_livraison_path ? (
              <div className="space-y-1">
                <AttachmentPreview
                  url={`/erp/api/bons-livraison/${envoi.bon_livraison_path.replace('bons-livraison/', '')}`}
                  fileName={envoi.bon_livraison_path.split('/').pop()}
                  downloadName={`bon-livraison-${envoi.order_number || envoi.id}.pdf`}
                  title={`Bon de livraison — Commande #${envoi.order_number}`}
                  kind="pdf"
                  testId="envoi-bl-attachment"
                />
                <button
                  type="button"
                  onClick={handleGenerateBonLivraison}
                  disabled={generatingPdf || !envoi.order_id}
                  title={envoi.order_id ? undefined : 'Envoi sans commande'}
                  className="block text-xs text-slate-500 hover:text-brand-600 disabled:opacity-50"
                  data-testid="envoi-bl-regenerate"
                >
                  {generatingPdf ? 'Génération…' : 'Régénérer'}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleGenerateBonLivraison}
                /* Le BL est celui d'une commande : sans rattachement, il n'y a
                   ni numéro, ni client, ni articles à imprimer. */
                disabled={generatingPdf || !envoi.order_id}
                title={envoi.order_id ? 'Générer le bon de livraison' : 'Envoi sans commande'}
                className="flex flex-col items-center justify-center gap-1 w-[92px] h-[120px] rounded-lg border border-dashed border-slate-300 bg-slate-50 text-slate-400 hover:border-brand-300 hover:text-brand-600 disabled:opacity-50 transition-colors"
                data-testid="envoi-bl-generate"
              >
                {generatingPdf
                  ? <RefreshCw size={16} className="animate-spin" />
                  : <FileText size={16} />}
                <span className="text-[11px] text-center px-1">{generatingPdf ? 'Génération…' : 'Générer'}</span>
              </button>
            )}
          </DetailField>
          {envoi.novoxpress_pickup_id && (
            <DetailField id="novoxpress_pickup_id" label="Ramassage" span2>
              <div className="flex items-center gap-2">
                {/* La pastille ouvre les détails du ramassage (date, fenêtre,
                    emplacement, consignes) — l'annulation vit désormais dans
                    cette modale, pour ne pas la mettre à un clic d'un survol. */}
                <button
                  type="button"
                  onClick={() => setShowPickupDetails(true)}
                  className="inline-flex items-center gap-1.5 text-sm text-brand-700 bg-brand-50 border border-brand-200 rounded-lg px-2.5 py-1 hover:bg-brand-100 hover:border-brand-300 transition-colors"
                  title="Voir les détails du ramassage"
                  data-testid="envoi-pickup-pill"
                >
                  <Package size={13} /> Planifié · {envoi.novoxpress_pickup_id}
                </button>
              </div>
            </DetailField>
          )}
        </DetailFieldGrid>

        {/* Articles — DataTable standard (vues, filtres, tri, groupement,
            recherche, totaux en pied). Lecture seule : les lignes appartiennent
            à la commande et s'éditent sur sa fiche. */}
        <div>
          <div className="flex items-baseline gap-2 mb-2">
            <h2 className="font-semibold text-slate-900">
              {envoi.items_fallback ? 'Articles de la commande' : "Articles de l'envoi"} ({itemRows.length})
            </h2>
            {totalWeight > 0 && (
              <span className="text-sm text-slate-500" data-testid="envoi-items-total-weight">
                Poids total {totalWeight.toFixed(2)} lbs
              </span>
            )}
          </div>
          <DataTable
            table="shipment_items"
            columns={ITEM_COLUMNS}
            data={itemRows}
            searchFields={['product_name', 'sku']}
            height={Math.max(180, Math.min(100 + itemRows.length * 32, 480))}
            emptyState={{
              icon: Package,
              title: 'Aucun article',
              description: "Cette commande n'a aucun article à expédier.",
            }}
          />
        </div>

      </div>

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

      <Modal isOpen={showPickupDetails} onClose={() => setShowPickupDetails(false)} title="Détails du ramassage">
        <NovoxpressPickupDetails
          envoi={envoi}
          cancelling={cancellingPickup}
          onCancel={async () => { const done = await handleCancelPickup(); if (done) setShowPickupDetails(false) }}
          onClose={() => setShowPickupDetails(false)}
        />
      </Modal>

      {/* « Envoyer » ouvre la composition (destinataire, Cc, objet, corps
          modifiables) ; l'envoi part avec la fenêtre d'annulation de 3 s. */}
      <EmailComposerModal
        isOpen={showSendTracking}
        onClose={() => setShowSendTracking(false)}
        title="Courriel de suivi"
        size="xl"
        load={async () => {
          const p = await api.shipments.trackingEmailPreview(envoi.id)
          return {
            ...p,
            notice: p.already_sent_at
              ? `Un courriel de suivi a déjà été envoyé le ${fmtDate(p.already_sent_at)}.`
              : null,
          }
        }}
        onSend={({ to, cc, subject, bodyHtml }) => api.shipments.sendTracking(envoi.id, { to, cc, subject, body_html: bodyHtml })}
        onSent={load}
      />

    </>
  )
}
