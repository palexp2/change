#!/usr/bin/env node
// Dépose un fichier local dans le Google Drive d'un compte connecté à l'ERP.
//
//   node server/scripts/drive-upload.mjs --list
//   node server/scripts/drive-upload.mjs --file docs/x.md [--account charles@orisha.io]
//                                        [--name "Titre dans le Drive"] [--parent <folderId>] [--doc]
//
// Sans --account : le premier compte Google connecté. --doc convertit en Google Doc
// (lisible directement dans le Drive) au lieu de déposer le fichier brut.
//
// Prérequis : le scope drive.file (voir connectors/google.js). Un compte connecté AVANT
// l'ajout du scope doit être reconnecté depuis la page Connecteurs, sinon Google répond
// ACCESS_TOKEN_SCOPE_INSUFFICIENT.
import { resolve } from 'path'
import db from '../src/db/database.js'
import { uploadFileToDrive } from '../src/services/drive.js'

const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const accounts = db.prepare(`
  SELECT id, account_email, updated_at FROM connector_oauth
  WHERE connector='google' AND refresh_token IS NOT NULL
  ORDER BY updated_at DESC
`).all()

if (args.includes('--list') || !accounts.length) {
  console.log(accounts.length ? 'Comptes Google connectés :' : 'Aucun compte Google connecté.')
  for (const a of accounts) console.log(`  ${a.account_email}  (reconnecté ${a.updated_at})`)
  process.exit(accounts.length ? 0 : 1)
}

const file = flag('file')
if (!file) {
  console.error('Usage: node server/scripts/drive-upload.mjs --file <chemin> [--account <email>] [--name <titre>] [--parent <folderId>] [--doc]')
  process.exit(1)
}

const wanted = (flag('account') || '').toLowerCase()
const account = wanted
  ? accounts.find(a => String(a.account_email).toLowerCase() === wanted)
  : accounts[0]
if (!account) {
  console.error(`Compte « ${wanted} » introuvable. --list pour voir les comptes connectés.`)
  process.exit(1)
}

try {
  const out = await uploadFileToDrive(account.id, {
    path: resolve(file),
    name: flag('name'),
    mimeType: 'text/markdown',
    parentId: flag('parent'),
    convertToGoogleDoc: args.includes('--doc'),
  })
  console.log(`Déposé dans le Drive de ${account.account_email} :`)
  console.log(`  ${out.name} (${out.mimeType}${out.size ? `, ${out.size} octets` : ''})`)
  console.log(`  ${out.webViewLink}`)
} catch (e) {
  const msg = e?.errors?.[0]?.message || e.message
  console.error(`Échec du dépôt : ${msg}`)
  if (/insufficient|scope/i.test(msg)) {
    console.error(`→ Reconnecte ${account.account_email} depuis la page Connecteurs (le scope d'écriture Drive vient d'être ajouté).`)
  }
  process.exit(1)
}
