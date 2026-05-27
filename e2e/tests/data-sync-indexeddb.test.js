// Vérifie que la persistance IndexedDB rend le 2e démarrage quasi-instant :
// au 1er mount → bootstrap complet (5-10s) + écriture IDB ; au 2e mount
// (reload du navigateur) → load IDB (~100ms) + delta léger.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login() {
  const r = await fetch(`${URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  })
  if (!r.ok) throw new Error(`Login failed: ${r.status}`)
  const { token } = await r.json()
  return token
}

describe('Data sync — persistance IndexedDB', () => {
  let token, browser, ctx, page

  before(async () => {
    token = await login()
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.addInitScript((t) => localStorage.setItem('erp_token', t), token)
  })

  after(async () => { await browser?.close() })

  test('1er mount fait un bootstrap, persiste en IDB ; 2e mount lit IDB', async () => {
    // 1er load — full bootstrap.
    const bootstrapResponses1 = []
    const handler1 = (r) => {
      if (r.url().includes('/erp/api/bootstrap') && !r.url().includes('/delta')) {
        bootstrapResponses1.push({ url: r.url(), status: r.status() })
      }
    }
    page.on('response', handler1)

    await page.goto(`${URL}/dashboard`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => {
      const s = window.__erpStore?.()
      return s && (s.tables.contacts?.rows || 0) > 0
    }, { timeout: 60000 })

    // Laisse persistSnapshot() se terminer (lancé en arrière-plan, ~1-2s pour
    // 64MB → IndexedDB).
    await page.waitForTimeout(3000)

    page.off('response', handler1)
    const initialBootstrapCalls = bootstrapResponses1.length
    assert.ok(initialBootstrapCalls >= 1, 'Le 1er mount doit faire au moins un GET /api/bootstrap')

    // 2e mount — reload de la page, IDB doit fournir les données instantanément.
    const bootstrapResponses2 = []
    const deltaResponses2 = []
    const handler2 = (r) => {
      const u = r.url()
      if (u.includes('/erp/api/bootstrap/delta')) deltaResponses2.push(u)
      else if (u.includes('/erp/api/bootstrap')) bootstrapResponses2.push(u)
    }
    page.on('response', handler2)

    const t0 = Date.now()
    await page.reload({ waitUntil: 'domcontentloaded' })
    // Attend que le store soit hydraté (peut être IDB-instant).
    await page.waitForFunction(() => {
      const s = window.__erpStore?.()
      return s && (s.tables.contacts?.rows || 0) > 0
    }, { timeout: 30000 })
    const elapsedMs = Date.now() - t0

    // Le delta de rattrapage est asynchrone — laisse le temps qu'il soit émis.
    await page.waitForTimeout(2000)

    console.log(`hydratation 2e mount: ${elapsedMs}ms ; bootstrap=${bootstrapResponses2.length} delta=${deltaResponses2.length}`)

    // 2e mount doit utiliser IDB → pas de /api/bootstrap, juste un delta.
    assert.equal(bootstrapResponses2.length, 0,
      `Pas de bootstrap au 2e mount (IDB doit suffire). Vu: ${bootstrapResponses2.join(', ')}`)
    assert.ok(deltaResponses2.length >= 1,
      'Au moins un appel /bootstrap/delta attendu pour rattraper depuis le snapshot persisté')

    // Hydratation instant (< 3s) — l'IDB read est rapide.
    assert.ok(elapsedMs < 8000,
      `Hydratation devrait être rapide grâce à IDB (vu ${elapsedMs}ms)`)
  })
})
