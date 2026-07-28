// Connexion au Google Sheets « CTB - Suivi » (suivi comptable hebdomadaire).
//
// Quand une facture à payer (Bill QuickBooks) est publiée depuis l'ERP —
// reçu de vente publié en type 'bill' ou achat fournisseur type 'bill' —
// une ligne est ajoutée dans la section « PROGRAMMATION DES FACTURES À PAYER »
// de l'onglet Sommaire : Fournisseur | $ | Dû le | Programmation du paiement.
// La programmation du paiement = le jour de paie hebdomadaire (mardi par
// défaut) qui précède strictement la date d'échéance ; si ce jour est déjà
// passé, le prochain jour de paie à venir.
//
// Piloté par l'automation système configurable `sys_ctb_programmation_paiement`
// (spreadsheet, onglet, jour de paiement, compte Google — éditables dans l'UI).
// Toute exécution est tracée via logSystemRun. Ne lève jamais vers l'appelant :
// un échec Sheets ne doit pas invalider une publication QB déjà réussie.
import db from '../db/database.js'
import { getSheetsClient } from '../connectors/google.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'

export const CTB_AUTOMATION_ID = 'sys_ctb_programmation_paiement'

export const CTB_DEFAULT_CONFIG = {
  spreadsheet_id: '13rd8x_xy5AQJemDwE6yWp8ffvkj3bEo7kq3cuogRGyQ', // CTB - Suivi
  sheet_name: 'Sommaire',
  section_header: 'PROGRAMMATION DES FACTURES À PAYER',
  paid_section_header: 'FACTURES PAYÉES CETTE SEMAINE',
  payment_weekday: '2', // ISO : 1=lundi … 7=dimanche. 2 = mardi (jour de paie des factures).
  google_account_email: 'pap@orisha.io',
}

export function getCtbConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(CTB_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...CTB_DEFAULT_CONFIG }
  for (const k of Object.keys(CTB_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

// ── Dates ────────────────────────────────────────────────────────────────────

// 'YYYY-MM-DD' → Date locale (midi pour éviter tout glissement de fuseau).
function parseDateOnly(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''))
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)
}

function isoWeekday(d) { return ((d.getDay() + 6) % 7) + 1 } // 1=lundi … 7=dimanche

