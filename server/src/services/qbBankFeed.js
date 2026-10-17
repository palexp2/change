// FLUX BANCAIRE QUICKBOOKS (« Opérations bancaires ») PILOTÉ DEPUIS BORÉAL.
//
// Boréal pose déjà le lien ligne de relevé ↔ écriture QuickBooks
// (qb_txn_type / qb_txn_id). Mais la ligne téléchargée par QuickBooks reste
// « En attente » tant que personne ne l'a appariée dans son écran — et
// « Publier » y créerait un doublon de l'écriture déjà liée. L'API n'a aucun
// accès au flux : ce robot fait les gestes de l'interface (Charles,
// 2026-10-10 : « toutes les actions proposées, je veux les faire de notre
// section transactions »).
//
//   matchFeed   apparie chaque ligne en attente à l'écriture DÉJÀ liée dans
//               Boréal : « Trouver d'autres correspondances » → la seule ligne
//               à cette date, ce montant (et ce type / tiers au besoin) →
//               Différence 0 → « Apparier »
//   excludeFeed exclut une ligne du flux (case + « Exclure »)
//
// Garde-fous : aucune case cochée si plus d'un enregistrement correspond ;
// « Apparier » seulement si QuickBooks affiche une différence nulle.

import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { launchContext } from './scrapers/browser.js'
import { checkSession, loadAccount, CAPTURE_DIR } from './qbReconcileRobot.js'
import { QB_APP_HOST, getQbRealmIdSync, qbGet } from '../connectors/quickbooks.js'
import { listQbBankAccounts } from './bankQbLink.js'
import { fetchQbEntry } from './qbEntry.js'
import { saveBridgeSession } from './scrapers/bridgeSessions.js'
import { logSync } from './syncLog.js'
import db from '../db/database.js'

const MODULE = 'bank:qb-feed'
const DATE_DRIFT_DAYS = 3
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const round2 = (n) => Math.round(n * 100) / 100
// « 6 122,42 $ », « -178,64 $ » → 6122.42 / -178.64
const parseMoney = (s) => {
  const t = String(s || '').replace(/[^\d,.-]/g, '').replace(',', '.')
  return t && /\d/.test(t) ? Number(t) : null
}
// Libellé de la case de sélection d'une ligne du flux : « … -$6,122.42 ».
const enAmount = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const words = (s) => (String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z]{3,}/g) || [])

// Type d'écriture Boréal → libellé de la colonne « Type » du panneau QBO.
const PANEL_TYPE = {
  expense: 'Dépense',
  check: 'Chèque',
  creditcardcredit: 'Crédit',
  billpayment: 'Paiement de facture',
  deposit: 'Dépôt',
  transfer: 'Virement',
  journal: 'Écriture de journal',
  recvpayment: 'Paiement',
  salesreceipt: 'Reçu de vente',
  refundreceipt: 'Remboursement',
  creditcardpayment: 'Paiement par carte',
  salestaxpayment: 'taxe',
}

async function waitUntil(fn, ms) {
  const until = Date.now() + ms
  do {
    if (await fn().catch(() => false)) return true
    await sleep(250)
  } while (Date.now() < until)
  return false
}

/* global document */
// Lignes de l'onglet « En attente » telles que QuickBooks les montre.
function readPendingRows() {
  return [...document.querySelectorAll('tr')].map((tr) => {
    const cb = tr.querySelector('input[type=checkbox][aria-label^="Sélectionner l’opération "]')
    if (!cb) return null
    const label = cb.getAttribute('aria-label').replace('Sélectionner l’opération ', '')
    const m = label.match(/^(\d{4}-\d{2}-\d{2}) (.*) (-?\$[\d,]+\.\d{2})$/)
    if (!m) return null
    const cells = [...tr.querySelectorAll('td')]
    const sugg = cells.length > 2 ? cells[cells.length - 2].innerText.replace(/\s+/g, ' ').replace(/ Apparier Catégoriser$/, '').trim() : ''
    const action = cells.length ? cells[cells.length - 1].innerText.trim() : ''
    return { key: label, date: m[1], description: m[2], amount: Number(m[3].replace(/[$,]/g, '')), suggestion: sugg, action }
  }).filter(Boolean)
}

