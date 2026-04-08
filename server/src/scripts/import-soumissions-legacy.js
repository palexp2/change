/**
 * Import legacy soumissions PDFs from Airtable Projects table.
 *
 * Champs Airtable lus dans la table Projets (tbl2Lh4KLVgHcRIZP) :
 *   - "Soumission"         (multipleAttachments) — soumissions envoyées au client
 *   - "Soumission signée"  (multipleAttachments) — version signée par le client
 *   - "Création"           (date)                — date de création du projet
 *
 * Pour chaque fichier :
 *   1. Télécharge le PDF depuis l'URL Airtable
 *   2. Sauvegarde dans /home/ec2-user/erp/server/storage/soumissions/
 *   3. Crée un enregistrement dans la table `soumissions` lié au bon projet
 *
 * Idempotent : un fichier déjà importé (même generated_pdf_path) est ignoré.
 */

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { getAccessToken } from '../connectors/airtable.js'

const BASE_ID     = 'appB4Fehk9jYd4s4B'
const TABLE_ID    = 'tbl2Lh4KLVgHcRIZP'
const STORAGE_DIR = '/home/ec2-user/erp/server/storage/soumissions'
const DELAY_MS    = 200  // between Airtable API pages (rate limit)

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/** Sanitise un nom de fichier pour le disque */
function safeFilename(str) {
  return str.replace(/[^a-zA-Z0-9._\-() ]/g, '_').trim()
}

/** Construit le nom de fichier local : <project_airtable_id>_<att_id>_<filename> */
function localFilename(projectAirtableId, attId, originalFilename) {
  const safe = safeFilename(originalFilename)
  return `${projectAirtableId}_${attId}_${safe}`
}

/** Télécharge un fichier et retourne le buffer */
async function downloadFile(url) {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`HTTP ${resp.status} pour ${url}`)
  return Buffer.from(await resp.arrayBuffer())
}

/** Retire l'extension d'un nom de fichier */
function nameWithoutExt(filename) {
  return filename.replace(/\.[^.]+$/, '')
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(STORAGE_DIR, { recursive: true })

  // Pré-charger tous les projets locaux (airtable_id → {id, company_id})
  const projectRows = db.prepare(
    'SELECT id, airtable_id, company_id FROM projects WHERE airtable_id IS NOT NULL'
  ).all()
  const projectByAirtableId = new Map(projectRows.map(p => [p.airtable_id, p]))
  console.log(`${projectRows.length} projets locaux indexés`)

  // Pré-charger les chemins déjà importés pour idempotence
  const existingPaths = new Set(
    db.prepare("SELECT generated_pdf_path FROM soumissions WHERE generated_pdf_path IS NOT NULL")
      .all()
      .map(r => r.generated_pdf_path)
  )
  console.log(`${existingPaths.size} fichiers déjà importés (seront ignorés)`)

  // Stats
  let pagesTotal = 0, projetsTraites = 0
  let fichiersTelecharges = 0, fichiersIgnores = 0, erreursDownload = 0, erreursProjet = 0

  const insertSoumission = db.prepare(`
    INSERT INTO soumissions
      (id, project_id, company_id, title, status, generated_pdf_path, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, 'legacy', ?, datetime('now'), datetime('now'))
  `)

  // Parcourir toutes les pages Airtable
  let offset = null
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`)
    url.searchParams.append('fields[]', 'Soumission')
    url.searchParams.append('fields[]', 'Soumission signée')
    url.searchParams.append('fields[]', 'Création')
    if (offset) url.searchParams.set('offset', offset)

    // Rafraîchit le token à chaque page (auto-refresh si expiré)
    const token = await getAccessToken()
    const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + token } })
    const data = await resp.json()
    if (!data.records) {
      console.error('Erreur API Airtable:', JSON.stringify(data))
      break
    }

    pagesTotal++
    if (pagesTotal % 5 === 0) process.stdout.write(`  Page ${pagesTotal}...\n`)

    for (const record of data.records) {
      const soumissions = record.fields['Soumission'] || []
      const signees     = record.fields['Soumission signée'] || []

      if (!soumissions.length && !signees.length) continue

      projetsTraites++
      const project = projectByAirtableId.get(record.id)

      if (!project) {
        erreursProjet++
        if (erreursProjet <= 10) console.warn(`  ⚠ Projet Airtable ${record.id} introuvable dans la DB locale`)
        continue
      }

      // Traiter les deux types d'attachements
      const allAtts = [
        ...soumissions.map(a => ({ att: a, signed: false })),
        ...signees.map(a => ({ att: a, signed: true })),
      ]

      for (const { att, signed } of allAtts) {
        const fname   = localFilename(record.id, att.id, att.filename)
        const fpath   = path.join(STORAGE_DIR, fname)
        const relPath = `storage/soumissions/${fname}`

        // Idempotence
        if (existingPaths.has(relPath)) {
          fichiersIgnores++
          continue
        }

        // Téléchargement
        let buffer
        try {
          buffer = await downloadFile(att.url)
        } catch (err) {
          erreursDownload++
          console.error(`  ✗ Téléchargement échoué: ${att.filename} — ${err.message}`)
          continue
        }

        fs.writeFileSync(fpath, buffer)

        // Titre : nom du fichier sans extension + [Signé] si besoin
        const rawTitle = nameWithoutExt(att.filename)
        const title    = signed ? `${rawTitle} [Signé]` : rawTitle

        // Insertion en DB
        insertSoumission.run(
          randomUUID(),
          project.id,
          project.company_id || null,
          title,
          relPath
        )

        existingPaths.add(relPath)
        fichiersTelecharges++

        if (fichiersTelecharges % 50 === 0) {
          console.log(`  ✓ ${fichiersTelecharges} fichiers importés...`)
        }
      }
    }

    offset = data.offset
    if (offset) await sleep(DELAY_MS)
  } while (offset)

  console.log('\n═══════════════════════════════════════')
  console.log(`Pages Airtable parcourues : ${pagesTotal}`)
  console.log(`Projets avec attachements : ${projetsTraites}`)
  console.log(`Fichiers téléchargés      : ${fichiersTelecharges}`)
  console.log(`Fichiers ignorés (déjà importés) : ${fichiersIgnores}`)
  console.log(`Projets non trouvés en DB : ${erreursProjet}`)
  console.log(`Erreurs de téléchargement : ${erreursDownload}`)
  console.log('═══════════════════════════════════════')
}

main().catch(err => {
  console.error('Erreur fatale:', err)
  process.exit(1)
})
