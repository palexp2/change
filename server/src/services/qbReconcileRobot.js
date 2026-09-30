/* global document, window, getComputedStyle, CSS */
// Robot « Rapprocher » QuickBooks.
//
// L'API Intuit n'offre aucun point d'entrée pour rapprocher ou cocher une
// écriture : la seule voie est l'écran « Rapprocher » de QuickBooks Online,
// piloté avec la session ouverte de Charles (reçue par le pont de session).
//
// Deux passages :
//  - `openReconcile` (tranche 1, LECTURE SEULE) : ouvre l'écran d'un compte, le
//    capture et lit ce qu'il affiche. Aucun clic qui modifie QuickBooks.
//  - `reconcileAccount` (tranche 2) : commence (ou reprend) le rapprochement à
//    la date du dernier solde imprimé du relevé, coche les écritures dont la
//    ligne Boréal est verte, lit la « Différence » et ENREGISTRE POUR PLUS TARD.
//
// Décision de Charles, 2026-09-26 : « Si c'est 0 $, il ne clique pas sur
// Terminer parce que ça ferme le mois — c'est moi qui vais le faire. » Le robot
// ne clique JAMAIS « Terminer » (`guardedClick` le refuse quel que soit
// l'appelant), ne crée ni ne modifie aucune écriture.
//
// Relevé officiel (2026-09-26, Charles : « c'est possible de faire faire ça par
// le robot aussi ? ») : quand un relevé déposé dans Boréal porte un solde de
// clôture vérifié, il fait foi. Le robot corrige alors la date et le solde de
// fin dans « Modifier les renseignements », coche ce qui est au relevé et
// DÉCOCHE ce qui n'y est pas. Sans relevé officiel : lignes vertes, jamais de
// décoche.
//
// Depuis le serveur (autre IP que le poste de Charles), Intuit peut exiger une
// revérification : on ne la contourne pas, on rend l'écran rencontré.
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import db from '../db/database.js'
import { launchContext } from './scrapers/browser.js'
import { getBridgeSession, saveBridgeSession } from './scrapers/bridgeSessions.js'
import { QB_APP_HOST, getQbRealmIdSync } from '../connectors/quickbooks.js'
import { logSync } from './syncLog.js'
import { listQbBankAccounts, fetchQbLedgerForReconcile } from './bankQbLink.js'
import { uploadsPath } from '../config/uploads.js'
import { summarizeAccount } from './bankReconcileSummary.js'
import { shiftDate } from '../utils/datetime.js'
import {
  parseMoney, parseScreenDate, detectDateOrder, formatDateFor, endingBalanceFor, buildExpected, matchScreen,
} from './qbReconcileMatch.js'

const MODULE = 'bank:qb-reconcile-robot'
export const RECONCILE_AUTOMATION_ID = 'sys_bank_qb_reconcile_robot'
const SESSION_KEY = 'quickbooks'
export const CAPTURE_DIR = uploadsPath('qb-reconcile')
const NEEDS_SESSION_HINT = "Ouvrir QuickBooks dans Chrome, puis « Envoyer mes sessions » depuis le module Orisha"
const GRACE_DAYS = 4

// Jamais, quel que soit l'appelant : « Terminer » ferme le mois.
const NEVER = /terminer|finish|fermer sans|close without/i
// Libellés d'actions qui écrivent dans QuickBooks — FR et EN. Refusés sauf
// autorisation explicite de l'appelant (`allow`).
const FORBIDDEN = /enregistrer|save|commencer|start|rapprocher maintenant|reconcile now|modifier|edit|annuler|undo|supprimer|delete/i

let running = false
export const isRobotRunning = () => running

const sleep = ms => new Promise(r => setTimeout(r, ms))

function slug(s) {
  return String(s || 'compte').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'compte'
}

// Témoins intuit.com encore valides (expires -1 = témoin de session : on garde).
function liveCookies(state) {
  const now = Date.now() / 1000
  return (state?.cookies || []).filter(c => c.domain.includes('intuit.com') && (c.expires <= 0 || c.expires > now))
}

// Quel écran QuickBooks a-t-il rendu ?
export function classify(url, text) {
  const u = String(url || '')
  const t = String(text || '')
  const verify = /v[ée]rifiez votre identit|verify (it'?s you|your identity)|confirm (it'?s you|your identity)|code de v[ée]rification|verification code|entrez le code|enter (the )?code/i
  if (/accounts\.intuit\.com|\/signin|\/login|sign-in/i.test(u)) return verify.test(t) ? 'verification' : 'login'
  if (verify.test(t.slice(0, 3000))) return 'verification'
  if (/choisir une entreprise|choose a company|select a company|s[ée]lectionner une entreprise/i.test(t.slice(0, 3000))) return 'company_picker'
  if (/\/app\/reconcile/i.test(u) && /rapproch|reconcil/i.test(t)) return 'reconcile'
  return 'unknown'
}

// Valeur affichée juste après un libellé (même ligne après « : » ou ligne suivante).
function valueAfter(lines, labels, pattern) {
  for (let i = 0; i < lines.length; i++) {
    if (!labels.some(l => l.test(lines[i]))) continue
    const sameLine = lines[i].split(/[:：]/).slice(1).join(':').trim()
    for (const candidate of [sameLine, lines[i + 1], lines[i + 2]]) {
      const m = String(candidate || '').match(pattern)
      if (m) return m[0].trim()
    }
  }
  return null
}

const DATE_RX = /\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}\s+\p{L}+\.?\s+\d{4}|\p{L}+\.?\s+\d{1,2},?\s+\d{4}/u
const MONEY_RX = /-?\(?\s*-?\$?\s*\d[\d\s\u00a0,.]*\d(?:\s*\$)?\)?|-?\$?\s*\d(?:\s*\$)?/