// Navigateur ouvert sur « Opérations bancaires » (session du module Chrome).
async function openBanking() {
  const s = checkSession()
  if (!s.session) return { error: s.hint || 'Session QuickBooks absente' }
  const opened = await launchContext({ storageState: s.session.state })
  const page = await opened.context.newPage()
  await page.setViewportSize({ width: 1800, height: 1300 })
  const ctx = { browser: opened.browser, context: opened.context, page }
  await page.goto(`${QB_APP_HOST}/app/banking?deeplinkcompanyid=${getQbRealmIdSync()}`, { waitUntil: 'domcontentloaded' })
  if (!await waitUntil(async () => (await page.locator('.qbo-account-card:visible').count()) > 0, 60_000)) {
    const body = await page.locator('body').innerText().catch(() => '')
    return { ...ctx, error: /connexion|sign in|identit/i.test(body) ? s.hint || 'Session QuickBooks expirée' : 'Opérations bancaires introuvables' }
  }
  // Bandeau de témoins : il intercepte les clics.
  await page.evaluate(() => document.querySelector('#onetrust-reject-all-handler, #onetrust-accept-btn-handler')?.click()).catch(() => {})
  return ctx
}

// Affiche le compte Boréal dans l'écran déjà ouvert, onglet « En attente ».
// `absent: true` quand QuickBooks ne télécharge pas ce compte.
async function selectAccount(ctx, bankAccountId) {
  const { page } = ctx
  const { qbId, error } = loadAccount(bankAccountId)
  if (error) return { error }
  const qbAcct = (await listQbBankAccounts().catch(() => [])).find((a) => a.id === qbId)
  if (!qbAcct) return { error: 'Compte QuickBooks introuvable' }
  const title = [qbAcct.acctnum, qbAcct.name].filter(Boolean).join(' ')
  // La carte visible porte le nom seul (« Comptes chèque Desjardins Ste-Foy ») ;
  // d'autres éléments masqués portent « numéro + nom ».
  const card = page.locator('.qbo-account-card:visible')
    .filter({ has: page.locator(`[title="${qbAcct.name}"], [title="${title}"], [title$=":${qbAcct.name}"]`) }).first()
  if (!await waitUntil(async () => (await card.count()) > 0, 5_000)) return { absent: true, error: `Compte « ${title} » absent des Opérations bancaires` }
  // QuickBooks rouvre le dernier compte consulté : on clique la carte jusqu'à
  // ce que l'en-tête affiche CE compte — sinon on apparierait ailleurs.
  // Sous-compte : l'en-tête peut montrer « Parent:Nom » ou « Nom ».
  const showing = () => page.evaluate((name) => [...document.querySelectorAll('h1,h2,h3,h4,button,span,div')]
    .some((n) => {
      if (n.childElementCount !== 0 || n.closest('[title]')) return false
      const t = n.textContent.trim()
      return t === name || t.endsWith(`:${name}`)
    }), String(qbAcct.name).trim())
  const switched = await waitUntil(async () => {
    if (await showing()) return true
    // Le menu de gauche recouvre parfois la première carte : clic JS en secours.
    await card.click({ timeout: 3_000 }).catch(() => card.evaluate((n) => n.click()).catch(() => {}))
    await sleep(2500)
    return showing()
  }, 40_000)
  if (!switched) return { error: `Impossible d'afficher le compte « ${title} » dans QuickBooks` }
  const tab = page.locator('button[aria-label^="REVIEW"]:visible').first()
  if (!await waitUntil(async () => (await tab.count()) > 0, 20_000)) return { error: 'Onglet « En attente » introuvable' }
  await tab.click()
  // La liste se recharge : on attend des lignes stables (ou un onglet vide).
  let last = -1
  await waitUntil(async () => {
    const n = (await page.evaluate(readPendingRows)).length
    const stable = n === last && (n > 0 || /En attente \(0\)/.test(await tab.innerText()))
    last = n
    return stable
  }, 25_000)
  await sleep(1000)
  return { title }
}

// Un seul passage du robot à la fois (bouton, exclusion ou passage horaire).
let busy = false
export const isFeedRobotBusy = () => busy

