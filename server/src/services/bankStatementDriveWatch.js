// Relevés du Drive → rapprochement préparé dans QuickBooks (Charles, 2026-09-27).
//
// Chaque matin : pour chaque compte, le relevé PDF le plus récent de son dossier
// du Drive partagé « Banque (relevés) ». S'il est nouveau, il est lu comme un
// dépôt de relevé (services/bankStatementImport.js — lu, JAMAIS importé : ses
// lignes sont déjà au compte, souvent à un jour d'écart, et l'import créait des
// doublons), puis le robot prépare le rapprochement de ce compte dans QuickBooks
// (services/qbReconcileRobot.js — il ne clique jamais « Terminer »).
//
// Pas de date fixe : chaque compte part le jour où SON relevé arrive (la
// MasterCard vers le 15-17, les comptes vers le début du mois).
import fs from 'fs'
import path from 'path'
import db from '../db/database.js'
import { getDriveClient } from '../connectors/google.js'
import { ensureUploadsDir } from '../config/uploads.js'
import { createUpload, analyzeUpload, getUpload, setUploadAccount } from './bankStatementImport.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'

export const DRIVE_WATCH_AUTOMATION_ID = 'sys_bank_statement_drive_watch'

// Dossier Drive (sous-dossiers par exercice parcourus) + filtre de nom éventuel.
export const STATEMENT_FOLDERS = {
  'BNC CAD': { folder: '1hZVAD-FHmrPUKZzkmeHjRC5OTIUVt6xs' },
  'BNC USD': { folder: '1B8HXHcfDxQ9lGNYeYA8EPgcCaRJo4Dp9' },
  'BNC Épargne': { folder: '1svh17W2ZpeqXUNcHbk8O8SMIqSJUz4bW' },
  'MasterCard BNC': { folder: '1T1usbG-E0bdO20hX3SWMDjsdjEMZlNvA' },
  'Desjardins CAD': { folder: '1jDqkoV-pYTf3idBBVyvTtpwKsW02t75t' },
  'Desjardins USD': { folder: '1Dl6ygeeIHvy0EnqnsQL_pOZmIFr3_sjI' },
  'Marge Desjardins': { folder: '1XZtzf7s1Wqhp43B7TfnryIovdHBm3euN' },
  'VISA Desjardins CAD': { folder: '1QtYnnvIvJYqccESXkNonvVTro94qYmGS' },
  'VISA Desjardins USD': { folder: '1MB-wpJsCKw7it6gXyaZs5VV4OpXLxMR8' },
  'Venn CAD': { folder: '1Z9ha2paGTT9DdYX6Dl4bmW0qKGisuuC4', name: /CAD/i },
  'Venn USD': { folder: '1Z9ha2paGTT9DdYX6Dl4bmW0qKGisuuC4', name: /USD/i },
}

async function drive() {
  const acc = db.prepare("SELECT id FROM connector_oauth WHERE connector='google' ORDER BY updated_at DESC LIMIT 1").get()
  if (!acc) throw new Error('Aucun compte Google connecté (page Connecteurs)')
  return getDriveClient(acc.id)
}

// PDF du dossier et de ses sous-dossiers ; le plus récent d'abord (nom, puis date
// de modification — les noms portent la date du relevé).
async function listPdfs(d, folderId, depth = 3) {
  const out = []
  let pageToken
  do {
    const r = await d.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,createdTime)', pageSize: 200, pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    })
    for (const f of r.data.files || []) {
      if (f.mimeType === 'application/vnd.google-apps.folder') { if (depth > 0) out.push(...await listPdfs(d, f.id, depth - 1)) } else if (f.mimeType === 'application/pdf') out.push(f)
    }
    pageToken = r.data.nextPageToken
  } while (pageToken)
  return out
}

export function newestStatementFile(files, nameFilter = null) {
  const dated = (f) => (String(f.name).match(/(20\d{2})[-_]?(\d{2})[-_]?(\d{2})?/) || []).slice(1).join('') || ''
  return files
    .filter((f) => !nameFilter || nameFilter.test(f.name))
    .sort((a, b) => dated(b).localeCompare(dated(a)) || String(b.createdTime).localeCompare(String(a.createdTime)))[0] || null
}

const known = (fileId) => db.prepare('SELECT id FROM bank_statement_uploads WHERE drive_file_id=?').get(fileId)

/**
 * @param {object} [opts]
 * @param {boolean} [opts.force]   même si l'automation est coupée
 * @param {boolean} [opts.reconcile]  lancer le robot après lecture (défaut oui)
 */
