// Origine d'une écriture : quelle automatisation (ou quel utilisateur) a écrit
// tel record — pour que l'historique d'une fiche dise « Sync Airtable a
// modifié » plutôt que « Système a modifié ».
//
// Mécanique : des triggers TEMP (propres à la connexion de ce processus, donc
// invisibles des scripts et des autres processus qui ouvrent erp.db) appellent
// la fonction JS erp_note_write(table, id) à chaque écriture. Comme
// better-sqlite3 est synchrone, elle s'exécute dans le contexte async de
// l'appelant : on y lit
//   1. l'origine explicite posée par withOrigin(automationId, fn) ;
//   2. sinon l'utilisateur de la requête HTTP (utils/requestContext.js) ;
//   3. sinon la pile d'appels : un module qui déclare une seule automatisation
//      (`const X_AUTOMATION_ID = 'sys_…'`) est l'automatisation.
// La note reste en mémoire jusqu'à ce que services/recordRevisions.js la lise.

import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import db from '../db/database.js'
import { requestContext } from '../utils/requestContext.js'

const originContext = new AsyncLocalStorage()

// Exécute fn en attribuant ses écritures à l'automatisation `id`.
export function withOrigin(id, fn) {
  return id ? originContext.run({ id }, fn) : fn()
}

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ID_LIT = /'(sys_[a-z0-9_]+)'/g
const DECL = /^(?:export )?const [A-Z0-9_]+ = '(sys_[a-z0-9_]+)'/gm

// Fichier → automatisation, pour les modules dédiés à une seule automatisation.
let moduleMap = null
function modules() {
  if (moduleMap) return moduleMap
  moduleMap = new Map()
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue }
      if (!e.name.endsWith('.js') || e.name.endsWith('.test.js')) continue
      const src = fs.readFileSync(p, 'utf8')
      const decl = [...src.matchAll(DECL)].map(m => m[1])
      if (decl.length !== 1) continue
      const ids = new Set([...src.matchAll(ID_LIT)].map(m => m[1]))
      if (ids.size === 1) moduleMap.set(p, decl[0])
    }
  }
  try { walk(SRC) } catch (e) { console.error('[writeOrigin] scan', e.message) }
  return moduleMap
}

function originFromStack() {
  const prep = Error.prepareStackTrace, lim = Error.stackTraceLimit
  const holder = {}
  try {
    Error.stackTraceLimit = 60
    Error.prepareStackTrace = (_, cs) => cs
    Error.captureStackTrace(holder, originFromStack)
  } finally {
    Error.prepareStackTrace = prep
    Error.stackTraceLimit = lim
  }
  const map = modules()
  for (const cs of holder.stack || []) {
    let f = cs.getFileName?.()
    if (!f) continue
    if (f.startsWith('file://')) f = fileURLToPath(f)
    const id = map.get(f)
    if (id) return id
  }
  return null
}

const notes = new Map()
const MAX_AGE_MS = 120_000

function noteWrite(table, id) {
  const origin = originContext.getStore()?.id
  const user = origin ? null : requestContext.getStore()?.user?.id || null
  const source = origin || (user ? null : originFromStack())
  const key = `${table}\u0000${id}`
  if (!source && !user) { notes.delete(key); return null }
  notes.set(key, { source, user, at: Date.now() })
  if (notes.size > 20_000) {
    const cutoff = Date.now() - MAX_AGE_MS
    for (const [k, v] of notes) if (v.at < cutoff) notes.delete(k)
  }
  return null
}

// Origine de la dernière écriture d'un record ({ source, user }), consommée.
export function takeWriteOrigin(table, id) {
  const key = `${table}\u0000${id}`
  const n = notes.get(key)
  if (!n) return null
  notes.delete(key)
  return Date.now() - n.at < MAX_AGE_MS ? n : null
}

// Pose les triggers TEMP sur les tables suivies. Processus principal seulement.
export function installWriteOriginTriggers(tables) {
  db.function('erp_note_write', { deterministic: false }, (t, id) => noteWrite(t, id))
  for (const t of tables) {
    if (!/^[a-z_]+$/.test(t)) continue
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)) continue
    for (const [ev, ref] of [['INSERT', 'NEW'], ['UPDATE', 'NEW'], ['DELETE', 'OLD']]) {
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS wo_${t}_${ev.toLowerCase()} AFTER ${ev} ON ${t}
        BEGIN SELECT erp_note_write('${t}', ${ref}.id); END;`)
    }
  }
}
