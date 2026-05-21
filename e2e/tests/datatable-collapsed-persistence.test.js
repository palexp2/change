// Vérifie que l'état collapsed/expanded des groupes d'un DataTable est
// persisté côté serveur (table_view_pills.collapsed_groups), au-delà du
// localStorage local. On utilise la page Factures et on regroupe par Statut
// pour avoir des groupes prévisibles.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('DataTable — persistance serveur des groupes collapsed', () => {
  let browser, ctx, page
  let snapshot = null
  let activePillId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Snapshot la pill active de factures pour restauration en after()
    const snap = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/views/factures', { headers: { Authorization: `Bearer ${tok}` } })
      const { pills } = await r.json()
      const lastId = localStorage.getItem('erp_lastView_factures')
      const pill = pills.find(p => String(p.id) === String(lastId)) || pills[0]
      return {
        id: pill.id,
        group_by: pill.group_by,
        group_order: pill.group_order,
        collapsed_groups: pill.collapsed_groups,
      }
    })
    snapshot = snap
    activePillId = snap.id
  })

  after(async () => {
    if (snapshot && page) {
      try {
        await page.evaluate(async (snap) => {
          const tok = localStorage.getItem('erp_token')
          await fetch(`/erp/api/views/factures/pills/${snap.id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              group_by: snap.group_by,
              group_order: snap.group_order,
              collapsed_groups: snap.collapsed_groups || [],
            }),
          })
        }, snapshot)
      } catch {}
    }
    await browser?.close()
  })

  test('cliquer "Tout fermer" persiste collapsed_groups sur la pill active', async () => {
    // Reset la pill : groupage par statut, aucun groupe collapsé
    await page.evaluate(async (id) => {
      const tok = localStorage.getItem('erp_token')
      await fetch(`/erp/api/views/factures/pills/${id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_by: 'status', group_order: null, collapsed_groups: [] }),
      })
    }, activePillId)

    await page.goto(`${URL}/factures`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid^="datatable-group-"][data-group-level="0"]', { timeout: 10000 })

    // "Tout fermer" via le panneau Grouper
    await page.click('button[data-panel-btn="group"]')
    await page.click('button:has-text("Tout fermer")')
    // L'autosave de collapsed_groups a un debounce de 400ms
    await page.waitForTimeout(1000)

    const pill = await page.evaluate(async (id) => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/views/factures', { headers: { Authorization: `Bearer ${tok}` } })
      const { pills } = await r.json()
      return pills.find(p => p.id === id)
    }, activePillId)

    assert.ok(Array.isArray(pill.collapsed_groups), `collapsed_groups doit être un array, got ${typeof pill.collapsed_groups}`)
    assert.ok(pill.collapsed_groups.length > 0, `attendu au moins un groupe collapsé après "Tout fermer", got ${JSON.stringify(pill.collapsed_groups)}`)
  })

  test('reload de la page : les groupes restent collapsés (server-side)', async () => {
    // (Suite directe du test précédent : la pill a déjà des collapsed_groups)
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid^="datatable-group-"][data-group-level="0"]', { timeout: 10000 })
    // Vide le localStorage pour s'assurer que la persistance vient bien du
    // serveur (pas du cache local).
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('erp_collapsed_')) localStorage.removeItem(k)
      }
    })
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid^="datatable-group-"][data-group-level="0"]', { timeout: 10000 })

    // Tous les en-têtes visibles doivent être collapsés (chevron right vs down).
    // Sans dépendance sur l'icône, on vérifie qu'aucune ligne de donnée n'est
    // visible sous les en-têtes (toutes collapsées). Concrètement : il ne reste
    // que des rows de type groupe (présence du testid datatable-group-*).
    const groupCount = await page.locator('[data-testid^="datatable-group-"]').count()
    const totalAbsoluteRows = await page.locator('div[style*="display: grid"][style*="position: absolute"]').count()
    // Quand tout est collapsé, on a uniquement les en-têtes de groupe ;
    // les rows de données ne sont pas rendues (pas dans virtualItems).
    assert.equal(totalAbsoluteRows, groupCount,
      `tous les groupes devraient être collapsés (groups=${groupCount}, total rows=${totalAbsoluteRows}) — la persistance serveur ne fonctionne pas`)
  })

  test('cliquer un groupe pour le déplier persiste le retrait du pathKey', async () => {
    // Sélectionne le premier groupe collapsé et déplie-le. Vérifie que son
    // pathKey disparaît du collapsed_groups stocké côté serveur.
    const firstGroup = page.locator('[data-testid^="datatable-group-"]').first()
    const testid = await firstGroup.getAttribute('data-testid')
    const pathKey = testid.replace(/^datatable-group-/, '')

    await firstGroup.click()
    await page.waitForTimeout(1000)

    const pill = await page.evaluate(async (id) => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/views/factures', { headers: { Authorization: `Bearer ${tok}` } })
      const { pills } = await r.json()
      return pills.find(p => p.id === id)
    }, activePillId)

    assert.ok(!pill.collapsed_groups.includes(pathKey),
      `pathKey "${pathKey}" ne devrait plus être dans collapsed_groups après dépli, got ${JSON.stringify(pill.collapsed_groups)}`)
  })
})
