import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, Mail, ExternalLink, Search, Filter, Sparkles, Pencil, Send, X, AlertTriangle, Plus, FileText } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import Spinner from '../components/Spinner.jsx'
import { fmtDate, fmtDateTime } from '../lib/formatDate.js'

// ── Petits composants utilitaires ─────────────────────────────────────────

// Textarea qui auto-grandit selon son contenu (jusqu'à un max).
function AutoTextarea({ value, onChange, onBlur, placeholder, className = '', minRows = 2, maxRows = 30, ...rest }) {
  const ref = useRef(null)
  function resize() {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const lineH = parseFloat(getComputedStyle(el).lineHeight) || 20
    const max = lineH * maxRows
    el.style.height = Math.min(el.scrollHeight, max) + 'px'
  }
  useEffect(() => { resize() }, [value])
  return (
    <textarea
      ref={ref}
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      rows={minRows}
      className={`w-full text-sm border border-slate-200 rounded-lg p-2 focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 resize-none ${className}`}
      {...rest}
    />
  )
}

// ── Éditeur de règles avec chips PDF inline ───────────────────────────────
//
// Format sérialisé : texte brut avec marqueurs `{{pdf:<token>|<nom>}}`. Le
// composant rend chaque marqueur comme une chip bleue non-éditable (un seul
// caractère côté curseur), insère/supprime au curseur, et émet le texte
// sérialisé à chaque édition. Le `+` en bas à droite ouvre un picker de PDFs
// publics filtré côté client.

const PDF_REF_RE_CLIENT = /\{\{pdf:([a-f0-9]{16,64})(?:\|([^}]*))?\}\}/g

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Sérialise le contenu d'un node DOM en texte avec marqueurs {{pdf:...}}.
function serializeNode(root) {
  let out = ''
  for (const n of root.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.nodeValue
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      const el = /** @type {HTMLElement} */ (n)
      if (el.tagName === 'BR') {
        out += '\n'
      } else if (el.dataset && el.dataset.pdfToken) {
        const name = el.dataset.pdfName || ''
        out += `{{pdf:${el.dataset.pdfToken}|${name}}}`
      } else {
        // <div> / <span> insérés par contenteditable : recurse, et préfixer
        // d'un \n si c'est une div (saut de ligne implicite).
        if (el.tagName === 'DIV' && out && !out.endsWith('\n')) out += '\n'
        out += serializeNode(el)
      }
    }
  }
  return out
}

// Construit le HTML interne du contenteditable depuis le texte sérialisé.
function rulesToHtml(value) {
  const text = value || ''
  let html = ''
  let last = 0
  for (const m of text.matchAll(PDF_REF_RE_CLIENT)) {
    const before = text.slice(last, m.index)
    html += escapeHtml(before).replace(/\n/g, '<br>')
    const token = m[1]
    const name = (m[2] || '').trim() || 'PDF'
    html += `<span contenteditable="false" data-pdf-token="${escapeHtml(token)}" data-pdf-name="${escapeHtml(name)}" class="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded bg-brand-50 text-brand-700 border border-brand-200 text-xs font-medium align-baseline cursor-default" title="Référence PDF — supprime la chip pour retirer">📎 ${escapeHtml(name)}</span>`
    last = m.index + m[0].length
  }
  html += escapeHtml(text.slice(last)).replace(/\n/g, '<br>')
  return html
}

