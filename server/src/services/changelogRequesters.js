// « Qui a demandé ça ? » — rattache chaque entrée du journal des nouveautés
// (client/src/data/changelog.json) à la demande humaine qui l'a provoquée.
//
// Il n'existe aucun lien explicite entre une entrée et sa demande : l'entrée est
// écrite par l'agent pendant l'exécution. Deux sources donnent le nom :
//   1. l'entrée le porte elle-même (champ `requester`) — fait foi ;
//   2. sinon on rapproche l'entrée des demandes traitées le même jour (file de
//      travaux → utilisateur qui a déposé le prompt ; signalements de la bulle
//      d'aide → auteur du signalement) par recouvrement de vocabulaire.
//
// Le rapprochement doit être NET : score élevé, assez de mots en commun, et
// nettement meilleur que le candidat suivant. Sinon aucun nom n'est renvoyé —
// mieux vaut « — » qu'attribuer une demande à la mauvaise personne.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import db from '../db/database.js'
import { REPO_ROOT, CHANGELOG_PATH } from './changelogGuard.js'

const TASKS_PATH = join(REPO_ROOT, 'agent-tasks.json')

// Mots vides + vocabulaire de l'app trop fréquent pour discriminer une demande.
const STOPWORDS = new Set([
  'avec', 'sans', 'pour', 'dans', 'depuis', 'plus', 'moins', 'tout', 'tous', 'toute', 'toutes',
  'cette', 'celui', 'celle', 'leur', 'leurs', 'elle', 'elles', 'nous', 'vous', 'mais', 'donc',
  'quand', 'comme', 'dont', 'être', 'etre', 'avoir', 'fait', 'faire', 'faut', 'peut', 'doit',
  'quon', 'quil', 'cest', 'lors', 'meme', 'aussi', 'encore', 'deja', 'entre', 'chaque',
  'page', 'pages', 'champ', 'champs', 'bouton', 'affiche', 'affichage', 'afficher', 'ajoute',
  'ajouter', 'modifier', 'modification', 'colonne', 'colonnes', 'ligne', 'lignes', 'tableau',
])

/** Vocabulaire significatif d'un texte : minuscules, sans accents, mots ≥ 4 lettres. */
export function tokenize(text) {
  const words = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
  const out = new Set()
  for (const w of words) {
    if (w.length >= 4 && !STOPWORDS.has(w)) out.add(w)
  }
  return out
}

/** Part du vocabulaire de `a` retrouvée dans `b`, et nombre de mots communs. */
export function overlap(a, b) {
  if (!a.size || !b.size) return { score: 0, common: 0 }
  let common = 0
  for (const w of a) if (b.has(w)) common++
  return { score: common / a.size, common }
}

const dayOf = (iso) => String(iso || '').slice(0, 10)

function daysApart(dayA, dayB) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayA) || !/^\d{4}-\d{2}-\d{2}$/.test(dayB)) return Infinity
  return Math.abs(Date.parse(`${dayA}T00:00:00Z`) - Date.parse(`${dayB}T00:00:00Z`)) / 86400000
}

export const entryKey = (e) => `${e?.date}|${e?.title}`

/** Texte d'une entrée servant au rapprochement : titre + description des changements. */
function entryText(e) {
  return [e?.title, ...(e?.changes || []).map((c) => c?.text)].filter(Boolean).join(' ')
}

/**
 * Rapproche les entrées du journal des demandes humaines.
 * @param {object[]} entries  entrées de changelog.json
 * @param {{name: string, title?: string, text?: string, date?: string}[]} requests
 * @returns {Record<string, {name: string, source: 'entry'|'match', requestTitle?: string, requestDate?: string}>}
 */
export function resolveRequesters(entries, requests, {
  minScore = 0.3, minCommon = 3, margin = 1.4, windowDays = 1,
} = {}) {
  const prepared = (requests || [])
    .filter((r) => r && r.name)
    .map((r) => ({ ...r, tokens: tokenize(`${r.title || ''} ${r.text || ''}`), day: dayOf(r.date) }))

  const out = {}
  for (const e of entries || []) {
    const key = entryKey(e)
    if (e?.requester) {
      out[key] = { name: String(e.requester), source: 'entry' }
      continue
    }
    const tokens = tokenize(entryText(e))
    if (!tokens.size) continue

    const scored = prepared
      .filter((r) => daysApart(r.day, e.date) <= windowDays)
      .map((r) => ({ r, ...overlap(tokens, r.tokens) }))
      .sort((a, b) => b.score - a.score)

    const best = scored[0]
    if (!best || best.score < minScore || best.common < minCommon) continue
    // Ambigu : un autre demandeur talonne le meilleur → on ne tranche pas.
    const rival = scored.find((s) => s.r.name !== best.r.name)
    if (rival && best.score < rival.score * margin) continue

    out[key] = {
      name: best.r.name,
      source: 'match',
      requestTitle: best.r.title || '',
      requestDate: best.r.date || '',
    }
  }
  return out
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Nom du demandeur d'une tâche agent : déposant du prompt, ou auteur du signalement. */
function requesterOfTask(task, promptAuthors) {
  if (task?.work_prompt_id) {
    const name = promptAuthors.get(task.work_prompt_id)
    if (name) return name
    return null
  }
  const author = String(task?.author || '').trim()
  // « File de travaux » n'est pas une personne : c'est le canal, pas le demandeur.
  if (!author || /^file de travaux/i.test(author)) return null
  return author
}

/** Demandes humaines connues du système, à rapprocher des entrées du journal. */
function collectRequests() {
  const tasks = readJson(TASKS_PATH)
  if (!Array.isArray(tasks)) return []

  const promptAuthors = new Map()
  try {
    for (const row of db.prepare(`
      SELECT p.id AS id, u.name AS name
      FROM work_prompts p LEFT JOIN users u ON u.id = p.created_by
      WHERE p.deleted_at IS NULL
    `).all()) {
      if (row.name) promptAuthors.set(row.id, row.name)
    }
  } catch {
    /* table absente (tests, DB neuve) → seuls les signalements restent */
  }

  return tasks
    // Une question (mode 'question') ne change rien dans l'app : elle ne peut
    // pas être à l'origine d'une entrée du journal.
    .filter((t) => t?.mode !== 'question')
    .map((t) => ({
      name: requesterOfTask(t, promptAuthors),
      title: t?.title || '',
      text: [t?.description, t?.user_summary].filter(Boolean).join(' '),
      date: t?.completed_at || t?.updated_at || t?.created_at || '',
    }))
    .filter((r) => r.name)
}

// Le fichier des tâches peut être volumineux : on ne le relit que s'il a bougé.
let _cache = null

/** Table « entrée du journal → demandeur », prête pour l'API. */
export function getChangelogRequesters() {
  let stamp = ''
  try {
    const st = statSync(TASKS_PATH)
    stamp = `${st.mtimeMs}`
  } catch { /* pas de fichier de tâches */ }
  try {
    const st = statSync(join(REPO_ROOT, CHANGELOG_PATH))
    stamp += `:${st.mtimeMs}`
  } catch { /* pas de journal */ }

  if (_cache && _cache.stamp === stamp) return _cache.value

  const data = readJson(join(REPO_ROOT, CHANGELOG_PATH))
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const value = resolveRequesters(entries, collectRequests())
  _cache = { stamp, value }
  return value
}