export function formatDateFr(d) {
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${d.getFullYear()}`
}

// Jour de paiement programmé : le <weekday> qui précède STRICTEMENT la date
// d'échéance (dû un mardi → le mardi d'avant). Si cette date est déjà passée,
// on retombe sur le prochain <weekday> à partir d'aujourd'hui — c'est le
// prochain moment réel où les paiements sont faits.
export function computeProgrammationDate(dueDateIso, weekday = 2, today = new Date()) {
  const due = parseDateOnly(dueDateIso)
  if (!due) return null
  const wd = Math.min(7, Math.max(1, Number(weekday) || 2))
  const d = new Date(due)
  d.setDate(d.getDate() - 1)
  while (isoWeekday(d) !== wd) d.setDate(d.getDate() - 1)
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  if (d < todayMidnight) {
    d.setTime(todayMidnight.getTime())
    d.setHours(12)
    while (isoWeekday(d) !== wd) d.setDate(d.getDate() + 1)
  }
  return d
}

// ── Localisation du bloc dans la grille ──────────────────────────────────────

const strip = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

// Trouve une section dans la grille (tableau de lignes de cellules) :
// 1) cellule dont le texte commence par le sectionHeader (insensible casse/accents),
// 2) ligne d'en-têtes en dessous contenant « Fournisseur » à la même colonne,
// 3) première ligne de données dont la cellule Fournisseur est vide.
// Retourne { headerRow, dataStartRow, firstEmptyRow, col, rows } (indices 0-based)
// ou null si introuvable. `rows` = lignes présentes, chacune un tableau de
// `width` cellules (texte brut, trimé).
export function locateSection(rows, sectionHeader, width) {
  const needle = strip(sectionHeader)
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r] || []
    for (let c = 0; c < cells.length; c++) {
      if (!strip(cells[c]).startsWith(needle)) continue
      // Ligne d'en-têtes : « Fournisseur » à la colonne c, dans les 3 lignes suivantes.
      for (let hr = r + 1; hr <= Math.min(r + 3, rows.length - 1); hr++) {
        if (strip((rows[hr] || [])[c]) !== 'fournisseur') continue
        const found = []
        let firstEmptyRow = null
        // Balaye vers le bas jusqu'à la première cellule Fournisseur vide.
        for (let dr = hr + 1; dr < rows.length + 200; dr++) {
          const cell = ((rows[dr] || [])[c] ?? '').toString().trim()
          if (!cell) { firstEmptyRow = dr; break }
          const line = []
          for (let w = 0; w < width; w++) line.push(((rows[dr] || [])[c + w] ?? '').toString().trim())
          found.push(line)
        }
        return { headerRow: hr, dataStartRow: hr + 1, firstEmptyRow, col: c, rows: found }
      }
    }
  }
  return null
}

// Bloc « Programmation des factures à payer » (4 colonnes : Fournisseur | $ |
// Dû le | Programmation). Conserve la forme historique { existing: [{vendor,…}] }.
export function locateProgrammationBlock(rows, sectionHeader = CTB_DEFAULT_CONFIG.section_header) {
  const sec = locateSection(rows, sectionHeader, 4)
  if (!sec) return null
  return {
    headerRow: sec.headerRow,
    dataStartRow: sec.dataStartRow,
    firstEmptyRow: sec.firstEmptyRow,
    col: sec.col,
    existing: sec.rows.map(([vendor, amount, due, prog]) => ({ vendor, amount, due, prog })),
  }
}

// A1 : index colonne 0-based → lettre(s)
function colLetter(c) {
  let s = ''
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

// ── Écriture ─────────────────────────────────────────────────────────────────

function getGoogleAccountId(email) {
  const row = db.prepare(
    "SELECT id FROM connector_oauth WHERE connector='google' AND account_email=? AND refresh_token IS NOT NULL"
  ).get(email)
  if (row) return row.id
  const any = db.prepare(
    "SELECT id, account_email FROM connector_oauth WHERE connector='google' AND refresh_token IS NOT NULL ORDER BY created_at LIMIT 1"
  ).get()
  return any?.id || null
}

// Montant : nombre JSON pour le CAD (la cellule reste numérique, formatée par le
// sheet) ; texte « 40,00 USD » pour les devises étrangères, comme les lignes
// existantes du fichier.
function amountCell(total, currency) {
  const n = Math.round((Number(total) || 0) * 100) / 100
  if (!currency || currency === 'CAD') return n
  // toLocaleString fr-CA insère des espaces fines insécables (U+202F) comme
  // séparateurs de milliers — on les normalise en espaces simples pour le sheet.
  const formatted = n.toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .replace(/[\u202f\u00a0]/g, ' ')
  return `${formatted} ${currency}`
}

// Valeur affichée d'une cellule montant → nombre, tolérant aux formats du
// fichier : « 1 046,27 », « 267,85 $ », « (22,68) » (négatif), « 40,00 USD ».
// Retourne null si aucun nombre exploitable.
export function parseAmountCell(text) {
  let s = String(text ?? '').replace(/[\u202f\u00a0\s]/g, '')
  if (!s) return null
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-')
  s = s.replace(/[()−-]/g, '').replace(/[^0-9.,]/g, '')
  if (!s) return null
  // fr-CA : la virgule est le séparateur décimal ; les points restants sont
  // des séparateurs de milliers.
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return negative ? -n : n
}

const sameAmount = (a, b) => a != null && b != null && Math.abs(a - b) < 0.005

// Ajoute une facture à payer dans la section « Programmation des factures à
// payer » du Sommaire. Fire-and-forget : log via logSystemRun, ne lève jamais.
// { vendor, total, currency, dueDate (YYYY-MM-DD|null), source } — source est
// une étiquette libre pour les logs (ex. « sale_receipt abc123 »).
export async function appendFactureAPayer({ vendor, total, currency = 'CAD', dueDate = null, source = '' }) {
  const t0 = Date.now()
  const trigger = { vendor, total, currency, dueDate, source }
  try {
    if (!isSystemAutomationActive(CTB_AUTOMATION_ID)) return { skipped: 'inactive' }
    if (!vendor || !String(vendor).trim()) throw new Error('Fournisseur manquant')
    const cfg = getCtbConfig()

    const accountId = getGoogleAccountId(cfg.google_account_email)
    if (!accountId) throw new Error('Aucun compte Google connecté (page Connecteurs)')
    const sheets = await getSheetsClient(accountId)

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: cfg.spreadsheet_id,
      range: `${cfg.sheet_name}!A1:Z300`,
      valueRenderOption: 'FORMATTED_VALUE',
    })
    const grid = res.data.values || []
    const block = locateProgrammationBlock(grid, cfg.section_header)
    if (!block) throw new Error(`Section « ${cfg.section_header} » introuvable dans l'onglet ${cfg.sheet_name}`)

    const progDate = dueDate ? computeProgrammationDate(dueDate, cfg.payment_weekday) : null
    const dueCell = dueDate ? formatDateFr(parseDateOnly(dueDate)) : '-'
    const progCell = progDate ? formatDateFr(progDate) : '-'

    // Dédup : même fournisseur + même échéance déjà dans le bloc → on ne
    // ré-ajoute pas (re-push après délien QB, achat créé à la main puis publié…).
    const dup = block.existing.find(e => strip(e.vendor) === strip(vendor) && e.due === dueCell)
    if (dup) {
      logSystemRun(CTB_AUTOMATION_ID, {
        status: 'success', duration_ms: Date.now() - t0, triggerData: trigger,
        result: `Déjà présent (ligne existante « ${dup.vendor} | ${dup.amount} | ${dup.due} ») — aucune écriture`,
      })
      return { skipped: 'duplicate' }
    }

    const rowIdx = block.firstEmptyRow ?? grid.length // 0-based
    const range = `${cfg.sheet_name}!${colLetter(block.col)}${rowIdx + 1}:${colLetter(block.col + 3)}${rowIdx + 1}`
    await sheets.spreadsheets.values.update({
      spreadsheetId: cfg.spreadsheet_id,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[String(vendor).trim(), amountCell(total, currency), dueCell, progCell]] },
    })

    logSystemRun(CTB_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0, triggerData: trigger,
      result: `Ajouté en ${range} : ${vendor} | ${amountCell(total, currency)} | ${dueCell} | ${progCell}`,
    })
    return { ok: true, range }
  } catch (e) {
    logSystemRun(CTB_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: trigger, error: e,
    })
    console.error('ctbSheet.appendFactureAPayer:', e.message)
    return { error: e.message }
  }
}