export function readScreen(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean)
  return {
    lastStatementEndingDate: valueAfter(lines, [/dernier relev[ée]/i, /last statement ending date/i, /date de fin du dernier/i], DATE_RX),
    lastEndingBalance: valueAfter(lines, [/solde de cl[ôo]ture/i, /solde de fin/i, /ending balance/i], MONEY_RX),
    beginningBalance: valueAfter(lines, [/solde d'ouverture/i, /solde de d[ée]but/i, /beginning balance/i, /opening balance/i], MONEY_RX),
  }
}

// Le compte affiché dans le sélecteur de compte. Toujours `:visible` : QuickBooks
// garde des champs cachés, et les leurres anti-robot vivent là (vécu sur Amazon).
async function selectedAccountName(page) {
  const selectors = [
    'input[aria-label*="ompte"]:visible',
    'input[aria-label*="ccount"]:visible',
    '[role="combobox"]:visible',
    'select:visible',
  ]
  for (const sel of selectors) {
    const el = page.locator(sel).first()
    if (!await el.count().catch(() => 0)) continue
    const v = await el.evaluate(n => (
      n.tagName === 'SELECT' ? n.options[n.selectedIndex]?.text
        : n.tagName === 'INPUT' ? n.value : n.textContent
    )).catch(() => null)
    if (v && String(v).trim()) return String(v).trim()
  }
  return null
}

// Tout clic passe par ici. « Terminer » / « Fermer sans enregistrer » : refusé,
// toujours. Les autres actions d'écriture : refusées sauf si l'appelant les
// autorise nommément (`allow`, ex. /commencer|start/ pour « Commencer »).
async function guardedClick(locator, allow = null) {
  const { label, finishMenu } = await locator.evaluate(n => ({
    label: `${n.textContent || ''} ${n.getAttribute('aria-label') || ''} ${n.value || ''}`,
    // Seule exception à NEVER : la flèche vide « Terminer menu » du bouton
    // partagé, qui ne fait qu'ouvrir le menu (« Enregistrer pour plus tard »).
    finishMenu: n.tagName === 'BUTTON' && n.getAttribute('aria-haspopup') === 'menu' && !(n.textContent || '').trim()
      && /^\s*(terminer|finish)(\s+maintenant|\s+now)?\s+menu\s*$/i.test(n.getAttribute('aria-label') || ''),
  })).catch(() => ({ label: '', finishMenu: false }))
  if (finishMenu) { await locator.click(); return }
  if (NEVER.test(label)) throw new Error(`Clic refusé (Terminer) : « ${label.trim().slice(0, 60)} »`)
  if (FORBIDDEN.test(label) && !(allow && allow.test(label))) {
    throw new Error(`Clic refusé (action d'écriture) : « ${label.trim().slice(0, 60)} »`)
  }
  await locator.click()
}

async function pickAccount(page, wanted, log) {
  const input = page.locator('input[aria-label*="ompte"]:visible, input[aria-label*="ccount"]:visible, [role="combobox"]:visible').first()
  if (!await input.count().catch(() => 0)) return false
  await guardedClick(input)
  await sleep(600)
  const option = page.locator('[role="option"]:visible, li:visible').filter({ hasText: wanted }).first()
  if (!await option.count().catch(() => 0)) {
    log(`option « ${wanted} » absente de la liste`)
    await page.keyboard.press('Escape').catch(() => {})
    return false
  }
  await guardedClick(option)
  await sleep(1500)
  return true
}

export function loadAccount(bankAccountId) {
  const account = db.prepare('SELECT id, name, kind, qb_account_id FROM bank_accounts WHERE id=? AND deleted_at IS NULL').get(bankAccountId)
  if (!account) return { error: 'Compte bancaire introuvable' }
  const qbId = String(account.qb_account_id || '').split(',').map(s => s.trim()).find(Boolean)
  if (!qbId) return { error: `« ${account.name} » n'est lié à aucun compte QuickBooks` }
  return { account, qbId }
}

export function checkSession() {
  const session = getBridgeSession(SESSION_KEY)
  if (!session) return { needsSession: true, screen: 'no_session', hint: NEEDS_SESSION_HINT }
  if (!liveCookies(session.state).length) return { needsSession: true, screen: 'expired', sessionAt: session.at, hint: NEEDS_SESSION_HINT }
  return { session }
}

const resumeButton = page => page.locator('button:visible, a:visible').filter({ hasText: /reprendre|resume/i }).first()
const startButton = page => page.locator('button:visible').filter({ hasText: /commencer|start reconcil/i }).first()
const gridOpen = async page => (await page.locator('tr input[type="checkbox"], [role="row"] input[type="checkbox"], [role="row"] [role="checkbox"]').count().catch(() => 0)) > 1
  && /diff[ée]rence/i.test(await page.locator('body').innerText().catch(() => ''))

// Attend (20 s par défaut) que l'écran de départ soit décidable : « Reprendre »,
// « Commencer » ou la grille. Rend ce qui est vu, null sinon.
async function waitForStartScreen(page, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs
  do {
    if (await resumeButton(page).count().catch(() => 0)) return 'reprendre'
    if (await gridOpen(page)) return 'grille'
    if (await startButton(page).count().catch(() => 0)) return 'commencer'
    await sleep(500)
  } while (Date.now() < until)
  return null
}

// Ouvre /app/reconcile sur le bon compte. Ne lance jamais de connexion.
export async function openScreen(opened, account, qbId, log) {
  const page = await opened.context.newPage()
  const realmId = getQbRealmIdSync()
  const params = new URLSearchParams({ accountId: qbId })
  if (realmId) params.set('deeplinkcompanyid', String(realmId))
  log(`ouverture ${QB_APP_HOST}/app/reconcile (compte QB ${qbId})`)
  await page.goto(`${QB_APP_HOST}/app/reconcile?${params}`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {})
  await sleep(2500)

  // QuickBooks peut rester plusieurs secondes sur son écran de chargement.
  let text = await page.locator('body').innerText().catch(() => '')
  for (let i = 0; i < 15 && classify(page.url(), text) === 'unknown'; i++) {
    await sleep(2000)
    text = await page.locator('body').innerText().catch(() => '')
  }
  const screen = classify(page.url(), text)
  log(`écran : ${screen} (${page.url().split('?')[0]})`)

  let accountName = null
  if (screen === 'reconcile') {
    // « Rapprocher » s'affiche avant le compte et ses boutons (Marge Desjardins,
    // 2026-09-27 : lu trop tôt, « Reprendre » manqué ; jusqu'à ~36 s mesurées).
    const ready = await waitForStartScreen(page, 45_000)
    log(`écran de départ : ${ready || 'non chargé après 45 s'}`)
    text = await page.locator('body').innerText().catch(() => text)
    accountName = await selectedAccountName(page)
    // Le nom QuickBooks exact du compte (lu par l'API, lecture seule).
    const wanted = await listQbBankAccounts()
      .then(list => list.find(a => a.id === qbId)?.name)
      .catch(() => null) || account.name
    if (!accountName || !accountName.toLowerCase().includes(String(wanted).toLowerCase())) {
      log(`compte affiché : ${accountName || '—'} ; recherche de « ${wanted} »`)
      if (await pickAccount(page, wanted, log).catch(e => { log(e.message); return false })) {
        await waitForStartScreen(page)
        accountName = await selectedAccountName(page)
        text = await page.locator('body').innerText().catch(() => text)
      }
    }
  }
  const needsSession = screen === 'login' || screen === 'verification'
  return {
    page, screen, text, accountName, needsSession,
    hint: needsSession ? (screen === 'verification'
      ? 'QuickBooks demande une revérification depuis le serveur — non contournée'
      : NEEDS_SESSION_HINT) : null,
  }
}

async function capture(page, account, log, suffix = '') {
  if (!existsSync(CAPTURE_DIR)) mkdirSync(CAPTURE_DIR, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
  const name = `${stamp}-${slug(account.name)}${suffix}.png`
  await page.screenshot({ path: join(CAPTURE_DIR, name), fullPage: true }).catch(e => log(`capture impossible : ${e.message}`))
  return name
}

/**
 * Ouvre l'écran « Rapprocher » de QuickBooks pour un compte bancaire Boréal.
 * Lecture seule. Ne lance jamais de connexion.
 * @returns {Promise<object>} { ok, screen, needsSession?, hint?, capture?, readings?, … }
 */
export async function openReconcile(bankAccountId) {
  const t0 = Date.now()
  const trace = []
  const log = m => trace.push(m)
  const finish = (result) => {
    logSync(MODULE, 'manual', {
      status: result.ok ? 'success' : 'error',
      error: result.ok ? null : (result.error || result.hint || result.screen || 'échec'),
      durationMs: Date.now() - t0,
    })
    return { ...result, trace }
  }

  const { account, qbId, error } = loadAccount(bankAccountId)
  if (error) return finish({ ok: false, error })
  const s = checkSession()
  if (!s.session) return finish({ ok: false, ...s })

  if (running) return finish({ ok: false, error: 'Un passage du robot est déjà en cours' })
  running = true

  let browser
  try {
    const opened = await launchContext({ storageState: s.session.state })
    browser = opened.browser
    const o = await openScreen(opened, account, qbId, log)
    const captureName = await capture(o.page, account, log)
    const ok = o.screen === 'reconcile'
    // La session a servi : QuickBooks a pu rafraîchir ses témoins, on les garde.
    if (ok) {
      try { saveBridgeSession(SESSION_KEY, await opened.context.storageState()) } catch { /* l'ancienne reste */ }
    }
    return finish({
      ok,
      screen: o.screen,
      needsSession: o.needsSession,
      hint: o.hint,
      account: { id: account.id, name: account.name, qb_account_id: qbId },
      pageUrl: o.page.url().split('?')[0],
      capture: captureName,
      readings: ok ? { accountName: o.accountName, ...readScreen(o.text) } : null,
      excerpt: o.text.slice(0, 1500),
    })
  } catch (e) {
    return finish({ ok: false, error: e.message })
  } finally {
    running = false
    if (browser) await browser.close().catch(() => {})
  }
}

// ── Tranche 2 : cocher, lire la Différence, enregistrer pour plus tard ───────

// Premier champ VISIBLE et modifiable portant l'un des libellés.
async function editableByLabel(page, rx) {
  const candidates = [
    ...await page.getByLabel(rx).all().catch(() => []),
    ...await page.locator('input:visible').all().catch(() => []),
  ]
  for (const el of candidates) {
    if (!await el.isVisible().catch(() => false)) continue
    if (!await el.isEditable().catch(() => false)) continue
    const tag = await el.evaluate(n => n.tagName).catch(() => '')
    if (tag !== 'INPUT') continue
    const label = await el.evaluate(n => {
      const byFor = n.id ? document.querySelector(`label[for="${CSS.escape(n.id)}"]`)?.textContent : ''
      return `${n.getAttribute('aria-label') || ''} ${byFor || ''} ${n.closest('label')?.textContent || ''} ${n.getAttribute('placeholder') || ''}`
    }).catch(() => '')
    if (rx.test(label)) return el
  }
  return null
}

const dateOrderOf = pattern => {
  const p = String(pattern || '').toLowerCase()
  if (/^\d{4}-|^(aaaa|yyyy)/.test(p)) return 'ymd'
  if (/^(mm|m)[/.-]/.test(p)) return 'mdy'
  if (/^(jj|dd|j|d)[/.-]/.test(p)) return 'dmy'
  return detectDateOrder([p])
}

// Écran de départ : « Reprendre » une session déjà en cours, sinon saisir date
// et solde de fin puis « Commencer ». Toute saisie est relue avant de cliquer.
async function startOrResume(page, { endDate, endingBalance, lastDateShown, log }) {
  const seen = await waitForStartScreen(page)
  // Le lien profond peut tomber directement dans une session en cours.
  if (seen === 'grille' || await gridOpen(page)) {
    log('grille déjà ouverte : session en cours')
    return { resumed: true }
  }
  const resume = resumeButton(page)
  if (await resume.count().catch(() => 0)) {
    log('rapprochement déjà en cours : reprise')
    await guardedClick(resume, /reprendre|resume/i)
    return { resumed: true }
  }

  const dateInput = await editableByLabel(page, /date de fin|ending date|statement date|date du relev/i)
  const balInput = await editableByLabel(page, /solde de (fin|cl[ôo]ture)|ending balance/i)
  if (!dateInput || !balInput) {
    return { error: seen ? 'Champs « date de fin » / « solde de fin » introuvables' : 'Écran de départ non chargé après 20 s (ni « Reprendre », ni « Commencer », ni grille)' }
  }

  const pattern = await dateInput.getAttribute('placeholder').catch(() => null)
    || await dateInput.inputValue().catch(() => null) || lastDateShown || ''
  const order = dateOrderOf(pattern)
  await dateInput.fill(formatDateFor(pattern, endDate))
  await dateInput.press('Tab').catch(() => {})
  await sleep(400)
  const dateBack = await dateInput.inputValue().catch(() => '')
  if (parseScreenDate(dateBack, order === 'ymd' ? null : order) !== endDate) {
    return { error: `Date de fin non acceptée par QuickBooks (${dateBack || 'vide'} ≠ ${endDate})` }
  }

  let balOk = false
  for (const txt of [endingBalance.toFixed(2), endingBalance.toFixed(2).replace('.', ',')]) {
    await balInput.fill(txt)
    await balInput.press('Tab').catch(() => {})
    await sleep(300)
    if (parseMoney(await balInput.inputValue().catch(() => '')) === endingBalance) { balOk = true; break }
  }
  if (!balOk) return { error: 'Solde de fin non accepté par QuickBooks' }

  const start = page.locator('button:visible').filter({ hasText: /commencer|start/i }).first()
  if (!await start.count().catch(() => 0)) return { error: 'Bouton « Commencer » introuvable' }
  await guardedClick(start, /commencer|start/i)
  log(`commencé au ${endDate}, solde ${endingBalance.toFixed(2)}`)
  return { resumed: false }
}

// Lignes de la grille (exécuté dans la page). Chaque ligne reçoit une marque
// `data-boreal-rec` pour la retrouver au clic.
function scanGridInPage() {
  const vis = el => {
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none'
  }
  const cellsOf = row => [...row.children].filter(c => /^(TD|TH)$/.test(c.tagName) || /cell|header/i.test(c.getAttribute('role') || ''))
  const txt = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
  let headers = null
  const rows = []
  let next = Number(document.body.dataset.borealNext || 0)
  for (const row of document.querySelectorAll('tr, [role="row"]')) {
    if (!vis(row)) continue
    const cells = cellsOf(row)
    if (!cells.length) continue
    if (cells.every(c => c.tagName === 'TH' || c.getAttribute('role') === 'columnheader')) {
      if (!headers || cells.length > headers.length) headers = cells.map(txt)
      continue
    }
    const cb = row.querySelector('input[type="checkbox"], [role="checkbox"]')
    if (!cb) continue
    if (!row.dataset.borealRec) row.dataset.borealRec = String(next++)
    const ids = new Set()
    for (const el of [row, ...row.querySelectorAll('*')]) {
      for (const a of el.attributes) {
        const m = String(a.value).match(/txn_?id=(\d+)/i)
        if (m) ids.add(m[1])
        if (/txn|transaction/i.test(a.name) && /^\d{1,10}$/.test(a.value)) ids.add(a.value)
      }
    }
    rows.push({
      key: row.dataset.borealRec,
      cells: cells.map(txt),
      checked: cb.checked === true || cb.getAttribute('aria-checked') === 'true',
      ids: [...ids],
    })
  }
  document.body.dataset.borealNext = String(next)
  return { headers, rows }
}

const MONEY_CELL = /^[-−(]?\s*\$?\s*\d[\d\s\u00a0.,]*[.,]\d{2}\s*\$?\)?$/

// Cellules → { key, date, amount (signé si la colonne est connue), abs, checked, ids, label }.
export function interpretRows(scan, kind) {
  const H = (scan.headers || []).map(h => h.toLowerCase())
  const find = rx => H.findIndex(h => rx.test(h))
  const iDate = find(/^date/)
  // Mise en page carte (Débit / Paiement) : décidée par les en-têtes, pas par
  // le type Boréal — la Marge Desjardins est « bank » ici mais « Credit Card »
  // dans QuickBooks. Avance = Débit = négatif, comme au relevé.
  const card = kind === 'card' || (find(/d[ée]p[ôo]t|deposit/) < 0 && find(/frais|charge|achat|d[ée]bit/) >= 0 && find(/paiement|payment/) >= 0)
  const iOut = card ? find(/frais|charge|achat|d[ée]bit/) : find(/paiement|payment|retrait|withdraw|d[ée]bit/)
  const iIn = card ? find(/paiement|payment|cr[ée]dit/) : find(/d[ée]p[ôo]t|deposit|cr[ée]dit/)
  const dateCells = scan.rows.map(r => (iDate >= 0 && r.cells.length === H.length ? r.cells[iDate] : r.cells.find(c => /\d/.test(c) && parseScreenDate(c, 'dmy'))))
  const order = detectDateOrder(dateCells)
  return scan.rows.map((r, n) => {
    const aligned = r.cells.length === H.length
    const date = parseScreenDate(dateCells[n], order)
    let amount = null, abs = null
    if (aligned && iOut >= 0 && iIn >= 0) {
      const out = parseMoney(r.cells[iOut]), inn = parseMoney(r.cells[iIn])
      if (out || inn) amount = Math.round(((inn || 0) - Math.abs(out || 0)) * 100) / 100
    }
    if (amount == null) {
      const money = r.cells.filter(c => MONEY_CELL.test(c)).map(parseMoney).filter(v => v != null)
      if (money.length === 1) abs = Math.abs(money[0])
    } else abs = Math.abs(amount)
    const label = r.cells.filter((c, i) => c && i !== iDate && i !== iOut && i !== iIn && !MONEY_CELL.test(c)).join(' · ').slice(0, 120)
    return { key: r.key, date, amount, abs, checked: r.checked, ids: r.ids, label }
  })
}

// Défile la grille jusqu'en bas pour charger les lignes paresseuses.
async function loadAllRows(page) {
  let last = -1
  for (let i = 0; i < 10; i++) {
    const n = await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        if (el.scrollHeight > el.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight
      }
      window.scrollTo(0, document.body.scrollHeight)
      return document.querySelectorAll('tr, [role="row"]').length
    }).catch(() => last)
    if (n === last) break
    last = n
    await sleep(700)
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {})
}

