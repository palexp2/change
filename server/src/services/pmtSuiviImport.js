// Import de l'onglet « Pmt_Suivi » du fichier CTB - Suivi vers treasury_payments.
//
// C'est le suivi manuel des paiements émis : une ligne par virement / chèque /
// paiement de carte, et la colonne « Montant » coloriée en VERT une fois le
// mouvement passé à la banque. Cet onglet est la seule source qui savait qu'un
// virement Interac avait été émis mais pas encore débité.
//
// Lecture via l'export Drive (xlsx) et non l'API Sheets : l'API Sheets n'est pas
// activée sur le projet Google Cloud, alors que l'export Drive fonctionne — et il
// porte les couleurs de cellule, donc le « vert = passé à la banque ».
//
// Idempotent : chaque ligne a une clé naturelle (date + libellé + montant +
// référence + rang d'occurrence), donc ré-importer met à jour au lieu de doubler.
import xlsx from 'xlsx'
import db from '../db/database.js'
import { getDriveClient } from '../connectors/google.js'
import { autoClearFromBank, createPayment, findAchatForPayment, PAYMENT_METHODS } from './treasuryPayments.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { logSync } from './syncLog.js'

export const PMT_SUIVI_FILE_ID = '13rd8x_xy5AQJemDwE6yWp8ffvkj3bEo7kq3cuogRGyQ' // CTB - Suivi
export const PMT_SUIVI_TAB = 'Pmt_Suivi'
export const PMT_SUIVI_AUTOMATION_ID = 'sys_pmt_suivi_sheet'

export const PMT_SUIVI_DEFAULT_CONFIG = {
  file_id: PMT_SUIVI_FILE_ID,
  sheet_name: PMT_SUIVI_TAB,
  // Vide = le compte Google connecté le plus récemment (comportement historique
  // du bouton de la page Paiements émis).
  google_account_email: '',
  // Plancher d'import : l'historique antérieur est déjà en base.
  since_date: '2026-01-01',
}

