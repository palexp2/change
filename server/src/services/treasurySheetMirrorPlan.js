// Writes only the four blocks of the existing BNC template. Pure planner:
// validation completes before any Google request can modify the workbook.
const norm = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
const cents = value => Math.round(value * 100)
const number = value => ({ numberValue: value })
const string = value => ({ stringValue: String(value) })
const formula = value => ({ formulaValue: value })

export function sheetDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '') || !Number.isFinite(Date.parse(iso))) throw new Error('Date de projection invalide')
  return Date.parse(iso) / 86400000 + 25569
}

export function planTreasurySheet(sheet, projection, recurring = []) {
  const grid = sheet.data?.[0]?.rowData || []
  const cell = (row, col) => grid[row]?.values?.[col] || {}
  const label = (row, col) => norm(cell(row, col).userEnteredValue?.stringValue)
  const headers = [[0, 0, 'fournisseur'], [0, 1, 'montant ($)'], [0, 2, 'date du paiement'],
    [0, 3, 'solde disponible'], [0, 5, 'solde disponible'], [0, 6, 'date'],
    [0, 8, 'sorties recurrentes'], [1, 8, 'jour approx'], [1, 9, 'montant'],
    [1, 10, 'description'], [0, 12, 'paie'], [0, 13, 'montant aprox']]
  if (headers.some(([r, c, expected]) => label(r, c) !== expected)) {
    throw new Error('Le modèle du Sheet BNC a changé : vérifier les quatre blocs avant de synchroniser')
  }
  if (!projection.balance_entry || !Number.isFinite(projection.balance_entry.balance)) {
    throw new Error('Aucun solde de départ valide dans Boréal')
  }
  if (!projection.days?.length) throw new Error('Projection vide : export annulé')
  const events = []
  let balance = cents(projection.balance_entry.balance)
  for (const day of projection.days) {
    sheetDate(day.date)
    for (const event of day.events) {
      if (!Number.isFinite(event.amount) || !event.label) throw new Error('Mouvement de projection invalide')
      events.push({ ...event, date: day.date })
      balance += cents(event.amount)
    }
    if (balance !== cents(day.balance)) throw new Error(`Solde incohérent avec la projection du ${day.date}`)
  }
  const planned = events.map((event, i) => [string(event.label), number(-cents(event.amount) / 100),
    number(sheetDate(event.date)), formula(`=${i === 0 ? 'F2' : `D${i + 1}`}-B${i + 2}`)])
  const payrollIds = new Set(recurring.filter(r => /^paie\b/.test(norm(r.label))).map(r => r.id))
  const payroll = events.filter(e => payrollIds.has(e.ref) && e.amount < 0)
    .map(e => [number(sheetDate(e.date)), number(-cents(e.amount) / 100)])
  const recurringRows = recurring.map(r => {
    const next = events.find(e => e.kind === 'recurring' && e.ref === r.id)
    const amount = next ? Math.abs(next.amount) : r.amount
    const day = r.frequency === 'monthly' ? r.day_of_month : null
    return [day == null ? {} : number(day), amount == null ? string('(voir le relevé)') : number(cents(amount) / 100), string(r.label)]
  })
  const sheetId = sheet.properties.sheetId
  const requests = []
  let changedCells = 0
  function block(startRow, startCol, width, values, styleRow) {
    let oldEnd = startRow
    for (let r = startRow; r < grid.length; r++) {
      if (Array.from({ length: width }, (_, c) => cell(r, startCol + c).userEnteredValue).some(Boolean)) oldEnd = r + 1
    }
    const endRow = Math.max(oldEnd, startRow + values.length)
    if (endRow > sheet.properties.gridProperties.rowCount) throw new Error('Le Sheet manque de lignes pour la projection')
    const range = { sheetId, startRowIndex: startRow, endRowIndex: endRow,
      startColumnIndex: startCol, endColumnIndex: startCol + width }
    if ((sheet.merges || []).some(m => m.startRowIndex < endRow && m.endRowIndex > startRow
      && m.startColumnIndex < startCol + width && m.endColumnIndex > startCol)) throw new Error('Cellules fusionnées dans un bloc de données')
    const rows = []
    let changed = false
    for (let r = startRow; r < endRow; r++) {
      const valuesForRow = []
      for (let c = 0; c < width; c++) {
        const desired = values[r - startRow]?.[c] || {}
        const current = cell(r, startCol + c).userEnteredValue || {}
        if (JSON.stringify(current) !== JSON.stringify(desired)) { changed = true; changedCells++ }
        valuesForRow.push(Object.keys(desired).length ? { userEnteredValue: desired } : {})
      }
      rows.push({ values: valuesForRow })
    }
    if (!changed) return
    // Extend existing typography, borders and number/date formats to new rows.
    if (startRow + values.length > oldEnd && styleRow != null) requests.push({ copyPaste: {
      source: { sheetId, startRowIndex: styleRow, endRowIndex: styleRow + 1,
        startColumnIndex: startCol, endColumnIndex: startCol + width },
      destination: { ...range, startRowIndex: oldEnd, endRowIndex: startRow + values.length }, pasteType: 'PASTE_FORMAT',
    } })
    requests.push({ updateCells: { range, rows, fields: 'userEnteredValue' } })
  }
  block(1, 0, 4, planned, 1)
  // Balance date stays the actual observation date, never the export date.
  const opening = [number(projection.balance_entry.balance), number(sheetDate(projection.balance_day))]
  // Only F2:G2 belong to this block; notes below it are not ours.
  const openingChanged = opening.some((v, i) => JSON.stringify(cell(1, 5 + i).userEnteredValue) !== JSON.stringify(v))
  if (openingChanged) {
    requests.push({ updateCells: { start: { sheetId, rowIndex: 1, columnIndex: 5 },
      rows: [{ values: opening.map(v => ({ userEnteredValue: v })) }], fields: 'userEnteredValue' } })
    changedCells += 2
  }
  block(4, 8, 3, recurringRows, 4)
  block(1, 12, 2, payroll, 1)
  return { requests, changed_cells: changedCells, movements: planned.length,
    recurring: recurringRows.length, payroll: payroll.length, horizon_days: projection.horizon_days,
    opening_balance: projection.balance_entry.balance, balance_day: projection.balance_day,
    final_balance: balance / 100, final_date: projection.days.at(-1).date }
}