// Coche UNE ligne encore décochée ; relue avant et après. Jamais de décoche.
async function checkRow(page, key) {
  const row = page.locator(`[data-boreal-rec="${key}"]`).first()
  const isChecked = () => row.evaluate(r => {
    const cb = r.querySelector('input[type="checkbox"], [role="checkbox"]')
    return !!cb && (cb.checked === true || cb.getAttribute('aria-checked') === 'true')
  }).catch(() => null)
  if (await isChecked() !== false) return false
  const cb = row.locator('input[type="checkbox"], [role="checkbox"]').first()
  await cb.scrollIntoViewIfNeeded().catch(() => {})
  if (await cb.isVisible().catch(() => false)) await guardedClick(cb)
  else await guardedClick(cb.locator('xpath=..'))
  await sleep(250)
  return await isChecked() === true
}

// La « Différence » affichée : le libellé, puis le montant de son bloc.
async function readDifference(page) {
  const raw = await page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const rx = /-?\(?[-−]?\s*\$?\s*\d[\d\s\u00a0.,]*[.,]\d{2}\s*\$?\)?/
    const labels = [...document.querySelectorAll('body *')]
      .filter(el => el.children.length === 0 && /^\s*diff[ée]rence\s*$/i.test(el.textContent || '') && vis(el))
    for (const lab of labels) {
      let node = lab
      for (let k = 0; k < 4 && node; k++) {
        node = node.parentElement
        const m = String(node?.innerText || '').replace(/diff[ée]rence/ig, ' ').match(rx)
        if (m) return m[0]
      }
    }
    return null
  }).catch(() => null)
  return { raw, value: raw == null ? null : parseMoney(raw.replace('−', '-')) }
}

