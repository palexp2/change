import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { ArrowLeft, Mail } from 'lucide-react'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import Spinner from '../components/Spinner.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'
import SoumissionSendModal, { SoumissionSentStamp, soumissionWasSent } from '../components/SoumissionSendModal.jsx'
import { useSoumissionBuilder, discountsPayload } from '../components/SoumissionBuilder.jsx'
import { useToast } from '../contexts/ToastContext.jsx'

// Page de création d'une soumission (/soumissions/nouvelle?projet=<id>) :
// saisie à gauche (useSoumissionBuilder, partagée avec la fiche), aperçu en
// direct du PDF client à droite.

// Langue et devise par défaut : celles du contact, sinon de l'entreprise du projet.
function defaultLanguage(project) {
  const l = (project.contact_language || project.company_language || '').toLowerCase()
  return l.startsWith('en') || l === 'anglais' ? 'English' : 'French'
}

// `&soumission=<id>` : modifie une soumission existante (ex. une copie
// fraîchement dupliquée) au lieu d'en créer une.
export default function SoumissionCreate() {
  const [params] = useSearchParams()
  const projectId = params.get('projet')
  const soumissionId = params.get('soumission')
  const [project, setProject] = useState(null)
  const [initial, setInitial] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    if (!projectId) { setError('Projet manquant'); return }
    Promise.all([
      api.projects.get(projectId),
      soumissionId ? api.documents.soumissions.get(soumissionId) : null,
    ]).then(([p, s]) => { setInitial(s); setProject(p) }).catch(e => setError(e.message))
  }, [projectId, soumissionId])
  if (error) return <Layout><div className="p-6"><ErrorBanner>{error}</ErrorBanner></div></Layout>
  if (!project) return <Layout><div className="p-10 flex justify-center"><Spinner /></div></Layout>
  return <SoumissionEditor key={soumissionId || 'new'} project={project} initial={initial} />
}

// Largeur d'une feuille Lettre à 96 dpi, marge d'aperçu comprise.
const SHEET_W = 880

// Aligne le nœud `from` (DOM affiché) sur `to` (DOM neuf) en ne touchant que
// ce qui diffère : le reste de la page ne bouge pas.
function morph(from, to) {
  if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) {
    from.replaceWith(from.ownerDocument.importNode(to, true))
    return
  }
  if (from.nodeType === Node.TEXT_NODE || from.nodeType === Node.COMMENT_NODE) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue
    return
  }
  if (from.nodeType !== Node.ELEMENT_NODE) return
  for (const a of [...from.attributes]) if (!to.hasAttribute(a.name)) from.removeAttribute(a.name)
  for (const a of to.attributes) if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value)
  const cur = [...from.childNodes]
  const next = [...to.childNodes]
  next.forEach((n, i) => { if (cur[i]) morph(cur[i], n); else from.appendChild(from.ownerDocument.importNode(n, true)) })
  for (let i = next.length; i < cur.length; i++) cur[i].remove()
}

// Aperçu du PDF : HTML du gabarit serveur dans une iframe mise à l'échelle de
// la colonne. L'iframe n'est chargée qu'une fois ; les mises à jour suivantes
// modifient son document en place (pas de page blanche, défilement conservé).
function PdfPreview({ html }) {
  const boxRef = useRef(null)
  const frameRef = useRef(null)
  const loadedRef = useRef(false)
  const latestRef = useRef(html)
  const [srcHtml, setSrcHtml] = useState(html)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const scale = size.w ? size.w / SHEET_W : 1
  const patch = () => {
    const doc = frameRef.current?.contentDocument
    if (!doc?.documentElement) return false
    morph(doc.documentElement, new DOMParser().parseFromString(latestRef.current, 'text/html').documentElement)
    return true
  }
  useEffect(() => {
    latestRef.current = html
    if (!(loadedRef.current && patch())) setSrcHtml(html)
  }, [html])
  const setFrame = useCallback(el => { frameRef.current = el; if (!el) loadedRef.current = false }, [])
  const onLoad = () => {
    loadedRef.current = true
    if (latestRef.current !== srcHtml) patch()
  }
  return (
    <div ref={boxRef} className="relative h-full overflow-hidden bg-slate-200">
      {srcHtml && size.w > 0 && (
        <iframe ref={setFrame}
          title="Aperçu" srcDoc={srcHtml} onLoad={onLoad}
          style={{ width: SHEET_W, height: size.h / scale, transform: `scale(${scale})`, transformOrigin: '0 0', border: 0 }} />
      )}
    </div>
  )
}

// Sélecteur segmenté, comme la langue de la modale System builder.
function Segmented({ label, value, options, onChange, locked }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-slate-200 p-0.5 text-xs">
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          disabled={!!locked && v !== value} title={locked && v !== value ? locked : undefined}
          className={`px-2 py-0.5 rounded font-medium ${value === v ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent'}`}>
          {l}
        </button>
      ))}
    </div>
  )
}

