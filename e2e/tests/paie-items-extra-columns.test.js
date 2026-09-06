const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Les champs holiday_1_20 (paie fériée QC, calculé serveur), insurance_gains et
// paid_leave (synchronisés depuis Airtable) existent en DB mais n'étaient affichés
// nulle part : RENDERS_PAIE_ITEMS ne les rendait pas et ils étaient hidden par
// défaut. Ce test vérifie qu'ils apparaissent désormais dans le tableau de la
// modale PaieDetail (colonnes default-visible + rendu monétaire/texte).
// Lecture seule : aucun record créé ni muté.
describe('Paies — colonnes Férié 1/20 / Gains assur. / Congés payés visibles', () => {
  let browser, ctx, page
  let paieId, sample // sample = { holiday_1_20, insurance_gains, paid_leave } d'un item, si dispo

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Trouve une paie avec items. Préfère une paie dont au moins un item porte une
    // valeur non-nulle sur l'un des champs ciblés, pour vérifier le rendu de valeur.
    const found = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}` }
      const list = await fetch('/erp/api/paies?limit=500', { headers: h }).then(r => r.json())
      const rows = list.data || list.rows || (Array.isArray(list) ? list : [])
      let fallback = null
      for (const p of rows) {
        const detail = await fetch(`/erp/api/paies/${p.id}`, { headers: h }).then(r => r.json())
        const items = detail.items || []
        if (items.length === 0) continue
        if (!fallback) fallback = { paieId: p.id, sample: null }
        const withVal = items.find(i =>
          i.holiday_1_20 != null || i.insurance_gains != null || (i.paid_leave != null && i.paid_leave !== ''))
        if (withVal) {
          return {
            paieId: p.id,
            sample: {
              holiday_1_20: withVal.holiday_1_20,
              insurance_gains: withVal.insurance_gains,
              paid_leave: withVal.paid_leave,
            },
          }
        }
      }
      return fallback
    })
    assert.ok(found, 'au moins une paie avec items doit exister')
    paieId = found.paieId
    sample = found.sample
  })

  after(async () => {
    await browser?.close()
  })

  test('les en-têtes des nouvelles colonnes apparaissent dans la modale PaieDetail', async () => {
    await page.goto(URL + '/paies', { waitUntil: 'domcontentloaded' })

    const row = page.locator(`[data-row-id="${paieId}"]`)
    await row.waitFor({ state: 'visible', timeout: 15000 })
    await row.click()

    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ timeout: 10000 })
    // Attend le rendu du tableau paie_items.
    await dialog.locator('table, [data-row-id]').first().waitFor({ timeout: 10000 })

    // Les en-têtes sont rendus en majuscules via CSS (text-transform), donc
    // innerText les renvoie en majuscules — comparaison insensible à la casse.
    const dialogText = (await dialog.innerText()).toLocaleUpperCase('fr-CA')
    for (const label of ['Férié 1/20', 'Gains assur.', 'Congés payés']) {
      const up = label.toLocaleUpperCase('fr-CA')
      assert.ok(dialogText.includes(up), `l'en-tête « ${label} » doit être visible dans la modale (vu : ${dialogText.slice(0, 500)})`)
    }
  })

  test('une valeur non-nulle est rendue formatée (si des données existent)', async (t) => {
    if (!sample) {
      t.skip('aucun item ne porte de valeur sur holiday_1_20 / insurance_gains / paid_leave')
      return
    }

    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ timeout: 10000 })
    const dialogText = await dialog.innerText()

    // Calcule la chaîne attendue avec le MÊME formateur que money()/num() du front,
    // exécuté dans le navigateur pour matcher exactement le locale rendu.
    const expected = await page.evaluate((s) => {
      const money = n => n == null ? null : new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2 }).format(n)
      const num = n => n == null ? null : Number(n).toLocaleString('fr-CA', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
      const out = {}
      if (s.holiday_1_20 != null) out.holiday_1_20 = money(s.holiday_1_20)
      if (s.insurance_gains != null) out.insurance_gains = money(s.insurance_gains)
      if (s.paid_leave != null && s.paid_leave !== '') out.paid_leave = String(s.paid_leave)
      return out
    }, sample)

    const checks = Object.entries(expected)
    assert.ok(checks.length > 0, 'au moins une valeur attendue doit être calculée')
    // Au moins une des valeurs ciblées doit apparaître telle quelle dans la modale.
    const anyVisible = checks.some(([, v]) => v && dialogText.includes(v))
    assert.ok(anyVisible, `au moins une valeur formatée parmi ${JSON.stringify(expected)} doit apparaître (texte vu : ${dialogText.slice(0, 600)})`)
  })
})