// Ce que montre l'écran à la fin du passage — rejoué tel quel par la page
// « Rapprocher (QBO) » de Boréal : les soldes du bandeau et la grille.
async function readView(page) {
  const text = await page.locator('body').innerText().catch(() => '')
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const amountBefore = (rx) => {
    const i = lines.findIndex(l => rx.test(l))
    if (i < 1) return null
    for (let k = i - 1; k >= Math.max(0, i - 2); k--) {
      const v = parseMoney(lines[k].replace('−', '-'))
      if (v != null) return v
    }
    return null
  }
  const summary = {
    ending_balance: amountBefore(/^solde de fermeture/i),
    cleared_balance: amountBefore(/^solde compens/i),
    beginning_balance: amountBefore(/^solde initial/i),
    out_total: amountBefore(/^\d+\s+(d[ée]bits?|paiements?|payments?|charges?)$/i),
    out_label: lines.find(l => /^\d+\s+(d[ée]bits?|paiements?)$/i.test(l)) || null,
    in_total: amountBefore(/^\d+\s+(d[ée]p[ôo]ts?|cr[ée]dits?|paiements?|deposits?)$/i),
    in_label: [...lines].reverse().find(l => /^\d+\s+(d[ée]p[ôo]ts?|cr[ée]dits?|paiements?)$/i.test(l)) || null,
    difference: amountBefore(/^diff[ée]rence$/i),
    end_date_label: (lines.find(l => /^date de fin du relev/i.test(l)) || '').replace(/^date de fin du relev[ée] de compte\s*:\s*/i, '') || null,
    title: lines.find(l => /^\d{5}\s/.test(l)) || null,
  }
  const scan = await page.evaluate(scanGridInPage).catch(() => ({ headers: [], rows: [] }))
  return { summary, headers: scan.headers || [], rows: (scan.rows || []).map(r => ({ cells: r.cells, checked: r.checked })) }
}