// Dernier passage par compte (bouton ou horaire), pour la pastille « Flux QB ».
const lastRun = new Map()
export const lastFeedRun = (accountId) => lastRun.get(accountId) || null
export function recordFeedRun(accountId, out) {
  const results = out.results || []
  const failed = results.filter((r) => !r.ok && !r.skipped)
  const last = {
    at: new Date().toISOString(), ok: !!out.ok, error: out.error || null,
    matched: results.filter((r) => r.ok).length, skipped: results.filter((r) => r.skipped).length,
    failed: failed.map((f) => ({ row: f.row || null, txn_id: f.txn_id || null, error: f.error })),
    capture: out.capture || null,
  }
  lastRun.set(accountId, last)
  return last
}

async function openFeed(bankAccountId) {
  const ctx = await openBanking()
  if (ctx.error) return ctx
  const sel = await selectAccount(ctx, bankAccountId)
  return sel.error ? { ...ctx, error: sel.error } : { ...ctx, title: sel.title }
}

async function shot(page, suffix) {
  if (!page) return null
  if (!existsSync(CAPTURE_DIR)) mkdirSync(CAPTURE_DIR, { recursive: true })
  const name = `${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}-flux-${suffix}.png`
  await page.screenshot({ path: join(CAPTURE_DIR, name) }).catch(() => {})
  return name
}

async function close(ctx) {
  if (!ctx?.browser) return
  try { saveBridgeSession('quickbooks', await ctx.context.storageState()) } catch { /* l'ancienne reste */ }
  await ctx.browser.close().catch(() => {})
}

// Transaction Boréal correspondant à une ligne du flux : même compte, même
// date, même montant signé. Plusieurs (deux virements identiques le même
// jour) : celles qui restent, dans l'ordre — le panneau ne montre plus les
// écritures déjà appariées.
function boreal(bankAccountId, row) {
  const at = (from, to) => db.prepare(`
    SELECT * FROM bank_transactions
    WHERE account_id = ? AND txn_date BETWEEN ? AND ? AND ROUND(amount, 2) = ? AND deleted_at IS NULL
    ORDER BY ABS(julianday(txn_date) - julianday(?)), created_at
  `).all(bankAccountId, from, to, round2(row.amount), row.date)
  const exact = at(row.date, row.date)
  if (exact.length) return exact
  // QuickBooks date la ligne au jour de l'achat, le relevé (donc Boréal) au
  // jour d'inscription : un à trois jours d'écart sur les cartes. Seulement si
  // un seul mouvement de ce montant tombe dans la fenêtre.
  const d = (n) => new Date(Date.parse(row.date) + n * 864e5).toISOString().slice(0, 10)
  const near = at(d(-DATE_DRIFT_DAYS), d(DATE_DRIFT_DAYS))
  return near.length === 1 ? near : []
}

// Une écriture déjà rapprochée (colonne « Comp. » = R) n'est plus proposée par
// QuickBooks : la ligne du flux qui lui correspond n'a plus qu'à être exclue.
async function isReconciled(entry) {
  try {
    const q = `start_date=${entry.date}&end_date=${entry.date}&columns=txn_type,name,subt_nat_home_amount,is_cleared&minorversion=75`
    const r = await qbGet(`/reports/TransactionList?${q}`)
    return (r.Rows?.Row || []).some((row) => {
      const c = (row.ColData || []).map((x) => x.value)
      return c.includes('R') && c.some((v) => Math.abs(Math.abs(Number(v)) - Math.abs(entry.total)) < 0.005)
        && (!entry.party || c.includes(entry.party))
    })
  } catch {
    return false
  }
}

