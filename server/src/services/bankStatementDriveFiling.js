// Relevés mensuels déposés à la main → rangés au Drive (Charles, 2026-10-03).
//
// On dépose ses fichiers dans la fenêtre « Déposer » du rapprochement ; quand la
// lecture reconnaît un RELEVÉ MENSUEL COMPLET d'un compte (PDF, soldes vérifiés,
// fin de période au jour de clôture du compte), Boréal le range dans le dossier
// Drive du compte (sous-dossier d'exercice avril → mars) sous le nom que porte
// déjà ce dossier (BNC_CAD_2026-09-30.pdf, CARTCRED_CREDCARD_4807_20261015.pdf…).
//
// Jamais deux fois : un fichier identique (empreinte md5) ou un relevé de la même
// date déjà présent dans le dossier suffit — le dépôt y est alors relié, rien
// n'est envoyé. Les exports CSV, captures et relevés partiels ne partent pas.
//
// Le même inventaire alimente la liste « relevés du mois » du travail récurrent
// d'Antoine, qui se coche seule quand tous les comptes ont leur relevé.
import fs from 'fs'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { Readable } from 'stream'
import db from '../db/database.js'
import { getDriveClient } from '../connectors/google.js'
import { STATEMENT_FOLDERS, DRIVE_WATCH_AUTOMATION_ID } from './bankStatementDriveWatch.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'

export const DRIVE_FILING_AUTOMATION_ID = 'sys_bank_statement_drive_filing'
export const STATEMENTS_TASK_ID = 'rt-al-releves-bancaires-drive'

// close : jour de clôture du relevé — 'eom' fin de mois, 'early' 1er-3 du mois
// suivant (Visa), 'mid' vers le 15 du mois suivant (MasterCard).
export const STATEMENT_NAMING = {
  'BNC CAD': { short: 'BNC CAD', close: 'eom', file: (d) => `BNC_CAD_${d}.pdf` },
  'BNC USD': { short: 'BNC USD', close: 'eom', file: (d) => `BNC_USD_${d}.pdf` },
  'BNC Épargne': { short: 'BNC Épargne', close: 'eom', file: (d) => `BNC_Epargne_${d}.pdf` },
  'MasterCard BNC': { short: 'MasterCard', close: 'mid', file: (d) => `CARTCRED_CREDCARD_4807_${d.replace(/-/g, '')}.pdf` },
  'Desjardins CAD': { short: 'Desj. CAD', close: 'eom', file: (d) => `Desj_CAD_${d}.pdf` },
  'Desjardins USD': { short: 'Desj. USD', close: 'eom', file: (d) => `Desj_USD_${d}.pdf` },
  'Marge Desjardins': { short: 'Marge Desj.', close: 'eom', file: (d) => `Marge_Desj_${d}.pdf` },
  'VISA Desjardins CAD': { short: 'Visa CAD', close: 'early', file: (d) => `Visa_CAD_${d}.pdf` },
  'VISA Desjardins USD': { short: 'Visa USD', close: 'early', file: (d) => `Visa_USD_${d}.pdf` },
  'Venn CAD': { short: 'Venn CAD', close: 'eom', sub: 'Venn CAD', file: (d) => `Venn Main CAD Statement - ${d.slice(0, 7)}.pdf` },
  'Venn USD': { short: 'Venn USD', close: 'eom', sub: 'Venn USD', file: (d) => `Venn Main USD Statement - ${d.slice(0, 7)}.pdf` },
}

// ─── Identité : le numéro imprimé sur le relevé ───────────────────────────────
//
// Lue dans le texte du PDF (sans modèle). Un relevé déposé ou rangé au Drive
// sous un compte dont il ne porte pas le numéro est refusé — vécu : le compte
// « Avantage entreprise » Desjardins (…0101247-ET1, CAD, 0 $) rangé trois mois
// sous Desjardins USD (…0807914-EOP).
export const STATEMENT_IDENTITY = {
  'BNC CAD': /0310224|03-102-24/,
  'BNC USD': /0016865|00-168-65/,
  'BNC Épargne': /7026521|70-265-21/,
  'MasterCard BNC': /114807/,
  'Desjardins CAD': /0101247-EOP|Folio[\s\S]{0,120}101247[\s\S]*EPARGNE AVEC OPERATIONS/,
  'Desjardins USD': /0807914/,
  'Marge Desjardins': /0101247-MC ?2/,
  'VISA Desjardins CAD': /4530 ?92/,
  'VISA Desjardins USD': /4891|6174/,
  'Venn CAD': /500010033379/,
  'Venn USD': /8335267190/,
}
const NOT_TRACKED = [{ re: /0101247-ET ?1|AVANTAGE ENTREPRISE/i, label: 'Avantage entreprise Desjardins (ET1)' }]

