// Import mensuel des heures R&D depuis le Drive.
//
// Source : Comptabilité/Feuilles de temps/Feuilles_de_temps_Dev_{année},
// fichier `feuille_de_temps_{mois}_{année}.xlsx` (mois sans zéro initial :
// juillet 2026 → feuille_de_temps_7_2026.xlsx). Un onglet par personne, colonnes
// Dates | Heures RSDE | Description RSDE, et une ligne « total » en pied.
//
// C'est l'ERP qui refait le total de chaque personne, en additionnant les lignes
// datées de son onglet (décision Charles, 2026-08-09 : « des fois la formule
// n'est pas bien faite »). La ligne « total » du fichier est quand même lue,
// mais seulement pour comparer : quand la formule du fichier ne couvre pas
// toutes ses lignes (juillet 2026 : SUM qui saute le 31), l'écart est signalé
// sur la carte des heures pour que la feuille soit corrigée à la source.
//
// Alimente rd_month_hours, qui remplace le fichier « R&D_Suivi_Feuilles de
// temps » : plus de recopie manuelle entre le fichier du mois, le suivi annuel
// et la grille de provision.
//
// Les lignes corrigées à la main dans l'ERP (source = 'manuel') ne sont jamais
// écrasées par un ré-import — elles sont signalées dans le rapport.
import { randomUUID } from 'crypto'
import xlsx from 'xlsx'
import db from '../db/database.js'
import { getDriveClient } from '../connectors/google.js'

// Sous-traitants : suivis pour la déclaration de fin d'année, mais exclus du
// calcul de la provision (ce ne sont pas des employés d'Orisha).
export const DEFAULT_CONTRACTORS = ['Antoine Ratheau']

// La liste des sous-traitants arrive soit du code (tableau), soit de la config
// de l'automation (chaîne « Antoine Ratheau, X Y » éditée dans l'interface).
export function parseContractors(value) {
  if (Array.isArray(value)) return value.map(s => String(s).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean)
  return null
}

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()

export function timesheetFileName(month) {
  const y = Number(month.slice(0, 4)); const m = Number(month.slice(5, 7))
  return `feuille_de_temps_${m}_${y}.xlsx`
}

// Compte Google utilisé pour lire le Drive. Par défaut celui de la comptable,
// qui a accès au dossier des feuilles de temps ; on retombe sur n'importe quel
// compte connecté si ce compte précis n'est pas branché.
function resolveGoogleAccount(preferredEmail) {
  if (preferredEmail) {
    const row = db.prepare(`SELECT * FROM connector_oauth WHERE connector='google' AND account_email = ?`).get(preferredEmail)
    if (row?.refresh_token) return row
  }
  return db.prepare(`
    SELECT * FROM connector_oauth WHERE connector='google' AND refresh_token IS NOT NULL
    ORDER BY updated_at DESC LIMIT 1
  `).get() || null
}

