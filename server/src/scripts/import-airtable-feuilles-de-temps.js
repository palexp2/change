#!/usr/bin/env node
// One-shot: importe les feuilles de temps Airtable (base "Feuilles de temps",
// table "Heures") des trois derniers mois en mode `simple` (start/end/break,
// sans codes d'activité). Les utilisateurs manquants sont créés et liés à
// leur fiche `employees` ; les comptes créés sont inactifs (active=0) — un
// admin doit les activer + définir le mot de passe avant qu'ils puissent
// se connecter.
//
// Idempotence : si une journée (user_id, date) existe déjà dans
// timesheet_days (deleted_at IS NULL), on la préserve — l'import ne
// l'écrase pas.
//
// Usage :
//   node src/scripts/import-airtable-feuilles-de-temps.js              # dry run
//   node src/scripts/import-airtable-feuilles-de-temps.js --apply      # exécute

import bcrypt from 'bcrypt'
import { randomBytes } from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import db from '../db/database.js'
import { getAccessToken, airtableFetch } from '../connectors/airtable.js'

const APPLY = process.argv.includes('--apply')
const BASE_ID = 'appSnHzaIqbpjNh3V'
const TABLE_ID = 'tblZjXF6p4CbllCKt'

// Aujourd'hui - 3 mois (calendaire)
const today = new Date()
const cutoff = new Date(today)
cutoff.setMonth(cutoff.getMonth() - 3)
const SINCE = cutoff.toISOString().slice(0, 10)

// Mapping Employé Airtable (singleSelect, prénom uniquement sauf Antoine Lambert) →
// soit user_id existant, soit instructions de création (email + employee_id).
// Les emails sont alignés sur ce qui existe en `employees.email_work`/`email_personal`
// quand disponible, sinon synthétisés en orisha.io.
const MAPPING = {
  'Martin': { user_email: 'martin@orisha.io', employee_id: '191ad678-8d5a-4ffe-a9dc-4efe72f49f71' },
  'Marc-Antoine': { user_email: 'marc-antoine@orisha.io', employee_id: 'bf474db8-11cb-41e2-8351-7c992a137935' },
  'Michel': { create: { email: 'michel@orisha.io', name: 'Michel Lambert', employee_id: 'b8273378-0ef8-4f05-9a6e-e2fbb2335236' } },
  'Daniel': { create: { email: 'nitrof1958@gmail.com', name: 'Daniel Fortin', employee_id: '4abfa28c-ec18-4987-9941-376eaa70e1ed' } },
  'Louis-Bernard': { create: { email: 'louis-bernard@orisha.io', name: 'Louis-Bernard Frechette', employee_id: '6fb31085-d3dd-483d-aaa0-5fb7894f0f56' } },
  'Sara-Ève': { create: { email: 'sara-eve@orisha.io', name: 'Sara-Ève Dufresne', employee_id: 'cd8cba14-764b-4eb4-bf5f-898795a4cca1' } },
  'Antoine Lambert': { create: { email: 'antoine.lambert96@gmail.com', name: 'Antoine Lambert', employee_id: 'd34ff805-970b-443a-bc22-b632a900ac5a' } },
  'Christine': { create: { email: 'christine.larouche@orisha.io', name: 'Christine Larouche', employee_id: '92b9ae53-ae03-452a-85c3-b4787c88562d' } },
  'Érik': { create: { email: 'erik.poudrier@orisha.io', name: 'Érik Poudrier Jessop', employee_id: '2f228e47-a2c3-4f5c-a6ff-b36d8dd5f362' } },
}

