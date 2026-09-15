// Lecture des relevés de carte de crédit déposés dans le Drive.
//
// POURQUOI. Le solde imprimé en tête d'un relevé BNC EST le montant prélevé au
// compte quelques jours plus tard — 1 724,69 $ sur le relevé du 16 août 2026,
// 1 724,69 $ sortis le 4 septembre. Aucune reconstitution à partir des achats ne
// fera mieux : le relevé ferme le 15 (reporté au jour ouvrable suivant) et
// travaille sur les dates de COMPTABILISATION, alors que le rapprochement
// bancaire ne connaît que les dates de transaction. Quand le relevé existe, il
// fait foi ; sinon seulement, la projection additionne les achats de la période.
//
// Les relevés vivent dans « BNC_et_Mastercard_Relevés / Mastercard Banque
// Nationale / <année-année> », un PDF par mois.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { getDriveClient } from '../connectors/google.js'
import { logSync } from './syncLog.js'

const execFileAsync = promisify(execFile)

// Dossier Drive des relevés, par compte du rapprochement bancaire.
export const CARD_STATEMENT_FOLDERS = {
  'MasterCard BNC': '1T1usbG-E0bdO20hX3SWMDjsdjEMZlNvA',
}

// En-tête d'un relevé BNC : « 26 08 16  $1,724.69  $1,724.69 2026 09 08 »
// = date du relevé, solde, paiement minimum, date d'échéance.
const HEADER_RE = /(\d{2})\s+(\d{2})\s+(\d{2})\s+\$([\d,]+\.\d{2})\s+\$[\d,]+\.\d{2}\s+(\d{4})\s+(\d{2})\s+(\d{2})/

export function parseStatementHeader(text) {
  const m = String(text || '').match(HEADER_RE)
  if (!m) return null
  const balance = Number(m[4].replace(/,/g, ''))
  if (!Number.isFinite(balance)) return null
  return {
    statement_date: `20${m[1]}-${m[2]}-${m[3]}`,
    balance,
    due_date: `${m[5]}-${m[6]}-${m[7]}`,
  }
}

async function pdfText(buffer) {
  const file = path.join(os.tmpdir(), `card-statement-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`)
  fs.writeFileSync(file, buffer)
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-layout', '-f', '1', '-l', '1', file, '-'])
    return stdout
  } finally {
    try { fs.unlinkSync(file) } catch { /* fichier déjà parti */ }
  }
}

async function googleDrive() {
  const acc = db.prepare(
    "SELECT id FROM connector_oauth WHERE connector='google' ORDER BY updated_at DESC LIMIT 1"
  ).get()
  if (!acc) throw new Error('Aucun compte Google connecté (page Connecteurs)')
  return getDriveClient(acc.id)
}

// Tous les PDF du dossier et de ses sous-dossiers d'année.
async function listStatementFiles(drive, folderId) {
  const out = []
  const children = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id,name,mimeType)', pageSize: 200,
    supportsAllDrives: true, includeItemsFromAllDrives: true,
  })
  for (const f of children.data.files || []) {
    if (f.mimeType === 'application/vnd.google-apps.folder') {
      out.push(...await listStatementFiles(drive, f.id))
    } else if (f.mimeType === 'application/pdf') {
      out.push(f)
    }
  }
  return out
}

// Importe les relevés pas encore lus. Idempotent : un relevé déjà en base n'est
// ni retéléchargé ni relu.
export async function importCardStatements({ accountName = null, force = false } = {}) {
  const t0 = Date.now()
  const targets = accountName
    ? { [accountName]: CARD_STATEMENT_FOLDERS[accountName] }
    : CARD_STATEMENT_FOLDERS
  let imported = 0, skipped = 0
  const errors = []
  try {
    const drive = await googleDrive()
    for (const [account, folderId] of Object.entries(targets)) {
      if (!folderId) continue
      const known = new Set(db.prepare(
        'SELECT drive_file_id FROM card_statements WHERE account_name = ? AND drive_file_id IS NOT NULL'
      ).all(account).map(r => r.drive_file_id))
      for (const file of await listStatementFiles(drive, folderId)) {
        if (!force && known.has(file.id)) { skipped++; continue }
        try {
          const res = await drive.files.get(
            { fileId: file.id, alt: 'media', supportsAllDrives: true },
            { responseType: 'arraybuffer' },
          )
          const parsed = parseStatementHeader(await pdfText(Buffer.from(res.data)))
          if (!parsed) { errors.push(`${file.name} : en-tête illisible`); continue }
          db.prepare(`
            INSERT INTO card_statements (id, account_name, statement_date, due_date, balance, drive_file_id, file_name)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_name, statement_date) DO UPDATE SET
              due_date = excluded.due_date, balance = excluded.balance,
              drive_file_id = excluded.drive_file_id, file_name = excluded.file_name,
              imported_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          `).run(newRecordId(), account, parsed.statement_date, parsed.due_date, parsed.balance, file.id, file.name)
          imported++
        } catch (e) {
          errors.push(`${file.name} : ${e.message}`)
        }
      }
    }
    logSync('card:statements', 'scheduled', { status: 'success', modified: imported, durationMs: Date.now() - t0 })
    return { imported, skipped, errors }
  } catch (e) {
    logSync('card:statements', 'scheduled', { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    throw e
  }
}
