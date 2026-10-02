// Fermeture automatique des projets restés ouverts trop longtemps.
//
// Un projet est « ouvert » tant que son champ « Vendu » est vide (c'est ce que
// filtre la vue « Ouvert » du pipeline). Passé `days` jours après sa date de
// création (champ « Création », à défaut created_at), il est fermé comme le
// faisait l'automatisation Airtable : Vendu = Non, Raison du refus = `reason`,
// Fermeture = aujourd'hui (si vide). Le statut natif n'est pas touché — il
// n'est plus utilisé (tous les projets sont « Ouvert »).
//
// Rattrapage : la condition est « au moins N jours », pas « exactement N » —
// un jour manqué (serveur arrêté) est rattrapé au passage suivant.

import db from '../db/database.js'
import { writeBackRecord } from './airtableWriteback.js'
import { emitEntity } from './realtimeEmitters.js'
import { isSystemAutomationActive, logSystemRun, touchSystemRun } from './systemAutomations.js'

export const PROJECT_AUTO_CLOSE_AUTOMATION_ID = 'sys_project_auto_close'

export const PROJECT_AUTO_CLOSE_DEFAULT_CONFIG = {
  days: '30',
  reason: 'Fermeture automatique',
}

const CLOSED_FIELDS = ['cf_vendu', 'raison_du_refus', 'close_date']

export function loadProjectAutoCloseConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id = ?').get(PROJECT_AUTO_CLOSE_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const days = Number.parseInt(cfg.days ?? PROJECT_AUTO_CLOSE_DEFAULT_CONFIG.days, 10)
  const reason = String(cfg.reason ?? '').trim() || PROJECT_AUTO_CLOSE_DEFAULT_CONFIG.reason
  return { days: Number.isInteger(days) && days > 0 ? days : 30, reason }
}

// Date du jour à Montréal (le serveur est en UTC : à 21 h la veille, il est
// déjà demain pour lui).
function todayMontreal() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date())
}

export function findProjectsToClose({ days, today = todayMontreal() }) {
  return db.prepare(`
    SELECT id, name, creation, created_at, close_date
    FROM projects
    WHERE deleted_at IS NULL
      AND (cf_vendu IS NULL OR cf_vendu = '')
      AND date(COALESCE(NULLIF(creation, ''), created_at)) <= date(?, ?)
    ORDER BY COALESCE(NULLIF(creation, ''), created_at)
  `).all(today, `-${days} days`)
}

export function runProjectAutoClose({ dryRun = false, trigger = 'planifie' } = {}) {
  const started = Date.now()
  const { days, reason } = loadProjectAutoCloseConfig()
  const today = todayMontreal()
  const candidates = findProjectsToClose({ days, today })
  const list = candidates.map(p => `${p.name} (ouvert le ${String(p.creation || p.created_at).slice(0, 10)})`)

  if (dryRun) {
    return { summary: `${candidates.length} projet(s) seraient fermés (ouverts depuis ${days} jours ou plus)`, projets: list }
  }

  const update = db.prepare(`
    UPDATE projects
    SET cf_vendu = 'Non', raison_du_refus = ?, close_date = COALESCE(NULLIF(close_date, ''), ?),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND (cf_vendu IS NULL OR cf_vendu = '')
  `)
  const closed = []
  const errors = []
  for (const p of candidates) {
    try {
      if (!update.run(reason, today, p.id).changes) continue
      closed.push(p)
      const row = db.prepare('SELECT airtable_id FROM projects WHERE id = ?').get(p.id)
      if (row?.airtable_id) {
        Promise.resolve(writeBackRecord('projets', p.id, CLOSED_FIELDS))
          .catch(e => console.error(`projectAutoClose writeback ${p.name}:`, e.message))
      }
      const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id)
      emitEntity('project', 'updated', p.id, updated, null, { source: PROJECT_AUTO_CLOSE_AUTOMATION_ID, fields: CLOSED_FIELDS })
    } catch (e) {
      errors.push(`${p.name} : ${e.message}`)
    }
  }

  const summary = `${closed.length} projet(s) fermé(s)` + (errors.length ? ` · ${errors.length} erreur(s)` : '')
  const result = { summary, projets: closed.map(p => p.name), ...(errors.length ? { erreurs: errors } : {}) }
  // Un passage à vide ne laisse pas de ligne d'historique — seulement ceux qui
  // ont fermé quelque chose (ou échoué), pour que le journal reste lisible.
  // « Exécuter » (manuel) est journalisé par la route elle-même.
  if (trigger !== 'manuel' && (closed.length || errors.length)) {
    logSystemRun(PROJECT_AUTO_CLOSE_AUTOMATION_ID, {
      status: errors.length && !closed.length ? 'error' : 'success',
      result,
      error: errors.length ? errors.join(' · ') : null,
      duration_ms: Date.now() - started,
      triggerData: { trigger, days, reason },
    })
  } else if (trigger !== 'manuel') {
    touchSystemRun(PROJECT_AUTO_CLOSE_AUTOMATION_ID)
  }
  return result
}

export function scheduledProjectAutoClose() {
  if (!isSystemAutomationActive(PROJECT_AUTO_CLOSE_AUTOMATION_ID)) return null
  return runProjectAutoClose({ trigger: 'planifie' })
}
