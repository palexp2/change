// Carnet d'idées (page /travaux, onglet « Idées »).
//
// Une idée n'est PAS une tâche : « The Future of ERP Systems » n'a rien à faire
// dans la file de prompts, où tout est destiné à partir en exécution. Cet onglet
// est le seul endroit de la page où rien ne s'exécute jamais — on y dépose ce
// qu'on veut garder et relire. Le passage à l'action est explicite (promoteIdea),
// et l'item créé arrive « de côté » dans la file : même promue, une idée ne
// déclenche pas d'exécution sans un geste de plus.
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { broadcastAll } from './realtime.js'
import { createPrompt } from './promptQueue.js'

const SELECT = 'SELECT * FROM work_ideas WHERE deleted_at IS NULL'

function broadcast() { broadcastAll({ type: 'travaux:ideas:updated' }) }

export function listIdeas() {
  return db.prepare(`${SELECT} ORDER BY priority DESC, position, created_at`).all()
}

export function getIdea(id) {
  return db.prepare(`${SELECT} AND id=?`).get(id) || null
}

function nextPosition() {
  return (db.prepare('SELECT MAX(position) AS m FROM work_ideas WHERE deleted_at IS NULL').get()?.m ?? 0) + 1
}

export function createIdea({ title, notes = null, tag = null, created_by = null }) {
  const text = String(title || '').trim()
  if (!text) throw new Error('title requis')
  const id = newRecordId()
  db.prepare(`
    INSERT INTO work_ideas (id, title, notes, tag, position, created_by)
    VALUES (?,?,?,?,?,?)
  `).run(id, text, notes || null, tag || null, nextPosition(), created_by)
  broadcast()
  return getIdea(id)
}

const EDITABLE = ['title', 'notes', 'tag', 'priority']

export function updateIdea(id, patch) {
  const row = getIdea(id)
  if (!row) return null
  const sets = []
  const vals = []
  for (const [k, v] of Object.entries(patch || {})) {
    if (!EDITABLE.includes(k)) continue
    // Le titre est la seule chose qui identifie une idée : on refuse de le vider.
    if (k === 'title' && !String(v || '').trim()) continue
    sets.push(`${k}=?`)
    vals.push(k === 'priority' ? (v ? 1 : 0) : k === 'title' ? String(v).trim() : (v === '' ? null : v))
  }
  if (!sets.length) return row
  db.prepare(`UPDATE work_ideas SET ${sets.join(', ')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(...vals, id)
  broadcast()
  return getIdea(id)
}

export function deleteIdea(id) {
  const row = getIdea(id)
  if (!row) return false
  db.prepare(`UPDATE work_ideas SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id)
  broadcast()
  return true
}

/** Réordonne le carnet dans l'ordre exact des ids reçus (les absents suivent). */
export function reorderIdeas(ids) {
  const upd = db.prepare('UPDATE work_ideas SET position=? WHERE id=? AND deleted_at IS NULL')
  db.transaction(() => { ids.forEach((id, i) => upd.run(i + 1, id)) })()
  broadcast()
  return listIdeas()
}

/**
 * Promotion en item de file. Volontairement créé en `paused` : une idée est floue
 * par nature, la promouvoir sert à la sortir du carnet, pas à lancer Claude dessus
 * séance tenante. L'utilisateur ajuste le prompt puis appuie sur ▶.
 * Idempotent : une idée déjà promue renvoie son item existant.
 */
export function promoteIdea(id, { userId = null, prompt = null, space = 'finance' } = {}) {
  const idea = getIdea(id)
  if (!idea) return null
  if (idea.work_prompt_id) {
    const existing = db.prepare('SELECT * FROM work_prompts WHERE id=? AND deleted_at IS NULL').get(idea.work_prompt_id)
    if (existing) return { idea, prompt: existing, already: true }
  }
  const body = String(prompt || '').trim()
    || [idea.title, idea.notes].filter(Boolean).join('\n\n')
  const created = createPrompt({
    title: idea.title,
    prompt: body,
    status: 'paused',
    created_by: userId,
    // L'item de file naît dans la section d'où l'idée est promue (finance/agent).
    space,
  })
  db.prepare(`UPDATE work_ideas SET work_prompt_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(created.id, id)
  broadcast()
  return { idea: getIdea(id), prompt: created, already: false }
}