export async function findTimesheetFile(month, { googleAccountEmail = null } = {}) {
  const account = resolveGoogleAccount(googleAccountEmail)
  if (!account) throw new Error('Aucun compte Google connecté (page Connecteurs)')
  const drive = await getDriveClient(account.id)
  const name = timesheetFileName(month)
  const res = await drive.files.list({
    q: `name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
    fields: 'files(id,name,mimeType,modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: 10,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  })
  const file = (res.data.files || [])[0] || null
  return { drive, account, file, expectedName: name }
}

// Heures RSDE d'un onglet. Deux lectures de la même colonne :
//   • `day_hours`  — la somme des lignes datées, recalculée par l'ERP. C'est la
//     valeur retenue (`hours`), quoi qu'affiche le pied de l'onglet ;
//   • `file_total` — la ligne « total » du fichier, gardée uniquement pour
//     signaler une formule qui ne couvre pas toutes ses lignes.
export function sumSheetHours(sheet) {
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, blankrows: false })
  let headerIdx = -1
  let hoursCol = 1
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const idx = (rows[i] || []).findIndex(c => norm(c).includes('heures rsde'))
    if (idx >= 0) { headerIdx = i; hoursCol = idx; break }
  }
  if (headerIdx < 0) return { hours: 0, day_hours: 0, file_total: null, days: 0, recognized: false }
  let dayHours = 0
  let days = 0
  let fileTotal = null
  for (const row of rows.slice(headerIdx + 1)) {
    const label = norm(row?.[0])
    if (!label) continue
    if (label === 'total') {
      const t = Number(row?.[hoursCol])
      if (Number.isFinite(t)) fileTotal = Math.round(t * 100) / 100
      continue
    }
    // Une ligne de jour porte une date en première colonne (2026/07/01, ou un
    // numéro de série Excel quand la cellule est typée date).
    const isDay = /\d{4}[/-]\d{1,2}[/-]\d{1,2}/.test(label) || /^\d{5}(\.\d+)?$/.test(label)
    if (!isDay) continue
    const v = Number(row?.[hoursCol])
    if (Number.isFinite(v)) { dayHours += v; days++ }
  }
  dayHours = Math.round(dayHours * 100) / 100
  return { hours: dayHours, day_hours: dayHours, file_total: fileTotal, days, recognized: true }
}

function matchEmployeeId(name) {
  const rows = db.prepare(`SELECT id, first_name, last_name FROM employees`).all()
  const target = norm(name)
  for (const e of rows) {
    if (norm(`${e.first_name} ${e.last_name}`) === target) return e.id
  }
  // Repli sur le nom de famille seul (les onglets portent parfois un prénom
  // abrégé : « Marc-Ant » dans le suivi annuel).
  for (const e of rows) {
    if (target && norm(e.last_name) && target.endsWith(norm(e.last_name))) return e.id
  }
  return null
}

// Import d'un mois. Idempotent : ré-importer le même mois met à jour les lignes
// issues de l'import et laisse intactes celles corrigées à la main.
export async function importRdHours(month, { googleAccountEmail = null, contractors = null } = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw new Error('Mois invalide (YYYY-MM attendu)')
  const contractorList = (parseContractors(contractors) || DEFAULT_CONTRACTORS).map(norm)

  const { drive, file, expectedName } = await findTimesheetFile(month, { googleAccountEmail })
  if (!file) throw new Error(`Fichier « ${expectedName} » introuvable dans le Drive`)

  const res = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' })
  const wb = xlsx.read(Buffer.from(res.data), { type: 'buffer' })

  const imported = []
  const skipped = []
  const unreadable = []
  const now = new Date().toISOString()

  const apply = db.transaction(() => {
    for (const sheetName of wb.SheetNames) {
      const { hours, day_hours: dayHours, file_total: fileTotal, recognized } = sumSheetHours(wb.Sheets[sheetName])
      if (!recognized) { unreadable.push(sheetName); continue }
      const contractor = contractorList.includes(norm(sheetName)) ? 1 : 0
      const existing = db.prepare(`
        SELECT * FROM rd_month_hours WHERE month = ? AND employee_name = ? AND deleted_at IS NULL
      `).get(month, sheetName)

      if (existing?.source === 'manuel') {
        skipped.push({ name: sheetName, kept: existing.hours, file_value: hours })
        continue
      }
      if (existing) {
        db.prepare(`
          UPDATE rd_month_hours SET hours = ?, day_hours = ?, file_total_hours = ?, contractor = ?,
            source = 'import', drive_file_id = ?, updated_at = ? WHERE id = ?
        `).run(hours, dayHours, fileTotal, contractor, file.id, now, existing.id)
      } else {
        db.prepare(`
          INSERT INTO rd_month_hours (id, month, employee_name, employee_id, hours, day_hours, file_total_hours, contractor, source, drive_file_id)
          VALUES (?,?,?,?,?,?,?,?,'import',?)
        `).run(randomUUID(), month, sheetName, matchEmployeeId(sheetName), hours, dayHours, fileTotal, contractor, file.id)
      }
      imported.push({ name: sheetName, hours, day_hours: dayHours, file_total: fileTotal, contractor: !!contractor })
    }
  })
  apply()

  // Aucun onglet lisible ni ligne manuelle conservée = le fichier n'a pas le
  // format attendu (colonnes renommées, classeur vide). Importer « rien » en
  // silence laisserait la provision tomber à zéro sans que personne le voie.
  if (!imported.length && !skipped.length) {
    throw new Error(
      `Aucun onglet reconnu dans « ${file.name} » — colonne « Heures RSDE » introuvable`
      + (unreadable.length ? ` (onglets : ${unreadable.join(', ')})` : ''),
    )
  }

  // Personnes qui avaient des heures le mois précédent mais n'ont pas d'onglet
  // dans ce classeur : le plus souvent un onglet oublié, à signaler.
  const prevM = (m => {
    let y = Number(m.slice(0, 4)); let mm = Number(m.slice(5, 7)) - 1
    if (mm === 0) { mm = 12; y -= 1 }
    return `${y}-${String(mm).padStart(2, '0')}`
  })(month)
  const inBook = new Set(wb.SheetNames.map(norm))
  const missingFromPrevious = db.prepare(`
    SELECT employee_name FROM rd_month_hours
    WHERE month = ? AND deleted_at IS NULL AND hours > 0
  `).all(prevM).map(r => r.employee_name).filter(n => !inBook.has(norm(n)))

  const employeeHours = imported.filter(r => !r.contractor).reduce((s, r) => s + r.hours, 0)
  return {
    month,
    file: { id: file.id, name: file.name, modified_time: file.modifiedTime },
    imported,
    skipped,
    unreadable,
    // Onglets dont la ligne « total » ne correspond pas à l'addition de leurs
    // lignes : c'est l'addition qui est retenue, la formule du fichier est à
    // corriger à la source.
    divergent: imported.filter(r => r.file_total != null && Math.abs(r.file_total - r.day_hours) > 0.005),
    missing_from_previous: missingFromPrevious,
    employee_hours: Math.round(employeeHours * 100) / 100,
    contractor_hours: Math.round(imported.filter(r => r.contractor).reduce((s, r) => s + r.hours, 0) * 100) / 100,
  }
}
