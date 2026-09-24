import { mkdir, writeFile } from 'node:fs/promises'
import db from '../db/database.js'
import { getSheetsClient } from '../connectors/google.js'
import { computeProjection } from './treasury.js'
import { getSoldeSheetConfig } from './treasurySoldeSheet.js'
import { planTreasurySheet } from './treasurySheetMirrorPlan.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { logSync } from './syncLog.js'

export const TREASURY_MIRROR_ID = 'sys_treasury_sheet_mirror'
let running = false

export function treasuryMirrorStatus() {
  const cfg = getSoldeSheetConfig()
  const last = db.prepare('SELECT status, result, error, created_at FROM automation_logs WHERE automation_id=? ORDER BY created_at DESC LIMIT 1').get(TREASURY_MIRROR_ID)
  return { active: isSystemAutomationActive(TREASURY_MIRROR_ID), direction: 'boreal_to_sheet', interval_minutes: 20,
    spreadsheet_id: cfg.spreadsheet_id, url: `https://docs.google.com/spreadsheets/d/${cfg.spreadsheet_id}`,
    last_run: last || null }
}

export async function syncTreasuryMirror({ dryRun = false, trigger = 'scheduled' } = {}) {
  if (!dryRun && !isSystemAutomationActive(TREASURY_MIRROR_ID)) return { skipped: true, reason: 'automation désactivée' }
  if (running) return { skipped: true, reason: 'synchronisation en cours' }
  running = true
  const started = Date.now()
  try {
    const cfg = getSoldeSheetConfig()
    // Dedicated writer account, already used by the transaction mirror.
    const account = db.prepare("SELECT id FROM connector_oauth WHERE connector='google' AND account_email='michel@orisha.io' AND refresh_token IS NOT NULL").get()
    if (!account) throw new Error('Reconnecter le compte Google michel@orisha.io dans Connecteurs')
    const sheets = await getSheetsClient(account.id)
    const { data } = await sheets.spreadsheets.get({ spreadsheetId: cfg.spreadsheet_id,
      ranges: [`'${cfg.sheet_name.replace(/'/g, "''")}'`], includeGridData: true })
    const sheet = data.sheets?.find(s => s.properties.title === cfg.sheet_name)
    if (!sheet) throw new Error(`Onglet introuvable : ${cfg.sheet_name}`)
    const projection = computeProjection({ scenario: 'certain' })
    const recurring = db.prepare('SELECT * FROM recurring_outflows WHERE active=1 AND deleted_at IS NULL ORDER BY day_of_month IS NULL, day_of_month, label').all()
    const { requests, ...plan } = planTreasurySheet(sheet, projection, recurring)
    if (!dryRun && requests.length) {
      // Keep the initial workbook and the preceding version locally, before
      // replacing stale forecast rows. Failure to save aborts the write.
      const directory = new URL('../../data/treasury-sheet-backups/', import.meta.url)
      await mkdir(directory, { recursive: true })
      const filename = encodeURIComponent(cfg.spreadsheet_id)
      const backup = JSON.stringify(data)
      await writeFile(new URL(`${filename}-initial.json`, directory), backup, { flag: 'wx', mode: 0o600 })
        .catch(e => { if (e.code !== 'EEXIST') throw e })
      await writeFile(new URL(`${filename}-previous.json`, directory), backup, { mode: 0o600 })
      // One atomic batch: formulas, opening balance and all four blocks agree.
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: cfg.spreadsheet_id, requestBody: { requests } })
    }
    const result = { ...plan, dry_run: dryRun, url: `https://docs.google.com/spreadsheets/d/${cfg.spreadsheet_id}`,
      summary: `${dryRun ? 'Simulation : ' : ''}${plan.movements} mouvements · ${plan.changed_cells} cellules ${dryRun ? 'à mettre à jour' : 'mises à jour'} · projection sur ${plan.horizon_days} jours` }
    if (!dryRun) {
      logSystemRun(TREASURY_MIRROR_ID, { status: 'success', result, duration_ms: Date.now() - started, triggerData: { trigger } })
      logSync('treasury:sheet-mirror', trigger === 'scheduled' ? 'scheduled' : 'manual', { status: 'success', modified: plan.changed_cells, durationMs: Date.now() - started })
    }
    return result
  } catch (error) {
    if (!dryRun) {
      logSystemRun(TREASURY_MIRROR_ID, { status: 'error', error, duration_ms: Date.now() - started, triggerData: { trigger } })
      logSync('treasury:sheet-mirror', trigger === 'scheduled' ? 'scheduled' : 'manual', { status: 'error', error: error.message })
    }
    throw error
  } finally { running = false }
}