// Ouvre le panneau « Trouver d'autres correspondances » d'une ligne.
// Les lignes du flux sont des « fantômes » tant qu'on n'y a pas cliqué : le
// premier clic les rend actives (et change leurs boutons), le second agit.
async function openMatchPanel(page, row) {
  const tr = page.locator('tr').filter({ has: page.locator(`input[aria-label="Sélectionner l’opération ${row.key}"]`) }).first()
  if (!await tr.count()) return { error: 'Ligne disparue du flux' }
  const panel = page.locator('.idsTrowser:visible').filter({ hasText: 'Trouver d’autres correspondances' }).first()
  // Le lien vit dans le volet déplié SOUS la ligne (un autre volet peut rester ouvert ailleurs).
  const more = tr.locator('xpath=following-sibling::tr[1]').getByRole('button', { name: /Trouver d’autres correspondances/ }).first()
  const click = (loc) => loc.click({ timeout: 5_000 }).catch(() => {})
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await panel.count()) return { panel }
    if (await more.count()) {
      await click(more)
    } else if (await tr.getByRole('button', { name: 'Trouver une correspondance' }).count()) {
      await click(tr.getByRole('button', { name: 'Trouver une correspondance' }).first())
    } else if (await tr.locator('[aria-label="Match"][aria-pressed="false"], li[aria-label="Apparier"][aria-pressed="false"]').count()) {
      // Ligne en mode « Catégoriser » : basculer sur « Apparier » ouvre le panneau.
      await click(tr.locator('[aria-label="Match"][aria-pressed="false"], li[aria-label="Apparier"][aria-pressed="false"]').first())
    } else {
      // Suggestion de QuickBooks : la déplier fait paraître « Trouver d'autres correspondances ».
      await click(tr.locator('td:nth-last-child(2) div[role=button]').first())
    }
    await waitUntil(async () => (await panel.count()) > 0 || (await more.count()) > 0, 4_000)
  }
  if (await panel.count()) return { panel }
  return { error: 'Panneau de correspondance introuvable' }
}

function readPanelRows(d) {
  return [...d.querySelectorAll('tbody tr')].map((tr, i) => {
    const c = [...tr.querySelectorAll('td')].map((td) => td.innerText.trim())
    if (!tr.querySelector('input[type=checkbox]') || !/^\d{4}-\d{2}-\d{2}$/.test(c[1] || '')) return null
    tr.dataset.matchRow = String(i)
    return { i, date: c[1], type: c[2], ref: c[3], payee: c[4], amount: c[5] }
  }).filter(Boolean)
}

