const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

describe('Automations — colonne Dernier Run affiche aussi l\'heure', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    await page.goto(URL + '/automations', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Automations")', { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('les cellules Dernier Run montrent la date ET l\'heure (YYYY-MM-DD HH:MM)', async (t) => {
    // Récupère via l'API une automation avec un vrai timestamp de dernier run,
    // pour comparer contre le rendu attendu dans le fuseau du navigateur.
    const sample = await page.evaluate(async () => {
      const res = await fetch('/erp/api/automations', {
        headers: { Authorization: `Bearer ${localStorage.getItem('erp_token')}` },
      })
      const rows = await res.json()
      const row = (Array.isArray(rows) ? rows : []).find(r => r.last_run_at)
      if (!row) return null
      const dt = new Date(row.last_run_at)
      const pad = n => String(n).padStart(2, '0')
      const expected = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`
      return { name: row.name, last_run_at: row.last_run_at, expected }
    })

    if (!sample) {
      t.skip('aucune automation avec last_run_at — rien à vérifier')
      return
    }

    // La valeur attendue (avec heure) doit apparaître dans le tableau.
    const cell = page.locator(`text=${sample.expected}`)
    assert.ok(
      await cell.count() >= 1,
      `"${sample.expected}" (dérivé de ${sample.last_run_at}) introuvable dans le tableau — l'heure n'est probablement pas affichée`
    )

    // Et aucune cellule Dernier Run ne doit rester au format date seule :
    // toutes les valeurs rendues doivent contenir HH:MM.
    const bare = await page.locator('td span.text-slate-500.text-xs')
      .filter({ hasText: /^\d{4}-\d{2}-\d{2}$/ }).count()
    assert.equal(bare, 0, `${bare} cellule(s) Dernier Run sans composante horaire`)
  })
})