function PdfPickerPopover({ onPick, onClose }) {
  const [files, setFiles] = useState(null)
  const [search, setSearch] = useState('')
  useEffect(() => {
    api.publicFiles.list({ limit: 'all' })
      .then(r => setFiles((r.data || []).filter(f => (f.mime_type || '').toLowerCase().includes('pdf'))))
      .catch(() => setFiles([]))
  }, [])
  const filtered = useMemo(() => {
    if (!files) return []
    const q = search.trim().toLowerCase()
    if (!q) return files
    return files.filter(f => (f.original_name || '').toLowerCase().includes(q))
  }, [files, search])
  return (
    <div className="absolute z-20 right-0 bottom-9 w-80 bg-white border border-slate-200 rounded-lg shadow-lg p-2">
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="text-xs font-semibold text-slate-700">Insérer un PDF</div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={14} /></button>
      </div>
      <div className="relative mb-2">
        <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          autoFocus
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Rechercher un fichier…"
          className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
        />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {files === null ? (
          <div className="text-xs text-slate-400 px-2 py-3 text-center">Chargement…</div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-slate-400 px-2 py-3 text-center">Aucun PDF trouvé</div>
        ) : filtered.map(f => (
          <button
            key={f.id}
            onClick={() => onPick(f)}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-left hover:bg-slate-100 rounded"
          >
            <FileText size={12} className="text-slate-400 shrink-0" />
            <span className="truncate">{f.original_name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function RulesEditor({ value, onChange, onBlur, placeholder }) {
  const ref = useRef(null)
  const savedRangeRef = useRef(null)
  const lastSerialized = useRef(null)  // null = pas encore monté
  const [pickerOpen, setPickerOpen] = useState(false)
  const [empty, setEmpty] = useState(!(value && value.length))

  // Render initial + resync si value change "de l'extérieur" (différent du
  // dernier émis). Évite de réécrire le DOM sur chaque keystroke (sinon le
  // curseur saute).
  useEffect(() => {
    if (!ref.current) return
    // Premier rendu (lastSerialized=null) : on rend toujours, même si value
    // est vide, pour qu'un changement futur de prop puisse détecter le diff.
    if (lastSerialized.current !== null && value === lastSerialized.current) return
    ref.current.innerHTML = rulesToHtml(value || '')
    lastSerialized.current = value || ''
    setEmpty(!(value && value.length))
  }, [value])

  function handleInput() {
    if (!ref.current) return
    const serialized = serializeNode(ref.current)
    lastSerialized.current = serialized
    setEmpty(serialized.length === 0)
    onChange(serialized)
  }

  function saveSelection() {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    // Vérifier que la range est bien dans notre éditeur
    if (ref.current && ref.current.contains(range.commonAncestorContainer)) {
      savedRangeRef.current = range.cloneRange()
    }
  }

  function insertChip(file) {
    const el = ref.current
    if (!el) return
    el.focus()
    // Restaurer la sélection sauvegardée si on l'a perdue en cliquant le picker
    const sel = window.getSelection()
    if (savedRangeRef.current) {
      sel.removeAllRanges()
      sel.addRange(savedRangeRef.current)
    } else {
      // Pas de sélection : insérer à la fin
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
    }
    const range = sel.getRangeAt(0)
    range.deleteContents()
    const chip = document.createElement('span')
    chip.setAttribute('contenteditable', 'false')
    chip.dataset.pdfToken = file.token
    chip.dataset.pdfName = file.original_name
    chip.className = 'inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded bg-brand-50 text-brand-700 border border-brand-200 text-xs font-medium align-baseline cursor-default'
    chip.title = 'Référence PDF — supprime la chip pour retirer'
    chip.textContent = `📎 ${file.original_name}`
    range.insertNode(chip)
    // Repositionner le curseur après la chip
    range.setStartAfter(chip)
    range.setEndAfter(chip)
    sel.removeAllRanges()
    sel.addRange(range)
    savedRangeRef.current = range.cloneRange()
    setPickerOpen(false)
    handleInput()
  }

  return (
    <div className="relative">
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        onBlur={() => { saveSelection(); onBlur && onBlur() }}
        onKeyUp={saveSelection}
        onMouseUp={saveSelection}
        className="w-full min-h-[160px] max-h-[480px] overflow-y-auto text-sm border border-slate-200 rounded-lg p-2 pb-9 focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 whitespace-pre-wrap"
        style={{ wordBreak: 'break-word' }}
      />
      {empty && (
        <div className="pointer-events-none absolute top-2 left-2 text-sm text-slate-400 whitespace-pre-wrap">
          {placeholder}
        </div>
      )}
      <div className="absolute right-2 bottom-2">
        <button
          type="button"
          onMouseDown={e => { e.preventDefault(); saveSelection() }}
          onClick={() => setPickerOpen(o => !o)}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200"
          title="Insérer une référence vers un PDF public"
        >
          <Plus size={12} /> PDF
        </button>
        {pickerOpen && <PdfPickerPopover onPick={insertChip} onClose={() => setPickerOpen(false)} />}
      </div>
    </div>
  )
}

// Petit indicateur "sauvegardé / en cours / erreur" pour autosave.
function SaveIndicator({ state }) {
  if (state === 'saving') return <span className="text-xs text-slate-400">enregistrement…</span>
  if (state === 'saved') return <span className="text-xs text-emerald-600 inline-flex items-center gap-1"><Check size={11} /> enregistré</span>
  if (state === 'error') return <span className="text-xs text-red-600">échec d'enregistrement</span>
  return null
}

// Hook : autosave-on-blur (les changements rapides ne déclenchent pas de save tant
// que le champ n'a pas perdu le focus — évite les écritures excessives).
function useBlurSave(saveFn) {
  const [state, setState] = useState('idle')
  async function flush(value) {
    setState('saving')
    try {
      await saveFn(value)
      setState('saved')
      setTimeout(() => setState(s => s === 'saved' ? 'idle' : s), 1500)
    } catch {
      setState('error')
    }
  }
  return { state, flush }
}

// ── Contrôles de régénération IA ──────────────────────────────────────────

function RegenerateControls({ disabled, onRegenerate, loading, hasEmail }) {
  return (
    <button
      onClick={onRegenerate}
      disabled={loading || disabled}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-brand-600 hover:bg-brand-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white"
      title="Générer le courriel via OpenAI avec le contexte du qualification call et les instructions IA"
    >
      {loading ? (
        <span className="h-3 w-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
      ) : (
        <Sparkles size={12} />
      )}
      {loading ? 'Génération…' : (hasEmail ? 'Régénérer' : 'Générer (IA)')}
    </button>
  )
}

// ── Modale de confirmation d'envoi ───────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function SendConfirmModal({ it, subject, body, onClose, onSent }) {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [recipient, setRecipient] = useState(it.contact?.email || '')

  // Compte Gmail effectif côté serveur : null tant qu'on n'a pas la réponse,
  // 'none' quand le serveur renvoie pas de compte. On évite d'afficher
  // 'Aucun compte connecté' tant qu'on n'a pas confirmé l'état.
  const [gmailAccount, setGmailAccount] = useState(null) // null=loading, ''=none, '<email>'=ok
  useEffect(() => {
    let cancelled = false
    api.emailRelance.gmailAccount()
      .then(r => { if (!cancelled) setGmailAccount(r.accountEmail || '') })
      .catch(() => { if (!cancelled) setGmailAccount('') })
    return () => { cancelled = true }
  }, [])

  const recipientName = [it.contact?.first_name, it.contact?.last_name].filter(Boolean).join(' ').trim()
  const recipientValid = EMAIL_RE.test(recipient.trim())
  const canSend = recipientValid && gmailAccount && !sending

  async function confirm() {
    setSending(true)
    setError(null)
    try {
      const r = await api.emailRelance.send(it.qualification_call.id, recipient.trim())
      onSent?.(r.sent || {})
    } catch (e) {
      setError(e.message || 'Échec d\'envoi')
      setSending(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-900 inline-flex items-center gap-2">
            <Send size={14} className="text-brand-600" /> Envoyer le courriel
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <X size={16} />
          </button>
        </header>

        <div className="p-5 space-y-4">
          <p className="text-sm text-slate-600">
            Confirme les détails avant d'envoyer. Tu peux modifier le destinataire si besoin.
          </p>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Destinataire</label>
            <input
              type="email"
              value={recipient}
              onChange={e => setRecipient(e.target.value)}
              placeholder="adresse@exemple.com"
              className={`w-full text-sm font-medium bg-white border rounded-lg px-3 py-2 focus:outline-none focus:ring-1 ${
                recipient && !recipientValid
                  ? 'border-red-300 text-red-700 focus:ring-red-500 focus:border-red-500'
                  : 'border-slate-200 text-slate-900 focus:ring-brand-500 focus:border-brand-500'
              }`}
            />
            {recipientName && (
              <div className="text-xs text-slate-500 mt-1">Contact principal : {recipientName}</div>
            )}
            {recipient && !recipientValid && (
              <div className="text-xs text-red-600 mt-1">Adresse courriel invalide</div>
            )}
          </div>

          <dl className="text-sm divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
            <div className="grid grid-cols-[110px_1fr] gap-3 px-3 py-2 bg-slate-50">
              <dt className="text-slate-500">Expéditeur</dt>
              <dd className="text-slate-900 break-all">
                {gmailAccount === null && <span className="text-slate-400">Vérification…</span>}
                {gmailAccount === '' && (
                  <span className="inline-flex items-center gap-1.5 text-red-700">
                    <AlertTriangle size={12} /> Aucun compte Gmail connecté
                  </span>
                )}
                {gmailAccount && <span className="font-medium">{gmailAccount}</span>}
              </dd>
            </div>
            <div className="grid grid-cols-[110px_1fr] gap-3 px-3 py-2">
              <dt className="text-slate-500">Sujet</dt>
              <dd className="text-slate-900 font-medium break-words">{subject}</dd>
            </div>
          </dl>

          {gmailAccount === '' && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>Connecte ton compte Gmail dans <a href="/erp/connectors" className="underline font-medium">Connectors</a> pour pouvoir envoyer des courriels depuis l'ERP.</span>
            </div>
          )}

          <div>
            <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Aperçu du corps</div>
            <div className="text-sm text-slate-700 whitespace-pre-wrap p-3 bg-slate-50 border border-slate-200 rounded-lg max-h-60 overflow-y-auto">
              {body}
            </div>
          </div>

          {it.sent && (
            <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>Un courriel a déjà été envoyé le {fmtDateTime(it.sent.at)} à {it.sent.to}. Confirmer enverra un <strong>second</strong> courriel.</span>
            </div>
          )}

          {error && (
            <div className="text-sm text-red-600 p-3 bg-red-50 border border-red-200 rounded-lg">
              {error}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-100 bg-slate-50">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm font-medium rounded-md text-slate-600 hover:bg-slate-100"
            disabled={sending}
          >
            Annuler
          </button>
          <button
            onClick={confirm}
            disabled={!canSend}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-brand-600 hover:bg-brand-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white"
          >
            {sending ? (
              <span className="h-3 w-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
            ) : (
              <Send size={12} />
            )}
            {sending ? 'Envoi…' : 'Envoyer maintenant'}
          </button>
        </footer>
      </div>
    </div>
  )
}

// ── Carte d'un courriel ───────────────────────────────────────────────────

function EmailCard({ it, generalRules, savedSpecific, onSavedSpecificChange, onSent }) {
  const qcId = it.qualification_call.id

  const [specific, setSpecific] = useState(savedSpecific || '')
  const [showInstructions, setShowInstructions] = useState(Boolean(savedSpecific))
  const specSave = useBlurSave(async (value) => {
    await api.emailRelance.saveQc(qcId, value)
    onSavedSpecificChange?.(qcId, value)
  })

  // it.email = { subject, body, language, model, temperature, userEdited } | null
  // null = pas encore généré → carte affiche l'état vide avec bouton Générer.
  const [email, setEmail] = useState(it.email)
  const [subjectDraft, setSubjectDraft] = useState(it.email?.subject || '')
  const [bodyDraft, setBodyDraft] = useState(it.email?.body || '')
  const [userEdited, setUserEdited] = useState(it.email?.userEdited || false)
  const [regenLoading, setRegenLoading] = useState(false)
  const [regenError, setRegenError] = useState(null)

  const [showSendModal, setShowSendModal] = useState(false)

  // Autosave on blur. Le serveur conserve les ai_* séparément, donc une édition
  // utilisateur n'écrase pas la trace de la dernière sortie IA.
  const draftSave = useBlurSave(async ({ subject, body }) => {
    await api.emailRelance.saveDraft(qcId, subject, body)
  })

  async function regenerate() {
    setRegenLoading(true)
    setRegenError(null)
    try {
      const out = await api.emailRelance.regenerate(qcId, 0.7, generalRules, specific)
      const next = {
        subject: out.subject,
        body: out.body,
        language: out.language,
        model: out.model,
        temperature: out.temperature,
        userEdited: false,
      }
      setEmail(next)
      setSubjectDraft(out.subject)
      setBodyDraft(out.body)
      setUserEdited(false)
    } catch (e) {
      setRegenError(e.message || 'Erreur de génération')
    } finally {
      setRegenLoading(false)
    }
  }

  return (
    <article className="card overflow-hidden">
      <header className="flex items-start justify-between gap-3 px-4 py-3 border-b border-slate-100 bg-slate-50">
        <div className="min-w-0">
          <Link
            to={`/companies/${it.company.id}`}
            className="text-sm font-semibold text-slate-900 hover:text-brand-700 inline-flex items-center gap-1"
          >
            {it.company.name}
            <ExternalLink size={12} className="text-slate-400" />
          </Link>
          <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
            {it.company.lifecycle_phase && <span>{it.company.lifecycle_phase}</span>}
            {it.contact && (it.contact.first_name || it.contact.last_name) && (
              <span>
                Contact : <Link to={`/contacts/${it.contact.id}`} className="text-brand-700 hover:underline">
                  {[it.contact.first_name, it.contact.last_name].filter(Boolean).join(' ')}
                </Link>
              </span>
            )}
            {it.qualification_call.call_date && <span>QC du {fmtDate(it.qualification_call.call_date)}</span>}
            {it.project && (
              <span>
                Projet perdu : <span className="font-mono">{it.project.project_number}</span>
                {it.project.close_date ? ` · ${fmtDate(it.project.close_date)}` : ''}
                {it.project.value_cad ? ` · ${new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(it.project.value_cad)}` : ''}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <RegenerateControls
            hasEmail={!!email}
            onRegenerate={regenerate}
            loading={regenLoading}
          />
          <button
            onClick={() => setShowSendModal(true)}
            disabled={!email}
            title={
              !email ? 'Génère d\'abord le courriel avec l\'IA'
              : it.contact?.email ? `Envoyer à ${it.contact.email}`
              : 'Envoyer (saisir le destinataire dans la modale)'
            }
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white"
          >
            <Send size={12} />
            Envoyer
          </button>
          {email && (
            <span className={`inline-flex text-xs font-medium px-2 py-0.5 rounded-full ${
              email.language === 'fr' ? 'bg-blue-100 text-blue-700' : 'bg-violet-100 text-violet-700'
            }`}>{email.language.toUpperCase()}</span>
          )}
        </div>
      </header>

      {it.sent && (
        <div className="px-4 py-2 border-b border-slate-100 text-xs bg-emerald-50 text-emerald-800 inline-flex items-center gap-1.5 w-full">
          <Check size={12} />
          Envoyé le {fmtDateTime(it.sent.at)}
          {it.sent.to ? ` à ${it.sent.to}` : ''}
          {it.sent.from ? ` · depuis ${it.sent.from}` : ''}
        </div>
      )}

      {showSendModal && (
        <SendConfirmModal
          it={it}
          subject={subjectDraft}
          body={bodyDraft}
          onClose={() => setShowSendModal(false)}
          onSent={(sent) => {
            setShowSendModal(false)
            onSent?.(qcId, sent)
          }}
        />
      )}

      {/* Bandeau d'état (généré par IA / édité / erreur) */}
      {email && (
        <div className="px-4 py-2 border-b border-slate-100 text-xs flex items-center gap-3 bg-slate-50">
          <span className="inline-flex items-center gap-1.5 text-violet-700">
            <Sparkles size={12} />
            Généré par IA{email.model ? ` · ${email.model}` : ''}{email.temperature != null ? ` · temp ${email.temperature}` : ''}
          </span>
          {userEdited && (
            <span className="inline-flex items-center gap-1.5 text-amber-700">
              <Pencil size={11} /> édité manuellement
            </span>
          )}
          {regenError && (
            <span className="text-red-600 truncate max-w-[260px]" title={regenError}>{regenError}</span>
          )}
        </div>
      )}

      {/* Instructions IA spécifiques à cette entreprise */}
      <div className="px-4 pt-3">
        {!showInstructions && !specific ? (
          <button
            onClick={() => setShowInstructions(true)}
            className="text-xs text-slate-500 hover:text-brand-700 inline-flex items-center gap-1"
          >
            <Sparkles size={11} /> Ajouter des instructions IA pour ce courriel
          </button>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-slate-400 uppercase tracking-wide inline-flex items-center gap-1.5">
                <Sparkles size={11} /> Instructions IA pour cette entreprise
              </span>
              <SaveIndicator state={specSave.state} />
            </div>
            <AutoTextarea
              value={specific}
              onChange={setSpecific}
              onBlur={() => specSave.flush(specific)}
              placeholder={`Ex. : Mentionner qu'on les a vus à l'expo Saint-Hyacinthe en novembre. Ne pas parler de tomates, ils font des fines herbes. Le décideur s'appelle Marie-Pier.`}
              minRows={2}
              maxRows={8}
            />
          </div>
        )}
      </div>

      <div className="p-4 space-y-3">
        {email ? (
          <>
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">Sujet</span>
                <SaveIndicator state={draftSave.state} />
              </div>
              <input
                type="text"
                value={subjectDraft}
                onChange={e => { setSubjectDraft(e.target.value); setUserEdited(true) }}
                onBlur={e => draftSave.flush({ subject: e.target.value, body: bodyDraft })}
                className="w-full text-sm font-medium text-slate-900 bg-white border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">Corps</span>
              </div>
              <AutoTextarea
                value={bodyDraft}
                onChange={v => { setBodyDraft(v); setUserEdited(true) }}
                onBlur={e => draftSave.flush({ subject: subjectDraft, body: e.target.value })}
                className="bg-slate-50 font-sans text-slate-700"
                minRows={8}
                maxRows={40}
              />
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center text-center py-10 px-4 border-2 border-dashed border-slate-200 rounded-lg bg-slate-50">
            <Sparkles size={28} className="text-brand-500 mb-3" />
            <h3 className="text-sm font-semibold text-slate-900 mb-1">Aucun courriel généré</h3>
            <p className="text-xs text-slate-500 max-w-sm mb-4">
              Le courriel sera personnalisé à partir des données du QC, des règles générales,
              et des instructions spécifiques que tu peux ajouter ci-dessus.
            </p>
            <button
              onClick={regenerate}
              disabled={regenLoading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-brand-600 hover:bg-brand-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white"
            >
              {regenLoading ? (
                <span className="h-3 w-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
              ) : (
                <Sparkles size={14} />
              )}
              {regenLoading ? 'Génération…' : 'Générer avec l\'IA'}
            </button>
            {regenError && (
              <div className="mt-3 text-xs text-red-600 max-w-sm">{regenError}</div>
            )}
          </div>
        )}

        {(it.qualification_call.challenges
          || it.qualification_call.farm_description
          || it.qualification_call.motivation_today
          || it.qualification_call.motivation_why_now) && (
          <details className="text-xs">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-700">Données source de la personnalisation</summary>
            <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-slate-100">
              {it.qualification_call.challenges && (
                <div>
                  <div className="text-slate-400 mb-0.5">Défis</div>
                  <div className="text-slate-600 whitespace-pre-wrap">{it.qualification_call.challenges}</div>
                </div>
              )}
              {it.qualification_call.farm_description && (
                <div>
                  <div className="text-slate-400 mb-0.5">Description ferme</div>
                  <div className="text-slate-600 whitespace-pre-wrap">{it.qualification_call.farm_description}</div>
                </div>
              )}
              {it.qualification_call.short_term_goals && (
                <div>
                  <div className="text-slate-400 mb-0.5">Objectifs court terme</div>
                  <div className="text-slate-600 whitespace-pre-wrap">{it.qualification_call.short_term_goals}</div>
                </div>
              )}
              {it.qualification_call.business_models?.length > 0 && (
                <div>
                  <div className="text-slate-400 mb-0.5">Modèles d'affaires</div>
                  <div className="text-slate-600">{it.qualification_call.business_models.join(', ')}</div>
                </div>
              )}
              {it.qualification_call.motivation_today && (
                <div className="md:col-span-2">
                  <div className="text-slate-400 mb-0.5">Motivation aujourd'hui (verbatim transcription)</div>
                  <div className="text-slate-600 whitespace-pre-wrap">{it.qualification_call.motivation_today}</div>
                </div>
              )}
              {it.qualification_call.motivation_why_now && (
                <div className="md:col-span-2">
                  <div className="text-slate-400 mb-0.5">Motivation — pourquoi maintenant (verbatim transcription)</div>
                  <div className="text-slate-600 whitespace-pre-wrap">{it.qualification_call.motivation_why_now}</div>
                </div>
              )}
            </div>
          </details>
        )}
      </div>
    </article>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function RelanceQualification() {
  const [items, setItems] = useState(null)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [langFilter, setLangFilter] = useState('all')

  // Règles générales (partagées entre tous les emails) + savedSpecific (par qc)
  const [generalRules, setGeneralRules] = useState('')
  const [savedSpecific, setSavedSpecific] = useState({})  // { [qcId]: instructions }
  const generalSave = useBlurSave(async (value) => {
    await api.emailRelance.saveGlobal(value)
  })

  useEffect(() => {
    Promise.all([
      api.emailRelance.qualificationCalls(),
      api.emailRelance.settings(),
    ]).then(([list, settings]) => {
      setItems(list.data || [])
      setGeneralRules(settings.general || '')
      setSavedSpecific(settings.perQc || {})
    }).catch(e => setError(e.message || 'Erreur de chargement'))
  }, [])

  // Persistance du scroll : on sauvegarde la position dans sessionStorage et
  // on la restaure après chargement des items, pour ne pas perdre l'endroit
  // où l'utilisateur était en train d'éditer un courriel après un refresh.
  // Les AutoTextarea s'auto-redimensionnent après le premier paint, donc la
  // hauteur totale grandit progressivement — on retente la restauration
  // jusqu'à atteindre la cible ou jusqu'à stabilisation (~1s max).
  useEffect(() => {
    if (items === null) return
    const main = document.querySelector('main')
    if (!main) return

    const SCROLL_KEY = 'erp.relanceQualif.scroll'
    const saved = sessionStorage.getItem(SCROLL_KEY)
    if (saved) {
      const targetY = parseInt(saved, 10)
      if (Number.isFinite(targetY) && targetY > 0) {
        let attempts = 0
        const tryRestore = () => {
          main.scrollTop = targetY
          attempts++
          if (main.scrollTop < targetY - 1 && attempts < 20) {
            setTimeout(tryRestore, 50)
          }
        }
        tryRestore()
      }
    }

    let raf = null
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = null
        try { sessionStorage.setItem(SCROLL_KEY, String(main.scrollTop)) } catch {}
      })
    }
    main.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      main.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [items])

  const filtered = useMemo(() => {
    if (!items) return []
    const q = search.trim().toLowerCase()
    return items.filter(it => {
      if (langFilter !== 'all' && it.email?.language !== langFilter) return false
      if (!q) return true
      return it.company.name.toLowerCase().includes(q)
        || (it.qualification_call.challenges || '').toLowerCase().includes(q)
        || (it.email?.subject || '').toLowerCase().includes(q)
    })
  }, [items, search, langFilter])

  // Compteurs : FR/EN ne comptent que les cartes avec un draft (les autres
  // n'ont pas encore de langue déterminée — la langue est choisie par l'IA).
  const counts = useMemo(() => {
    if (!items) return { total: 0, fr: 0, en: 0 }
    return {
      total: items.length,
      fr: items.filter(i => i.email?.language === 'fr').length,
      en: items.filter(i => i.email?.language === 'en').length,
    }
  }, [items])

  if (items === null && !error) {
    return <Layout><Spinner center /></Layout>
  }
  if (error) {
    return <Layout><div className="p-6 text-red-600">Erreur : {error}</div></Layout>
  }

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Mail size={22} className="text-brand-600" />
            Relances qualification
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Templates d'emails personnalisés pour les entreprises ayant eu un appel de qualification
            et dont la phase HubSpot est <strong>Quote Sent</strong>. Personnalise les règles de gauche
            pour orienter l'IA, ou édite directement chaque courriel.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6 items-start">
          {/* Sidebar gauche : règles générales (sticky sur desktop) */}
          <aside className="lg:sticky lg:top-6 space-y-4">
            <div className="card p-4">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-slate-900 inline-flex items-center gap-1.5">
                  <Sparkles size={14} className="text-brand-600" /> Règles générales
                </h2>
                <SaveIndicator state={generalSave.state} />
              </div>
              <p className="text-xs text-slate-500 mb-2">
                Ces consignes s'ajoutent au prompt système pour <strong>tous</strong> les courriels régénérés
                par l'IA. Modifie-les pour orienter le ton, ajouter ta signature, exclure certains sujets, etc.
              </p>
              <RulesEditor
                value={generalRules}
                onChange={setGeneralRules}
                onBlur={() => generalSave.flush(generalRules)}
                placeholder={`Ex. :\n- Signature : Pierre-Alex, fondateur\n- On tutoie quand le prénom finit en -y, sinon on vouvoie\n- Mentionner qu'on est basés à Saint-Hyacinthe si pertinent\n- Ne pas chiffrer les rendements promis avant un appel\n\nClique « + PDF » en bas pour insérer une référence à un fichier public.`}
              />
            </div>
          </aside>

          {/* Colonne principale : filtres + liste */}
          <div>
            <div className="flex flex-wrap items-center gap-3 mb-4">
              <div className="relative flex-1 min-w-[240px]">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Rechercher par entreprise, défi…"
                  className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
                />
              </div>
              <div className="inline-flex items-center gap-1 text-xs">
                <Filter size={14} className="text-slate-400" />
                {[
                  { v: 'all', label: `Tous (${counts.total})` },
                  { v: 'fr', label: `FR (${counts.fr})` },
                  { v: 'en', label: `EN (${counts.en})` },
                ].map(opt => (
                  <button
                    key={opt.v}
                    onClick={() => setLangFilter(opt.v)}
                    className={`px-2.5 py-1 rounded-md font-medium ${
                      langFilter === opt.v
                        ? 'bg-brand-50 text-brand-700 border border-brand-200'
                        : 'text-slate-500 hover:bg-slate-100 border border-transparent'
                    }`}
                  >{opt.label}</button>
                ))}
              </div>
            </div>

            {filtered.length === 0 ? (
              <div className="card p-10 text-center text-slate-400">Aucun email à afficher.</div>
            ) : (
              <div className="space-y-4">
                {filtered.map(it => (
                  <EmailCard
                    key={it.company.id}
                    it={it}
                    generalRules={generalRules}
                    savedSpecific={savedSpecific[it.qualification_call.id]}
                    onSavedSpecificChange={(qcId, value) =>
                      setSavedSpecific(prev => ({ ...prev, [qcId]: value }))
                    }
                    onSent={(qcId, sent) =>
                      setItems(prev => prev.map(p =>
                        p.qualification_call.id === qcId ? { ...p, sent } : p
                      ))
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  )
}
