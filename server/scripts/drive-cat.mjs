#!/usr/bin/env node
// Lit/exporte un fichier Drive vers stdout ou un fichier local.
//   node server/scripts/drive-cat.mjs --account michel@orisha.io --id <fileId> [--out /tmp/x.xlsx]
import { writeFileSync } from 'fs'
import db from '../src/db/database.js'
import { getDriveClient } from '../src/connectors/google.js'

const args = process.argv.slice(2)
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1] }

const accounts = db.prepare(`
  SELECT id, account_email FROM connector_oauth
  WHERE connector='google' AND refresh_token IS NOT NULL ORDER BY updated_at DESC
`).all()
const wanted = (flag('account') || '').toLowerCase()
const account = wanted ? accounts.find(a => String(a.account_email).toLowerCase() === wanted) : accounts[0]
const drive = await getDriveClient(account.id)

const fileId = flag('id')
const meta = await drive.files.get({ fileId, fields: 'id,name,mimeType', supportsAllDrives: true })
const mime = meta.data.mimeType
const out = flag('out')

const EXPORT = {
  'application/vnd.google-apps.document': out ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

let res
if (EXPORT[mime]) {
  res = await drive.files.export({ fileId, mimeType: EXPORT[mime] }, { responseType: 'arraybuffer' })
} else {
  res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' })
}
const buf = Buffer.from(res.data)
if (out) { writeFileSync(out, buf); console.error(`${meta.data.name} → ${out} (${buf.length} o)`) }
else process.stdout.write(buf)