export function getPmtSuiviConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(PMT_SUIVI_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...PMT_SUIVI_DEFAULT_CONFIG }
  for (const k of Object.keys(PMT_SUIVI_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

const strip = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

// « 01/08/2026 » / « 1/8/2026 » → « 2026-08-01 » (jour/mois/année, format du fichier).
export function parseFrDate(v) {
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(String(v ?? '').trim())
  if (!m) return null
  const [, d, mo, y] = m
  const dd = Number(d), mm = Number(mo)
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}

// « 5,748.75 » → 5748.75 · « (22.68) » → −22.68 (note de crédit) · « 40 USD » →
// { amount: 40, currency: 'USD' }.
export function parseAmount(v) {
  const raw = String(v ?? '').trim()
  if (!raw) return null
  const currency = /usd/i.test(raw) ? 'USD' : 'CAD'
  const neg = /^\(.*\)$/.test(raw)
  // Espaces de milliers du fichier : normale, insécable, insécable fine.
  const n = Number(raw.replace(/\(|\)/g, '').replace(/usd|cad|\$/gi, '').replace(/[\s\u00a0\u202f]/g, '').replace(/,/g, ''))
  if (!Number.isFinite(n) || n === 0) return null
  return { amount: Math.abs(n), currency, credit: neg }
}

// Le fichier mélange les comptes : un paiement de Visa USD sort du BNC USD, un
// achat payé par Venn sort de Venn. Seuls les mouvements du BNC CAD entrent dans
// la projection — d'où l'importance de ne pas tous les y verser.
export function classifyAccount(label, comment) {
  const t = strip(`${label} ${comment}`)
  if (/venn usd/.test(t)) return 'Venn USD'
  if (/venn cad/.test(t) && /^vir/.test(strip(label))) return 'BNC CAD' // virement Venn → BNC : entrée au BNC
  if (/bnc usd/.test(t)) return 'BNC USD'
  if (/mastercard/.test(t) && /relev|renflou/.test(t)) return 'BNC CAD'
  return 'BNC CAD'
}

// Les virements internes sont notés comme des lignes de paiement (« Vir Venn CAD
// à BNC », « BNC Épargne à BNC Chèque ») : côté BNC chèque, ce sont des ENTRÉES.
// C'est la DESTINATION qui décide : « Vir Venn CAD à BNC » et « BNC Épargne à
// BNC Chèque » alimentent le compte projeté (entrées), « BNC Chèque à BNC
// Épargne » le vide (sortie).
export function classifyDirection(label) {
  const t = strip(label).replace(/\s+/g, ' ')
  const m = /(?:^|\s)(?:a|à)\s+(.+)$/.exec(t)
  if (!m) return 'out'
  const target = m[1].trim()
  if (/epargne|usd|venn|desj|visa|mastercard|marge/.test(target)) return 'out'
  return /bnc/.test(target) ? 'in' : 'out'
}

export function classifyMethod(comment) {
  const t = strip(comment)
  if (/interac/.test(t)) return 'interac'
  if (/code de paiement/.test(t)) return 'code_paiement'
  if (/mastercard|visa|\bmc\b|carte/.test(t)) return 'carte'
  if (/virement|transfert/.test(t)) return 'transfert'
  if (/cheque/.test(t)) return 'cheque'
  return 'autre'
}

// Vert = passé à la banque. Toute teinte franchement verte compte (le fichier
// utilise 00FF00, mais un vert plus doux ne doit pas casser la lecture).
export function isGreen(fill) {
  const rgb = String(fill || '').replace(/^#/, '').slice(-6)
  if (!/^[0-9a-f]{6}$/i.test(rgb)) return false
  const r = parseInt(rgb.slice(0, 2), 16), g = parseInt(rgb.slice(2, 4), 16), b = parseInt(rgb.slice(4, 6), 16)
  return g > 120 && g > r + 40 && g > b + 40
}

// Analyse la grille de l'onglet. Pur : aucune écriture, aucun réseau — c'est ce
// qui est testable.
export function parsePmtSuivi({ rows, fills, since = '2026-01-01' }) {
  const header = rows.findIndex(r => (r || []).some(c => strip(c) === 'date du pmt'))
  if (header < 0) throw new Error('Onglet Pmt_Suivi : ligne d\'en-têtes introuvable (« Date du Pmt »)')
  const cols = {}
  ;(rows[header] || []).forEach((c, i) => {
    const s = strip(c)
    if (s === 'date du jour') cols.entered = i
    else if (s === 'date de la facture') cols.invoiceDate = i
    else if (s === 'date du pmt') cols.date = i
    else if (s.startsWith('# paiement')) cols.reference = i
    else if (s === 'fournisseur') cols.label = i
    else if (s === '# facture') cols.invoice = i
    else if (s === 'montant') cols.amount = i
    else if (s.startsWith('commentaire')) cols.comment = i
  })
  for (const k of ['date', 'label', 'amount']) {
    if (cols[k] == null) throw new Error(`Onglet Pmt_Suivi : colonne « ${k} » introuvable`)
  }
  const out = []
  const seen = new Map()
  for (let r = header + 1; r < rows.length; r++) {
    const row = rows[r] || []
    const label = String(row[cols.label] ?? '').trim()
    const amt = parseAmount(row[cols.amount])
    if (!label || !amt) continue
    const date = parseFrDate(row[cols.date]) || parseFrDate(row[cols.entered])
    if (!date || date < since) continue
    const comment = String(row[cols.comment] ?? '').trim()
    const reference = String(row[cols.reference] ?? '').trim() || null
    const direction = amt.credit
      // Note de crédit dans une colonne de sorties : le sens s'inverse.
      ? (classifyDirection(label) === 'in' ? 'out' : 'in')
      : classifyDirection(label)
    const base = `${date}|${strip(label)}|${amt.amount.toFixed(2)}|${strip(reference)}`
    const n = (seen.get(base) || 0) + 1
    seen.set(base, n)
    out.push({
      payment_date: date,
      direction,
      amount: amt.amount,
      currency: amt.currency,
      account: classifyAccount(label, comment),
      label,
      invoice_date: parseFrDate(row[cols.invoiceDate]) || null,
      invoice_number: String(row[cols.invoice] ?? '').trim() || null,
      reference,
      method: classifyMethod(comment),
      notes: comment || null,
      cleared: isGreen(fills[`${r}:${cols.amount}`]),
      import_key: `pmtsuivi:${base}|${n}`,
      source: 'import',
    })
  }
  return { rows: out, sheet_rows: rows.length - header - 1 }
}

// Lit l'onglet depuis Drive (export xlsx, styles inclus) et retourne
// { rows, raw, fills } :
//   - `rows` : valeurs FORMATÉES (ce que l'œil voit) — « 37,591 », « 4 August » ;
//   - `raw`  : valeurs BRUTES de cellule — 37590.83, 46238 (numéro de série de
//     date Excel). Indispensable dès qu'un chiffre doit être exact au cent
//     près : le fichier « Maintien du solde disponible BNC » affiche ses
//     montants arrondis à l'unité, donc les lire à l'écran fausse le solde ;
//   - `fills` : indexé « ligne:colonne » (0-based) → couleur de fond.
export async function fetchPmtSuiviGrid({ googleAccountEmail = null, fileId = PMT_SUIVI_FILE_ID, tab = PMT_SUIVI_TAB } = {}) {
  const acc = googleAccountEmail
    ? db.prepare("SELECT id FROM connector_oauth WHERE connector='google' AND account_email=?").get(googleAccountEmail)
    : db.prepare("SELECT id FROM connector_oauth WHERE connector='google' ORDER BY updated_at DESC LIMIT 1").get()
  if (!acc) throw new Error('Aucun compte Google connecté (page Connecteurs)')
  const drive = await getDriveClient(acc.id)
  const res = await drive.files.export(
    { fileId, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    { responseType: 'arraybuffer' },
  )
  const wb = xlsx.read(Buffer.from(res.data), { type: 'buffer', cellStyles: true })
  const ws = wb.Sheets[tab]
  if (!ws) throw new Error(`Onglet « ${tab} » introuvable dans le fichier`)
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, blankrows: true, raw: false })
  // Même découpage (header:1 + blankrows) : `raw[r][c]` correspond exactement à
  // `rows[r][c]`, cellule par cellule.
  const raw = xlsx.utils.sheet_to_json(ws, { header: 1, blankrows: true, raw: true })
  const fills = {}
  const range = xlsx.utils.decode_range(ws['!ref'])
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[xlsx.utils.encode_cell({ r, c })]
      const rgb = cell?.s?.fgColor?.rgb || cell?.s?.bgColor?.rgb
      if (rgb) fills[`${r}:${c}`] = rgb
    }
  }
  return { rows, raw, fills }
}

