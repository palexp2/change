// Vérifie que l'utilisateur peut réordonner les cartes du dashboard depuis le
// panneau de personnalisation. Le test couvre :
//   - le panneau liste toutes les sections avec un handle de drag visible
//   - persister un ordre custom dans localStorage change l'ordre de rendu
//   - dispatcher manuellement des DragEvents HTML5 entre deux rows met à jour
//     l'ordre persisté
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Dashboard — Personnalisation : réordonner les cartes', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    // Nettoyage : supprime les prefs custom utilisées par les tests pour ne pas
    // polluer les autres tests qui partagent le même compte
    if (page) {
      try {
        await page.evaluate(() => {
          for (const k of Object.keys(localStorage)) {
            if (k.startsWith('dashboard_prefs_')) localStorage.removeItem(k)
          }
        })
      } catch {}
    }
    await browser?.close()
  })

  test('le panneau "Personnaliser" liste toutes les sections avec un handle de drag', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.click('button:has-text("Personnaliser")')
    await page.waitForSelector('[data-testid^="dashboard-editor-row-"]', { timeout: 5000 })

    const rows = await page.locator('[data-testid^="dashboard-editor-row-"]').all()
    assert.ok(rows.length >= 13, `attendu ≥13 rows, reçu ${rows.length}`)

    // Chaque row doit être draggable
    for (const r of rows) {
      const draggable = await r.getAttribute('draggable')
      assert.equal(draggable, 'true', 'chaque row doit être draggable')
    }

    // Ferme le panneau
    await page.click('button:has-text("Fermer")')
  })

  test('un ordre custom dans localStorage est respecté au rendu', async () => {
    // Place section_geo_map en premier et section_project_goal en dernier — un
    // ordre clairement différent du défaut pour valider le tri.
    const customOrder = [
      'section_geo_map',
      'section_subscription_events',
      'section_profitability',
      'section_replacement_rate',
      'section_projects_created',
      'section_closing',
      'section_shipments',
      'section_shipping_costs',
      'section_top_products',
      'section_inventory_valuation',
      'section_tickets_monthly',
      'section_support_weekly',
      'section_project_goal',
    ]
    await page.evaluate((order) => {
      // L'app stocke par user id (extrait du JWT). On reproduit la même logique
      // que loadPrefs(user?.id || 'default') côté client.
      const tok = localStorage.getItem('erp_token')
      const payload = tok ? JSON.parse(atob(tok.split('.')[1])) : null
      const k = `dashboard_prefs_${payload?.id || 'default'}`
      const cur = (() => { try { return JSON.parse(localStorage.getItem(k) || '{}') } catch { return {} } })()
      localStorage.setItem(k, JSON.stringify({ ...cur, _order: order }))
    }, customOrder)

    await page.reload({ waitUntil: 'networkidle' })
    // Attendre qu'au moins une section soit rendue
    await page.waitForSelector('[data-section-id]', { timeout: 10000 })

    const rendered = await page.locator('[data-section-id]').evaluateAll(els => els.map(el => el.getAttribute('data-section-id')))
    assert.equal(rendered[0], 'section_geo_map', `1ère section attendue section_geo_map, reçu ${rendered[0]}`)
    assert.equal(rendered[rendered.length - 1], 'section_project_goal', `dernière section attendue section_project_goal, reçu ${rendered[rendered.length - 1]}`)
  })

  test('drag-and-drop réordonne et persiste dans localStorage', async () => {
    // Reset à l'ordre par défaut (en supprimant _order)
    await page.evaluate(() => {
      const tok = localStorage.getItem('erp_token')
      const payload = tok ? JSON.parse(atob(tok.split('.')[1])) : null
      const k = `dashboard_prefs_${payload?.id || 'default'}`
      try {
        const cur = JSON.parse(localStorage.getItem(k) || '{}')
        delete cur._order
        localStorage.setItem(k, JSON.stringify(cur))
      } catch {}
    })
    await page.reload({ waitUntil: 'networkidle' })
    await page.click('button:has-text("Personnaliser")')
    await page.waitForSelector('[data-testid^="dashboard-editor-row-"]', { timeout: 5000 })

    // Ordre initial des rows dans le panneau (= ordre déclaré WIDGET_DEFS)
    const initial = await page.locator('[data-testid^="dashboard-editor-row-"]').evaluateAll(els =>
      els.map(el => el.getAttribute('data-testid').replace('dashboard-editor-row-', ''))
    )
    assert.equal(initial[0], 'section_project_goal', `ordre initial attendu section_project_goal en tête, reçu ${initial[0]}`)

    // Drag manuel : déplace la 3e row AVANT la 1re via DragEvents natifs.
    // (Playwright `locator.dragTo` ne déclenche pas toujours les HTML5 drag
    // events ; on les dispatche directement pour un comportement déterministe.)
    const sourceId = initial[2]
    const targetId = initial[0]
    await page.evaluate(({ sourceId, targetId }) => {
      const src = document.querySelector(`[data-testid="dashboard-editor-row-${sourceId}"]`)
      const dst = document.querySelector(`[data-testid="dashboard-editor-row-${targetId}"]`)
      const dt = new DataTransfer()
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      const rect = dst.getBoundingClientRect()
      // clientY = top + 1 → le handler considère la moitié supérieure → 'before'
      dst.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientX: rect.left + 5, clientY: rect.top + 1,
      }))
      dst.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientX: rect.left + 5, clientY: rect.top + 1,
      }))
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
    }, { sourceId, targetId })

    // Attendre la mise à jour
    await page.waitForFunction((sourceId) => {
      const rows = document.querySelectorAll('[data-testid^="dashboard-editor-row-"]')
      return rows.length > 0 && rows[0].getAttribute('data-testid') === `dashboard-editor-row-${sourceId}`
    }, sourceId, { timeout: 5000 })

    const after = await page.locator('[data-testid^="dashboard-editor-row-"]').evaluateAll(els =>
      els.map(el => el.getAttribute('data-testid').replace('dashboard-editor-row-', ''))
    )
    assert.equal(after[0], sourceId, `après drag, ${sourceId} doit être en tête, reçu ${after[0]}`)

    // localStorage doit refléter la nouvelle position
    const persistedOrder = await page.evaluate(() => {
      const tok = localStorage.getItem('erp_token')
      const payload = tok ? JSON.parse(atob(tok.split('.')[1])) : null
      const k = `dashboard_prefs_${payload?.id || 'default'}`
      const cur = JSON.parse(localStorage.getItem(k) || '{}')
      return cur._order
    })
    assert.ok(Array.isArray(persistedOrder), '_order doit être persisté')
    assert.equal(persistedOrder[0], sourceId, `_order persisté: ${sourceId} en tête attendu, reçu ${persistedOrder[0]}`)

    // Le rendu du dashboard derrière le panneau doit aussi refléter l'ordre
    const renderedSections = await page.locator('[data-section-id]').evaluateAll(els =>
      els.map(el => el.getAttribute('data-section-id'))
    )
    assert.equal(renderedSections[0], sourceId, `section rendue en tête attendue ${sourceId}, reçu ${renderedSections[0]}`)
  })
})
