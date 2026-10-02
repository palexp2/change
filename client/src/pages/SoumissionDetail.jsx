import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { ArrowLeft, Copy, Trash2, PackagePlus, Mail } from 'lucide-react'
import { api } from '../lib/api.js'
import { PageTitle } from '../components/PageTitle.jsx'
import { Badge, SOUMISSION_STATUS_COLORS as STATUS_COLORS } from '../components/Badge.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import AttachmentPreview from '../components/AttachmentPreview.jsx'
import SoumissionSendModal, { SoumissionSentStamp, soumissionWasSent } from '../components/SoumissionSendModal.jsx'
import { useSoumissionBuilder, discountsPayload } from '../components/SoumissionBuilder.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { fmtDate } from '../lib/formatDate.js'
import { DetailFieldGrid, DetailField } from '../components/DetailFieldGrid.jsx'
import { InlineTextarea } from '../components/InlineFields.jsx'

// Articles : même mise en page que la page de création, enregistrée au fil de
// la saisie. Lecture seule pour une soumission d'Airtable, déjà envoyée ou
// convertie : on la duplique pour la changer.
function SoumissionItems({ soumission, onSaved }) {
  const { addToast } = useToast()
  const readOnly = !!soumission.airtable_id || !!soumission.converted_order || soumissionWasSent(soumission)
  const { ready, items, discounts, body } = useSoumissionBuilder({
    initial: soumission, language: soumission.language || 'French', currency: soumission.currency || 'CAD', readOnly,
  })
  // Notes et date de validité renvoyées telles quelles : la route les écrase sinon.
  const latest = useRef(soumission)
  latest.current = soumission
  const pending = useRef(null)
  const save = () => {
    const body = pending.current
    pending.current = null
    if (!body) return
    api.documents.soumissions.update(soumission.id, {
      ...body, notes: latest.current.notes, discount_valid_until: latest.current.discount_valid_until || null,
    }).then(onSaved).catch(e => addToast({ message: e.message, type: 'error' }))
  }
  // Le 1er passage après chargement est la soumission relue : rien à écrire.
  const hydrated = useRef(false)
  useEffect(() => {
    if (!ready || readOnly) return
    if (!hydrated.current) { hydrated.current = true; return }
    pending.current = { items, discounts: discountsPayload(discounts) }
    const t = setTimeout(save, 500)
    return () => clearTimeout(t)
  }, [ready, items, discounts]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => save, []) // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="bg-white rounded-xl border shadow-sm p-6 mb-5 space-y-4" data-testid="soumission-items">{body}</div>
}

