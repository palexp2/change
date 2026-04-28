const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Feuille de temps — verrouillage du mode quand des entrées existent', () => {
  let browser, ctx, page
  const testDate = '2030-02-12' // date isolée
  let createdDayId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'fr-CA' })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => {
    if (createdDayId) {
      await page.evaluate(async ({ id }) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/timesheets/day/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      }, { id: createdDayId })
    }
    await browser?.close()
  })

  test('Backend — PATCH mode=simple interdit si entries existent (409)', async () => {
    const out = await page.evaluate(async ({ date }) => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const day = await fetch('/erp/api/timesheets/day', {
        method: 'POST', headers: h, body: JSON.stringify({ date, mode: 'detailed' }),
      }).then(r => r.json())
      await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST', headers: h, body: JSON.stringify({ description: 'Test', duration: '30' }),
      })
      const r = await fetch(`/erp/api/timesheets/day/${day.id}`, {
        method: 'PATCH', headers: h, body: JSON.stringify({ mode: 'simple' }),
      })
      return { id: day.id, status: r.status, body: await r.json() }
    }, { date: testDate })
    createdDayId = out.id
    assert.strictEqual(out.status, 409, `attendu 409, reçu ${out.status}`)
    assert.match(out.body.error, /simplifi/i)
    // Vérifie que le mode n'a PAS changé en DB
    const stillDetailed = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      const d = await fetch(`/erp/api/timesheets/day?date=2030-02-12`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      return d.mode
    }, { id: createdDayId })
    assert.strictEqual(stillDetailed, 'detailed')
  })

  test('Backend — PATCH mode=simple autorisé si aucune entry', async () => {
    const out = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      // Récupère l'unique entry et la supprime
      const d = await fetch(`/erp/api/timesheets/day?date=2030-02-12`, { headers: h }).then(r => r.json())
      for (const e of (d.entries || [])) {
        await fetch(`/erp/api/timesheets/entries/${e.id}`, { method: 'DELETE', headers: h })
      }
      const r = await fetch(`/erp/api/timesheets/day/${id}`, {
        method: 'PATCH', headers: h, body: JSON.stringify({ mode: 'simple' }),
      })
      return { status: r.status, body: await r.json() }
    }, { id: createdDayId })
    assert.strictEqual(out.status, 200)
    assert.strictEqual(out.body.mode, 'simple')
  })

  test('UI — bouton "Simplifié" désactivé quand entries > 0 en mode détaillé', async () => {
    // Reprépare la journée avec une entry
    await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      await fetch(`/erp/api/timesheets/day/${id}`, {
        method: 'PATCH', headers: h, body: JSON.stringify({ mode: 'detailed' }),
      })
      await fetch(`/erp/api/timesheets/day/${id}/entries`, {
        method: 'POST', headers: h, body: JSON.stringify({ description: 'UI test', duration: '45' }),
      })
    }, { id: createdDayId })

    // Ouvre la page à la bonne date (shiftDate depuis today)
    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Feuille de temps")', { timeout: 10000 })
    // Navigue jusqu'à testDate via l'API (plus simple que cliquer des chevrons pendant 4 ans)
    await page.evaluate(({ date }) => {
      // Force React state via dispatch d'un event sur le store — pas faisable ici.
      // On charge /feuille-de-temps avec un localStorage hack ? Non. On se rabat sur l'API pour valider côté data
      // et on vérifie la UI via le cas simple : rendre les entries visibles en chargeant aujourd'hui via setDate.
      void date
    }, { date: testDate })

    // Plan B : crée une journée "aujourd'hui" avec entries puis vérifie le bouton
    const { todayId, todayStr } = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const today = new Date().toISOString().slice(0, 10)
      let d = await fetch(`/erp/api/timesheets/day?date=${today}`, { headers: h }).then(r => r.json())
      if (!d) {
        d = await fetch('/erp/api/timesheets/day', { method: 'POST', headers: h, body: JSON.stringify({ date: today, mode: 'detailed' }) }).then(r => r.json())
      } else {
        await fetch(`/erp/api/timesheets/day/${d.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ mode: 'detailed' }) })
      }
      // Ajoute une entry si la journée est vide
      if (!d.entries || d.entries.length === 0) {
        await fetch(`/erp/api/timesheets/day/${d.id}/entries`, {
          method: 'POST', headers: h, body: JSON.stringify({ description: 'UI lock test', duration: '15' }),
        })
      }
      return { todayId: d.id, todayStr: today }
    })
    void todayStr

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Feuille de temps")', { timeout: 10000 })
    // Le bouton "Simplifié" doit être disabled
    const simpleBtn = page.locator('button:has-text("Simplifié")')
    await simpleBtn.waitFor({ state: 'visible' })
    const disabled = await simpleBtn.isDisabled()
    assert.strictEqual(disabled, true, 'Bouton "Simplifié" doit être désactivé quand entries > 0')
    // Libellé de verrouillage visible
    await page.waitForSelector('text=/Mode verrouillé/', { timeout: 2000 })

    // Cleanup : supprime les entries ajoutées "aujourd'hui" pour ne pas polluer
    await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}` }
      const d = await fetch(`/erp/api/timesheets/day?date=${new Date().toISOString().slice(0,10)}`, { headers: h }).then(r => r.json())
      for (const e of (d?.entries || []).filter(x => x.description === 'UI lock test')) {
        await fetch(`/erp/api/timesheets/entries/${e.id}`, { method: 'DELETE', headers: h })
      }
      void id
    }, { id: todayId })
  })
})
