import { createWriteStream, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { getDriveClient } from '../connectors/google.js'
import { enqueueTranscription } from './whisper.js'

function parseAcrFilename(filename) {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}-\d{2}-\d{2}) \(phone\) (.+?) \(([+\d\s\-()]+)\) ([↗↙])/)
  if (m) {
    const [, date, time, contactName, phone, arrow] = m
    return {
      contactName: contactName.trim(),
      phone: phone.replace(/\s/g, ''),
      timestamp: new Date(`${date}T${time.replace(/-/g, ':')}`).toISOString(),
      direction: arrow === '↗' ? 'out' : 'in',
    }
  }
  const m2 = filename.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}-\d{2}-\d{2})/)
  if (m2) {
    return { contactName: null, phone: null, direction: 'in',
      timestamp: new Date(`${m2[1]}T${m2[2].replace(/-/g, ':')}`).toISOString() }
  }
  return { contactName: null, phone: null, direction: 'in', timestamp: new Date().toISOString() }
}

function findOrCreateContact(phone, contactName) {
  if (phone) {
    const digits = phone.replace(/\D/g, '').slice(-10)
    const byPhone = db.prepare(`
      SELECT id FROM contacts WHERE
      replace(replace(replace(replace(replace(phone,' ',''),'-',''),'(',''),')',''),'+','') LIKE ?
      LIMIT 1
    `).get(`%${digits}`)
    if (byPhone) return byPhone.id
  }
  if (contactName) {
    const parts = contactName.trim().split(' ')
    const lastName = parts.slice(1).join(' ') || parts[0]
    const byName = db.prepare(`SELECT id FROM contacts WHERE last_name LIKE ? LIMIT 1`).get(`%${lastName}%`)
    if (byName) return byName.id
  }
  const id = uuid()
  const parts = (contactName || '').trim().split(' ')
  db.prepare('INSERT INTO contacts (id, first_name, last_name, phone) VALUES (?,?,?,?)')
    .run(id, parts[0] || '', parts.slice(1).join(' ') || '', phone || null)
  return id
}

async function downloadFile(drive, fileId, destPath) {
  const dest = createWriteStream(destPath)
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' })
  return new Promise((resolve, reject) => {
    res.data.pipe(dest)
    dest.on('finish', resolve)
    dest.on('error', reject)
  })
}

async function syncFolder(drive, folderId, userId) {
  const uploadsDir = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'calls')
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true })

  const params = {
    q: `'${folderId}' in parents and (mimeType contains 'audio/' or mimeType contains 'video/') and trashed=false`,
    fields: 'nextPageToken, files(id, name, mimeType, createdTime)',
    orderBy: 'createdTime desc',
    pageSize: 50,
  }

  const list = await drive.files.list(params)
  const files = list.data.files || []
  let imported = 0

  for (const file of files) {
    if (db.prepare('SELECT id FROM calls WHERE drive_file_id=?').get(file.id)) continue

    const parsed = parseAcrFilename(file.name)
    let meta = {}
    try {
      const baseName = file.name.replace(/\.(m4a|mp4|wav)$/i, '')
      const jsonFiles = await drive.files.list({
        q: `'${folderId}' in parents and name='${baseName}.json' and trashed=false`,
        fields: 'files(id)', pageSize: 1,
      })
      const jsonFileId = jsonFiles.data.files?.[0]?.id
      if (jsonFileId) {
        const jsonContent = await drive.files.get({ fileId: jsonFileId, alt: 'media' })
        meta = jsonContent.data || {}
      }
    } catch {}

    const direction = meta.direction === 'Outgoing' ? 'out' : meta.direction === 'Incoming' ? 'in' : parsed.direction
    const phone = meta.callee || parsed.phone
    const durationSeconds = meta.duration ? Math.round(Number(meta.duration) / 1000) : null

    const ext = file.mimeType.includes('mpeg') || file.name.endsWith('.m4a') ? 'm4a' : 'mp4'
    const localFilename = `${uuid()}.${ext}`
    const localPath = join(uploadsDir, localFilename)

    try { await downloadFile(drive, file.id, localPath) }
    catch (e) { console.error(`❌ Download ${file.name}:`, e.message); continue }

    const contactId = parsed.contactName || phone
      ? findOrCreateContact(phone, parsed.contactName)
      : null

    const interactionId = uuid()
    const callId = uuid()

    db.prepare('INSERT INTO interactions (id, contact_id, user_id, type, direction, timestamp) VALUES (?,?,?,?,?,?)')
      .run(interactionId, contactId, userId || null, 'call', direction, parsed.timestamp)

    db.prepare('INSERT INTO calls (id, interaction_id, recording_path, caller_number, callee_number, duration_seconds, drive_file_id, drive_filename) VALUES (?,?,?,?,?,?,?,?)')
      .run(callId, interactionId, localFilename, direction === 'out' ? null : phone, direction === 'out' ? phone : null, durationSeconds, file.id, file.name)

    enqueueTranscription(callId, localPath).catch(console.error)
    imported++
  }
  return imported
}

export async function syncDrive() {
  // Load folders config — new multi-folder format first, fall back to legacy single-folder
  const foldersRow = db.prepare(`
    SELECT value FROM connector_config WHERE connector='google' AND key='drive_folders'
  `).get()

  let folders = []
  if (foldersRow?.value) {
    try { folders = JSON.parse(foldersRow.value) } catch {}
  }

  // Legacy fallback
  if (folders.length === 0) {
    const folderRow = db.prepare(`
      SELECT value FROM connector_config WHERE connector='google' AND key='drive_folder_id'
    `).get()
    if (folderRow?.value) {
      const emailRow = db.prepare(`
        SELECT value FROM connector_config WHERE connector='google' AND key='drive_sync_email'
      `).get()
      folders = [{ folder_id: folderRow.value, email: emailRow?.value || null, user_id: null, label: 'Dossier par défaut' }]
    }
  }

  if (folders.length === 0) { console.log(`⚠️  No Drive folders configured`); return }

  let totalImported = 0
  for (const folder of folders) {
    if (!folder.folder_id) continue

    // Resolve OAuth account for this folder
    let oauthRow
    if (folder.email) {
      oauthRow = db.prepare(`
        SELECT * FROM connector_oauth WHERE connector='google' AND account_email=?
      `).get(folder.email)
    }
    if (!oauthRow) {
      oauthRow = db.prepare(`
        SELECT * FROM connector_oauth WHERE connector='google' ORDER BY updated_at DESC LIMIT 1
      `).get()
    }
    if (!oauthRow?.refresh_token) { console.log(`⚠️  No Google account for folder ${folder.label}`); continue }

    let drive
    try { drive = await getDriveClient(oauthRow.id) }
    catch (e) { console.error(`❌ Drive auth for ${folder.label}:`, e.message); continue }

    try {
      const n = await syncFolder(drive, folder.folder_id, folder.user_id || null)
      totalImported += n
    } catch (e) {
      console.error(`❌ Drive sync folder ${folder.label}:`, e.message)
    }
  }

  db.prepare(`
    INSERT INTO drive_sync_state (id, last_page_token, last_synced_at)
    VALUES (1,?,datetime('now'))
    ON CONFLICT(id) DO UPDATE SET last_synced_at=excluded.last_synced_at
  `).run(null)

  if (totalImported > 0) console.log(`🎙️  Drive sync: ${totalImported} recordings`)
}