// Choisit la ligne du bloc Programmation correspondant à une facture payée.
// `existing` = [{vendor, amount, due, prog}], `dueCell` au format JJ/MM/AAAA.
// Règles : même fournisseur (insensible casse/accents) ; si plusieurs lignes,
// départage par échéance puis par montant ; ambigu → -1 (on ne retire rien).
export function findProgrammationLineToRemove(existing, { vendor, total = null, dueCell = null }) {
  const candidates = existing.map((e, i) => ({ ...e, i })).filter(e => strip(e.vendor) === strip(vendor))
  if (!candidates.length) return -1
  if (candidates.length === 1) return candidates[0].i
  const t = Number(total)
  const byDue = dueCell ? candidates.filter(e => e.due === dueCell) : []
  if (byDue.length === 1) return byDue[0].i
  if (byDue.length > 1) {
    const both = byDue.filter(e => sameAmount(parseAmountCell(e.amount), t))
    return (both[0] ?? byDue[0]).i
  }
  const byAmount = Number.isFinite(t) ? candidates.filter(e => sameAmount(parseAmountCell(e.amount), t)) : []
  if (byAmount.length === 1) return byAmount[0].i
  return -1
}

async function getSheetIdByName(sheets, spreadsheetId, name) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' })
  const found = (meta.data.sheets || []).find(s => strip(s.properties?.title) === strip(name))
  return found?.properties?.sheetId ?? null
}

