const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que les nouveaux champs (Lien GitHub, Escalade, Mots-clés, Arbre de
// troubleshoot utilisé, Documents, Items retour) sont visibles, éditables et
// persistés via PUT /api/tickets/:id.
describe('TicketDetail — nouveaux champs', () => {
  let browser, ctx, page, token, ticketId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    const res = await page.evaluate(async (tok) => {
      const r = await fetch('/erp/api/tickets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `E2E extra fields ${Date.now()}`, type: 'Support', status: 'Waiting on us' }),
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

  test('les 6 champs sont visibles et persistent via blur', async () => {
    await page.goto(`${URL}/tickets/${ticketId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    const cases = [
      { label: 'Lien GitHub',                    value: 'https://github.com/orisha/erp/issues/42', column: 'lien_issue_github' },
      { label: 'Escalade',                       value: 'Marc',                                     column: 'escalade' },
      { label: 'Mots-clés',                      value: 'capteur, valve, calibration',              column: 'mots_cles' },
      { label: 'Arbre de troubleshoot utilisé',  value: 'Capteur de température',                   column: 'arbre_de_troubleshoot_utilise' },
      { label: 'Documents',                      value: 'manuel-v2.pdf, photos serre',              column: 'documents' },
      { label: 'Items retour',                   value: 'Capteur S-12 (RMA-2026-001)',              column: 'items_retours' },
    ]

    // Saisit chaque champ via leur label visible : on cible le 1er input/textarea
    // qui suit le label `<FieldLabel>` dans le DOM.
    for (const c of cases) {
      const ctrl = page.locator(
        `xpath=//div[contains(concat(" ", normalize-space(text()), " "), " ${c.label} ")]/following::*[self::input or self::textarea][1]`,
      ).first()
      await ctrl.waitFor({ state: 'visible', timeout: 5000 })
      await ctrl.fill(c.value)
      await ctrl.blur()
      await page.waitForFunction(async ({ tok, id, col, val }) => {
        const r = await fetch(`/erp/api/tickets/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
        const t = await r.json()
        return t[col] === val
      }, { tok: token, id: ticketId, col: c.column, val: c.value }, { timeout: 5000 })
    }

    // Vérifie via l'API que les 6 colonnes sont bien persistées.
    const fetched = await page.evaluate(async ({ tok, id }) => {
      const r = await fetch(`/erp/api/tickets/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    }, { tok: token, id: ticketId })

    for (const c of cases) {
      assert.equal(fetched[c.column], c.value, `${c.column} attendu "${c.value}", vu "${fetched[c.column]}"`)
    }

    // L'icône d'ouverture du lien GitHub doit être présente quand le champ contient une URL valide.
    const openIcon = page.locator(`a[href="${cases[0].value}"]`).first()
    assert.ok(await openIcon.isVisible(), 'Lien externe GitHub doit être visible')
  })
})
