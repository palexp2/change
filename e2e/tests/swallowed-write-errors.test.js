// Vérifie que 3 écritures réseau auparavant avalées par `.catch(() => {})`
// surfacent désormais un feedback d'erreur visible (toast / indicateur d'autosave) :
//   1. OrderDetail — autosave du type d'item (PATCH /orders/:id/items/:itemId)
//      → ScanToast rouge (`.fixed.top-4 … .bg-red-600`).
//   2. AchatsFournisseurs — persistance du pré-remplissage comptes (PUT
//      /achats-fournisseurs/:id) → message d'erreur autosave (`.bg-red-100`).
//   3. AutomationDetail — suppression d'automation (DELETE /automations/:id)
//      → toast d'erreur ET pas de navigation/faux « supprimée ».
//
// Méthode : on intercepte l'appel API muté et on le force en 500 AVANT qu'il
// n'atteigne le serveur → RIEN n'est créé/modifié/supprimé en DB côté écriture
// testée. Seule l'automation jetable (scénario 3) est réellement créée puis
// nettoyée dans after().
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

async function fail500(route) {
  await route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'E2E forced error' }),
  })
}

describe('Erreurs d\'écriture auparavant avalées → feedback visible', () => {
  let browser, ctx, page
  let automationId = null
  let orderWithItemsId = null

  async function api(method, path, body) {
    return page.evaluate(async ({ method, path, body }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      const txt = await r.text()
      let parsed
      try { parsed = JSON.parse(txt) } catch { parsed = txt }
      return { status: r.status, body: parsed }
    }, { method, path, body })
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Trouve une commande existante possédant au moins un article (lecture seule —
    // l'autosave testé sera intercepté en 500, donc rien n'est muté).
    const list = await api('GET', '/orders?limit=all')
    const rows = Array.isArray(list.body?.data) ? list.body.data : (Array.isArray(list.body) ? list.body : [])
    for (const r of rows.slice(0, 40)) {
      const det = await api('GET', `/orders/${r.id}`)
      if (Array.isArray(det.body?.items) && det.body.items.length > 0) { orderWithItemsId = r.id; break }
    }

    // Automation jetable, inactive (aucun cron enregistré), pour le test de suppression.
    const created = await api('POST', '/automations', {
      name: `E2E swallowed-delete ${Date.now()}`,
      trigger_type: 'manual',
      active: 0,
    })
    automationId = created.body?.id || null
  })

  after(async () => {
    // Nettoie l'automation jetable, même si le test a échoué (DELETE réel non intercepté).
    if (page && automationId) {
      await page.unroute('**/erp/api/automations/*').catch(() => {})
      await api('DELETE', `/automations/${automationId}`)
    }
    await browser?.close()
  })

  test('OrderDetail — échec autosave du type d\'item → ScanToast rouge', async (t) => {
    if (!orderWithItemsId) { t.skip('aucune commande avec articles trouvée'); return }
    await page.goto(`${URL}/orders/${orderWithItemsId}`, { waitUntil: 'networkidle' })

    // 4e colonne = « Type » (drag-handle, Produit, Qté, Type).
    const typeCell = page.locator('tbody tr').first().locator('td').nth(3)
    await typeCell.waitFor({ state: 'visible', timeout: 10000 })
    await typeCell.click()

    const select = typeCell.locator('select')
    await select.waitFor({ state: 'visible', timeout: 5000 })

    // Force l'échec du PATCH (n'atteint jamais le serveur → type inchangé en DB).
    await page.route('**/erp/api/orders/*/items/*', (route) =>
      route.request().method() === 'PATCH' ? fail500(route) : route.continue())

    // Choisit une valeur de type DIFFÉRENTE de la valeur courante.
    const current = await select.inputValue()
    const next = ['Facturable', 'Remplacement', 'Non facturable'].find(v => v !== current)
    await select.selectOption(next)

    const toast = page.locator('.fixed.top-4').filter({ hasText: 'E2E forced error' })
    await toast.waitFor({ state: 'visible', timeout: 5000 })

    await page.unroute('**/erp/api/orders/*/items/*')
  })

  test('AutomationDetail — échec suppression → toast d\'erreur + pas de navigation', async (t) => {
    if (!automationId) { t.skip('automation jetable non créée'); return }
    await page.goto(`${URL}/automations/${automationId}`, { waitUntil: 'networkidle' })
    await page.locator('button:has-text("Supprimer")').first().waitFor({ state: 'visible', timeout: 10000 })

    // Force l'échec du DELETE (n'atteint jamais le serveur → automation conservée).
    await page.route('**/erp/api/automations/*', (route) =>
      route.request().method() === 'DELETE' ? fail500(route) : route.continue())

    await page.locator('button:has-text("Supprimer")').first().click()

    // Confirme dans la modale (ConfirmProvider — bouton « Confirmer »).
    const confirmBtn = page.locator('[role="dialog"] button:has-text("Confirmer")')
    await confirmBtn.waitFor({ state: 'visible', timeout: 5000 })
    await confirmBtn.click()

    // Toast d'erreur centralisé (addToast) — PAS de faux « supprimée ».
    const errToast = page.locator('.fixed.bottom-4.left-4 .bg-red-600').filter({ hasText: 'E2E forced error' })
    await errToast.waitFor({ state: 'visible', timeout: 5000 })

    // On reste sur la fiche : aucune navigation vers /automations.
    await page.waitForTimeout(500)
    assert.ok(page.url().includes(`/automations/${automationId}`),
      `doit rester sur la fiche, URL=${page.url()}`)
    // Aucun toast de succès « supprimée » ne doit apparaître.
    const successToast = page.locator('.fixed.bottom-4.left-4').filter({ hasText: 'supprimée' })
    assert.equal(await successToast.count(), 0, 'aucun toast « supprimée » ne doit s\'afficher en cas d\'échec')

    await page.unroute('**/erp/api/automations/*')
  })

  test('AchatsFournisseurs — échec persistance du pré-remplissage → erreur autosave', async (t) => {
    // Réplique le scénario de pré-remplissage : un achat publié (modèle) + un achat
    // brouillon courant du même fournisseur dont les comptes sont vides.
    const accountsRes = await api('GET', '/connectors/quickbooks/accounts')
    const accounts = Array.isArray(accountsRes.body) ? accountsRes.body : []
    const exp1 = accounts.find(a => ['Expense', 'Other Expense', 'Cost of Goods Sold', 'Other Current Asset'].includes(a.AccountType))
    const pay1 = accounts.find(a => ['Bank', 'Credit Card'].includes(a.AccountType))
    if (!exp1 || !pay1) { t.skip('comptes QuickBooks indisponibles'); return }

    const VENDOR = `__e2e_swallowed_${Date.now()}`
    let pastId = null, currentId = null
    try {
      const past = await api('POST', '/achats-fournisseurs', {
        type: 'purchase', date_achat: '2030-01-01', vendor: VENDOR, description: 'E2E past',
        amount_cad: 100, tax_cad: 15, payment_method: 'Carte de crédit', status: 'Brouillon',
      })
      const current = await api('POST', '/achats-fournisseurs', {
        type: 'purchase', date_achat: '2026-06-14', vendor: VENDOR, description: 'E2E current',
        amount_cad: 50, tax_cad: 7.5, payment_method: 'Carte de crédit', status: 'Brouillon',
      })
      pastId = past.body?.id; currentId = current.body?.id
      assert.ok(pastId && currentId, 'achats jetables créés')

      await api('PUT', `/achats-fournisseurs/${pastId}`, {
        quickbooks_id: 'E2E-SWALLOWED-PAST',
        expense_account_id: exp1.Id,
        payment_account_id: pay1.Id,
      })

      // Intercepte le PUT AVANT la navigation : le pré-remplissage (useEffect au
      // montage) déclenche un PUT autosave → forcé en 500 → setError affiché.
      await page.route('**/erp/api/achats-fournisseurs/*', (route) =>
        route.request().method() === 'PUT' ? fail500(route) : route.continue())

      await page.goto(`${URL}/achats-fournisseurs?id=${currentId}`, { waitUntil: 'networkidle' })
      // La note de pré-remplissage confirme que le useEffect a appliqué le patch.
      await page.locator('[data-testid="achat-prefill-note"]').waitFor({ state: 'visible', timeout: 10000 })

      const errBox = page.locator('.text-red-600.bg-red-100').filter({ hasText: 'E2E forced error' })
      await errBox.waitFor({ state: 'visible', timeout: 5000 })
    } finally {
      await page.unroute('**/erp/api/achats-fournisseurs/*').catch(() => {})
      for (const id of [pastId, currentId]) {
        if (id) await api('DELETE', `/achats-fournisseurs/${id}`)
      }
    }
  })
})