function SoumissionEditor({ project, initial }) {
  const navigate = useNavigate()
  const { addToast } = useToast()
  // Quitter = fermer la page et rouvrir le projet en panneau sur la liste des projets.
  const onClose = () => navigate(`/projects/${project.id}`, { replace: true, state: { overList: true } })
  const [language, setLanguage] = useState(() => initial?.language || defaultLanguage(project))
  const [currency, setCurrency] = useState(() => initial?.currency || (/^usd/i.test(project.company_currency || '') ? 'USD' : 'CAD'))
  // Devise du client Stripe : une soumission dans une autre devise ne pourrait pas être payée.
  const [stripeCurrency, setStripeCurrency] = useState(null)
  useEffect(() => {
    if (!project.company_id) return
    api.documents.soumissions.stripeCurrency(project.company_id)
      .then(r => { if (r.currency) { setStripeCurrency(r.currency); if (!soumissionWasSent(initial)) setCurrency(r.currency) } })
      .catch(() => {})
  }, [project.company_id]) // eslint-disable-line react-hooks/exhaustive-deps
  const [saving, setSaving] = useState(false)
  // Déjà envoyée : figée, seul le ré-envoi reste (dupliquer pour la changer).
  const sent = soumissionWasSent(initial)
  const { ready, items, discounts, body } = useSoumissionBuilder({ initial, language, currency, readOnly: sent })

  const payload = () => ({
    language, currency,
    discounts: discountsPayload(discounts),
    project_id: project.id, company_id: project.company_id || null, items,
    // La mise à jour efface ce qu'on ne renvoie pas : on garde ceux de la soumission ouverte.
    ...(initial && { notes: initial.notes, discount_valid_until: initial.discount_valid_until || null }),
  })
  // Aperçu : recalculé 300 ms après la dernière saisie ; une réponse périmée
  // n'écrase jamais une plus récente.
  const [previewHtml, setPreviewHtml] = useState('')
  const previewSeq = useRef(0)
  useEffect(() => {
    const seq = ++previewSeq.current
    const t = setTimeout(() => {
      api.documents.soumissions.preview(payload())
        .then(r => { if (seq === previewSeq.current) setPreviewHtml(r.html) })
        .catch(console.error)
    }, 300)
    return () => clearTimeout(t)
  }, [language, currency, items, discounts]) // eslint-disable-line react-hooks/exhaustive-deps

  // « Envoyer » enregistre d'abord : création la 1re fois, mise à jour ensuite
  // (la modale d'envoi fermée sans envoyer laisse la page telle quelle).
  const [savedId, setSavedId] = useState(initial?.id || null)
  const [sending, setSending] = useState(false)
  const persist = async () => {
    if (sent) return initial
    if (savedId) return api.documents.soumissions.update(savedId, payload())
    const result = await api.documents.soumissions.create(payload())
    setSavedId(result.id)
    addToast({ message: `${result.title || 'Soumission'} créée`, type: 'success' })
    return result
  }
  const save = async (then) => {
    setSaving(true)
    try {
      await persist()
      then()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Layout>
    <div className="h-full flex min-h-0">
    <div className="flex-1 min-w-0 overflow-y-auto p-6">
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <Link to={`/projects/${project.id}`} replace state={{ overList: true }} className="text-slate-400 hover:text-slate-700"><ArrowLeft size={18} /></Link>
        <h1 className="text-lg font-semibold text-slate-900 truncate">{project.name || 'Nouvelle soumission'}</h1>
        <div className="ml-auto flex items-center gap-2">
          <Segmented label="Langue" value={language} onChange={setLanguage} options={[['French', 'FR'], ['English', 'EN']]}
            locked={sent && 'Déjà envoyée'} />
          <Segmented label="Devise" value={currency} onChange={setCurrency} options={[['CAD', 'CAD'], ['USD', 'USD']]}
            locked={(sent && 'Déjà envoyée') || (stripeCurrency && `Client Stripe en ${stripeCurrency}`)} />
        </div>
      </div>

      {body}

      <div className="flex justify-end items-center gap-2 pt-2 border-t border-slate-200">
        <SoumissionSentStamp soumission={initial} />
        <button type="button" onClick={onClose} className="btn-ghost">Annuler</button>
        {!sent && (
          <button type="button" onClick={() => save(onClose)} disabled={saving || !ready || items.length === 0} className="btn-secondary">
            {savedId ? 'Enregistrer' : 'Créer'}
          </button>
        )}
        <button type="button" onClick={() => save(() => setSending(true))} disabled={saving || !ready || items.length === 0}
          className="btn-primary flex items-center gap-1.5" data-testid="soumission-send">
          <Mail size={14} /> {soumissionWasSent(initial) ? 'Ré-envoyer' : 'Envoyer'}
        </button>
      </div>
      <SoumissionSendModal soumissionId={savedId} isOpen={sending} onClose={() => setSending(false)} onSent={onClose} />
    </div>
    </div>
    <div className="w-[46%] max-w-[760px] flex-shrink-0 border-l border-slate-200 hidden lg:block">
      <PdfPreview html={previewHtml} />
    </div>
    </div>
    </Layout>
  )
}