// Import complet. Les lignes déjà importées sont mises à jour (le passage au vert
// dans le fichier coche « passé à la banque » ici), les lignes saisies dans l'ERP
// ne sont jamais touchées (elles n'ont pas d'import_key).
export async function importPmtSuivi({
  since = null, googleAccountEmail = null, userId = null,
  trigger = 'manual', apply = true,
} = {}) {
  const t0 = Date.now()
  const cfg = getPmtSuiviConfig()
  const sinceDate = /^\d{4}-\d{2}-\d{2}$/.test(String(since || '')) ? since : cfg.since_date
  try {
    const result = await runPmtSuiviImport({
      since: sinceDate,
      googleAccountEmail: googleAccountEmail || cfg.google_account_email || null,
      fileId: cfg.file_id,
      tab: cfg.sheet_name,
      userId,
      apply,
    })
    logSync('treasury:pmt-suivi', trigger === 'scheduled' ? 'scheduled' : 'manual',
      { status: 'success', modified: result.created + result.updated, durationMs: Date.now() - t0 })
    logSystemRun(PMT_SUIVI_AUTOMATION_ID, {
      status: 'success',
      result: { summary: `${result.created} ajouté(s) · ${result.updated} mis à jour · ${result.parsed} ligne(s) lue(s)`, ...result },
      duration_ms: Date.now() - t0,
      triggerData: { trigger, apply },
    })
    return result
  } catch (e) {
    logSync('treasury:pmt-suivi', trigger === 'scheduled' ? 'scheduled' : 'manual',
      { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    logSystemRun(PMT_SUIVI_AUTOMATION_ID, { status: 'error', error: e, duration_ms: Date.now() - t0, triggerData: { trigger, apply } })
    throw e
  }
}

// Cœur de l'import (sans journalisation) — `apply: false` compte ce qui serait
// écrit sans rien toucher (bouton « Simuler » de la fiche automation).
async function runPmtSuiviImport({ since, googleAccountEmail, fileId, tab, userId, apply }) {
  const grid = await fetchPmtSuiviGrid({ googleAccountEmail, fileId, tab })
  const { rows, sheet_rows } = parsePmtSuivi({ ...grid, since })
  let created = 0, updated = 0
  const getByKey = db.prepare('SELECT id, cleared_at FROM treasury_payments WHERE import_key = ?')
  const upd = db.prepare(`
    UPDATE treasury_payments SET
      payment_date=?, direction=?, amount=?, currency=?, account=?, label=?,
      invoice_date=?, invoice_number=?, reference=?, method=?, notes=?,
      cleared_at = CASE WHEN ? THEN COALESCE(cleared_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ELSE NULL END,
      cleared_source = CASE WHEN ? THEN COALESCE(cleared_source, 'sheet') ELSE NULL END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), deleted_at = NULL
    WHERE id = ?
  `)
  for (const p of rows) {
    const existing = getByKey.get(p.import_key)
    if (existing) {
      if (apply) {
        upd.run(p.payment_date, p.direction, p.amount, p.currency, p.account, p.label,
          p.invoice_date, p.invoice_number, p.reference, p.method, p.notes, p.cleared ? 1 : 0, p.cleared ? 1 : 0, existing.id)
      }
      updated++
      continue
    }
    if (!apply) { created++; continue }
    createPayment({
      ...p,
      method: PAYMENT_METHODS.includes(p.method) ? p.method : 'autre',
      // Lien à la facture réglée quand il est sans ambiguïté (fournisseur +
      // montant exact) : sans lui, la facture resterait projetée à son échéance
      // EN PLUS du paiement (cas des paiements post-datés).
      achat_id: p.direction === 'out' ? findAchatForPayment(p) : null,
      cleared_at: p.cleared ? new Date().toISOString() : null,
      cleared_source: p.cleared ? 'sheet' : null,
    }, userId)
    created++
  }
  return { created, updated, parsed: rows.length, sheet_rows, since, applied: !!apply }
}

// Cadence de la sync automatique (index.js) — exposée pour que l'interface
// affiche la même valeur que le planificateur.
export const PMT_SUIVI_INTERVAL_MINUTES = 30

// État pour la page Paiements émis : l'automation est-elle active ? quand la
// feuille a-t-elle été relue la dernière fois (bouton OU sync automatique) ?
export function pmtSuiviStatus() {
  const auto = db.prepare('SELECT active FROM automations WHERE id = ? AND system = 1').get(PMT_SUIVI_AUTOMATION_ID)
  const last = db.prepare(`
    SELECT status, result, error, created_at FROM automation_logs
    WHERE automation_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(PMT_SUIVI_AUTOMATION_ID) || null
  let result = null
  if (last?.result) { try { result = JSON.parse(last.result) } catch { result = { summary: last.result } } }
  return {
    active: !!(auto && auto.active),
    interval_minutes: PMT_SUIVI_INTERVAL_MINUTES,
    last_run: last
      ? { status: last.status, executed_at: last.created_at, error: last.error, ...((result && typeof result === 'object') ? result : {}) }
      : null,
  }
}

// Sync automatique (index.js, toutes les 30 min) — coupe-circuit si
// l'automation est désactivée depuis la page Automations.
export async function scheduledPmtSuiviImport() {
  if (!isSystemAutomationActive(PMT_SUIVI_AUTOMATION_ID)) return null
  const result = await importPmtSuivi({ trigger: 'scheduled', apply: true })
  // Même enchaînement que le bouton : une ligne fraîchement importée peut déjà
  // être au relevé bancaire.
  try { autoClearFromBank({ accountName: 'BNC CAD' }) } catch {}
  return result
}