// « Enregistrer pour plus tard » : directement visible, ou dans le menu du
// bouton partagé « Terminer maintenant ▾ » — on n'ouvre alors QUE la flèche,
// jamais le bouton lui-même. Introuvable ou ambigu → on n'enregistre rien.
async function saveForLater(page, log) {
  const item = () => page.locator('button:visible, [role="menuitem"]:visible, a:visible, li:visible')
    .filter({ hasText: /enregistrer pour plus tard|save for later/i })
  if (!await item().count().catch(() => 0)) {
    // « Terminer maintenant » si la Différence n'est pas nulle, « Terminer » sinon.
    const finish = page.locator('button:visible').filter({ hasText: /^\s*(terminer|finish)(\s+maintenant|\s+now)?\s*$/i }).first()
    if (!await finish.count().catch(() => 0)) return { saved: false, why: '« Enregistrer pour plus tard » introuvable' }
    const marked = await finish.evaluate(btn => {
      let p = btn.parentElement
      for (let k = 0; k < 3 && p; k++, p = p.parentElement) {
        // La flèche : sans texte (son aria-label peut être « Terminer menu »).
        const toggle = [...p.querySelectorAll('button')].find(b => b !== btn && !b.contains(btn) && !btn.contains(b)
          && !(b.textContent || '').trim()
          && (b.getAttribute('aria-haspopup') != null || b.getAttribute('aria-expanded') != null))
        if (toggle) { toggle.dataset.borealToggle = '1'; return true }
      }
      return false
    }).catch(() => false)
    if (!marked) return { saved: false, why: 'menu de « Terminer maintenant » introuvable' }
    await guardedClick(page.locator('[data-boreal-toggle="1"]').first())
    await sleep(600)
  }
  const n = await item().count().catch(() => 0)
  if (n !== 1) {
    await page.keyboard.press('Escape').catch(() => {})
    return { saved: false, why: n ? '« Enregistrer pour plus tard » ambigu' : '« Enregistrer pour plus tard » introuvable' }
  }
  await guardedClick(item().first(), /enregistrer pour plus tard|save for later/i)
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await sleep(1500)
  log('enregistré pour plus tard')
  return { saved: true }
}