// Enregistre une facture payée : ajoute Fournisseur | $ | Déboursé le dans la
// section « Factures payées cette semaine » et retire la ligne correspondante
// du bloc « Programmation des factures à payer » (deleteRange limité aux 4
// colonnes du bloc — les sections voisines ne bougent pas). Fire-and-forget :
// log via logSystemRun, ne lève jamais.
export async function appendFacturePayee({ vendor, total, currency = 'CAD', paidDate = null, dueDate = null, source = '' }) {
  const t0 = Date.now()
  const trigger = { vendor, total, currency, paidDate, dueDate, source, action: 'facture_payee' }
  try {
    if (!isSystemAutomationActive(CTB_AUTOMATION_ID)) return { skipped: 'inactive' }
    if (!vendor || !String(vendor).trim()) throw new Error('Fournisseur manquant')
    const cfg = getCtbConfig()

    const accountId = getGoogleAccountId(cfg.google_account_email)
    if (!accountId) throw new Error('Aucun compte Google connecté (page Connecteurs)')
    const sheets = await getSheetsClient(accountId)

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: cfg.spreadsheet_id,
      range: `${cfg.sheet_name}!A1:Z300`,
      valueRenderOption: 'FORMATTED_VALUE',
    })
    const grid = res.data.values || []
    const actions = []

    // 1) Ajout dans « Factures payées cette semaine » (3 colonnes).
    const paid = locateSection(grid, cfg.paid_section_header, 3)
    if (!paid) throw new Error(`Section « ${cfg.paid_section_header} » introuvable dans l'onglet ${cfg.sheet_name}`)
    const paidCell = paidDate ? formatDateFr(parseDateOnly(paidDate)) : formatDateFr(new Date())
    const amountNum = Math.round((Number(total) || 0) * 100) / 100
    const dupPaid = paid.rows.find(([v, a, d]) =>
      strip(v) === strip(vendor) && d === paidCell && sameAmount(parseAmountCell(a), amountNum))
    if (dupPaid) {
      actions.push('Déjà présent dans Factures payées — aucune écriture')
    } else {
      const rowIdx = paid.firstEmptyRow ?? grid.length
      const range = `${cfg.sheet_name}!${colLetter(paid.col)}${rowIdx + 1}:${colLetter(paid.col + 2)}${rowIdx + 1}`
      await sheets.spreadsheets.values.update({
        spreadsheetId: cfg.spreadsheet_id,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[String(vendor).trim(), amountCell(total, currency), paidCell]] },
      })
      actions.push(`Payée : ajouté en ${range} (${vendor} | ${amountCell(total, currency)} | ${paidCell})`)
    }

    // 2) Retrait de la ligne correspondante du bloc Programmation.
    const block = locateProgrammationBlock(grid, cfg.section_header)
    if (block && block.existing.length) {
      const dueCell = dueDate ? formatDateFr(parseDateOnly(dueDate)) : null
      const idx = findProgrammationLineToRemove(block.existing, { vendor, total: amountNum, dueCell })
      if (idx >= 0) {
        const sheetId = await getSheetIdByName(sheets, cfg.spreadsheet_id, cfg.sheet_name)
        if (sheetId == null) throw new Error(`Onglet ${cfg.sheet_name} introuvable (sheetId)`)
        const rowIdx = block.dataStartRow + idx
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: cfg.spreadsheet_id,
          requestBody: {
            requests: [{
              deleteRange: {
                range: {
                  sheetId,
                  startRowIndex: rowIdx,
                  endRowIndex: rowIdx + 1,
                  startColumnIndex: block.col,
                  endColumnIndex: block.col + 4,
                },
                shiftDimension: 'ROWS',
              },
            }],
          },
        })
        const removed = block.existing[idx]
        actions.push(`Programmation : ligne retirée (${removed.vendor} | ${removed.amount} | ${removed.due})`)
      } else {
        actions.push('Programmation : aucune ligne correspondante (rien retiré)')
      }
    }

    logSystemRun(CTB_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0, triggerData: trigger,
      result: actions.join(' · '),
    })
    return { ok: true, actions }
  } catch (e) {
    logSystemRun(CTB_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: trigger, error: e,
    })
    console.error('ctbSheet.appendFacturePayee:', e.message)
    return { error: e.message }
  }
}

// Diagnostic (bouton dry-run de la page automation) : vérifie l'accès au
// spreadsheet, localise la section et rapporte où la prochaine ligne irait.
export async function diagnoseCtbSheet() {
  const cfg = getCtbConfig()
  const accountId = getGoogleAccountId(cfg.google_account_email)
  if (!accountId) return { summary: '❌ Aucun compte Google connecté (page Connecteurs)' }
  let grid
  try {
    const sheets = await getSheetsClient(accountId)
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: cfg.spreadsheet_id,
      range: `${cfg.sheet_name}!A1:Z300`,
      valueRenderOption: 'FORMATTED_VALUE',
    })
    grid = res.data.values || []
  } catch (e) {
    return {
      summary: `❌ Lecture impossible : ${e.message}`,
      hint: "Vérifier que l'API Google Sheets est activée dans le projet Cloud et que le compte a été reconnecté depuis la page Connecteurs (nouveau scope Sheets).",
      config: cfg,
    }
  }
  const block = locateProgrammationBlock(grid, cfg.section_header)
  if (!block) return { summary: `❌ Section « ${cfg.section_header} » introuvable dans ${cfg.sheet_name}`, config: cfg }
  const nextRow = (block.firstEmptyRow ?? grid.length) + 1
  const paid = locateSection(grid, cfg.paid_section_header, 3)
  const paidSummary = paid
    ? `✅ Factures payées : colonne ${colLetter(paid.col)}, ${paid.rows.length} ligne(s), prochaine : ${colLetter(paid.col)}${(paid.firstEmptyRow ?? grid.length) + 1}`
    : `❌ Section « ${cfg.paid_section_header} » introuvable`
  return {
    summary: `✅ Section trouvée — colonne ${colLetter(block.col)}, en-têtes ligne ${block.headerRow + 1}, ` +
      `${block.existing.length} facture(s) programmée(s), prochaine ligne : ${colLetter(block.col)}${nextRow} · ${paidSummary}`,
    existing: block.existing,
    config: cfg,
  }
}
