const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Le champ « Mots-clés » d'un billet était un input texte libre affichant le
// tableau JSON brut (["capteur température","programme déshum"]). Il devient un
// champ de sélection multiple : pastilles retirables + menu recherchable
// alimenté par les mots-clés déjà utilisés, avec création d'une valeur libre.
// Le test travaille sur un billet créé pour l'occasion, supprimé dans after().
describe('Billets — mots-clés en sélection multiple', () => {
  let browser, ctx, page, token, ticketId

  const apiGet = () => page.evaluate(async ({ tok, id }) => {
    const r = await fetch(`/erp/api/tickets/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
    return r.json()
  }, { tok: token, id: ticketId })

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    const res = await page.evaluate(async (tok) => {
      const r = await fetch('/erp/api/tickets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `E2E mots-cles ${Date.now()}`, type: 'Support', status: 'Waiting on us' }),
      })
      return { status: r.status, data: await r.json() }
    }, token)
    assert.equal(res.status, 201, `create ticket: ${JSON.stringify(res.data)}`)
    ticketId = res.data.id
  })

  after(async () => {
    if (ticketId) {
      await page.evaluate(async ({ tok, id }) => {
        await fetch(`/erp/api/tickets/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } })
      }, { tok: token, id: ticketId })
    }
    await browser?.close()
  })

  test('sélection, création et retrait de mots-clés, persistés en tableau JSON', async () => {
    await page.goto(`${URL}/tickets/${ticketId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    const field = page.locator('[data-testid="ticket-mots-cles"]')
    await field.waitFor({ state: 'visible', timeout: 10000 })

    // Plus d'input texte libre sur ce champ.
    assert.equal(await field.locator('input[placeholder="mot1, mot2, mot3"]').count(), 0,
      'le champ mots-clés ne doit plus être un input texte libre')

    // a) Le menu propose les mots-clés déjà utilisés sur les autres billets.
    const known = await page.evaluate(async (tok) => {
      const r = await fetch('/erp/api/tickets/keywords', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    }, token)
    assert.ok(Array.isArray(known) && known.length > 10, `liste de mots-clés attendue, vu ${JSON.stringify(known).slice(0, 120)}`)
    const existing = known[0]

    await page.click('[data-testid="ticket-mots-cles-add"]')
    const menu = page.locator('[data-testid="ticket-mots-cles-menu"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })

    // b) Recherche dans le menu (règle « dropdowns avec recherche »).
    await page.fill('[data-testid="ticket-mots-cles-search"]', existing)
    const opt = menu.locator(`[data-testid="ticket-mots-cles-opt-${existing}"]`)
    await opt.waitFor({ state: 'visible', timeout: 5000 })
    await opt.click()

    await page.waitForFunction(async ({ tok, id, kw }) => {
      const r = await fetch(`/erp/api/tickets/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
      const t = await r.json()
      return t.mots_cles === JSON.stringify([kw])
    }, { tok: token, id: ticketId, kw: existing }, { timeout: 8000 })

    // c) Création d'un mot-clé absent de la liste.
    const invented = `E2E ${Date.now()}`
    await page.fill('[data-testid="ticket-mots-cles-search"]', invented)
    await page.click('[data-testid="ticket-mots-cles-create"]')

    await page.waitForFunction(async ({ tok, id, expected }) => {
      const r = await fetch(`/erp/api/tickets/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
      const t = await r.json()
      return t.mots_cles === expected
    }, { tok: token, id: ticketId, expected: JSON.stringify([existing, invented]) }, { timeout: 8000 })

    // d) Les deux valeurs sont affichées en pastilles.
    await page.keyboard.press('Escape')
    const chips = field.locator('[data-testid="ticket-mots-cles-chip"]')
    await chips.first().waitFor({ state: 'visible', timeout: 5000 })
    const labels = (await chips.allInnerTexts()).map(s => s.trim())
    assert.deepEqual(labels, [existing, invented], `pastilles attendues, vu ${JSON.stringify(labels)}`)

    // e) Retrait d'une pastille → autosave, sans bouton « Enregistrer ».
    await field.locator(`[data-testid="ticket-mots-cles-remove-${existing}"]`).click()
    await page.waitForFunction(async ({ tok, id, expected }) => {
      const r = await fetch(`/erp/api/tickets/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
      const t = await r.json()
      return t.mots_cles === expected
    }, { tok: token, id: ticketId, expected: JSON.stringify([invented]) }, { timeout: 8000 })

    // f) Après rechargement, la valeur enregistrée revient en pastille.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    const after = field.locator('[data-testid="ticket-mots-cles-chip"]')
    await after.first().waitFor({ state: 'visible', timeout: 10000 })
    assert.deepEqual((await after.allInnerTexts()).map(s => s.trim()), [invented])

    const saved = await apiGet()
    assert.equal(saved.mots_cles, JSON.stringify([invented]))
  })

  // Le champ vit aussi dans le side-peek de /tickets, dont le corps a un
  // overflow : le menu doit s'y afficher entièrement (rendu en portail) et non
  // être rogné. 100 % lecture seule sur les billets existants : on ouvre le
  // menu, on ne coche rien.
  test('dans le side-peek, le menu de sélection s\'ouvre sans être rogné', async () => {
    await page.goto(`${URL}/tickets`, { waitUntil: 'networkidle' })
    // La vue par défaut peut être vide (filtre sur les billets récents) : on
    // prend la première vue qui affiche des lignes.
    const tabs = page.locator('button[class*="-mb-px"]')
    const tabCount = await tabs.count()
    let opened = false
    for (let i = 0; i < tabCount && !opened; i++) {
      await tabs.nth(i).click()
      await page.waitForTimeout(1200)
      if (await page.locator('[data-row-id]').count() === 0) continue
      await page.locator('[data-row-id]').first().locator('.font-medium').first().click()
      await page.locator('[data-testid="record-peek-body"]').waitFor({ timeout: 8000 })
      opened = true
    }
    assert.ok(opened, 'aucune vue de /tickets ne contient de ligne à ouvrir en side-peek')

    const body = page.locator('[data-testid="record-peek-body"]')
    const field = body.locator('[data-testid="ticket-mots-cles"]')
    await field.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await body.locator('input[placeholder="mot1, mot2, mot3"]').count(), 0,
      'le side-peek ne doit plus afficher le champ mots-clés en texte libre')

    await field.locator('[data-testid="ticket-mots-cles-add"]').click()
    const menu = page.locator('[data-testid="ticket-mots-cles-menu"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    const box = await menu.boundingBox()
    assert.ok(box && box.width > 100 && box.height > 60, `menu trop petit : ${JSON.stringify(box)}`)
    assert.ok(box.x >= 0 && box.x + box.width <= 1400 + 1, 'menu hors de la fenêtre')
    assert.ok(await menu.locator('button').count() > 5, 'le menu doit lister les mots-clés existants')

    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached', timeout: 5000 })
  })
})
