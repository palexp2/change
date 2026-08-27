#!/usr/bin/env node
// Recherche de fichiers dans le Drive d'un compte connecté (scope drive.readonly).
//   node server/scripts/drive-find.mjs --account michel@orisha.io --q "Déboursés"
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
if (!account) { console.error('compte introuvable', accounts.map(a => a.account_email)); process.exit(1) }

const drive = await getDriveClient(account.id)
const q = flag('q', 'Déboursés')
const res = await drive.files.list({
  q: `name contains '${q.replace(/'/g, "\\'")}' and trashed=false`,
  fields: 'files(id,name,mimeType,parents,modifiedTime,webViewLink)',
  pageSize: 50,
  includeItemsFromAllDrives: true,
  supportsAllDrives: true,
})
console.log(`${account.account_email} — ${res.data.files.length} résultat(s) pour "${q}"`)
for (const f of res.data.files) {
  console.log(`${f.id}  ${f.mimeType.replace('application/vnd.google-apps.', 'gapps/')}  ${f.name}  parents=${(f.parents || []).join(',')}`)
}