// Dernier relevé déposé et vérifié (solde d'ouverture + lignes = clôture) du
// compte, s'il est plus récent que le dernier solde imprimé connu.
export function officialStatement(accountId, notBefore) {
  const up = db.prepare(`
    SELECT id, original_name, period_end, closing_balance, rows_json FROM bank_statement_uploads
    WHERE account_id=? AND balance_ok=1 AND closing_balance IS NOT NULL AND period_end IS NOT NULL
      -- Le vrai relevé de la banque (PDF) seulement : une capture d'écran ou un
      -- export partiel a déjà fait décocher à tort deux lignes de Desjardins
      -- CAD (2026-09-26).
      AND mime = 'application/pdf'
      AND rows_json IS NOT NULL AND status IN ('pret','importe') AND period_end >= ?
    ORDER BY period_end DESC, created_at DESC LIMIT 1
  `).get(accountId, notBefore || '0000')
  if (!up) return null
  let rows = []
  try { rows = JSON.parse(up.rows_json) } catch { return null }
  if (!Array.isArray(rows)) return null
  // Zéro ligne = un mois sans mouvement, vérifié (ouverture = clôture) : rien à
  // cocher, mais la date et le solde de fin font foi.
  rows = rows.filter(r => r && r.txn_date && Number.isFinite(Number(r.amount)))
  return {
    id: up.id, name: up.original_name, endDate: up.period_end,
    endingBalance: Math.round(Math.abs(Number(up.closing_balance)) * 100) / 100,
    expected: rows.map(r => ({ date: r.txn_date, amount: Number(r.amount), qbId: null, label: r.description || '' })),
  }
}

// « Modifier les renseignements » : aligne date et solde de fin sur le relevé
// officiel. Relu avant d'enregistrer ; rien à changer → « Annuler ».
async function editStatementInfo(page, { endDate, endingBalance, log }) {
  const btn = page.locator('button:visible').filter({ hasText: /modifier les renseignements|edit info/i }).first()
  if (!await btn.count().catch(() => 0)) return { error: '« Modifier les renseignements » introuvable' }
  await guardedClick(btn, /modifier les renseignements|edit info/i)
  await sleep(1500)
  const found = await page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const head = [...document.querySelectorAll('body *')].find(el => el.children.length === 0 && vis(el)
      && /modifiez les renseignements|edit your statement info/i.test(el.textContent || ''))
    let box = head
    while (box && ![...box.querySelectorAll('input')].filter(vis).length) box = box.parentElement
    if (!box) return null
    const inputs = [...box.querySelectorAll('input')].filter(vis)
    const date = inputs.find(i => /^\d{4}-\d{2}-\d{2}$|^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(i.value.trim()))
    const bal = inputs.find(i => i !== date && /\d/.test(i.value))
    if (!date || !bal) return null
    date.dataset.borealDate = '1'; bal.dataset.borealBal = '1'
    return { date: date.value, bal: bal.value }
  }).catch(() => null)
  const cancel = async () => {
    const c = page.locator('button:visible').filter({ hasText: /^\s*(annuler|cancel)\s*$/i }).last()
    if (await c.count().catch(() => 0)) await guardedClick(c, /annuler|cancel/i)
    else await page.keyboard.press('Escape').catch(() => {})
    await sleep(800)
  }
  if (!found) { await cancel(); return { error: 'Champs du relevé introuvables dans « Modifier les renseignements »' } }
  const dateOrder = /^\d{4}-/.test(found.date) ? 'ymd' : detectDateOrder([found.date])
  const dateNow = parseScreenDate(found.date, dateOrder === 'ymd' ? null : dateOrder)
  const balNow = parseMoney(found.bal)
  if (dateNow === endDate && balNow === endingBalance) {
    await cancel()
    log(`renseignements déjà justes (${endDate}, ${endingBalance.toFixed(2)})`)
    return { changed: false }
  }
  const dateIn = page.locator('[data-boreal-date="1"]').first()
  const balIn = page.locator('[data-boreal-bal="1"]').first()
  if (dateNow !== endDate) {
    await dateIn.fill(formatDateFor(found.date, endDate))
    await dateIn.press('Tab').catch(() => {})
    await sleep(400)
    const back = await dateIn.inputValue().catch(() => '')
    if (parseScreenDate(back, dateOrder === 'ymd' ? null : dateOrder) !== endDate) { await cancel(); return { error: `Date de fin refusée (${back})` } }
  }
  let balOk = balNow === endingBalance
  for (const txt of [endingBalance.toFixed(2).replace('.', ','), endingBalance.toFixed(2)]) {
    if (balOk) break
    await balIn.fill(txt)
    await balIn.press('Tab').catch(() => {})
    await sleep(300)
    balOk = parseMoney(await balIn.inputValue().catch(() => '')) === endingBalance
  }
  if (!balOk) { await cancel(); return { error: 'Solde de fin refusé par QuickBooks' } }
  // « Enregistrer » du panneau — jamais « Enregistrer pour plus tard ».
  const save = page.locator('button:visible').filter({ hasText: /^\s*(enregistrer|save)\s*$/i }).last()
  if (!await save.count().catch(() => 0)) { await cancel(); return { error: '« Enregistrer » du panneau introuvable' } }
  await guardedClick(save, /^\s*(enregistrer|save)\s*$/i)
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await sleep(2500)
  log(`renseignements corrigés : ${found.date} / ${found.bal} → ${endDate} / ${endingBalance.toFixed(2)}`)
  return { changed: true, before: { date: found.date, balance: balNow } }
}

