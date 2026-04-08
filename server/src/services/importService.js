import { readFileSync } from 'fs'
import { extname } from 'path'
import db from '../db/database.js'
import { newId } from '../utils/ids.js'

// ── CSV parser (no external deps) ────────────────────────────────────────────

function parseCSV(content) {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (!lines.length) return []

  const rows = []
  for (const line of lines) {
    if (!line.trim()) continue
    rows.push(parseCSVLine(line))
  }

  if (rows.length < 2) return []
  const headers = rows[0]
  return rows.slice(1).map(cells => {
    const obj = {}
    headers.forEach((h, i) => { obj[h] = cells[i] ?? '' })
    return obj
  })
}

function parseCSVLine(line) {
  const cells = []
  let cur = '', inQuote = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++ }
      else inQuote = !inQuote
    } else if (c === ',' && !inQuote) {
      cells.push(cur); cur = ''
    } else {
      cur += c
    }
  }
  cells.push(cur)
  return cells
}

// ── Value coercion ────────────────────────────────────────────────────────────

function coerceValue(raw, fieldType) {
  if (raw === null || raw === undefined || raw === '') return null
  const s = String(raw).trim()

  switch (fieldType) {
    case 'number':
    case 'currency':
    case 'percent': {
      const n = Number(s.replace(/[,\s]/g, ''))
      return isNaN(n) ? { error: `"${raw}" n'est pas un nombre valide` } : n
    }
    case 'checkbox':
    case 'boolean': {
      const lower = s.toLowerCase()
      if (['true', '1', 'oui', 'yes'].includes(lower)) return true
      if (['false', '0', 'non', 'no'].includes(lower)) return false
      return { error: `"${raw}" n'est pas un booléen valide` }
    }
    case 'date': {
      // Accept ISO YYYY-MM-DD or DD/MM/YYYY
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
      const dmyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
      if (dmyMatch) return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, '0')}-${dmyMatch[1].padStart(2, '0')}`
      return { error: `"${raw}" n'est pas une date valide (YYYY-MM-DD ou DD/MM/YYYY)` }
    }
    default:
      return s
  }
}

// ── Main import function ──────────────────────────────────────────────────────

export async function importRecords(tableId, filePath, mapping, mode, userId) {
  // 1. Verify table exists
  const table = db.prepare('SELECT * FROM base_tables WHERE id = ? AND deleted_at IS NULL').get(tableId)
  if (!table) throw Object.assign(new Error('Table introuvable'), { status: 404 })

  // 2. Load fields for type coercion
  const fields = db.prepare("SELECT * FROM base_fields WHERE table_id = ? AND deleted_at IS NULL").all(tableId)
  const fieldsByKey = Object.fromEntries(fields.map(f => [f.key, f]))

  // 3. Parse file
  const ext = extname(filePath).toLowerCase()
  let rawRows = []

  if (ext === '.json') {
    const content = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) throw Object.assign(new Error('Le fichier JSON doit contenir un tableau'), { status: 400 })
    rawRows = parsed
  } else if (ext === '.csv') {
    const content = readFileSync(filePath, 'utf8')
    rawRows = parseCSV(content)
  } else if (ext === '.xlsx' || ext === '.xls') {
    const { read, utils } = await import('xlsx')
    const workbook = read(readFileSync(filePath))
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    rawRows = utils.sheet_to_json(sheet, { defval: '' })
  } else {
    throw Object.assign(new Error('Format non supporté. Utiliser .csv, .xlsx ou .json'), { status: 400 })
  }

  // 4. Validate row count
  if (rawRows.length > 5000) throw Object.assign(new Error('Maximum 5000 lignes par import'), { status: 400 })

  // 5. Parse mapping
  const mappingObj = typeof mapping === 'string' ? JSON.parse(mapping) : (mapping || {})

  // 6. If replace mode → soft-delete existing records
  if (mode === 'replace') {
    db.prepare("UPDATE base_records SET deleted_at = datetime('now') WHERE table_id = ? AND deleted_at IS NULL")
      .run(tableId)
  }

  // 7. Process rows
  const errors = []
  const validRecords = []
  const maxSort = db.prepare('SELECT MAX(sort_order) as m FROM base_records WHERE table_id = ?').get(tableId).m || 0

  // Autonumber field
  const autonumField = db.prepare("SELECT * FROM base_fields WHERE table_id = ? AND type = 'autonumber' AND deleted_at IS NULL").get(tableId)

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i]
    const data = {}
    let hasError = false

    for (const [srcCol, targetKey] of Object.entries(mappingObj)) {
      const rawVal = row[srcCol]
      const field = fieldsByKey[targetKey]
      const fieldType = field?.type || 'text'
      const coerced = coerceValue(rawVal, fieldType)

      if (coerced && typeof coerced === 'object' && coerced.error) {
        errors.push({ row: i + 2, column: srcCol, message: coerced.error })
        hasError = true
        break
      }
      if (coerced !== null) data[targetKey] = coerced
    }

    if (!hasError) validRecords.push(data)
  }

  // 8. Batch insert in transaction
  let imported = 0
  db.transaction(() => {
    let seq = autonumField
      ? db.prepare('SELECT autonumber_seq FROM base_tables WHERE id = ?').get(tableId).autonumber_seq
      : null

    for (let i = 0; i < validRecords.length; i++) {
      const data = { ...validRecords[i] }
      const recId = newId('record')

      if (autonumField) {
        seq++
        db.prepare('UPDATE base_tables SET autonumber_seq = ? WHERE id = ?').run(seq, tableId)
        data[autonumField.key] = seq
      }

      db.prepare(`INSERT INTO base_records (id, table_id, data, sort_order) VALUES (?, ?, ?, ?)`)
        .run(recId, tableId, JSON.stringify(data), maxSort + i + 1)

      db.prepare(`INSERT INTO record_history (id, table_id, record_id, user_id, action, diff) VALUES (?, ?, ?, ?, 'create', ?)`)
        .run(newId('record'), tableId, recId, userId, JSON.stringify({ source: 'import' }))

      imported++
    }
  })()

  return { imported, errors }
}
