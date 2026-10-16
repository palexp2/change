// Ctrl+Z (⌘Z) dans toute l'app : annule la dernière action de l'utilisateur.
//
// Deux sources, la plus récente passe d'abord :
//  1. le serveur — toute modification de champ d'une fiche, d'où qu'elle vienne
//     (tableau, fiche, kanban, formulaire), lue dans l'historique des fiches
//     (server/src/services/undoLastEdit.js) ;
//  2. le navigateur — les toasts « Annuler » (suppressions, champs retirés…),
//     mémorisés ici par ToastProvider.
// Dans un champ de saisie, Ctrl+Z garde son sens natif (annuler la frappe).
import api from './api.js'
import { sync as syncStore } from './dataSync.js'
import { TABLE_COLUMN_META } from './tableDefs.js'

const MAX_AGE_MS = 60 * 60 * 1000
const SAME_ACTION_MS = 3000
let local = [] // { id, at, run }

export function rememberUndo(id, run) {
  local.push({ id, at: Date.now(), run })
  if (local.length > 50) local.shift()
}

export function forgetUndo(id) {
  local = local.filter(e => e.id !== id)
}

function topLocal() {
  const now = Date.now()
  local = local.filter(e => now - e.at < MAX_AGE_MS)
  return local[local.length - 1] || null
}

const TEXT_INPUT = /^(text|search|email|url|tel|password|number|date|datetime-local|month|time|week)$/i

function typingInField(el) {
  if (!el) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  return el.tagName === 'INPUT' && TEXT_INPUT.test(el.type || 'text')
}

export function isUndoShortcut(e) {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')
}

const humanize = c => c.replace(/^cf_/, '').replace(/_/g, ' ').replace(/^./, m => m.toUpperCase())

function undoneMessage(r) {
  if (r.kind === 'created') return 'Création annulée'
  if (r.kind === 'restored') return 'Restauré'
  const names = (r.columns || []).filter(c => c !== 'deleted_at').map(c => r.labels?.[c]
    || TABLE_COLUMN_META[r.table]?.find(m => (m.field || m.id) === c)?.label || humanize(c))
  return names.length ? `Annulé : ${names.join(', ')}` : 'Annulé'
}

let busy = false

export async function runGlobalUndo({ addToast, removeToast }) {
  if (busy || !localStorage.getItem('erp_token')) return
  busy = true
  try {
    const entry = topLocal()
    const r = await api.undo.last(entry ? Date.now() - entry.at : null)
    if (r?.use === 'local' && entry) {
      forgetUndo(entry.id)
      removeToast(entry.id)
      await entry.run()
    } else if (r?.undone) {
      // La même action peut aussi avoir son toast « Annuler » (suppression) :
      // elle vient d'être annulée, le toast n'a plus d'objet.
      const now = Date.now()
      for (const e of local.filter(e => Math.abs(now - e.at - r.age_ms) < SAME_ACTION_MS)) {
        forgetUndo(e.id)
        removeToast(e.id)
      }
      addToast({ type: 'success', message: undoneMessage(r), duration: 2500 })
      syncStore()
    } else {
      addToast({ type: 'info', message: 'Rien à annuler', duration: 1500 })
    }
  } catch (e) {
    addToast({ type: 'error', message: 'Annulation impossible : ' + (e.message || 'erreur'), duration: 4000 })
  } finally {
    busy = false
  }
}

export function handleUndoKey(e, toasts) {
  if (e.defaultPrevented || !isUndoShortcut(e) || typingInField(document.activeElement)) return
  e.preventDefault()
  runGlobalUndo(toasts)
}