// Décoche UNE ligne cochée (relevé officiel seulement) ; relue avant et après.
async function uncheckRow(page, key) {
  const row = page.locator(`[data-boreal-rec="${key}"]`).first()
  const isChecked = () => row.evaluate(r => {
    const cb = r.querySelector('input[type="checkbox"], [role="checkbox"]')
    return !!cb && (cb.checked === true || cb.getAttribute('aria-checked') === 'true')
  }).catch(() => null)
  if (await isChecked() !== true) return false
  const cb = row.locator('input[type="checkbox"], [role="checkbox"]').first()
  await cb.scrollIntoViewIfNeeded().catch(() => {})
  if (await cb.isVisible().catch(() => false)) await guardedClick(cb)
  else await guardedClick(cb.locator('xpath=..'))
  await sleep(250)
  return await isChecked() === false
}

// Lignes vertes du compte jusqu'à la date de fin, et ce que QuickBooks en montre.
async function expectedFor(accountId, qbId, endDate, log) {
  const from = shiftDate(endDate, -365)
  const targets = db.prepare(`
    SELECT id, txn_date, amount, description, qb_txn_id FROM bank_transactions
    WHERE account_id=? AND status='rapproche' AND deleted_at IS NULL AND txn_date<=? AND txn_date>=?
    ORDER BY txn_date
  `).all(accountId, endDate, from)
  const ledger = await fetchQbLedgerForReconcile(qbId, from, endDate)
  const { expected, alreadyReconciled } = buildExpected(targets, ledger, { graceDays: GRACE_DAYS })
  log(`${targets.length} ligne(s) verte(s), ${alreadyReconciled} déjà rapprochée(s) dans QuickBooks, ${expected.length} écriture(s) à cocher`)
  return { targets, expected, alreadyReconciled }
}

/**
 * Prépare le rapprochement d'un compte dans QuickBooks : coche les lignes
 * vertes, lit la Différence, enregistre pour plus tard. Ne termine jamais.
 * @returns {Promise<object>} { ok, difference, checked, already_checked, unmatched_boreal, unmatched_qb, screenshot, saved, … }
 */
