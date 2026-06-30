import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { MessageSquarePlus } from 'lucide-react'
import { Modal } from './Modal.jsx'
import { api } from '../lib/api.js'
import { useToast } from '../contexts/ToastContext.jsx'

// FAB discret « Signaler un problème / suggérer une amélioration », monté dans
// Layout donc visible sur toutes les pages. Envoie le texte saisi vers le
// backlog de l'agent (POST /api/agent/backlog) en y joignant automatiquement la
// route courante comme contexte — l'agent sait ainsi d'où vient la suggestion.
export function FeedbackFab() {
  const location = useLocation()
  const { addToast } = useToast()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || saving) return
    setSaving(true)
    // On joint la route courante (pathname + search) comme contexte. La page
    // d'origine aide l'agent à situer la suggestion sans que l'utilisateur ait
    // à la décrire.
    const context = `${location.pathname}${location.search || ''}`
    const payload = `${trimmed}\n\n— Signalé depuis : ${context}`
    try {
      await api.agent.addBacklog(payload)
      addToast({ message: 'Merci ! Suggestion transmise à l\'agent', type: 'success' })
      setText('')
      setOpen(false)
    } catch {
      addToast({ message: 'Échec de l\'envoi de la suggestion', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid="feedback-fab"
        onClick={() => setOpen(true)}
        title="Signaler un problème / suggérer une amélioration"
        aria-label="Signaler un problème ou suggérer une amélioration"
        className="fixed bottom-5 right-5 z-40 w-11 h-11 rounded-full bg-brand-600 text-white shadow-lg
          flex items-center justify-center hover:bg-brand-700 hover:scale-105 active:scale-95
          transition-all opacity-60 hover:opacity-100 print:hidden"
      >
        <MessageSquarePlus size={18} />
      </button>

      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        title="Signaler un problème / suggérer une amélioration"
        size="sm"
      >
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-slate-500">
            Décrivez le problème rencontré ou l'amélioration souhaitée. La page
            courante est automatiquement jointe pour aider l'agent.
          </p>
          <textarea
            data-testid="feedback-fab-text"
            value={text}
            onChange={e => setText(e.target.value)}
            rows={5}
            className="input w-full resize-y"
            placeholder="Ex. : Le filtre par date ne garde pas ma sélection quand je change de page…"
          />
          <div className="text-xs text-slate-400">
            Contexte joint : <span className="font-mono">{location.pathname}{location.search}</span>
          </div>
          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={() => setOpen(false)} className="btn-secondary">
              Annuler
            </button>
            <button
              type="submit"
              data-testid="feedback-fab-submit"
              disabled={saving || !text.trim()}
              className="btn-primary"
            >
              {saving ? 'Envoi…' : 'Envoyer'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  )
}
