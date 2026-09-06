// OrderDetail — section Rentabilité (revenus, coûts, profit) + champ revenu override.
// Vérifie :
//   1. La section "Rentabilité" est rendue avec Revenus / Coûts / Profit.
//   2. Le champ "Revenu override" autosauvegarde (on blur, pas de bouton Enregistrer)
//      et se reflète dans order.profitability (revenue_override_cad + revenue_effective).
//   3. L'override se propage au tableau Rentabilité du dashboard (recentShippedOrders).
//   4. Effacer l'override (bouton X) retombe sur le revenu calculé.
//
// Restauration : la valeur override d'origine de la commande de test est relue avant
// et restaurée dans after() — la DB de test = la DB de prod.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

const PROBE = 12345.67

describe('OrderDetail — section Rentabilité + revenu override', () => {
  let browser, ctx, page
  let orderId, originalOverride, fromDashboard

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    // Préfère une commande déjà présente dans le tableau Rentabilité du dashboard
    // (recentShippedOrders) pour pouvoir tester la propagation. Sinon, n'importe
    // quelle commande pour au moins tester la section + autosave.
    const picked = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${tok}` }
      const dash = await fetch('/erp/api/dashboard', { headers: h }).then(r => r.json())
      const recent = dash.recentShippedOrders || []
      if (recent.length > 0) return { id: recent[0].id, fromDashboard: true }
      const list = await fetch('/erp/api/orders?limit=1', { headers: h }).then(r => r.json())
      const o = (list.data || [])[0]
      return o ? { id: o.id, fromDashboard: false } : null
    })
    assert.ok(picked, 'aucune commande disponible pour le test')
    orderId = picked.id
    fromDashboard = picked.fromDashboard

    // Relit la valeur override courante pour la restaurer après.
    originalOverride = await page.evaluate(async (id) => {
      const tok = localStorage.getItem('erp_token')
      const d = await fetch(`/erp/api/orders/${id}`, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json())
      return d.profitability ? d.profitability.revenue_override_cad : null
    }, orderId)
  })

  after(async () => {
    // Restaure toujours la valeur d'origine, même si le test a échoué.
    if (orderId !== undefined && page) {
      try {
        await page.evaluate(async ({ id, val }) => {
          const tok = localStorage.getItem('erp_token')
          await fetch(`/erp/api/orders/${id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ revenue_override_cad: val }),
          })
        }, { id: orderId, val: originalOverride })
      } catch {}
    }
    await browser?.close()
  })

  test('la section Rentabilité est rendue avec Revenus / Coûts / Profit', async () => {
    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'networkidle' })

    await page.getByRole('heading', { name: 'Rentabilité' }).waitFor({ state: 'visible', timeout: 8000 })
    const section = page.locator('.card', { has: page.getByRole('heading', { name: 'Rentabilité' }) })
    for (const label of ['Revenus', 'Coûts', 'Profit']) {
      assert.ok(await section.getByText(label, { exact: true }).count() > 0, `libellé "${label}" manquant`)
    }

    // Le champ override existe, pas de bouton "Enregistrer".
    const input = page.locator('input[placeholder="Vide = revenu calculé"]')
    await input.waitFor({ state: 'visible', timeout: 5000 })
    const saveBtn = await page.getByRole('button', { name: /^(Enregistrer|Sauvegarder|Save)$/i }).count()
    assert.equal(saveBtn, 0, `aucun bouton "Enregistrer" attendu, trouvé ${saveBtn}`)
  })

  test('saisir un override autosauvegarde et se reflète dans profitability', async () => {
    const input = page.locator('input[placeholder="Vide = revenu calculé"]')
    await input.fill(String(PROBE))
    await input.blur()
    await page.waitForTimeout(900) // round-trip + reload()

    const prof = await page.evaluate(async (id) => {
      const tok = localStorage.getItem('erp_token')
      const d = await fetch(`/erp/api/orders/${id}`, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json())
      return d.profitability
    }, orderId)
    assert.equal(prof.revenue_override_cad, PROBE, 'revenue_override_cad non persisté')
    assert.equal(prof.revenue_effective, PROBE, 'revenue_effective ne reflète pas l\'override')
  })

  test('l\'override se propage au tableau Rentabilité du dashboard', async (t) => {
    if (!fromDashboard) {
      t.skip('aucune commande expédiée récente dans recentShippedOrders — propagation non testable')
      return
    }
    const revenue = await page.evaluate(async (id) => {
      const tok = localStorage.getItem('erp_token')
      const dash = await fetch('/erp/api/dashboard', { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json())
      const row = (dash.recentShippedOrders || []).find(o => o.id === id)
      return row ? row.revenue : null
    }, orderId)
    assert.equal(revenue, PROBE, 'le revenu du dashboard ne reflète pas l\'override')
  })

  test('effacer l\'override (X) retombe sur le revenu calculé', async () => {
    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'networkidle' })
    const input = page.locator('input[placeholder="Vide = revenu calculé"]')
    await input.waitFor({ state: 'visible', timeout: 5000 })
    // Le bouton X n'apparaît que si le champ est non vide.
    const clearBtn = page.locator('button[title="Effacer l\'override"]')
    await clearBtn.click()
    await page.waitForTimeout(900)

    const prof = await page.evaluate(async (id) => {
      const tok = localStorage.getItem('erp_token')
      const d = await fetch(`/erp/api/orders/${id}`, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json())
      return d.profitability
    }, orderId)
    assert.equal(prof.revenue_override_cad, null, 'override non effacé')
    assert.equal(prof.revenue_effective, prof.revenue_computed, 'revenue_effective devrait égaler le calculé après effacement')
  })
})
