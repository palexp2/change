import db from '../db/database.js'
import { importTimesheetsForPaie } from './paieTimesheetImport.js'
import { writeBackRecord } from './airtableWriteback.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'

export const PAIE_SYNC_ID = 'sys_timesheet_paie_sync'

// Paies encore ouvertes : pas encore « Envoyés » et période récente.
function openPaies(today = new Date().toISOString().slice(0, 10)) {
  const since = new Date(Date.parse(today + 'T00:00:00Z') - 45 * 86400000).toISOString().slice(0, 10)
  return db.prepare(`
    SELECT id, period_start, period_end FROM paies
    WHERE period_end IS NOT NULL AND period_end >= ? AND COALESCE(status, '') != 'Envoyés'
    ORDER BY period_end
  `).all(since)
}

// Recopie les heures saisies dans Boréal dans les lignes des paies ouvertes,
// puis dans Airtable. Une ligne corrigée à la main dans Airtable depuis la
// dernière recopie est laissée telle quelle.
export async function syncTimesheetsToPaies({ dryRun = false, trigger = 'saisie Boréal' } = {}) {
  if (!dryRun && !isSystemAutomationActive(PAIE_SYNC_ID)) return { skipped: 'automation inactive' }
  const t0 = Date.now()
  const state = db.prepare('SELECT written_hours FROM paie_timesheet_sync_state WHERE paie_item_id = ?')
  const keep = (item) => {
    const cur = item.regular_hours == null ? null : Number(item.regular_hours)
    if (cur == null || cur === 0) return false
    const last = state.get(item.id)
    return !last || Math.abs(Number(last.written_hours) - cur) > 0.001
  }
  const reports = []
  try {
    for (const p of openPaies()) {
      if (dryRun) {
        const r = db.transaction(() => { const x = importTimesheetsForPaie(p.id, { keep }); throw Object.assign(new Error('rollback'), { x }) })
        try { r() } catch (e) { if (!e.x) throw e; reports.push({ paie: p, ...e.x }) }
        continue
      }
      const r = importTimesheetsForPaie(p.id, { keep })
      for (const id of r.changed) await writeBackRecord('paie_items', id, ['regular_hours']).catch(e => console.error('paie sync write-back:', e.message))
      reports.push({ paie: p, ...r })
    }
    const lines = reports.map(r => {
      const upd = r.results.filter(x => r.changed.includes(x.item_id)).map(x => `${x.employee_name} ${x.timesheet_hours} h`)
      const kept = r.results.filter(x => x.skipped === 'edited_in_airtable').map(x => x.employee_name)
      return `Paie ${r.paie.period_start} → ${r.paie.period_end} : ${r.changed.length} ligne(s) mise(s) à jour${upd.length ? ` (${upd.join(', ')})` : ''}${kept.length ? ` · corrigé(s) dans Airtable, laissé(s) : ${kept.join(', ')}` : ''}`
    })
    const summary = lines.join('\n') || 'Aucune paie ouverte'
    const changed = reports.some(r => r.changed.length)
    if (!dryRun && (changed || trigger === 'manuel')) logSystemRun(PAIE_SYNC_ID, { status: 'success', result: summary, triggerData: { trigger }, duration_ms: Date.now() - t0 })
    return { summary, reports, dry_run: dryRun }
  } catch (e) {
    if (!dryRun) logSystemRun(PAIE_SYNC_ID, { status: 'error', error: e, triggerData: { trigger }, duration_ms: Date.now() - t0 })
    throw e
  }
}

let timer = null
export function scheduleTimesheetPaieSync() {
  if (process.env.ERP_ROLE === 'standby' || process.env.NODE_ENV === 'test') return
  clearTimeout(timer)
  timer = setTimeout(() => {
    syncTimesheetsToPaies().catch(e => console.error('timesheet paie sync:', e.message))
  }, 30_000)
  timer.unref?.()
}