export async function reconcileAccount(bankAccountId, { requireOfficial = false } = {}) {
  const t0 = Date.now()
  const trace = []
  const log = m => trace.push(m)
  const base = { difference: null, checked: 0, already_checked: 0, unmatched_boreal: [], unmatched_qb: [], screenshot: null, saved: false }
  const finish = (result) => {
    logSync(MODULE, 'manual', {
      status: result.ok ? 'success' : 'error',
      error: result.ok ? null : (result.error || result.hint || result.screen || 'échec'),
      records_modified: result.checked || 0,
      durationMs: Date.now() - t0,
    })
    return { ...base, ...result, duration_ms: Date.now() - t0, trace }
  }

  const { account, qbId, error } = loadAccount(bankAccountId)
  if (error) return finish({ ok: false, error })
  const stmt = summarizeAccount(account.id)?.statement
  if (!stmt?.date || stmt.printed_balance_signed == null) return finish({ ok: false, error: 'Aucun solde imprimé au relevé' })
  // Le dernier relevé PDF du compte fait foi, qu'il soit plus récent ou non que
  // le dernier solde imprimé de Boréal — écarté plus bas s'il est déjà rapproché
  // dans QuickBooks.
  let official = officialStatement(account.id, null)
  let endDate = official ? official.endDate : stmt.date
  let endingBalance = official ? official.endingBalance : endingBalanceFor(account.kind, stmt.printed_balance_signed)
  if (official) log(`relevé officiel : ${official.name} (${official.endDate}, ${official.endingBalance.toFixed(2)})`)
  const s = checkSession()
  if (!s.session) return finish({ ok: false, ...s, statement_date: endDate, ending_balance: endingBalance })

  if (running) return finish({ ok: false, error: 'Un passage du robot est déjà en cours' })
  running = true

  let browser
  try {
    const opened = await launchContext({ storageState: s.session.state })
    browser = opened.browser
    const o = await openScreen(opened, account, qbId, log)
    const page = o.page
    const lastEnd = (String(o.text || '').match(/date de fin du dernier relev[ée] de compte\s*(\d{4}-\d{2}-\d{2})/i) || [])[1] || null
    if (official && lastEnd && lastEnd >= official.endDate) {
      log(`relevé ${official.name} déjà rapproché dans QuickBooks (dernier : ${lastEnd}) — ignoré`)
      official = null
      endDate = stmt.date
      endingBalance = endingBalanceFor(account.kind, stmt.printed_balance_signed)
    }
    if (requireOfficial && !official) {
      return finish({ ok: false, skipped: true, error: 'Aucun nouveau relevé à rapprocher', statement_date: null, qb_last_end: lastEnd })
    }
    const exp = official
      ? { targets: [], expected: official.expected, alreadyReconciled: 0 }
      : await expectedFor(account.id, qbId, endDate, log)
    const meta = { statement_date: endDate, ending_balance: endingBalance, official_statement: official?.name || null, qb_last_end: lastEnd }
    if (o.screen !== 'reconcile') {
      const shot = await capture(page, account, log)
      return finish({ ok: false, screen: o.screen, needsSession: o.needsSession, hint: o.hint, screenshot: shot, ...meta })
    }

    const st = await startOrResume(page, { endDate, endingBalance, lastDateShown: readScreen(o.text).lastStatementEndingDate, log })
    if (st.error) {
      const shot = await capture(page, account, log)
      return finish({ ok: false, error: st.error, screenshot: shot, ...meta })
    }
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {})
    await sleep(3000)
    let infoFix = null
    if (official && st.resumed) {
      infoFix = await editStatementInfo(page, { endDate, endingBalance, log }).catch(e => ({ error: e.message }))
      if (infoFix.error) {
        const shot = await capture(page, account, log)
        return finish({ ok: false, error: infoFix.error, screenshot: shot, resumed: true, ...meta })
      }
    }
    if (!/diff[ée]rence/i.test(await page.locator('body').innerText().catch(() => ''))) {
      const shot = await capture(page, account, log)
      return finish({ ok: false, error: 'Grille de rapprochement non affichée', screenshot: shot, resumed: st.resumed, ...meta })
    }

    // Page par page (au plus 20) : charger, apparier, cocher.
    let remaining = exp.expected.map((e, i) => ({ ...e, i }))
    const unmatchedQb = []
    let checked = 0, alreadyChecked = 0, failed = 0, screenRows = 0, unchecked = 0
    for (let p = 0; p < 20; p++) {
      await loadAllRows(page)
      const rows = interpretRows(await page.evaluate(scanGridInPage), account.kind)
      screenRows += rows.length
      const { matches, unmatchedScreen } = matchScreen(rows, remaining, { endDate, graceDays: GRACE_DAYS })
      for (const m of matches) {
        if (m.checked) { alreadyChecked++; continue }
        if (await checkRow(page, m.key).catch(e => { log(e.message); return false })) checked++
        else failed++
      }
      const used = new Set(matches.map(m => m.expectedIndex))
      remaining = remaining.filter((_, j) => !used.has(j))
      unmatchedQb.push(...unmatchedScreen.filter(r => !r.checked).map(r => ({ date: r.date, amount: r.amount ?? r.abs, label: r.label })))
      // Relevé officiel : ce qui est coché sans y figurer n'a rien à faire là
      // — décoché, puis remis si la Différence s'en trouve éloignée de zéro.
      if (official) {
        const cand = unmatchedScreen.filter(x => x.checked)
        if (cand.length) {
          await sleep(800)
          const before = (await readDifference(page)).value
          const done = []
          for (const r of cand) {
            if (await uncheckRow(page, r.key).catch(e => { log(e.message); return false })) {
              done.push(r)
              log(`décochée : ${r.date} ${r.amount ?? r.abs} ${r.label.slice(0, 40)}`)
            }
          }
          await sleep(1200)
          const after = (await readDifference(page)).value
          if (done.length && before != null && after != null && Math.abs(after) > Math.abs(before) + 0.005) {
            for (const r of done) await checkRow(page, r.key).catch(() => false)
            log(`décoches annulées : la différence passait de ${before} à ${after}`)
          } else unchecked += done.length
        }
      }

      const next = page.locator([
        'button:not([disabled])[aria-label*="age suivante"]:visible',
        'button:not([disabled])[aria-label*="ext page"]:visible',
        'button:not([disabled])[aria-label="Suivant"]:visible',
        'button:not([disabled])[aria-label="Next"]:visible',
      ].join(', ')).first()
      if (!remaining.length || !await next.count().catch(() => 0)) break
      log(`page suivante (${p + 2})`)
      await guardedClick(next)
      await sleep(1500)
    }
    log(`${screenRows} ligne(s) à l'écran · ${checked} cochée(s) · ${alreadyChecked} déjà cochée(s) · ${unchecked} décochée(s)${failed ? ` · ${failed} coche(s) refusée(s)` : ''}`)

    await sleep(1500)
    const diff = await readDifference(page)
    log(`différence lue : ${diff.raw ?? '—'}`)
    const view = await readView(page).catch(() => null)
    const shot = await capture(page, account, log)
    const save = await saveForLater(page, log).catch(e => ({ saved: false, why: e.message }))
    if (!save.saved) log(`non enregistré : ${save.why}`)

    try { saveBridgeSession(SESSION_KEY, await opened.context.storageState()) } catch { /* l'ancienne reste */ }

    const byId = new Map(exp.targets.map(t => [t.id, t]))
    return finish({
      ok: true,
      ...meta,
      resumed: !!st.resumed,
      difference: diff.value,
      difference_raw: diff.raw,
      checked,
      already_checked: alreadyChecked,
      failed_checks: failed,
      unchecked,
      info_fixed: infoFix?.changed ? infoFix.before : null,
      already_reconciled_qb: exp.alreadyReconciled,
      unmatched_boreal: official
        ? remaining.filter(e => e.date >= shiftDate(endDate, -20)).map(e => ({ id: null, date: e.date, amount: e.amount, label: e.label }))
        : remaining.flatMap(e => e.borealIds.map(id => byId.get(id)).filter(Boolean))
        .map(t => ({ id: t.id, date: t.txn_date, amount: t.amount, label: t.description })),
      unmatched_qb: unmatchedQb,
      screenshot: shot,
      saved: !!save.saved,
      save_note: save.saved ? null : save.why,
      view,
    })
  } catch (e) {
    return finish({ ok: false, error: e.message })
  } finally {
    running = false
    if (browser) await browser.close().catch(() => {})
  }
}