/** ok : le relevé porte le numéro du compte · wrong : celui d'un autre (`owner`) · unknown : texte illisible ou sans numéro. */
export function identifyStatement(text, accountName) {
  const t = String(text || '').replace(/\s+/g, ' ')
  if (t.length < 100) return { verdict: 'unknown' }
  const matches = Object.keys(STATEMENT_IDENTITY).filter((n) => STATEMENT_IDENTITY[n].test(t))
  if (matches.includes(accountName)) return { verdict: 'ok' }
  if (matches.length === 1) return { verdict: 'wrong', owner: matches[0], label: STATEMENT_NAMING[matches[0]]?.short || matches[0] }
  const other = NOT_TRACKED.find((x) => x.re.test(t))
  if (other) return { verdict: 'wrong', owner: null, label: other.label }
  if (matches.length) return { verdict: 'wrong', owner: null, label: matches.join(', ') }
  return { verdict: 'unknown' }
}

function pdfText(file) {
  try { return execFileSync('pdftotext', ['-layout', file, '-'], { timeout: 30000, maxBuffer: 20 * 1024 * 1024 }).toString() } catch { return '' }
}

// ─── Dates ────────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0')
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate() // m : 1-12
function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000)
function nextMonth(month) {
  const [y, m] = month.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`
}

/** Date lue dans un nom de fichier (« 2026-09 » seul = fin de ce mois). */
export function dateFromFileName(name) {
  const m = String(name).match(/(20\d{2})[-_]?(\d{2})(?:[-_]?(\d{2}))?(?!\d)/)
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2])
  if (mo < 1 || mo > 12) return null
  return `${m[1]}-${m[2]}-${m[3] || pad(lastDay(y, mo))}`
}

/** Fenêtre où tombe la clôture du relevé du mois `month` (YYYY-MM). */
export function closeWindow(close, month) {
  const nx = nextMonth(month)
  if (close === 'early') return { from: `${nx}-01`, to: `${nx}-08` }
  if (close === 'mid') return { from: `${nx}-10`, to: `${nx}-22` }
  return { from: `${month}-25`, to: addDays(`${nx}-01`, 4) }
}

/** La fin de période est-elle un jour de clôture normal pour ce compte ? */
export function isClosingDay(close, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return false
  const [y, m, d] = day.split('-').map(Number)
  if (close === 'early') return d >= 1 && d <= 4
  if (close === 'mid') return d >= 13 && d <= 19
  return d === lastDay(y, m)
}

/** Exercice avril → mars (« 2026-2027 ») ; une clôture des premiers jours d'avril reste sur mars. */
export function fiscalFolderName(day) {
  const ref = addDays(day, -5)
  const y = Number(ref.slice(0, 4)); const m = Number(ref.slice(5, 7))
  const start = m >= 4 ? y : y - 1
  return `${start}-${start + 1}`
}

/**
 * Un dépôt est-il un relevé mensuel complet ? PDF lu, soldes d'ouverture et de
 * clôture imprimés et vérifiés, fin de période au jour de clôture du compte.
 * Un export CSV, une capture ou un relevé « du 3 au 2 » imprimé en cours de mois
 * n'en est pas un.
 */
export function isMonthlyStatement(up, close) {
  if (!up || !close) return false
  if (!['pdf_texte', 'pdf_image'].includes(up.source)) return false
  if (up.document_kind === 'facture') return false
  if (!['pret', 'importe'].includes(up.status)) return false
  if (up.opening_balance == null || up.closing_balance == null || !up.balance_ok) return false
  if (!isClosingDay(close, up.period_end)) return false
  if (up.period_start) {
    const span = daysBetween(up.period_start, up.period_end)
    if (span < 14 || span > 45) return false
  }
  return true
}

// ─── Drive ────────────────────────────────────────────────────────────────────

const WRITER_ORDER = ['michel@orisha.io', 'charles@orisha.io', 'guillaume@orisha.io', 'martin@orisha.io']

function googleAccounts() {
  const rows = db.prepare("SELECT id, account_email FROM connector_oauth WHERE connector='google' ORDER BY updated_at DESC").all()
  const rank = (r) => { const i = WRITER_ORDER.indexOf(r.account_email); return i < 0 ? 99 : i }
  return rows.sort((a, b) => rank(a) - rank(b))
}

// Un compte qui n'a que la lecture refuse l'écriture : on passe au suivant.
async function withWritableDrive(fn) {
  let last
  for (const acc of googleAccounts()) {
    try {
      return await fn(await getDriveClient(acc.id))
    } catch (e) {
      last = e
      if (!/insufficient|permission|forbidden|invalid_grant/i.test(e.message)) throw e
    }
  }
  throw last || new Error('Aucun compte Google connecté (page Connecteurs)')
}

async function anyDrive() {
  const acc = googleAccounts()[0]
  if (!acc) throw new Error('Aucun compte Google connecté (page Connecteurs)')
  return getDriveClient(acc.id)
}

const FOLDER_MIME = 'application/vnd.google-apps.folder'

async function listChildren(d, folderId) {
  const out = []
  let pageToken
  do {
    const r = await d.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType,md5Checksum,createdTime)', pageSize: 200, pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    })
    out.push(...(r.data.files || []))
    pageToken = r.data.nextPageToken
  } while (pageToken)
  return out
}

async function listPdfsDeep(d, folderId, depth = 3) {
  const out = []
  for (const f of await listChildren(d, folderId)) {
    if (f.mimeType === FOLDER_MIME) { if (depth > 0) out.push(...await listPdfsDeep(d, f.id, depth - 1)) } else if (f.mimeType === 'application/pdf') out.push(f)
  }
  return out
}

// Inventaire Drive par compte, gardé 10 min (le dossier ne change pas souvent et
// la liste des travaux se recharge souvent).
const cache = new Map()
const CACHE_MS = 10 * 60 * 1000
async function accountFiles(d, accountName) {
  const hit = cache.get(accountName)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.files
  const cfg = STATEMENT_FOLDERS[accountName]
  const files = (await listPdfsDeep(d, cfg.folder)).filter((f) => !cfg.name || cfg.name.test(f.name))
  cache.set(accountName, { at: Date.now(), files })
  return files
}
export function invalidateDriveCache(accountName = null) {
  if (accountName) cache.delete(accountName); else cache.clear()
}

async function findOrCreateFolder(d, parentId, name) {
  const hit = (await listChildren(d, parentId)).find((f) => f.mimeType === FOLDER_MIME && f.name.trim() === name)
  if (hit) return hit.id
  const r = await d.files.create({
    requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] }, fields: 'id', supportsAllDrives: true,
  })
  return r.data.id
}

// Même relevé déjà au Drive : même fichier, ou même clôture (à 3 jours près ;
// au mois près quand le nom ne porte que le mois).
export function findExisting(files, { md5, periodEnd }) {
  return files.find((f) => md5 && f.md5Checksum === md5)
    || files.find((f) => {
      const day = dateFromFileName(f.name)
      return day && Math.abs(daysBetween(day, periodEnd)) <= 3
    })
    || null
}

// ─── Classement d'un dépôt ────────────────────────────────────────────────────

// Le solde de clôture désigne le compte : sur un folio Desjardins, la marge et le
// compte courant sont indiscernables autrement. On ne corrige que si le compte
// lu contredit son propre solde connu ET qu'un seul autre compte y correspond.
function knownBalance(accountId, day) {
  return db.prepare(`SELECT balance FROM bank_transactions WHERE account_id=? AND txn_date<=? AND balance IS NOT NULL
    AND deleted_at IS NULL ORDER BY txn_date DESC, rowid DESC LIMIT 1`).get(accountId, day)?.balance ?? null
}
const sameAmount = (a, b) => a != null && b != null && Math.abs(Math.abs(a) - Math.abs(b)) <= 0.01
export function accountByClosingBalance(up) {
  if (up.closing_balance == null || !up.period_end || Math.abs(up.closing_balance) < 0.01) return null
  if (up.account_id && sameAmount(knownBalance(up.account_id, up.period_end), up.closing_balance)) return null
  const matches = db.prepare('SELECT id, name, currency FROM bank_accounts WHERE deleted_at IS NULL').all()
    .filter((a) => STATEMENT_NAMING[a.name] && (!up.currency || !a.currency || a.currency.toUpperCase() === String(up.currency).toUpperCase()))
    .filter((a) => sameAmount(knownBalance(a.id, up.period_end), up.closing_balance))
  return matches.length === 1 ? matches[0] : null
}

const touch = (id, patch) => {
  const keys = Object.keys(patch)
  db.prepare(`UPDATE bank_statement_uploads SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`)
    .run(...keys.map((k) => patch[k]), id)
}

let chain = Promise.resolve()
/** Range au Drive le dépôt `id` s'il est un relevé mensuel complet. Sérialisé : deux dépôts du même relevé ne partent pas deux fois. */
export function fileUploadToDrive(id, opts = {}) {
  const run = chain.then(() => fileOne(id, opts))
  chain = run.catch(() => {})
  return run
}

async function fileOne(id, { force = false, trigger = 'dépôt de relevé', recheck = false } = {}) {
  if (!force && !isSystemAutomationActive(DRIVE_FILING_AUTOMATION_ID)) return null
  const load = () => db.prepare('SELECT u.*, b.name AS account_name FROM bank_statement_uploads u LEFT JOIN bank_accounts b ON b.id=u.account_id WHERE u.id=?').get(id)
  let up = load()
  if (!up) return null
  // Relié à un fichier du Drive qui s'avère d'un autre compte : le lien saute, on reclasse.
  if (up.drive_filing === 'deja' && recheck && up.account_name && STATEMENT_FOLDERS[up.account_name]) {
    const d = await anyDrive()
    const f = (await accountFiles(d, up.account_name)).find((x) => x.id === up.drive_file_id)
    if (f && (await driveFileIdentity(d, f, up.account_name)).verdict === 'wrong') {
      touch(id, { drive_file_id: null, drive_filing: null, drive_file_name: null })
      up = load()
    }
  }
  if (up.drive_file_id) return null
  const owner = accountByClosingBalance(up)
  if (owner && owner.id !== up.account_id) {
    const { setUploadAccount } = await import('./bankStatementImport.js')
    setUploadAccount(id, owner.id)
    up = load()
  }
  const ident = up.account_name ? identifyStatement(pdfText(up.file_path), up.account_name) : { verdict: 'unknown' }
  if (ident.verdict === 'wrong' && ident.owner) {
    const target = db.prepare('SELECT id FROM bank_accounts WHERE name=? AND deleted_at IS NULL').get(ident.owner)
    if (target) {
      const { setUploadAccount } = await import('./bankStatementImport.js')
      setUploadAccount(id, target.id)
      up = load()
    }
  } else if (ident.verdict === 'wrong') {
    touch(id, { drive_filing: 'autre_compte', error: `Relevé du compte ${ident.label}, pas de « ${up.account_name} » — non rangé au Drive` })
    logSystemRun(DRIVE_FILING_AUTOMATION_ID, {
      status: 'error', error: `${up.original_name} : compte ${ident.label}, pas ${up.account_name}`,
      result: { account: up.account_name, file: up.original_name }, triggerData: { trigger, upload_id: id },
    })
    return { status: 'autre_compte', label: ident.label }
  }
  const spec = STATEMENT_NAMING[up.account_name]
  if (!spec || !STATEMENT_FOLDERS[up.account_name] || !isMonthlyStatement(up, spec.close)) return null

  const t0 = Date.now()
  const fileName = spec.file(up.period_end)
  const base = { account: up.account_name, file: up.original_name, period_end: up.period_end }
  try {
    const md5 = crypto.createHash('md5').update(fs.readFileSync(up.file_path)).digest('hex')
    invalidateDriveCache(up.account_name)
    // Un fichier de même date mais d'un AUTRE compte (mal rangé à la main) n'est pas « déjà au Drive ».
    const d = await anyDrive()
    const files = []
    for (const f of await accountFiles(d, up.account_name)) {
      if (f.md5Checksum === md5) { files.push(f); continue }
      const day = dateFromFileName(f.name)
      if (!day || Math.abs(daysBetween(day, up.period_end)) > 3) continue
      if ((await driveFileIdentity(d, f, up.account_name)).verdict !== 'wrong') files.push(f)
    }
    const existing = findExisting(files, { md5, periodEnd: up.period_end })
    // Même date mais autre relevé (soldes différents) : c'est le compte qui est faux, on ne relie pas.
    const clash = existing && db.prepare(`SELECT 1 FROM bank_statement_uploads WHERE drive_file_id=? AND id<>?
      AND closing_balance IS NOT NULL AND ABS(closing_balance - ?) > 0.01`).get(existing.id, id, up.closing_balance)
    if (clash) throw new Error(`Un autre relevé (solde différent) est déjà au Drive sous ${existing.name} — vérifier le compte`)
    if (existing) {
      touch(id, { drive_file_id: existing.id, drive_filing: 'deja', drive_file_name: existing.name })
      logSystemRun(DRIVE_FILING_AUTOMATION_ID, {
        status: 'success', duration_ms: Date.now() - t0,
        result: { summary: `${spec.short} : déjà au Drive (${existing.name})`, ...base, drive_file: existing.name },
        triggerData: { trigger, upload_id: id },
      })
      afterFiling(up.account_name).catch(() => {})
      return { status: 'deja', name: existing.name }
    }

    const created = await withWritableDrive(async (d) => {
      let parent = await findOrCreateFolder(d, STATEMENT_FOLDERS[up.account_name].folder, fiscalFolderName(up.period_end))
      if (spec.sub) parent = await findOrCreateFolder(d, parent, spec.sub)
      const r = await d.files.create({
        requestBody: { name: fileName, parents: [parent] },
        media: { mimeType: 'application/pdf', body: Readable.from(fs.readFileSync(up.file_path)) },
        fields: 'id,name', supportsAllDrives: true,
      })
      return r.data
    })
    touch(id, { drive_file_id: created.id, drive_filing: 'depose', drive_file_name: created.name })
    invalidateDriveCache(up.account_name)
    logSystemRun(DRIVE_FILING_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0,
      result: { summary: `${spec.short} : ${created.name} → ${fiscalFolderName(up.period_end)}${spec.sub ? ` / ${spec.sub}` : ''}`, ...base, drive_file: created.name },
      triggerData: { trigger, upload_id: id },
    })
    afterFiling(up.account_name, id).catch((e) => console.error('driveFiling.after:', e.message))
    return { status: 'depose', name: created.name }
  } catch (e) {
    touch(id, { drive_filing: 'erreur' })
    logSystemRun(DRIVE_FILING_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, error: e, result: base, triggerData: { trigger, upload_id: id },
    })
    return { status: 'erreur', error: e.message }
  }
}

// Après un classement : la liste du mois se met à jour (et se coche si complète),
// et le relevé nouvellement au Drive part au robot QuickBooks comme ceux que la
// veille du matin y trouve.
async function afterFiling(accountName, uploadId = null) {
  await syncStatementsTask()
  if (!uploadId || !isSystemAutomationActive(DRIVE_WATCH_AUTOMATION_ID)) return
  const account = db.prepare('SELECT id, qb_account_id FROM bank_accounts WHERE name=? AND deleted_at IS NULL').get(accountName)
  if (!account?.qb_account_id) return
  const { reconcileAccount } = await import('./qbReconcileRobot.js')
  const { recordRun } = await import('./bankStatementDriveWatch.js')
  const out = await reconcileAccount(account.id, { requireOfficial: true })
  if (!out.skipped) await recordRun(account.id, out)
}

// ─── Liste du mois ────────────────────────────────────────────────────────────

/**
 * Pour le mois `month` (YYYY-MM, relevés couvrant ce mois) : un élément par
 * compte, `done` quand son relevé est au Drive. Le Drive fait foi ; un dépôt
 * relié au Drive dont la clôture tombe dans la fenêtre compte aussi (nom de
 * fichier parfois décalé d'un mois dans le dossier).
 */
export async function statementChecklist(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw new Error('Mois attendu (AAAA-MM)')
  const d = await anyDrive()
  const out = []
  for (const [accountName, spec] of Object.entries(STATEMENT_NAMING)) {
    const account = db.prepare('SELECT id FROM bank_accounts WHERE name=? AND deleted_at IS NULL').get(accountName)
    if (!account) continue
    const w = closeWindow(spec.close, month)
    const item = { account: accountName, label: spec.short, expected_by: w.to, done: false, file: null }
    try {
      // Plusieurs fichiers pour la même date (un mal rangé + le bon) : le bon l'emporte.
      const inWindow = (await accountFiles(d, accountName)).filter((x) => { const day = dateFromFileName(x.name); return day && day >= w.from && day <= w.to })
      let f = null; let wrong = null
      for (const x of inWindow) {
        const ident = await driveFileIdentity(d, x, accountName)
        if (ident.verdict !== 'wrong') { f = x; break }
        wrong = wrong || { file: x.name, wrong: ident.label }
      }
      if (f) Object.assign(item, { done: true, file: f.name })
      else if (wrong) Object.assign(item, wrong)
      else {
        const up = db.prepare(`SELECT drive_file_name, original_name FROM bank_statement_uploads
          WHERE account_id=? AND drive_file_id IS NOT NULL AND period_end BETWEEN ? AND ? LIMIT 1`).get(account.id, w.from, w.to)
        if (up) Object.assign(item, { done: true, file: up.drive_file_name || up.original_name })
      }
    } catch (e) {
      item.error = e.message
    }
    out.push(item)
  }
  return out
}

// Verdict d'identité d'un fichier du Drive, gardé par id + empreinte (un fichier remplacé est relu).
const identityCache = new Map()
async function driveFileIdentity(d, f, accountName) {
  const key = `${f.id}:${f.md5Checksum || ''}:${accountName}`
  if (identityCache.has(key)) return identityCache.get(key)
  const tmp = path.join(os.tmpdir(), `releve-${f.id}.pdf`)
  let res = { verdict: 'unknown' }
  try {
    const r = await d.files.get({ fileId: f.id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' })
    fs.writeFileSync(tmp, Buffer.from(r.data))
    res = identifyStatement(pdfText(tmp), accountName)
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* rien */ }
  }
  identityCache.set(key, res)
  return res
}

/** Coche le travail « relevés au Drive » des mois dont tous les relevés sont arrivés (mois courant de la tâche + rattrapage). */
export async function syncStatementsTask() {
  const { listRecurringTasks, completeFromAutomation } = await import('./recurringWork.js')
  const task = listRecurringTasks({ owner: 'AL' }).find((t) => t.id === STATEMENTS_TASK_ID)
  if (!task) return []
  const months = [...(task.done ? [] : [task.period_key]), ...(task.catch_up || []).map((p) => p.period_key)]
  const done = []
  for (const month of months) {
    const list = await statementChecklist(month)
    if (list.length && list.every((x) => x.done)) {
      completeFromAutomation(STATEMENTS_TASK_ID, { periodKey: month, note: `${list.length} relevés au Drive` })
      done.push(month)
    }
  }
  return done
}

/** Dépôts des 7 derniers jours pas encore passés au Drive (compte corrigé après coup, lecture terminée hors route…). */
export async function fileRecentUploads(trigger = 'balayage') {
  pruneForeignHints()
  const ids = db.prepare(`SELECT id FROM bank_statement_uploads WHERE
    (drive_filing='deja' OR (drive_file_id IS NULL AND (drive_filing IS NULL OR drive_filing='erreur'))) AND source IN ('pdf_texte','pdf_image')
    AND status IN ('pret','importe') AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')`).all().map((r) => r.id)
  const out = []
  for (const id of ids) { const r = await fileUploadToDrive(id, { trigger, recheck: true }); if (r) out.push({ id, ...r }) }
  return out
}

/** Retire des indices appris d'un compte ceux qui désignent un AUTRE compte (ex. « …0101247-ET1 » appris sur la Visa USD). */
export function pruneForeignHints() {
  const rows = db.prepare("SELECT id, name, statement_hints FROM bank_accounts WHERE deleted_at IS NULL AND statement_hints IS NOT NULL AND statement_hints <> ''").all()
  let n = 0
  for (const a of rows) {
    const hints = a.statement_hints.split(/[,;\n]/).map((h) => h.trim()).filter(Boolean)
    const keep = hints.filter((h) => {
      if (NOT_TRACKED.some((x) => x.re.test(h))) return false
      return !Object.entries(STATEMENT_IDENTITY).some(([name, re]) => name !== a.name && re.test(h))
    })
    if (keep.length !== hints.length) {
      db.prepare('UPDATE bank_accounts SET statement_hints=? WHERE id=?').run(keep.join(', '), a.id)
      n += hints.length - keep.length
    }
  }
  return n
}
