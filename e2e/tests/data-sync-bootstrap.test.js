// Vérifie que le cache client (lib/dataSync + dataStore) :
//   1. fait un bootstrap au login (window.__erpStore() renvoie des tables hydratées)
//   2. expose les helpers de debug attendus
//   3. survit à un reload (sans assertion sur l'IndexedDB pour l'instant — la
//      persistance arrive en Phase 5)

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

describe('Data sync — bootstrap au login', () => {
  let token, browser, ctx, page

  before(async () => {
    token = await login()
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.addInitScript((t) => localStorage.setItem('erp_token', t), token)
  })

  after(async () => { await browser?.close() })

  test('le store est hydraté avec les tables attendues après auth', async () => {
    await page.goto(`${URL}/dashboard`, { waitUntil: 'domcontentloaded' })

    // Attend que le bootstrap soit terminé (jusqu'à 30s — la requête fait ~5s
    // + le parse côté client).
    const state = await page.waitForFunction(() => {
      if (typeof window.__erpStore !== 'function') return null
      const s = window.__erpStore()
      // On considère le bootstrap terminé quand au moins 5 tables sont hydratées.
      const hydrated = Object.entries(s.tables).filter(([, v]) => v.rows > 0)
      if (hydrated.length < 5) return null
      return s
    }, { timeout: 60000 }).then((h) => h.jsonValue())

    assert.ok(state.lastSyncTs, 'lastSyncTs doit être défini')

    // Tables critiques attendues.
    const tables = state.tables
    for (const t of ['companies', 'contacts', 'products', 'orders']) {
      assert.ok(tables[t], `table ${t} doit être présente dans le store`)
      assert.ok(tables[t].rows > 0, `table ${t} doit avoir des rows hydratées`)
    }

    console.log('store hydraté:', Object.fromEntries(
      Object.entries(tables).map(([k, v]) => [k, v.rows])
    ))
  })

  test('le delta polling tourne et met à jour lastSyncTs', async () => {
    const ts1 = await page.evaluate(() => window.__erpStore().lastSyncTs)
    // Attend ~12s pour qu'un tick de polling (10s) ait eu lieu.
    await page.waitForTimeout(12000)
    const ts2 = await page.evaluate(() => window.__erpStore().lastSyncTs)
    assert.ok(ts2 >= ts1, `lastSyncTs doit avancer (était ${ts1}, devenu ${ts2})`)
    // Au moins un changement (le poll réussit) → ts2 strictement plus récent.
    assert.notEqual(ts2, ts1, 'lastSyncTs doit changer après un tick de polling')
  })
})
