import { Link, useNavigate } from 'react-router-dom'
import { Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { fmtDateTime } from '../lib/formatDate.js'

// Fiche d'une acceptation de page hébergée : qui, quand, et le texte tel
// qu'il a été accepté (panneau latéral, registre recordPeekRoutes).
export default function AcceptationDetail({ recordId: id, onClose }) {
  const confirm = useConfirm()
  const navigate = useNavigate()
  const { record: a, loading, loadError, reload } = useDetailRecord(
    () => api.publicFiles.getAcceptance(id), [id], { clearOnError: true })
  const pending = detailPending({ loading, loadError, onRetry: reload, record: a, notFound: 'Acceptation introuvable.' })
  if (pending) return pending

  async function handleDelete() {
    const ok = await confirm({ title: "Supprimer l'acceptation", message: a.contact_name || a.name, confirmLabel: 'Supprimer', danger: true })
    if (!ok) return
    await api.publicFiles.deleteAcceptance(id)
    if (onClose) onClose()
    else navigate('/acceptations')
  }

  const field = (label, value) => (
    <div>
      <div className="label">{label}</div>
      <div className="text-sm text-slate-800 py-1">{value || <span className="text-slate-400">—</span>}</div>
    </div>
  )

  return (
    <DetailShell header={{
      actions: (
        <button onClick={handleDelete} className="btn-secondary text-red-600" title="Supprimer" data-testid="acceptance-delete">
          <Trash2 size={14} />
        </button>
      ),
    }}>
      <div className="card p-5 grid grid-cols-2 gap-4">
        {field('Contact', a.contact_id
          ? <Link to={`/contacts/${a.contact_id}`} className="link-record">{a.contact_name || a.email || 'Contact'}</Link>
          : null)}
        {field('Quand', fmtDateTime(a.at))}
        {field('Page', <a href={`/erp/p/${a.page_token}`} target="_blank" rel="noreferrer" className="link-record">{a.page_name}</a>)}
        {field('Nom signé', a.name)}
        {field('IP', a.ip)}
        {field('Empreinte', <span className="font-mono text-xs" title={a.hash}>{a.hash?.slice(0, 16)}</span>)}
      </div>
      <div className="mt-5">
        <div className="text-sm font-semibold text-slate-900 mb-2">Texte signé</div>
        <div className="card p-5 text-sm text-slate-800 whitespace-pre-wrap leading-relaxed" data-testid="acceptance-text">
          {a.text || <span className="text-slate-400">—</span>}
        </div>
      </div>
    </DetailShell>
  )
}
