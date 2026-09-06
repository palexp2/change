// Vérifie que l'ordre des groupes peut être contrôlé depuis le panneau Grouper :
// 3 modes — Défaut (ordre des options du single_select), A→Z, Z→A.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const ROW_SEL = 'div[style*="display: grid"][style*="position: absolute"]'

// Récupère les en-têtes de groupe affichés (dans l'ordre du DOM virtualisé).
async function getGroupHeaders(page) {
  return page.evaluate((rowSel) => {
    const rows = document.querySelectorAll(rowSel)
    const headers = []
    for (const r of rows) {
      // Un row group a className contenant 'bg-slate-100' et un text-xs font-semibold
      if (r.className.includes('bg-slate-100')) {
        const label = r.querySelector('span.font-semibold')?.textContent?.trim()
        if (label) headers.push(label)
      }
    }
    return headers
  }, ROW_SEL)
}

describe('DataTable — ordre des groupes', () => {
  let browser, ctx, page
  let viewSnapshot = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Snapshot la vue active de factures pour restauration
    viewSnapshot = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/views/factures', { headers: { Authorization: `Bearer ${tok}` } })
      const data = await r.json()
      const lastId = localStorage.getItem('erp_lastView_factures')
      const pill = (data.pills || []).find(p => String(p.id) === String(lastId)) || (data.pills || [])[0]
      if (!pill) return null
      return {
        id: pill.id,
        sort: pill.sort || [],
        filters: pill.filters || [],
        visible_columns: pill.visible_columns || [],
        group_by: pill.group_by || null,
        group_order: pill.group_order || null,
      }
    })
  })

  after(async () => {
    if (viewSnapshot && page) {
      try {
        await page.evaluate(async (snap) => {
          const tok = localStorage.getItem('erp_token')
          await fetch(`/erp/api/views/factures/pills/${snap.id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sort: snap.sort, filters: snap.filters,
              visible_columns: snap.visible_columns,
              group_by: snap.group_by, group_order: snap.group_order,
            }),
          })
        }, viewSnapshot)
      } catch {}
    }
    await browser?.close()
  })

  async function setupGroupByStatus() {
    await page.goto(URL + '/factures', { waitUntil: 'networkidle' })
    await page.waitForSelector(ROW_SEL, { timeout: 15000 })
    // Active le groupage par "Statut" via le menu contextuel sur l'entête
    const header = page.locator('div.cursor-grab', { hasText: /^Statut$/i }).first()
    await header.click({ button: 'right' })
    await page.waitForSelector('text=Grouper par cette colonne', { timeout: 5000 })
    await page.click('text=Grouper par cette colonne')
    await page.waitForTimeout(500)
  }

  // Sélectionne un mode d'ordre (Défaut/A → Z/Z → A) et collapse tous les groupes
  // pour que tous les entêtes tiennent dans le viewport (sinon le virtualizer
  // ne rend que les entêtes proches du scroll position). Doit être appelé alors
  // que le panneau Grouper est ouvert.
  async function applyOrderAndCollapse(orderLabel) {
    await page.click(`button:has-text("${orderLabel}")`)
    await page.waitForTimeout(300)
    await page.click('button:has-text("Tout fermer")')
    await page.waitForTimeout(300)
    // Ferme le panneau en cliquant ailleurs
    await page.mouse.click(20, 20)
    await page.waitForTimeout(200)
  }

  test('le panneau Grouper expose Défaut / A → Z / Z → A quand un groupBy single_select est actif', async () => {
    await setupGroupByStatus()
    // Ouvrir le panneau Grouper
    await page.click('button[data-panel-btn="group"]')
    // Attend que les boutons d'ordre (rendus par niveau actif) soient présents
    await page.waitForSelector('button:has-text("A → Z")', { timeout: 3000 })
    for (const label of ['Défaut', 'A → Z', 'Z → A']) {
      const visible = await page.locator(`button:has-text("${label}")`).first().isVisible()
      assert.ok(visible, `bouton "${label}" absent`)
    }
    await page.keyboard.press('Escape')
  })

  test('A → Z trie les groupes alphabétiquement croissant', async () => {
    await setupGroupByStatus()
    await page.click('button[data-panel-btn="group"]')
    await page.waitForSelector('button:has-text("A → Z")', { timeout: 3000 })
    await applyOrderAndCollapse('A → Z')
    const headers = await getGroupHeaders(page)
    assert.ok(headers.length >= 2, `au moins 2 groupes attendus, got ${headers.length}: ${JSON.stringify(headers)}`)
    const sorted = [...headers].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }))
    assert.deepEqual(headers, sorted, `groupes pas en ordre A→Z: ${JSON.stringify(headers)}`)
  })

  test('Z → A trie les groupes alphabétiquement décroissant', async () => {
    await setupGroupByStatus()
    await page.click('button[data-panel-btn="group"]')
    await page.waitForSelector('button:has-text("A → Z")', { timeout: 3000 })
    await applyOrderAndCollapse('Z → A')
    const headers = await getGroupHeaders(page)
    assert.ok(headers.length >= 2, `au moins 2 groupes attendus`)
    const sortedDesc = [...headers].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' })).reverse()
    assert.deepEqual(headers, sortedDesc, `groupes pas en ordre Z→A: ${JSON.stringify(headers)}`)
  })

  test('Défaut respecte l\'ordre des options de TABLE_COLUMN_META', async () => {
    await setupGroupByStatus()
    await page.click('button[data-panel-btn="group"]')
    await page.waitForSelector('button:has-text("A → Z")', { timeout: 3000 })
    await applyOrderAndCollapse('Défaut')
    const headers = await getGroupHeaders(page)
    // Pour factures : options = ['Payée', 'Partielle', 'En retard', 'Envoyée', 'Brouillon', 'Annulée']
    const optionsOrder = ['Payée', 'Partielle', 'En retard', 'Envoyée', 'Brouillon', 'Annulée']
    const positions = headers.map(h => {
      const idx = optionsOrder.indexOf(h)
      return idx === -1 ? Number.MAX_SAFE_INTEGER : idx
    })
    // Vérifie que les positions sont en ordre croissant (les groupes hors options
    // sont en queue, regroupés ensemble)
    for (let i = 1; i < positions.length; i++) {
      assert.ok(
        positions[i] >= positions[i - 1],
        `groupe "${headers[i]}" (pos ${positions[i]}) après "${headers[i-1]}" (pos ${positions[i-1]}): ${JSON.stringify(headers)}`,
      )
    }
  })
})
