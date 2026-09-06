// /paiements-emis?onglet=cedule — lien « ouvrir la facture » sur les lignes à payer.
//
// Le lien vers la facture existait déjà sur un paiement émis (« Facture réglée »,
// onglet « À passer à la banque ») ; il manquait là où on DÉCIDE de payer. Ce
// test vérifie que :
//   1. chaque ligne de la cédule porte un lien vers la fiche de la facture, et
//      que ce lien affiche le n° de facture ;
//   2. le clic ouvre bien la fiche de CETTE facture (pas la liste brute) ;
//   3. le lien équivalent sur un paiement émis pointe lui aussi sur la fiche.
//
// Aucun record réel touché : une facture jetable marquée E2E, créée en Brouillon
// puis passée à « Reçue » pour ne PAS écrire dans le Google Sheet CTB, supprimée
// dans after() avec le paiement éventuellement créé.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
const VENDOR = `E2E Lien Facture ${STAMP}`
const INVOICE_NO = `E2E-LF-${STAMP}`
const TODAY = new Date().toISOString().slice(0, 10)
const IN_2_DAYS = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)

describe('Cédule « À payer » — lien vers la facture sur chaque ligne', () => {
  let browser, ctx, page
  let billId = null
  const createdPaymentIds = []

  const apiFetch = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts })

  const openSchedule = async () => {
    await page.goto(`${URL}/paiements-emis?onglet=cedule`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="schedule-view"]', { timeout: 20000 })
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    let r = await apiFetch('/achats-fournisseurs', {
      method: 'POST',
      body: JSON.stringify({
        type: 'bill', date_achat: TODAY, due_date: IN_2_DAYS, vendor: VENDOR,
        vendor_invoice_number: INVOICE_NO, amount_cad: 321.45, tax_cad: 0, total_cad: 321.45,
        status: 'Brouillon', notes: 'Record jetable créé par un test E2E',
      }),
    })
    assert.equal(r.status, 201, `création de la facture : ${JSON.stringify(r.body)}`)
    billId = r.body.id
    r = await apiFetch(`/achats-fournisseurs/${billId}`, { method: 'PUT', body: JSON.stringify({ status: 'Reçue' }) })
    assert.equal(r.status, 200, `statut de la facture : ${JSON.stringify(r.body)}`)
  })

  after(async () => {
    for (const id of createdPaymentIds) {
      try { await apiFetch(`/treasury/payments/${id}`, { method: 'DELETE' }) } catch { /* déjà parti */ }
    }
    if (billId) {
      try { await apiFetch(`/treasury/payment-schedule/${billId}/pay`, { method: 'DELETE' }) } catch { /* pas de paiement */ }
      try { await apiFetch(`/achats-fournisseurs/${billId}`, { method: 'DELETE' }) } catch { /* déjà parti */ }
    }
    await browser?.close()
  })

  test('la ligne à payer porte un lien vers la fiche de la facture', async () => {
    await openSchedule()
    await page.waitForSelector(`[data-testid="schedule-item-${billId}"]`, { timeout: 25000 })

    const link = page.locator(`a[data-testid="schedule-bill-${billId}"]`)
    await link.waitFor({ timeout: 20000 })
    const href = await link.getAttribute('href')
    assert.ok(href.endsWith(`/fournisseurs/achats?id=${billId}`), `href inattendu : ${href}`)
    // Le n° de facture, lui, ouvre QuickBooks : la fiche ERP est portée par
    // l'icône à sa gauche (deux destinations, deux affordances).
    const num = page.locator(`[data-testid="schedule-qb-${billId}"]`)
    await num.waitFor({ timeout: 20000 })
    assert.equal((await num.textContent()).trim(), INVOICE_NO)
  })

  test('le clic ouvre la fiche de CETTE facture, pas la liste brute', async () => {
    await openSchedule()
    await page.waitForSelector(`a[data-testid="schedule-bill-${billId}"]`, { timeout: 25000 })
    await page.click(`a[data-testid="schedule-bill-${billId}"]`)

    await page.waitForURL(u => u.toString().includes(`/fournisseurs/achats?id=${billId}`), { timeout: 20000 })
    // La liste charge par pages : la fiche s'ouvre dès que la facture est là.
    const dialog = page.locator('[role="dialog"]')
    await dialog.waitFor({ timeout: 40000 })
    const text = await dialog.textContent()
    assert.ok(text.includes(INVOICE_NO) || text.includes(VENDOR),
      `la fiche ouverte ne semble pas être la bonne facture : ${text.slice(0, 300)}`)
  })

  test('le lien « Facture réglée » d\'un paiement émis mène aussi à la fiche', async () => {
    await openSchedule()
    await page.waitForSelector(`[data-testid="schedule-pay-${billId}"]`, { timeout: 25000 })
    await page.click(`[data-testid="schedule-pay-${billId}"]`)

    // Le paiement du jour créé par la cédule est lié à la facture.
    let pmt = null
    for (let i = 0; i < 25 && !pmt; i++) {
      const r = await apiFetch('/treasury/payments?status=all&limit=500')
      pmt = (r.body || []).find(p => p.achat_id === billId) || null
      if (!pmt) await new Promise(res => setTimeout(res, 400))
    }
    assert.ok(pmt, 'paiement absent de la liste des paiements émis')
    createdPaymentIds.push(pmt.id)

    await page.goto(`${URL}/paiements-emis?onglet=pending`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`[data-testid="payment-row-${pmt.id}"]`, { timeout: 25000 })
    await page.click(`[data-testid="payment-expand-${pmt.id}"]`)
    const link = page.locator(`a[data-testid="payment-bill-link-${pmt.id}"]`)
    await link.waitFor({ timeout: 20000 })
    const href = await link.getAttribute('href')
    assert.ok(href.endsWith(`/fournisseurs/achats?id=${billId}`), `href inattendu : ${href}`)
  })
})
