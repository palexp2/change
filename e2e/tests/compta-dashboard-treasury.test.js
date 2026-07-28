const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Dashboard comptabilité — projection BNC + saisie de solde', () => {
  let browser, ctx, page, balanceId, recurringId

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

  after(async () => {
    // Cleanup — s'exécute même en cas d'échec.
    try { if (balanceId) await apiFetch(`/treasury/balance/${balanceId}`, { method: 'DELETE' }) } catch {}
    try { if (recurringId) await apiFetch(`/treasury/recurring/${recurringId}`, { method: 'DELETE' }) } catch {}
    await browser?.close()
  })

  test('la page /comptabilite affiche les sections attendues', async () => {
    await page.goto(URL + '/comptabilite', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Dashboard comptabilité")', { timeout: 15000 })
    for (const id of ['treasury-section', 'compta-deferred-revenue', 'compta-missing-receipts']) {
      await page.waitForSelector(`[data-testid="${id}"]`, { state: 'attached', timeout: 20000 })
    }
    // La section « Banques & cartes de crédit » a été retirée du dashboard compta.
    assert.equal(await page.locator('[data-testid="compta-bank-accounts"]').count(), 0)
  })

  test('l\'endpoint projection renvoie une série quotidienne cohérente', async () => {
    const r = await apiFetch('/treasury/projection?days=30')
    assert.equal(r.status, 200)
    const b = r.body
    assert.ok(Array.isArray(b.days) && b.days.length >= 30, 'série quotidienne manquante')
    assert.equal(typeof b.min_balance, 'number')
    assert.equal(typeof b.threshold, 'number')
    // Chaque jour : balance = balance de la veille + delta.
    for (let i = 1; i < b.days.length; i++) {
      const expected = Math.round((b.days[i - 1].balance + b.days[i].delta) * 100) / 100
      assert.equal(b.days[i].balance, expected, `incohérence au jour ${b.days[i].date}`)
    }
  })

  test('noter un solde via l\'UI crée une entrée et met à jour la projection', async () => {
    await page.fill('[data-testid="treasury-balance-input"]', '47694')
    await page.click('[data-testid="treasury-balance-save"]')
    // L'entrée doit apparaître via l'API.
    let entry = null
    for (let i = 0; i < 40; i++) {
      const r = await apiFetch('/treasury/balances')
      entry = (r.body || []).find(e => e.balance === 47694)
      if (entry) break
      await new Promise(res => setTimeout(res, 300))
    }
    assert.ok(entry, 'saisie de solde introuvable via API')
    balanceId = entry.id
    // La projection repart de ce solde.
    const proj = await apiFetch('/treasury/projection')
    assert.equal(proj.body.balance_entry?.id, balanceId)
    assert.equal(proj.body.days[0].balance >= 0, true)
  })

  test('l\'endpoint projection expose la fenêtre d\'action (gestion au fur et à mesure)', async () => {
    const r = await apiFetch('/treasury/projection')
    const aw = r.body.action_window
    assert.ok(aw, 'action_window manquante')
    assert.ok(aw.days >= 1 && aw.days <= r.body.horizon_days)
    assert.equal(typeof aw.min_balance, 'number')
    // Le point bas de la fenêtre ne peut pas être plus bas que celui du plein horizon.
    assert.ok(aw.min_balance >= r.body.min_balance)
    // Le virement suggéré top-level = celui de la fenêtre d'action.
    assert.equal(r.body.suggested_transfer, aw.suggested_transfer)
  })

  test('montant variable : ne s\'applique qu\'à la prochaine occurrence', async () => {
    // Jour du mois = dans ~3 jours → première occurrence proche ; horizon 90 j
    // pour garantir qu'une mensualité fixe aurait ≥ 2 occurrences.
    const soon = new Date(Date.now() + 3 * 86400000)
    const day = Math.min(soon.getDate(), 28)
    const created = await apiFetch('/treasury/recurring', {
      method: 'POST',
      body: JSON.stringify({
        label: `E2E Variable ${Date.now()}`, amount: 777.77,
        frequency: 'monthly', day_of_month: day, variable_amount: 1,
      }),
    })
    assert.equal(created.status, 201)
    recurringId = created.body.id
    assert.equal(created.body.variable_amount, 1)
    assert.equal(created.body.amount_stale, 0, 'montant tout juste saisi — pas périmé')
    assert.ok(created.body.amount_applies_to, 'amount_applies_to manquant')

    const proj = await apiFetch('/treasury/projection?days=90')
    const occurrences = proj.body.days.flatMap(d => d.events).filter(e => e.ref === recurringId)
    assert.equal(occurrences.length, 1, `une seule occurrence attendue, trouvé ${occurrences.length}`)
    assert.equal(occurrences[0].date, created.body.amount_applies_to)

    // Re-saisir le montant met à jour l'horodatage (le montant reste applicable).
    const updated = await apiFetch(`/treasury/recurring/${recurringId}`, {
      method: 'PUT', body: JSON.stringify({ amount: 888.88 }),
    })
    assert.equal(updated.body.amount, 888.88)
    assert.equal(updated.body.amount_stale, 0)

    const del = await apiFetch(`/treasury/recurring/${recurringId}`, { method: 'DELETE' })
    assert.equal(del.status, 200)
    recurringId = null
  })

  test('la modale de sortie récurrente offre le type de montant fixe/variable', async () => {
    await page.goto(URL + '/comptabilite', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="recurring-add"]', { timeout: 20000 })
    await page.click('[data-testid="recurring-add"]')
    await page.waitForSelector('[data-testid="recurring-variable"]', { timeout: 10000 })
    const options = await page.locator('[data-testid="recurring-variable"] option').allInnerTexts()
    assert.ok(options.some(o => /variable/i.test(o)), 'option « Variable » absente')
    await page.keyboard.press('Escape')
  })

  test('CRUD d\'une sortie récurrente', async () => {
    const created = await apiFetch('/treasury/recurring', {
      method: 'POST',
      body: JSON.stringify({ label: `E2E Récurrente ${Date.now()}`, amount: 123.45, frequency: 'monthly', day_of_month: 15 }),
    })
    assert.equal(created.status, 201)
    recurringId = created.body.id
    const updated = await apiFetch(`/treasury/recurring/${recurringId}`, {
      method: 'PUT', body: JSON.stringify({ amount: 200 }),
    })
    assert.equal(updated.body.amount, 200)
    const del = await apiFetch(`/treasury/recurring/${recurringId}`, { method: 'DELETE' })
    assert.equal(del.status, 200)
    recurringId = null
  })
})