export default function SoumissionDetail({ recordId, onClose }) {
  const id = recordId
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [duplicating, setDuplicating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [sending, setSending] = useState(false)
  const confirm = useConfirm()
  const { addToast } = useToast()

  const { record: soumission, setRecord: setSoumission, loading, loadError, reload: load } =
    useDetailRecord(() => api.documents.soumissions.get(id), [id], { clearOnError: true })

  useRealtimeChannel(id ? `soumission:${id}` : null, (msg) => {
    if (msg.type === 'soumission:updated') setSoumission(s => s ? { ...s, ...msg.payload } : s)
    else if (msg.type === 'soumission:deleted') onClose?.()
  })

  const isDraft = soumission?.status === 'Brouillon' && !soumission?.airtable_id

  // Notes modifiables sur place, hors mode édition. `discount_valid_until`
  // est renvoyé tel quel : la route l'écrase sinon.
  const [notesSaving, setNotesSaving] = useState(false)
  const saveNotes = async (notes) => {
    setNotesSaving(true)
    try {
      const updated = await api.documents.soumissions.update(id, { notes, discount_valid_until: soumission.discount_valid_until || null })
      setSoumission(s => s ? { ...s, ...updated } : s)
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setNotesSaving(false)
    }
  }

  const duplicate = async () => {
    setDuplicating(true)
    try {
      const copy = await api.documents.soumissions.duplicate(id)
      // La copie s'ouvre dans l'éditeur ; sans projet, l'éditeur n'a rien à charger.
      const pid = copy.project_id || soumission.project_id
      navigate(pid ? `/soumissions/nouvelle?projet=${pid}&soumission=${copy.id}` : `/soumissions/${copy.id}`)
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setDuplicating(false)
    }
  }

  const handleDelete = async () => {
    if (!(await confirm('Supprimer cette soumission ?'))) return
    setDeleting(true)
    try {
      await api.documents.soumissions.delete(id)
      // La fiche supprimée n'a plus rien à montrer. Ouverte depuis son projet,
      // on referme le panneau et le projet reste dessous ; ouverte par sa propre
      // adresse (lien, fil d'activité), elle cède la place à son projet.
      const pid = soumission.project_id
      if (pid && (!onClose || pathname.startsWith('/soumissions/'))) {
        navigate(`/projects/${pid}`, { replace: !!onClose, state: { tab: 'soumissions' } })
      } else if (onClose) onClose()
      else navigate('/pipeline')
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
      setDeleting(false)
    }
  }

  const pdfTitle = soumission
    ? `${soumission.language === 'English' ? 'Quote' : 'Soumission'}-${String(soumission.id).slice(0, 8).toUpperCase()}`
    : 'Soumission'

  const pending = detailPending({ loading, loadError, onRetry: load, record: soumission, notFound: 'Soumission introuvable.' })
  if (pending) return pending

  return (
    <DetailShell className="px-4 py-6">

        {/* Top bar */}
        <div className="flex items-center justify-between mb-6">
          {soumission.project_id ? (
            <Link to={`/projects/${soumission.project_id}`} state={{ tab: 'soumissions' }}
              className="flex items-center gap-2 text-slate-500 hover:text-slate-700 text-sm">
              <ArrowLeft size={16} />
              {soumission.project_name ? `Projet : ${soumission.project_name}` : 'Projet'}
            </Link>
          ) : <div />}

          <div className="flex items-center gap-2">
            {soumission.converted_order && (
              <Link to={`/orders/${soumission.converted_order.id}`}
                className="flex items-center gap-1.5 border border-green-200 bg-green-50 text-green-700 px-3 py-2 rounded-lg text-sm hover:bg-green-100">
                <PackagePlus size={14} /> Commande #{soumission.converted_order.order_number}
              </Link>
            )}
            <SoumissionSentStamp soumission={soumission} history />
            <button onClick={() => setSending(true)} data-testid="soumission-send"
              className="flex items-center gap-1.5 bg-brand-600 text-white px-3 py-2 rounded-lg text-sm font-medium hover:bg-brand-700">
              <Mail size={14} /> {soumissionWasSent(soumission) ? 'Ré-envoyer' : 'Envoyer'}
            </button>
            <button onClick={duplicate} disabled={duplicating}
              className="flex items-center gap-1.5 border border-slate-200 text-slate-600 px-3 py-2 rounded-lg text-sm hover:bg-slate-50">
              <Copy size={14} /> {duplicating ? 'Copie…' : 'Dupliquer'}
            </button>
            {isDraft && (
              <button onClick={handleDelete} disabled={deleting}
                className="flex items-center gap-1.5 border border-red-200 text-red-500 px-3 py-2 rounded-lg text-sm hover:bg-red-50">
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Header card */}
        <div className="bg-white rounded-xl border shadow-sm p-6 mb-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <PageTitle className="mb-1">
                {soumission.title || <span className="text-slate-400 italic font-normal">Sans titre</span>}
              </PageTitle>
              {soumission.company_name && (
                <LinkedRecordField
                  name="company_id"
                  value={soumission.company_id || soumission.company_name}
                  options={[{ id: soumission.company_id || soumission.company_name, name: soumission.company_name }]}
                  getHref={soumission.company_id ? c => `/companies/${c.id}` : undefined}
                  disabled
                  allowClear={false}
                />
              )}
            </div>
            <div className="flex flex-col items-end gap-2 flex-shrink-0">
              <Badge color={STATUS_COLORS[soumission.status] || 'gray'}>{soumission.status || 'Brouillon'}</Badge>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">{soumission.language === 'English' ? 'English' : 'Français'}</span>
                <span className="text-xs font-mono font-semibold text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
                  {soumission.currency || 'CAD'}
                </span>
              </div>
              {soumission.airtable_id && <span className="text-xs text-blue-400">Airtable</span>}
            </div>
          </div>

          {/* Carte de champs commune : une seule liste, réordonnable et
              masquable depuis la fiche (bouton « Personnaliser les champs »).
              Les champs personnalisés de la table s'y posent seuls. */}
          <DetailFieldGrid
            entityType="soumissions"
            record={soumission}
            className="mt-5 pt-4 border-t"
            testId="soumission-fields"
          >
            <DetailField id="created_at" label="Créée le">
              <p className="text-sm text-slate-700">{fmtDate(soumission.created_at)}</p>
            </DetailField>
            <DetailField id="expiration_date" label="Expiration">
              <p className="text-sm text-slate-700">{fmtDate(soumission.expiration_date)}</p>
            </DetailField>
            <DetailField id="project_name" label="Projet">
              {soumission.project_id
                ? <LinkedRecordField
                  name="project_id"
                  value={soumission.project_id}
                  options={[{ id: soumission.project_id, name: soumission.project_name || 'Projet' }]}
                  getHref={p => `/projects/${p.id}`}
                  disabled
                  allowClear={false}
                />
                : <p className="text-sm text-slate-700">{soumission.project_name || '—'}</p>}
            </DetailField>
            <DetailField id="notes" label="Notes" span2>
              {!soumission.airtable_id ? (
                <InlineTextarea value={soumission.notes} saving={notesSaving} onSave={saveNotes} testId="soumission-notes" />
              ) : (
                <p className="text-sm text-slate-600 whitespace-pre-wrap">{soumission.notes || '—'}</p>
              )}
            </DetailField>
          </DetailFieldGrid>
        </div>

        <SoumissionItems key={soumission.id} soumission={soumission}
          onSaved={updated => setSoumission(s => (s ? { ...s, ...updated } : s))} />

        {/* PDF section */}
        <div className="bg-white rounded-xl border shadow-sm p-5">
          <h2 className="font-semibold text-slate-700 text-sm mb-3">Document PDF</h2>
          {/* Le serveur produit le PDF à la demande : rendu local, ou pièce
              jointe relue dans Airtable pour une soumission synchronisée. */}
          {soumission.generated_pdf_path || soumission.pdf_url || !soumission.airtable_id ? (
            <AttachmentPreview
              url={`${api.documents.soumissions.pdfUrl(id)}?v=${encodeURIComponent(soumission.updated_at || '')}`}
              kind="pdf"
              title={pdfTitle}
              fileName={`${pdfTitle}.pdf`}
              size="md"
              testId="soumission-pdf"
            />
          ) : (
            <p className="text-xs text-slate-400">Aucun PDF</p>
          )}
        </div>
      <SoumissionSendModal soumissionId={id} isOpen={sending} onClose={() => setSending(false)} onSent={() => load()} />
    </DetailShell>
  )
}
