// ANNULER LA CORRESPONDANCE D'UNE LIGNE DU FLUX BANCAIRE QUICKBOOKS.
//
// Une écriture appariée à une ligne téléchargée (« Opérations bancaires » →
// « Publié ») ne se supprime pas par l'API (code 6480) et l'API n'a aucun
// accès au flux bancaire. Ce robot fait le geste de l'interface : onglet
// « Publié » du compte, la ligne de CE montant à cette date, « Annuler ».
// L'écriture reste dans QuickBooks, la ligne repart « En attente »
// (Charles, 2026-10-06 : la dépense Google d'août, à refaire en facture).
//
// Garde-fous : une seule ligne doit correspondre (montant exact, date à ±5 j,
// et le libellé du marchand quand on le connaît) ; sinon on ne clique rien.

import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { launchContext } from './scrapers/browser.js'
import { checkSession, loadAccount, CAPTURE_DIR } from './qbReconcileRobot.js'
import { QB_APP_HOST, getQbRealmIdSync } from '../connectors/quickbooks.js'
import { listQbBankAccounts } from './bankQbLink.js'
import { saveBridgeSession } from './scrapers/bridgeSessions.js'
import { logSync } from './syncLog.js'

const MODULE = 'bank:qb-feed-undo'
const DRIFT_DAYS = 5
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const daysApart = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5
const money = (n) => Math.abs(n).toFixed(2).replace('.', ',')
const words = (s) => (String(s || '').toLowerCase().match(/[a-z]{3,}/g) || [])

async function waitUntil(fn, ms) {
  const until = Date.now() + ms
  do {
    if (await fn().catch(() => false)) return true
    await sleep(250)
  } while (Date.now() < until)
  return false
}

// Lignes visibles de l'onglet « Publié » : date, texte, et l'index du lien « Annuler ».
// Exécutée dans la page QuickBooks.
/* global document */
function scanRows() {
  return [...document.querySelectorAll('tr')].map((tr, i) => {
    const cells = [...tr.querySelectorAll('td')].map((td) => td.innerText.trim())
    const undo = [...tr.querySelectorAll('button, a')].find((b) => /^(annuler|undo)$/i.test(b.innerText.trim()))
    if (!cells.length || !undo) return null
    tr.dataset.feedRow = String(i)
    return { i, date: cells.find((c) => /^\d{4}-\d{2}-\d{2}$/.test(c)) || null, text: cells.join(' | ') }
  }).filter(Boolean)
}

/**
 * @param {string} bankAccountId  compte Boréal
 * @param {{ date: string, amount: number, label?: string, dryRun?: boolean }} target  dryRun : trouve la ligne sans cliquer
 * @returns {Promise<{ ok: boolean, error?: string, row?: string, capture?: string, trace: string[] }>}
 */
export async function undoBankFeedMatch(bankAccountId, { date, amount, label = '', dryRun = false }) {
  const t0 = Date.now()
  const trace = []
  const log = (m) => trace.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`)
  const done = (r) => {
    logSync(MODULE, 'manual', { status: r.ok ? 'success' : 'error', error: r.ok ? null : r.error, durationMs: Date.now() - t0 })
    return { ...r, trace }
  }
  const { qbId, error } = loadAccount(bankAccountId)
  if (error) return done({ ok: false, error })
  const s = checkSession()
  if (!s.session) return done({ ok: false, error: s.hint })
  const qbAcct = (await listQbBankAccounts().catch(() => [])).find((a) => a.id === qbId)
  if (!qbAcct) return done({ ok: false, error: 'Compte QuickBooks introuvable' })
  const title = [qbAcct.acctnum, qbAcct.name].filter(Boolean).join(' ')

  let browser
  let page
  const shot = async (suffix) => {
    if (!page) return null
    if (!existsSync(CAPTURE_DIR)) mkdirSync(CAPTURE_DIR, { recursive: true })
    const name = `${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}-flux-${suffix}.png`
    await page.screenshot({ path: join(CAPTURE_DIR, name) }).catch(() => {})
    return name
  }
  try {
    const opened = await launchContext({ storageState: s.session.state })
    browser = opened.browser
    page = await opened.context.newPage()
    await page.goto(`${QB_APP_HOST}/app/banking?deeplinkcompanyid=${getQbRealmIdSync()}`, { waitUntil: 'domcontentloaded' })
    const card = page.locator(`[title="${title}"]:visible`).first()
    if (!await waitUntil(async () => (await card.count()) > 0, 60_000)) {
      return done({ ok: false, error: /connexion|sign in|identit/i.test(await page.locator('body').innerText().catch(() => '')) ? s.hint || 'Session QuickBooks expirée' : `Compte « ${title} » absent des Opérations bancaires`, capture: await shot('compte') })
    }
    await card.evaluate((n) => { const c = n.closest('button,[role="button"],[role="tab"],li,a') || n; c.scrollIntoView(); c.click() })
    log(`compte ${title}`)
    await sleep(3000)
    const tab = page.locator('[aria-label^="ACCEPTED"]:visible').first()
    if (!await waitUntil(async () => (await tab.count()) > 0, 20_000)) return done({ ok: false, error: 'Onglet « Publié » introuvable', capture: await shot('onglet') })
    await tab.click()
    log('onglet Publié')

    // Recherche par montant : la ligne visée remonte en tête, quelle que soit la page.
    const search = page.locator('input[placeholder="Rechercher"]:visible, input[placeholder="Search"]:visible').first()
    if (await search.count()) {
      await search.fill(Math.abs(amount).toFixed(2))
      await search.press('Enter')
      log(`recherche ${Math.abs(amount).toFixed(2)}`)
    }
    const want = `${money(amount)}`
    let rows = []
    await waitUntil(async () => {
      rows = await page.evaluate(scanRows)
      return rows.some((r) => r.text.includes(want))
    }, 25_000)
    const hint = words(label)[0]
    const hits = rows.filter((r) => r.text.includes(want) && r.date && daysApart(r.date, date) <= DRIFT_DAYS)
    const byLabel = hint ? hits.filter((r) => r.text.toLowerCase().includes(hint)) : hits
    const pick = byLabel.length === 1 ? byLabel : hits
    log(`${hits.length} ligne(s) à ${want} $ près du ${date}`)
    if (pick.length !== 1) {
      return done({ ok: false, error: pick.length ? `${pick.length} lignes à ${want} $ — aucune annulée` : `Aucune ligne « Publié » à ${want} $ près du ${date}`, capture: await shot('introuvable') })
    }
    if (dryRun) return done({ ok: true, dryRun: true, row: pick[0].text, capture: await shot('apercu') })
    const row = page.locator(`tr[data-feed-row="${pick[0].i}"]`)
    await row.locator('button, a').filter({ hasText: /^(annuler|undo)$/i }).first().click()
    log(`Annuler : ${pick[0].text.slice(0, 120)}`)
    // La ligne quitte « Publié » quand QuickBooks a pris le geste.
    const gone = await waitUntil(async () => !(await page.evaluate(scanRows)).some((r) => r.text === pick[0].text), 20_000)
    const capture = await shot(gone ? 'annulee' : 'incertain')
    try { saveBridgeSession('quickbooks', await opened.context.storageState()) } catch { /* l'ancienne reste */ }
    if (!gone) return done({ ok: false, error: 'QuickBooks n\'a pas confirmé l\'annulation', capture })
    return done({ ok: true, row: pick[0].text, capture })
  } catch (e) {
    return done({ ok: false, error: e.message, capture: await shot('erreur') })
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}