// Apparie UNE ligne du flux (déjà à l'écran) à l'écriture QuickBooks donnée.
async function matchOne(page, row, entry, { dryRun }) {
  const opened = await openMatchPanel(page, row)
  if (opened.error) return { ok: false, error: opened.error }
  const { panel } = opened
  const cancel = async () => {
    await panel.getByRole('button', { name: /^(Cancel|Annuler)$/ }).first().click({ timeout: 5_000 }).catch(() => {})
    // « Quitter sans apparier ? » quand une case était cochée.
    await page.locator('button:visible').filter({ hasText: /^Quitter$/ }).first().click({ timeout: 3_000 }).catch(() => {})
    await sleep(1500)
  }
  try {
    const sameAmount = (c) => Math.abs(Math.abs(parseMoney(c.amount)) - Math.abs(entry.total)) < 0.005
    // Le panneau ne liste que les écritures pas encore appariées de la
    // période : en général une page suffit. Sinon, recherche par montant
    // (QuickBooks la veut sans zéros inutiles : « 13.5 », « 10000 »).
    let cands = []
    await waitUntil(async () => (cands = await panel.evaluate(readPanelRows)).length > 0, 15_000)
    if (!cands.some(sameAmount) && /de\s+[2-9]/.test(await panel.innerText())) {
      const search = panel.locator('input[aria-label="Rechercher"]').first()
      await search.fill(String(Math.abs(entry.total)))
      await search.press('Enter')
      await waitUntil(async () => (cands = await panel.evaluate(readPanelRows)).some(sameAmount), 10_000)
    }
    let hits = cands.filter((c) => c.date === entry.date && sameAmount(c))
    const typeLabel = PANEL_TYPE[entry.entity]
    if (hits.length > 1 && typeLabel) hits = hits.filter((c) => c.type.toLowerCase().includes(typeLabel.toLowerCase()))
    if (hits.length > 1 && entry.party) {
      const w = words(entry.party)[0]
      if (w) hits = hits.filter((c) => words(c.payee).includes(w))
    }
    if (hits.length > 1 && entry.doc_number) hits = hits.filter((c) => c.ref === entry.doc_number)
    if (hits.length !== 1) {
      await cancel()
      if (hits.length) return { ok: false, error: `${hits.length} écritures possibles — rien d'apparié` }
      if (await isReconciled(entry)) return { ok: false, reconciled: true, error: `${entry.type_label} du ${entry.date} (${entry.total} $) déjà rapproché dans QuickBooks — ligne à exclure` }
      return { ok: false, error: `Écriture ${entry.type_label} du ${entry.date} (${entry.total} $) absente des correspondances QuickBooks` }
    }
    const hit = hits[0]
    if (dryRun) { await cancel(); return { ok: true, dryRun: true, with: `${hit.date} ${hit.type} ${hit.payee} ${hit.amount}` } }
    // Case maison : on clique son étiquette (l'input est masqué, check() échoue).
    await panel.locator(`tr[data-match-row="${hit.i}"] label`).first().click({ timeout: 5_000 })
    // QuickBooks recalcule « Différence » : on n'apparie qu'à 0,00 $.
    const zero = await waitUntil(async () => {
      const t = await panel.innerText()
      // Libellés puis valeurs : « …Différence :\n6 122,42 $\n0,00 $\n0,00 $ ».
      const m = t.match(/Différence\s*:\s*\n([^\n]+)\n([^\n]+)\n([^\n]+)/)
      return m && Math.abs(parseMoney(m[3])) < 0.005
    }, 8_000)
    if (!zero) { await cancel(); return { ok: false, error: 'Différence non nulle dans QuickBooks — rien d’apparié' } }
    await panel.locator('button').filter({ hasText: /^Apparier$/ }).last().click({ timeout: 10_000 })
    const gone = await waitUntil(async () => (await panel.count()) === 0
      && !(await page.evaluate(readPendingRows)).some((r) => r.key === row.key), 30_000)
    if (!gone) return { ok: false, error: 'QuickBooks n’a pas confirmé l’appariement' }
    return { ok: true, with: `${hit.date} ${hit.type} ${hit.payee} ${hit.amount}` }
  } catch (e) {
    await cancel()
    return { ok: false, error: e.message }
  }
}

// La pièce liée dans Boréal (reçu, facture d'achat) doit confirmer l'écriture
// avant qu'on apparie (Charles, 2026-10-10) : même montant que le débit, et
// soit c'est la pièce qui a produit l'écriture, soit c'est le même fournisseur.
// Pas de pièce (virement, frais bancaires) : rien à contredire.
export function docProof(txn, entry, accountCurrency = 'CAD') {
  if (!txn.matched_type || !txn.matched_id || txn.matched_type === 'stripe_payout') return { ok: true, doc: null }
  const amount = Math.abs(round2(txn.amount))
  let doc
  if (txn.matched_type === 'receipt') {
    const r = db.prepare('SELECT company, total, currency, bank_charged_total, quickbooks_id, accrual_payment_qb_id, status FROM sale_receipts WHERE id = ? AND deleted_at IS NULL').get(String(txn.matched_id))
    if (!r) return { ok: false, reason: 'Pièce liée introuvable' }
    if (r.status !== 'done') return { ok: false, reason: 'Pièce liée pas encore lue' }
    doc = { label: 'reçu', vendor: r.company, ids: [r.quickbooks_id, r.accrual_payment_qb_id],
      total: r.bank_charged_total ?? ((r.currency || 'CAD') === accountCurrency ? r.total : null) }
  } else if (txn.matched_type === 'achat') {
    const a = db.prepare('SELECT vendor, total_cad, quickbooks_id FROM achats_fournisseurs WHERE id = ?').get(String(txn.matched_id))
    if (!a) return { ok: false, reason: 'Achat lié introuvable' }
    doc = { label: 'achat', vendor: a.vendor, ids: [a.quickbooks_id], total: accountCurrency === 'CAD' ? a.total_cad : null }
  } else {
    return { ok: true, doc: null }
  }
  const sameId = doc.ids.filter(Boolean).map(String).includes(String(entry.qb_id))
  const v = words(doc.vendor)
  const sameVendor = !!entry.party && words(entry.party).some((w) => v.includes(w))
  if (doc.total != null && Math.abs(Number(doc.total) - amount) > 0.02) {
    return { ok: false, reason: `Pièce liée (${doc.label} ${doc.vendor || ''}) à ${doc.total} $, débit à ${amount} $` }
  }
  if (!sameId && !sameVendor) {
    return { ok: false, reason: `Pièce liée (${doc.label} ${doc.vendor || '?'}) ≠ écriture QuickBooks (${entry.party || entry.type_label})` }
  }
  return { ok: true, doc: doc.label }
}

