import { useState, useEffect, useCallback, useRef } from 'react'
import { HelpCircle, Check } from 'lucide-react'
import { Modal } from './Modal.jsx'
import ThinkingOrb from './ThinkingOrb'
import { api } from '../lib/api.js'
import { StatusPill, ThreadMessage, QuestionChoices, ReplyBox, isAsking } from '../lib/travauxQueue.jsx'

// Questions posées depuis le FAB « Modifier le système » (mode Question) : un
// petit bouton flottant au-dessus du FAB en suit l'état (en réflexion /
// répondu) jusqu'à ce que l'utilisateur dise qu'il a terminé avec chacune.
// Suivi par navigateur (localStorage) : seuls les ids sont gardés, l'état est
// relu sur le serveur.
const KEY = 'erp_feedback_questions'
const EVT = 'feedback-questions:changed'

function readIds() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
function writeIds(ids) {
  try { localStorage.setItem(KEY, JSON.stringify(ids)) } catch { /* stockage indisponible */ }
  window.dispatchEvent(new Event(EVT))
}

/** Appelé par le FAB après le dépôt d'une question. */
export function trackQuestion(id) {
  if (id) writeIds([...readIds().filter(x => x !== id), id])
}

const thinking = p => ['queued', 'running', 'paused'].includes(p.status)
// Le texte saisi, sans le contexte de page ni les captures ajoutés par le FAB.
const askedText = p => String(p.prompt || '').split('\n\nContexte (ERP) :')[0]

export function FeedbackQuestions({ hidden = false }) {
  const [ids, setIds] = useState(readIds)
  const [prompts, setPrompts] = useState([])
  const [open, setOpen] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const sync = () => setIds(readIds())
    window.addEventListener(EVT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(EVT, sync); window.removeEventListener('storage', sync) }
  }, [])

  const load = useCallback(async () => {
    if (!ids.length) { setPrompts([]); return }
    const mine = ++seq.current
    try {
      const r = await api.travaux.listPrompts({ ids: ids.join(',') })
      if (mine !== seq.current) return
      const found = r?.prompts || []
      // Question retirée de la file entre-temps : plus rien à suivre.
      if (found.length < ids.length) writeIds(ids.filter(id => found.some(p => p.id === id)))
      setPrompts(ids.map(id => found.find(p => p.id === id)).filter(Boolean))
    } catch { /* réseau : on garde l'état affiché */ }
  }, [ids])

  const anyThinking = prompts.some(thinking)
  useEffect(() => {
    load()
    const onEvt = () => load()
    window.addEventListener('travaux:prompts:updated', onEvt)
    const t = setInterval(load, anyThinking || !prompts.length ? 10_000 : 60_000)
    return () => { window.removeEventListener('travaux:prompts:updated', onEvt); clearInterval(t) }
  }, [load, anyThinking, prompts.length])

  // Plus rien à montrer : la modale se referme d'elle-même.
  useEffect(() => { if (!ids.length) setOpen(false) }, [ids.length])

  const done = id => writeIds(ids.filter(x => x !== id))
  const reply = async (id, text, placement) => { await api.travaux.replyToPrompt(id, text, placement); load() }

  if (!ids.length) return null
  const answered = prompts.filter(p => !thinking(p)).length

  return (
    <>
      <button
        type="button"
        data-testid="feedback-questions-fab"
        data-feedback-picker
        onClick={() => setOpen(true)}
        title={anyThinking ? 'Question en réflexion' : 'Question répondue'}
        aria-label="Mes questions"
        className={`fixed bottom-[4.25rem] right-[26px] z-[9989] w-8 h-8 rounded-full shadow-lg items-center justify-center
          hover:scale-105 active:scale-95 transition-all print:hidden
          ${anyThinking ? 'bg-white border border-slate-200 text-brand-600' : 'bg-emerald-600 text-white'}
          ${hidden ? 'hidden' : 'flex'}`}
      >
        {anyThinking ? <ThinkingOrb state="working" size={16} ink /> : <Check size={16} />}
        {ids.length > 1 && (
          <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-slate-800 text-white text-[10px] leading-4 text-center">
            {answered}/{ids.length}
          </span>
        )}
      </button>

      <Modal isOpen={open} onClose={() => setOpen(false)} title="Mes questions" size="md" zIndex={95}>
        <div className="space-y-4" data-testid="feedback-questions-list">
          {prompts.map(p => (
            <div key={p.id} className="border border-slate-200 rounded-lg p-3 space-y-2">
              <div className="flex items-start gap-2">
                <HelpCircle size={14} className="text-slate-400 mt-0.5 shrink-0" />
                <p className="flex-1 text-sm font-medium text-slate-800 whitespace-pre-wrap">{askedText(p)}</p>
                <StatusPill p={p} />
              </div>
              {(p.messages || []).map(m => <ThreadMessage key={m.id} m={m} />)}
              {!p.messages?.length && p.user_summary && (
                <div className="text-sm text-slate-600 whitespace-pre-wrap bg-slate-50 rounded-lg px-3 py-2">{p.user_summary}</div>
              )}
              {isAsking(p) && <QuestionChoices p={p} onAnswer={opt => reply(p.id, opt)} />}
              {!thinking(p) && <ReplyBox onSend={(text, placement) => reply(p.id, text, placement)} />}
              <div className="flex justify-end">
                <button
                  type="button"
                  data-testid="feedback-question-done"
                  onClick={() => done(p.id)}
                  className="btn-secondary text-sm inline-flex items-center gap-1"
                >
                  <Check size={14} /> Terminé
                </button>
              </div>
            </div>
          ))}
          {!prompts.length && <div className="flex justify-center py-4"><ThinkingOrb size={18} ink /></div>}
        </div>
      </Modal>
    </>
  )
}
