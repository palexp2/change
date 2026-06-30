const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Règle design FK : le nom d'un employé lié dans le tableau paie_items doit être
// un lien cliquable vers /employees/:employee_id (et non un texte brut).
// Ce test ne fait que LIRE des données existantes — aucun record créé ni muté.
describe('Paies — employee_name du tableau paie_items est un lien FK', () => {
  let browser, ctx, page
  let paieId, emp // emp = { employee_id, first_name, last_name }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Trouve une paie existante dont les items ont un employé lié (lecture seule).
    const found = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}` }
      const list = await fetch('/erp/api/paies?limit=500', { headers: h }).then(r => r.json())
      const rows = list.data || list.rows || (Array.isArray(list) ? list : [])
      for (const p of rows.filter(r => (r.items_count || 0) > 0)) {
        const detail = await fetch(`/erp/api/paies/${p.id}`, { headers: h }).then(r => r.json())
        const item = (detail.items || []).find(i => i.employee_id && (i.first_name || i.last_name))
        if (item) return { paieId: p.id, emp: { employee_id: item.employee_id, first_name: item.first_name, last_name: item.last_name } }
      }
      return null
    })
    assert.ok(found, 'une paie avec au moins un item lié à un employé doit exister')
    paieId = found.paieId
    emp = found.emp
  })

  after(async () => {
    await browser?.close()
  })

  test('le nom employé rend un <a> vers /employees/:id et navigue au clic', async () => {
    await page.goto(URL + '/paies', { waitUntil: 'domcontentloaded' })

    // Ouvre la fiche paie ciblée (la ligne porte data-row-id = id de la paie).
    const row = page.locator(`[data-row-id="${paieId}"]`)
    await row.waitFor({ state: 'visible', timeout: 15000 })
    await row.click()

    // La modale PaieDetail charge le tableau paie_items.
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ timeout: 10000 })

    // Le lien FK vers la fiche employé doit exister, avec le nom complet en texte.
    const link = dialog.locator(`a[href$="/employees/${emp.employee_id}"]`).first()
    await link.waitFor({ state: 'visible', timeout: 10000 })
    const txt = (await link.innerText()).trim()
    const expected = `${emp.first_name || ''} ${emp.last_name || ''}`.trim()
    assert.ok(txt.includes(expected) && expected.length > 0, `le lien doit afficher le nom de l'employé (« ${expected} », vu « ${txt} »)`)

    // Clic → navigation vers la fiche employé.
    await link.click()
    await page.waitForURL(u => u.toString().includes(`/employees/${emp.employee_id}`), { timeout: 10000 })
    assert.ok(page.url().includes(`/employees/${emp.employee_id}`), 'le clic doit naviguer vers /employees/:id')
  })
})