// Apparie les lignes « En attente » du compte déjà affiché.
async function matchRows(page, bankAccountId, { txnIds = null, dryRun = false } = {}) {
  const results = []
  const rows = await page.evaluate(readPendingRows)
  const used = new Set()
  for (const row of rows) {
    const txn = boreal(bankAccountId, row).find((t) => !used.has(t.id) && t.qb_txn_id && t.qb_txn_type)
    if (!txn) {
      if (!txnIds) results.push({ row: row.key, ok: false, skipped: true, error: 'Aucune écriture liée dans Boréal' })
      continue
    }
    used.add(txn.id)
    if (txnIds && !txnIds.includes(txn.id)) continue
    const entry = await fetchQbEntry(txn.qb_txn_type, txn.qb_txn_id)
    if (!entry.readable || entry.total == null || !entry.date) {
      results.push({ row: row.key, txn_id: txn.id, ok: false, error: entry.reason || 'Écriture QuickBooks illisible' })
      continue
    }
    const currency = db.prepare('SELECT currency FROM bank_accounts WHERE id = ?').get(bankAccountId)?.currency || 'CAD'
    const proof = docProof(txn, entry, currency)
    if (!proof.ok) {
      results.push({ row: row.key, txn_id: txn.id, ok: false, error: `${proof.reason} — rien d'apparié` })
      continue
    }
    let r = await matchOne(page, row, entry, { dryRun })
    // L'écriture liée est déjà rapprochée dans QuickBooks : la ligne du flux
    // fait doublon, on l'exclut (réversible dans l'onglet « Exclues »).
    if (r.reconciled && !dryRun) {
      const x = await excludeRow(page, row).catch((e) => ({ ok: false, error: e.message }))
      r = x.ok ? { ok: true, excluded: true, with: `exclue (${entry.type_label} du ${entry.date} déjà rapproché)` } : { ...r, error: `${r.error} ; exclusion ratée : ${x.error}` }
    }
    results.push({ row: row.key, txn_id: txn.id, ...r })
  }
  if (txnIds) {
    for (const id of txnIds) {
      if (!results.some((r) => r.txn_id === id)) results.push({ txn_id: id, ok: false, error: 'Pas en attente dans QuickBooks' })
    }
  }
  return results
}

/**
 * Apparie, dans le flux QuickBooks, les lignes « En attente » du compte à
 * l'écriture que Boréal leur a déjà liée. `txnIds` limite aux transactions
 * données ; sans, toutes les lignes en attente qui ont un lien.
 */
export async function matchFeed(bankAccountId, opts = {}) {
  if (busy) return { ok: false, error: 'Le robot du flux QuickBooks est déjà en cours', results: [] }
  busy = true
  const t0 = Date.now()
  let ctx
  let results = []
  try {
    ctx = await openFeed(bankAccountId)
    if (ctx.error) return { ok: false, error: ctx.error, capture: await shot(ctx.page, 'apparier'), results }
    results = await matchRows(ctx.page, bankAccountId, opts)
    const failed = results.filter((r) => !r.ok && !r.skipped)
    logSync(MODULE, 'manual', { status: failed.length ? 'error' : 'success', error: failed.map((f) => f.error).join(' · ') || null, durationMs: Date.now() - t0 })
    return { ok: true, results, capture: failed.length ? await shot(ctx.page, 'apparier-echecs') : null }
  } catch (e) {
    return { ok: false, error: e.message, results, capture: await shot(ctx?.page, 'apparier-erreur') }
  } finally {
    await close(ctx)
    busy = false
  }
}

