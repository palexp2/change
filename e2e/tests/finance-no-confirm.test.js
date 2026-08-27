const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Espace finance + extracteur de données : plus aucune étape de re-confirmation.
// Un clic sur un bouton d'action DOIT déclencher l'action, sans boîte de dialogue.
//
// AUCUNE DONNÉE RÉELLE N'EST TOUCHÉE (cf. CLAUDE.md : prod DB = test DB) : les
// requêtes destructrices sont interceptées et simulées côté navigateur, donc le
// serveur ne les reçoit jamais. Chaque test vérifie ensuite via l'API que
// l'enregistrement visé existe toujours.
const FINANCE_PAGES = [
  ['/comptabilite', 'Dashboard comptabilité'],
  ['/paiements-emis', 'Paiements et virements émis'],
  ['/rapprochement', 'Rapprochement bancaire'],
  ['/comptes-prepayes', 'Comptes prépayés'],
  ['/dettes-lt', 'Dettes à long terme'],
  ['/fin-de-mois', 'Écritures de fin de mois'],
  ['/budget-marketing', 'Budget marketing'],
  ['/sale-receipts', 'Extraction de données'],
]

describe('Espace finance & extracteur — aucune double confirmation', () => {
  let browser, ctx, page, token
  let dialogs = []

  const apiCall = (method, path) => page.evaluate(async ({ base, method, path, t }) => {
    const r = await fetch(base + '/api' + path, { method, headers: { Authorization: 'Bearer ' + t } })
    return { status: r.status, json: await r.json().catch(() => null) }
  }, { base: URL, method, path, t: token })

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    page = await ctx.newPage()
    // Espion global : toute boîte de dialogue native ouverte pendant la suite
    // est enregistrée (et rejetée) — sa présence fait échouer les tests.
    page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss() })
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
  })

  after(async () => { await browser?.close() })

  test('toutes les pages du périmètre se chargent', async () => {
    for (const [path, title] of FINANCE_PAGES) {
      await page.goto(URL + path, { waitUntil: 'domcontentloaded' })
      await page.locator(`text=${title}`).first().waitFor({ timeout: 15000 })
    }
    assert.deepEqual(dialogs, [], 'aucune boîte de dialogue au chargement')
  })

  // Famille « suppression » : la dette est supprimée au premier clic. La requête
  // DELETE est interceptée — la dette réelle survit.
  test('supprimer une dette : un seul clic, aucune confirmation', async (t) => {
    const debts = await apiCall('GET', '/lt-debts')
    const debt = debts.json?.[0]
    if (!debt) { t.skip('aucune dette en base'); return }

    let deleteCalls = 0
    const route = /\/api\/lt-debts\/[^/?]+$/
    await page.route(route, async r => {
      if (r.request().method() !== 'DELETE') return r.continue()
      deleteCalls++
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })

    try {
      dialogs = []
      await page.goto(URL + '/dettes-lt', { waitUntil: 'domcontentloaded' })
      await page.locator(`button:has-text("${debt.label}")`).first().click()
      await page.locator('button:has-text("Configurer")').first().click()
      await page.locator('[role="dialog"]').waitFor({ timeout: 10000 })
      await page.locator('[role="dialog"] button:has-text("Supprimer")').first().click()

      const deadline = Date.now() + 5000
      while (deleteCalls === 0 && Date.now() < deadline) await page.waitForTimeout(100)
      assert.equal(deleteCalls, 1, 'la suppression doit partir au premier clic')
      assert.deepEqual(dialogs, [], 'aucune confirmation ne doit s\'ouvrir')
    } finally {
      await page.unroute(route)
    }

    // La dette réelle n'a pas été touchée (requête interceptée).
    const after = await apiCall('GET', '/lt-debts')
    assert.ok(after.json.some(d => d.id === debt.id), 'la dette réelle existe toujours')
  })

  // Famille « comptabilisation QuickBooks » : publier une écriture de fin de
  // mois ne demande plus de re-confirmation. Requête interceptée : rien n'est
  // publié dans QuickBooks.
  test('comptabiliser une écriture de fin de mois : un seul clic', async (t) => {
    await page.goto(URL + '/fin-de-mois', { waitUntil: 'domcontentloaded' })
    await page.locator('text=Écritures de fin de mois').first().waitFor({ timeout: 15000 })
    const btn = page.locator('[data-testid^="publish-"]').first()
    await page.waitForTimeout(1500) // laisse charger les provisions du mois
    if (await btn.count() === 0) { t.skip('aucune écriture publiable ce mois-ci'); return }

    let publishCalls = 0
    const route = /\/api\/(month-end|prepaid)\/.*(publish|correct)/
    await page.route(route, async r => {
      publishCalls++
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ qb_je_id: 'E2E-SIMULE' }) })
    })

    try {
      dialogs = []
      await btn.click()
      const deadline = Date.now() + 5000
      while (publishCalls === 0 && Date.now() < deadline) await page.waitForTimeout(100)
      assert.equal(publishCalls, 1, 'la comptabilisation doit partir au premier clic')
      assert.deepEqual(dialogs, [], 'aucune confirmation ne doit s\'ouvrir')
    } finally {
      await page.unroute(route)
    }
  })

  // Contre-épreuve : la suppression d'un reçu détruit le PDF sur le disque
  // (hard delete). Sa confirmation est VOLONTAIREMENT conservée — ce test la
  // verrouille pour qu'un futur nettoyage ne l'emporte pas par mégarde.
  test('extracteur : la suppression définitive d\'un reçu garde sa confirmation', async (t) => {
    const list = await apiCall('GET', '/sale-receipts?limit=1')
    const rows = Array.isArray(list.json) ? list.json : (list.json?.data || [])
    const receipt = rows[0]
    if (!receipt) { t.skip('aucun reçu en base'); return }

    let deleteCalls = 0
    const route = /\/api\/sale-receipts\/[^/?]+$/
    await page.route(route, async r => {
      if (r.request().method() !== 'DELETE') return r.continue()
      deleteCalls++
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })

    try {
      await page.goto(`${URL}/sale-receipts/${receipt.id}`, { waitUntil: 'domcontentloaded' })
      const del = page.locator('button:has-text("Supprimer")').first()
      await del.waitFor({ timeout: 15000 })
      await del.click()
      // Une fenêtre de confirmation (modale applicative) doit apparaître et
      // RIEN ne doit partir tant qu'elle n'est pas validée.
      await page.locator('text=Supprimer ce reçu ?').waitFor({ timeout: 10000 })
      await page.waitForTimeout(600)
      assert.equal(deleteCalls, 0, 'aucune suppression avant validation de la confirmation')
    } finally {
      await page.unroute(route)
    }
  })
})
