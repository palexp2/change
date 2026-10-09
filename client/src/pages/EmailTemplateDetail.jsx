import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Copy as CopyIcon, Trash2, Link2 } from 'lucide-react'
import api from '../lib/api.js'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { useAutosave } from '../lib/useAutosave.js'
import { TEMPLATE_VARS, VAR_LABELS, usedVars, templateFallbacks } from '../lib/emailTemplateVars.js'
import TemplateBodyEditor from '../components/TemplateBodyEditor.jsx'

// Fiche d'un modèle de courriel : nom, langue, objet, texte (autosave).
// Variables [Email]… insérées au curseur, remplacées à l'insertion dans un
// courriel : lib/emailTemplateVars.js.
// Lien sur un morceau du texte : sélection + bouton lien (ou Ctrl+K) → fenêtre
// (url + jetons) ; le lien s'affiche comme tel, un clic rouvre la fenêtre
// (components/TemplateBodyEditor.jsx). Enregistré en `[texte](url)`. L'url peut porter des
// variables ; les pages avec acceptation (Fichiers publics) sont proposées avec
// ?contact=[Contact ID] — la page reconnaît le client par l'id de son contact.

export default function EmailTemplateDetail({ recordId: id, onClose }) {
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [error, setError] = useState(null)
  const [pages, setPages] = useState([])
  const bodyRef = useRef(null)
  useEffect(() => {
    // Toutes les pages HTML hébergées ; ?contact=[Contact ID] seulement sur celles avec acceptation.
    api.publicFiles.list().then(r => setPages((r.data || []).filter(f => /html/i.test(f.mime_type || '') || /\.html?$/i.test(f.original_name || ''))))
      .catch(() => setPages([]))
  }, [])

  const { record: t, setRecord: setT, loading, loadError, reload } = useDetailRecord(
    () => api.emailTemplates.get(id), [id], { clearOnError: true })

  const { save } = useAutosave(t, (p) => api.emailTemplates.update(id, p), {
    onSaved: updated => { setError(null); setT(cur => ({ ...cur, ...updated })) },
    onError: (key, prev, e) => { setError(e.message); setT(cur => ({ ...cur, [key]: prev })) },
  })

  const pending = detailPending({ loading, loadError, onRetry: reload, record: t, notFound: 'Modèle introuvable.' })
  if (pending) return pending

  async function handleDelete() {
    const ok = await confirm({ title: 'Supprimer le modèle', message: t.name, confirmLabel: 'Supprimer', danger: true })
    if (!ok) return
    await api.emailTemplates.remove(id)
    if (onClose) onClose()
    else navigate('/modeles-courriel')
  }

  async function handleDuplicate() {
    const copy = await api.emailTemplates.duplicate(id)
    navigate(`/modeles-courriel/${copy.id}`)
  }

  const subjectOnlyVars = usedVars(t.subject).filter(k => !usedVars(t.body).includes(k))

  const field = (key, props = {}) => (
    <input className="input" key={t[key]} defaultValue={t[key] || ''} data-testid={`email-template-${key}`}
      onBlur={e => e.target.value !== (t[key] || '') && save(key, e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} {...props} />
  )

  return (
    <DetailShell
      header={{
        actions: (<>
          <button onClick={handleDuplicate} className="btn-secondary" title="Dupliquer" data-testid="email-template-duplicate">
            <CopyIcon size={14} />
          </button>
          <button onClick={handleDelete} className="btn-secondary text-red-600" title="Supprimer" data-testid="email-template-delete">
            <Trash2 size={14} />
          </button>
        </>),
      }}
    >
      {error && <div className="mb-3 text-sm text-red-600">{error}</div>}

      <div className="card p-5 space-y-4">
        <div><label className="label">Nom interne</label>{field('name')}</div>
        <div><label className="label">Objet</label>{field('subject')}</div>
        <div>
          <div className="flex items-center gap-1">
            <label className="label mr-auto">Texte</label>
            {TEMPLATE_VARS.map(v => (
              <button key={v} type="button" data-testid="email-template-var"
                className="text-xs px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:text-slate-800"
                onMouseDown={e => e.preventDefault()} onClick={() => bodyRef.current?.insertVar(v)}>[{v}]</button>
            ))}
            <button type="button" className="btn-secondary !px-2 !py-1" title="Lien (Ctrl+K)" data-testid="email-template-link"
              onMouseDown={e => e.preventDefault()} onClick={() => bodyRef.current?.startLink()}>
              <Link2 size={14} />
            </button>
          </div>
          <TemplateBodyEditor ref={bodyRef} value={t.body || ''} testId="email-template-body"
            vars={TEMPLATE_VARS} onSave={body => save('body', body)}
            fallbacks={templateFallbacks(t)} onFallback={(k, v) => save('fallbacks', { ...templateFallbacks(t), [k]: v })}
            linkOptions={pages.map(f => ({ value: `${window.location.origin}/erp/p/${f.token}${f.accept_page ? '?contact=[Contact ID]' : ''}`, label: f.original_name }))} />
        </div>
        {/* Jetons de l'objet absents du texte : leur « si vide » se règle ici
            (dans le texte, un clic sur l'étiquette suffit). */}
        {subjectOnlyVars.length > 0 && (
          <div data-testid="email-template-fallbacks">
            <label className="label">Si vide</label>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-center">
              {subjectOnlyVars.map(k => (
                <FallbackRow key={k} k={k} value={templateFallbacks(t)[k] || ''}
                  onSave={v => save('fallbacks', { ...templateFallbacks(t), [k]: v })} />
              ))}
            </div>
          </div>
        )}
      </div>
    </DetailShell>
  )
}

function FallbackRow({ k, value, onSave }) {
  return (<>
    <span className="text-xs text-slate-500">[{VAR_LABELS[k] || k}]</span>
    <input className="input text-sm" key={value} defaultValue={value} data-testid={`email-template-fallback-${k}`}
      onBlur={e => e.target.value !== value && onSave(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
  </>)
}