export async function watchDriveStatements({ force = false, reconcile = true, trigger = 'cron quotidien' } = {}) {
  if (!force && !isSystemAutomationActive(DRIVE_WATCH_AUTOMATION_ID)) return null
  const t0 = Date.now()
  const report = []
  try {
    const d = await drive()
    const dir = ensureUploadsDir('releves')
    for (const [name, cfg] of Object.entries(STATEMENT_FOLDERS)) {
      const account = db.prepare('SELECT id, name, qb_account_id FROM bank_accounts WHERE name=? AND deleted_at IS NULL').get(name)
      if (!account) { report.push({ account: name, skipped: 'compte inconnu' }); continue }
      try {
        const file = newestStatementFile(await listPdfs(d, cfg.folder), cfg.name)
        if (!file) { report.push({ account: name, skipped: 'aucun PDF' }); continue }
        if (known(file.id)) { report.push({ account: name, file: file.name, skipped: 'déjà lu' }); continue }

        const res = await d.files.get({ fileId: file.id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' })
        const dest = path.join(dir, `drive-${file.id}.pdf`)
        fs.writeFileSync(dest, Buffer.from(res.data))
        const id = createUpload({ filePath: dest, originalName: file.name, mime: 'application/pdf', userId: null })
        db.prepare('UPDATE bank_statement_uploads SET drive_file_id=? WHERE id=?').run(file.id, id)
        await analyzeUpload(id, { accountId: account.id })
        if (getUpload(id)?.account_id !== account.id) setUploadAccount(id, account.id)
        const up = getUpload(id)
        const entry = {
          account: name, file: file.name, upload_id: id, period_end: up.period_end,
          closing_balance: up.closing_balance, balance_ok: !!up.balance_ok,
        }
        if (reconcile && up.balance_ok && account.qb_account_id) {
          const { reconcileAccount } = await import('./qbReconcileRobot.js')
          const out = await reconcileAccount(account.id, { requireOfficial: true })
          if (!out.skipped) await recordRun(account.id, out)
          entry.robot = out.ok ? { difference: out.difference, saved: out.saved, checked: out.checked, unchecked: out.unchecked } : { error: out.error || out.hint || out.screen }
        } else if (!up.balance_ok) entry.robot = { skipped: 'solde du relevé non vérifié' }
        report.push(entry)
      } catch (e) {
        report.push({ account: name, error: e.message })
      }
    }
    // Un relevé ajouté au Drive à la main compte aussi pour la liste du mois.
    try {
      const { syncStatementsTask, invalidateDriveCache, fileRecentUploads } = await import('./bankStatementDriveFiling.js')
      invalidateDriveCache()
      await fileRecentUploads('veille du matin')
      await syncStatementsTask()
    } catch (e) { report.push({ account: 'liste du mois', error: e.message }) }
    const lu = report.filter((r) => r.upload_id).length
    logSystemRun(DRIVE_WATCH_AUTOMATION_ID, {
      status: report.some((r) => r.error) ? 'error' : 'success',
      duration_ms: Date.now() - t0,
      result: { summary: `${lu} nouveau(x) relevé(s) lu(s)`, accounts: report },
      error: report.filter((r) => r.error).map((r) => `${r.account} : ${r.error}`).join(' · ') || null,
      triggerData: { trigger },
    })
    return report
  } catch (e) {
    logSystemRun(DRIVE_WATCH_AUTOMATION_ID, { status: 'error', duration_ms: Date.now() - t0, error: e, triggerData: { trigger } })
    throw e
  }
}

// Même trace que le bouton de la page (route POST /bank/accounts/:id/qb-reconcile).
export async function recordRun(accountId, out) {
  const { newRecordId } = await import('../utils/recordId.js')
  db.prepare(`
    INSERT INTO bank_qb_reconcile_runs (id, account_id, ok, statement_date, ending_balance, difference, checked,
      already_checked, saved, resumed, unmatched_boreal, unmatched_qb, screenshot, error, needs_session, result, run_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newRecordId(), accountId, out.ok ? 1 : 0, out.statement_date || null, out.ending_balance ?? null,
    out.difference ?? null, out.checked || 0, out.already_checked || 0, out.saved ? 1 : 0, out.resumed ? 1 : 0,
    JSON.stringify(out.unmatched_boreal || []), JSON.stringify(out.unmatched_qb || []), out.screenshot || null,
    out.error || out.hint || null, out.needsSession ? 1 : 0, JSON.stringify(out), null)
}