/**
 * Passage horaire : tous les comptes Boréal mappés que QuickBooks télécharge,
 * dans un seul navigateur. Retourne un résultat par compte visité.
 */
export async function matchAllFeeds() {
  if (busy) return { ok: false, error: 'Le robot du flux QuickBooks est déjà en cours', accounts: [] }
  busy = true
  const accounts = []
  let ctx
  try {
    ctx = await openBanking()
    if (ctx.error) return { ok: false, error: ctx.error, accounts }
    const list = db.prepare(`SELECT id, name FROM bank_accounts WHERE qb_account_id IS NOT NULL AND qb_account_id != '' AND name NOT LIKE 'ZZ %' ORDER BY name`).all()
    for (const a of list) {
      try {
        let sel = await selectAccount(ctx, a.id)
        if (sel.error && !sel.absent) {
          // L'écran se coince parfois : on le recharge une fois.
          await ctx.page.reload({ waitUntil: 'domcontentloaded' })
          await waitUntil(async () => (await ctx.page.locator('.qbo-account-card:visible').count()) > 0, 60_000)
          sel = await selectAccount(ctx, a.id)
        }
        if (sel.absent) continue
        if (sel.error) { accounts.push({ account_id: a.id, account: a.name, ok: false, error: sel.error, results: [] }); continue }
        const results = await matchRows(ctx.page, a.id)
        recordFeedRun(a.id, { ok: true, results })
        accounts.push({ account_id: a.id, account: a.name, ok: true, results })
      } catch (e) {
        accounts.push({ account_id: a.id, account: a.name, ok: false, error: e.message, results: [] })
      }
    }
    return { ok: true, accounts }
  } catch (e) {
    return { ok: false, error: e.message, accounts }
  } finally {
    await close(ctx)
    busy = false
  }
}

// Exclut une ligne déjà à l'écran : case de la ligne → « Exclure » (barre de sélection).
async function excludeRow(page, row) {
  const cb = page.locator(`input[aria-label="Sélectionner l’opération ${row.key}"]`).first()
  await cb.check({ force: true, timeout: 5_000 })
  const btn = page.locator('button:visible').filter({ hasText: /^Exclure$/ }).first()
  if (!await waitUntil(async () => (await btn.count()) > 0, 8_000)) return { ok: false, error: 'Bouton « Exclure » introuvable', capture: await shot(page, 'exclure') }
  await btn.click()
  // Une confirmation peut suivre.
  const confirm = page.locator('[role=dialog] button:visible').filter({ hasText: /^(Exclure|Oui|Confirmer)$/ }).first()
  if (await waitUntil(async () => (await confirm.count()) > 0, 3_000)) await confirm.click()
  const gone = await waitUntil(async () => !(await page.evaluate(readPendingRows)).some((r) => r.key === row.key), 20_000)
  if (!gone) return { ok: false, error: 'QuickBooks n’a pas confirmé l’exclusion', capture: await shot(page, 'exclure-incertain') }
  return { ok: true, row: row.key }
}

/** Exclut une ligne du flux QuickBooks (onglet « En attente » → « Exclues »). */
export async function excludeFeed(bankAccountId, txnId) {
  const txn = db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(txnId)
  if (!txn) return { ok: false, error: 'Transaction introuvable' }
  const amt = enAmount(round2(txn.amount))
  if (busy) return { ok: false, error: 'Le robot du flux QuickBooks est déjà en cours' }
  busy = true
  let ctx
  try {
    ctx = await openFeed(bankAccountId)
    if (ctx.error) return { ok: false, error: ctx.error }
    const rows = (await ctx.page.evaluate(readPendingRows)).filter((r) => r.key.endsWith(` ${amt}`) && boreal(bankAccountId, r).some((t) => t.id === txn.id))
    if (rows.length !== 1) return { ok: false, error: rows.length ? `${rows.length} lignes identiques en attente — rien d'exclu` : 'Pas en attente dans QuickBooks' }
    return await excludeRow(ctx.page, rows[0])
  } catch (e) {
    return { ok: false, error: e.message, capture: await shot(ctx?.page, 'exclure-erreur') }
  } finally {
    await close(ctx)
    busy = false
  }
}
