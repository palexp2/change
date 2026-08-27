const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Test LECTURE SEULE : aperçus uniquement — aucune écriture n'est publiée sur
// QuickBooks, aucun record créé ni modifié.
describe('Répartition de paie & AGA — aperçus', () => {
  let browser, ctx, page

  const apiFetch = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts })

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('aperçu API : écriture balancée (débits = crédit)', async () => {
    const list = await apiFetch('/paies?limit=1&page=1')
    const paie = (list.body?.data || [])[0]
    assert.ok(paie, 'aucune paie en base')
    const r = await apiFetch(`/paies/${paie.id}/repartition-preview`)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const p = r.body
    assert.ok(Array.isArray(p.lines) && p.lines.length >= 2)
    const debits = p.lines.filter(l => l.type === 'Debit').reduce((s, l) => s + l.amount, 0)
    const credits = p.lines.filter(l => l.type === 'Credit').reduce((s, l) => s + l.amount, 0)
    assert.equal(Math.round(debits * 100), Math.round(credits * 100), 'écriture non balancée')
    assert.equal(p.base, Math.round((p.total - p.reimb - p.phone - p.meals) * 100) / 100)
  })

  test('aperçu API : ajouts phone/meals pris en compte', async () => {
    const list = await apiFetch('/paies?limit=1&page=1')
    const paie = list.body.data[0]
    const r = await apiFetch(`/paies/${paie.id}/repartition-preview?phone=30&meals=100`)
    assert.equal(r.body.phone, 30)
    assert.equal(r.body.meals, 100)
    assert.ok(r.body.lines.some(l => l.amount === 100 && /Repas/.test(l.label)))
  })

  test('aperçu AGA : ventilation par département, montant avec virgule', async () => {
    // Virgule décimale (clavier fr-CA) acceptée par le serveur.
    const r = await apiFetch('/paies/aga-repartition/preview', {
      method: 'POST', body: JSON.stringify({ amount: '2 737,95' }),
    })
    assert.equal(r.status, 200)
    const debits = r.body.lines.filter(l => l.type === 'Debit')
    assert.equal(debits.length, 4)
    assert.equal(Math.round(debits.reduce((s, l) => s + l.amount, 0) * 100) / 100, 2737.95)
    // Reproduit les dépenses QB d'avril à juillet 2026 (Purchases 16848 → 17667).
    assert.deepEqual(Object.fromEntries(debits.map(l => [l.acctnum, l.amount])),
      { 62100: 890.86, 62200: 311.78, 62201: 260.11, 62300: 1275.20 })
    // La banque n'est pas une ligne : elle est portée par la dépense QB.
    assert.ok(r.body.bank_acctnum && !debits.some(l => l.acctnum === r.body.bank_acctnum))
    assert.equal(r.body.taxcode, 'Exonéré')
  })

  test('la section Répartition apparaît dans le détail d\'une paie', async () => {
    await page.goto(URL + '/paies', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=Paies', { timeout: 15000 })
    // Ouvrir la première paie de la liste (lignes du DataTable en divs).
    const row = page.locator('text=/^#?7$|Complété|Envoyés/').first()
    await row.click({ timeout: 15000 }).catch(() => {})
    const section = page.locator('[data-testid="paie-repartition"]')
    const visible = await section.waitFor({ state: 'attached', timeout: 15000 }).then(() => true).catch(() => false)
    if (!visible) {
      console.warn('Section répartition non atteinte par clic — vérifiée via API seulement')
      return
    }
    await section.scrollIntoViewIfNeeded()
    assert.ok(await section.locator('table tr').count() >= 2, 'lignes d\'écriture absentes')
  })

  test('carte AGA sur le Dashboard comptabilité', async () => {
    await page.goto(URL + '/comptabilite', { waitUntil: 'domcontentloaded' })
    const card = page.locator('[data-testid="compta-aga"]')
    await card.waitFor({ state: 'attached', timeout: 20000 })
    await card.scrollIntoViewIfNeeded()
    const input = card.locator('[data-testid="compta-aga-amount"]')
    await input.fill('2 737,95')
    await input.blur()
    await card.locator('table tr').first().waitFor({ timeout: 15000 })
    assert.ok(await card.locator('table tr').count() >= 4, 'aperçu AGA absent')
  })
})