function secsToHHMM(s) {
  if (s == null || s < 0) return null
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

async function fetchAirtableRecords() {
  const token = await getAccessToken()
  const all = []
  let offset = null
  do {
    const q = offset
      ? `?pageSize=100&offset=${encodeURIComponent(offset)}`
      : '?pageSize=100'
    const data = await airtableFetch(`/${BASE_ID}/${TABLE_ID}${q}`, token)
    all.push(...data.records)
    offset = data.offset
  } while (offset)
  return all
}

async function resolveUserId(empName, createdUsersLog) {
  const cfg = MAPPING[empName]
  if (!cfg) return { error: `mapping introuvable pour "${empName}"` }

  if (cfg.user_email) {
    const u = db.prepare('SELECT id, employee_id FROM users WHERE email = ?').get(cfg.user_email.toLowerCase())
    if (!u) return { error: `user existant "${cfg.user_email}" introuvable` }
    // Lier employee_id si manquant (mise à jour bénigne)
    if (!u.employee_id && cfg.employee_id && APPLY) {
      db.prepare('UPDATE users SET employee_id = ? WHERE id = ?').run(cfg.employee_id, u.id)
    }
    return { user_id: u.id }
  }

  if (cfg.create) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(cfg.create.email.toLowerCase())
    if (existing) return { user_id: existing.id }
    if (!APPLY) {
      // Dry-run: simuler avec ID symbolique
      createdUsersLog.push({ ...cfg.create, simulated: true })
      return { user_id: `__simulated__${cfg.create.email}` }
    }
    const id = uuidv4()
    const placeholderPwd = randomBytes(32).toString('hex')
    const hash = await bcrypt.hash(placeholderPwd, 10)
    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, active, employee_id)
      VALUES (?, ?, ?, ?, 'ops', 0, ?)
    `).run(id, cfg.create.email.toLowerCase(), hash, cfg.create.name, cfg.create.employee_id)
    createdUsersLog.push({ ...cfg.create, id })
    return { user_id: id }
  }

  return { error: 'config invalide' }
}

async function main() {
  console.log(`📅 Plage : depuis ${SINCE} (3 derniers mois)`)
  console.log(`🔧 Mode : ${APPLY ? 'APPLY (écriture)' : 'DRY RUN'}\n`)

  console.log('🔄 Fetch Airtable…')
  const records = await fetchAirtableRecords()
  console.log(`   ${records.length} lignes au total\n`)

  // 1. Filtre date + champs requis
  const inWindow = []
  let skippedNoDate = 0, skippedNoEmp = 0, skippedOutOfWindow = 0
  for (const r of records) {
    const f = r.fields
    if (!f.Date) { skippedNoDate++; continue }
    if (!f['Employé']) { skippedNoEmp++; continue }
    if (f.Date < SINCE) { skippedOutOfWindow++; continue }
    inWindow.push(r)
  }
  console.log(`📊 Filtrage :`)
  console.log(`   ${inWindow.length} dans la fenêtre (≥ ${SINCE})`)
  console.log(`   ${skippedOutOfWindow} hors fenêtre`)
  console.log(`   ${skippedNoDate} sans date / ${skippedNoEmp} sans employé\n`)

  // 2. Résolution employé → user_id (création si nécessaire)
  const createdUsers = []
  const empToUser = {}
  const employeeNames = [...new Set(inWindow.map(r => r.fields['Employé']))]
  for (const name of employeeNames) {
    const r = await resolveUserId(name, createdUsers)
    if (r.error) {
      console.error(`❌ ${name}: ${r.error}`)
      process.exit(1)
    }
    empToUser[name] = r.user_id
  }
  if (createdUsers.length) {
    console.log(`👤 Utilisateurs ${APPLY ? 'créés' : 'à créer'} (active=0, mot de passe aléatoire — admin doit activer + reset) :`)
    for (const u of createdUsers) console.log(`   • ${u.name} <${u.email}>${u.id ? ` → ${u.id}` : ''}`)
    console.log('')
  }

  // 3. Conversion + dédup
  const byKey = new Map()  // (user_id|date) → { ...row, totalSecs }
  let invalidTimes = 0
  let dupsDropped = 0
  for (const r of inWindow) {
    const f = r.fields
    const userId = empToUser[f['Employé']]
    const debut = typeof f['Début'] === 'number' ? f['Début'] : null
    const fin = typeof f['Fin'] === 'number' ? f['Fin'] : null
    const pause = typeof f['Pause'] === 'number' ? f['Pause'] : 0
    if (debut == null || fin == null || fin <= debut) { invalidTimes++; continue }
    const totalSecs = fin - debut - pause
    const key = `${userId}|${f.Date}`
    const row = {
      user_id: userId,
      date: f.Date,
      start_time: secsToHHMM(debut),
      end_time: secsToHHMM(fin),
      break_minutes: Math.round(pause / 60),
      _totalSecs: totalSecs,
      _airtableId: r.id,
    }
    const existing = byKey.get(key)
    if (!existing || row._totalSecs > existing._totalSecs) {
      if (existing) dupsDropped++
      byKey.set(key, row)
    } else {
      dupsDropped++
    }
  }
  console.log(`🧮 Conversion : ${byKey.size} jours uniques, ${dupsDropped} doublons écartés (gardé le plus long), ${invalidTimes} avec début/fin invalide\n`)

  // 4. Skip si timesheet_day existe déjà (deleted_at IS NULL) pour préserver la saisie manuelle
  const checkExisting = db.prepare(`
    SELECT id FROM timesheet_days
    WHERE user_id = ? AND date = ? AND deleted_at IS NULL
  `)
  const toInsert = []
  let existingSkipped = 0
  for (const row of byKey.values()) {
    if (checkExisting.get(row.user_id, row.date)) { existingSkipped++; continue }
    toInsert.push(row)
  }
  console.log(`💾 ${toInsert.length} jours à insérer (${existingSkipped} déjà présents — préservés)\n`)

  // 5. Aperçu par employé
  const summary = {}
  for (const r of toInsert) {
    const empName = Object.entries(empToUser).find(([, uid]) => uid === r.user_id)?.[0] || '?'
    if (!summary[empName]) summary[empName] = { count: 0, minDate: r.date, maxDate: r.date, hours: 0 }
    summary[empName].count++
    summary[empName].hours += r._totalSecs / 3600
    if (r.date < summary[empName].minDate) summary[empName].minDate = r.date
    if (r.date > summary[empName].maxDate) summary[empName].maxDate = r.date
  }
  console.log('📈 Récap par employé :')
  for (const [emp, s] of Object.entries(summary).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`   ${emp.padEnd(20)} ${String(s.count).padStart(4)} jours, ${s.hours.toFixed(1).padStart(7)} h, ${s.minDate} → ${s.maxDate}`)
  }
  console.log('')

  // 6. Insert
  if (!APPLY) {
    console.log('🟡 DRY RUN — relance avec --apply pour exécuter.')
    return
  }

  const insertDay = db.prepare(`
    INSERT INTO timesheet_days (id, user_id, date, mode, start_time, end_time, break_minutes)
    VALUES (?, ?, ?, 'simple', ?, ?, ?)
  `)
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      insertDay.run(uuidv4(), r.user_id, r.date, r.start_time, r.end_time, r.break_minutes)
    }
  })
  tx(toInsert)
  console.log(`✅ ${toInsert.length} feuilles de temps insérées.`)
}

main().catch((e) => {
  console.error('💥 Erreur :', e.message)
  console.error(e.stack)
  process.exit(1)
})
