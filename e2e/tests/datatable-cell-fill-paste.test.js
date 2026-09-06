const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Mode « tableur » du DataTable (Pipeline / projets) : sélection multi-cellules,
// remplissage vers le bas (Ctrl+D) et copier/coller (Ctrl+C / Ctrl+V).
//
// Le test crée un champ personnalisé texte temporaire sur `projects` (via le
// flux UI « + Ajouter un champ », qui rend la colonne visible), pilote les
// gestes au clavier/souris, puis vérifie les valeurs côté serveur.
//
// Nettoyage (after) :
//   - le champ custom créé est supprimé via l'API admin ;
//   - les `visible_columns` de chaque pill de la vue projets sont restaurés à
//     leur valeur d'origine (l'auto-affichage du nouveau champ les a pu muter).
describe('DataTable — mode tableur (fill-down + copier/coller)', () => {
  let browser, ctx, page
  let fieldId = null
  let colId = null
  let originalPills = []
  const FIELD_NAME = `E2E Grid ${Date.now()}`

  // Appel API authentifié depuis le contexte de la page (réutilise le token).
  async function apiCall(method, path, body) {
    return page.evaluate(async ({ method, path, body }) => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api' + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      const txt = await res.text()
      let json
      try { json = JSON.parse(txt) } catch { json = txt }
      return { status: res.status, body: json }
    }, { method, path, body })
  }

  async function gotoPipeline() {
    await page.goto(`${URL}/pipeline`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 15000 })
  }

  // Poll la valeur d'une colonne d'un projet jusqu'à correspondance (les écritures
  // sont des PUT asynchrones déclenchés par le mode tableur).
  async function waitForVal(id, col, expected, timeout = 9000) {
    const start = Date.now()
    let last
    while (Date.now() - start < timeout) {
      const r = await apiCall('GET', `/projects/${id}`)
      last = r.body?.[col]
      if (last === expected) return
      await page.waitForTimeout(250)
    }
    assert.equal(last, expected, `projet ${id} · colonne ${col} devrait valoir "${expected}" (got "${last}")`)
  }

  // Les rowIds des N premières cellules rendues de la colonne custom.
  async function firstCellRowIds(n) {
    const cells = page.locator(`[data-grid-cell$="|${colId}"]`)
    await cells.first().waitFor({ state: 'visible', timeout: 10000 })
    return cells.evaluateAll((els, n) =>
      els.slice(0, n).map(e => e.getAttribute('data-grid-cell').split('|')[0]), n)
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({
      viewport: { width: 1500, height: 950 },
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Purge d'éventuels champs « E2E Grid » résiduels d'un run précédent avorté.
    const existing = await apiCall('GET', '/custom-fields/projects')
    for (const f of (existing.body?.data || [])) {
      if (typeof f.name === 'string' && f.name.startsWith('E2E Grid')) {
        await apiCall('DELETE', `/custom-fields/${f.id}`)
      }
    }

    // Sauvegarde des pills de la vue projets (pour restauration en after()).
    const views = await apiCall('GET', '/views/projects')
    originalPills = (views.body?.pills || []).map(p => ({
      id: p.id, locked: p.locked, visible_columns: p.visible_columns || [],
    }))

    // Au moins 3 projets nécessaires pour une plage de fill-down.
    const pr = await apiCall('GET', '/projects?limit=all')
    assert.ok((pr.body?.data || []).length >= 3, 'il faut au moins 3 projets pour le test')

    // Création du champ custom via le flux UI (rend la colonne visible).
    await gotoPipeline()
    await page.click('button[aria-label="Ajouter un champ"]')
    await page.fill('input[placeholder*="Priorité interne"]', FIELD_NAME)
    await page.click('button:has-text("Créer")')
    // Le header de la nouvelle colonne apparaît une fois le champ créé + rechargé.
    await page.waitForSelector(`text=${FIELD_NAME}`, { timeout: 15000 })

    const cf = await apiCall('GET', '/custom-fields/projects')
    const list = Array.isArray(cf.body) ? cf.body : (cf.body?.data || [])
    const field = list.find(f => f.name === FIELD_NAME)
    assert.ok(field, 'le champ custom créé devrait être retrouvé via l\'API')
    fieldId = field.id
    colId = field.column_name
  })

  after(async () => {
    try {
      if (page && fieldId) await apiCall('DELETE', `/custom-fields/${fieldId}`)
      // Restaure les visible_columns des pills (l'auto-affichage a pu les muter).
      if (page) {
        for (const p of originalPills) {
          if (p.locked === 1) continue
          await apiCall('PUT', `/views/projects/pills/${p.id}`, { visible_columns: p.visible_columns })
        }
      }
    } catch { /* best-effort cleanup */ }
    await browser?.close()
  })

  test('remplissage vers le bas (Ctrl+D) propage la valeur du haut sur la plage', async () => {
    await gotoPipeline()
    const ids = await firstCellRowIds(3)
    assert.equal(ids.length, 3, 'devrait avoir 3 cellules de la colonne custom')

    const cells = page.locator(`[data-grid-cell$="|${colId}"]`)
    const VAL = `FILL_${Date.now()}`

    // Saisir la valeur dans la cellule du haut (double-clic → input → Enter).
    await cells.nth(0).dblclick()
    const input = page.locator('[data-testid="datatable-cell-input"]')
    await input.waitFor({ state: 'visible', timeout: 5000 })
    await input.fill(VAL)
    await input.press('Enter')
    await waitForVal(ids[0], colId, VAL)

    // Sélectionner la plage cellule0 → cellule2 puis remplir vers le bas.
    await cells.nth(0).click()
    await cells.nth(2).click({ modifiers: ['Shift'] })
    // La barre d'info du mode tableur confirme la sélection.
    await page.waitForSelector('[data-testid="datatable-grid-bar"]', { timeout: 5000 })
    await page.keyboard.press('Control+d')

    await waitForVal(ids[1], colId, VAL)
    await waitForVal(ids[2], colId, VAL)
  })

  test('copier/coller (Ctrl+C → Ctrl+V) reporte la valeur sur une autre cellule', async () => {
    await gotoPipeline()
    const ids = await firstCellRowIds(2)
    assert.equal(ids.length, 2)

    const cells = page.locator(`[data-grid-cell$="|${colId}"]`)
    const VAL = `COPY_${Date.now()}`

    // Donner une valeur distincte à la cellule source.
    await cells.nth(0).dblclick()
    const input = page.locator('[data-testid="datatable-cell-input"]')
    await input.waitFor({ state: 'visible', timeout: 5000 })
    await input.fill(VAL)
    await input.press('Enter')
    await waitForVal(ids[0], colId, VAL)

    // Copier la cellule source, sélectionner une autre cellule, coller.
    await cells.nth(0).click()
    await page.keyboard.press('Control+c')
    await cells.nth(1).click()
    await page.keyboard.press('Control+v')

    await waitForVal(ids[1], colId, VAL)
  })
})
