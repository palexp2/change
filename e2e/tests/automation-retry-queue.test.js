const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const path = require('path')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const ROUTER_ID = 'sys_airtable_webhook_router'

// Throwaway fixture row in webhook_sync_retry. There is no API seam to create a
// retry entry (the queue is only populated when a real Airtable sync fails), so
// the panel's populated state is tested with a fake row inserted directly.
// The module name is intentionally unknown to SYNC_FNS, so processRetryQueue()
// (triggered by "Retenter maintenant") simply DELETES it without hitting Airtable
// — zero external side effects. after() removes the row if it somehow survives.
const FIXTURE_ID = `e2e-retry-${Date.now()}`
const FIXTURE_MODULE = `e2e-fake-module-${Date.now()}`

// Resolve the server's better-sqlite3 + DB from this test file's location.
const DB_PATH = path.resolve(__dirname, '../../server/data/erp.db')
const BetterSqlite3 = require(path.resolve(__dirname, '../../server/node_modules/better-sqlite3'))

function seedFixture() {
  const db = new BetterSqlite3(DB_PATH)
  try {
    db.prepare(`
      INSERT INTO webhook_sync_retry (id, module, changes, attempts, last_error, created_at, next_retry_at)
      VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'))
    `).run(FIXTURE_ID, FIXTURE_MODULE, '{}', 3, 'E2E synthetic error: connexion refusée')
  } finally {
    db.close()
  }
}

function deleteFixture() {
  const db = new BetterSqlite3(DB_PATH)
  try {
    db.prepare('DELETE FROM webhook_sync_retry WHERE id=?').run(FIXTURE_ID)
  } finally {
    db.close()
  }
}

describe('Retry queue panel — sys_airtable_webhook_router', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => {
    deleteFixture()
    await browser?.close()
  })

  test('GET /retry-queue renvoie { items, max_attempts } pour le router', async () => {
    const res = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/automations/${id}/retry-queue`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return { status: r.status, body: await r.json() }
    }, ROUTER_ID)
    assert.strictEqual(res.status, 200)
    assert.ok(Array.isArray(res.body.items), 'items doit être un tableau')
    assert.ok(typeof res.body.max_attempts === 'number', 'max_attempts doit être un nombre')
  })

  test('GET /retry-queue 404 pour une autre automation', async () => {
    const res = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/automations/sys_installation_followup/retry-queue', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return r.status
    })
    assert.strictEqual(res, 404, 'le retry-queue ne doit exister que pour le router')
  })

  test('UI affiche le panneau (état vide quand aucune entrée)', async () => {
    // Make sure no fixture is present for this assertion.
    deleteFixture()
    await page.goto(`${URL}/automations/${ROUTER_ID}`, { waitUntil: 'networkidle' })
    const panel = page.locator('[data-testid="retry-queue-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 8000 })
    await assert.doesNotReject(
      page.locator('[data-testid="retry-queue-empty"]').waitFor({ state: 'visible', timeout: 6000 }),
      'l\'état vide devrait s\'afficher quand la file est vide'
    )
  })

  test('UI affiche une entrée en échec + bouton, et le retry la draine', async () => {
    seedFixture()
    await page.goto(`${URL}/automations/${ROUTER_ID}`, { waitUntil: 'networkidle' })

    const item = page.locator('[data-testid="retry-queue-item"]')
    await item.first().waitFor({ state: 'visible', timeout: 8000 })

    // Le module en échec + le compteur de tentatives + l'erreur sont rendus.
    const itemText = await item.first().innerText()
    assert.ok(itemText.includes(FIXTURE_MODULE), 'le nom du module doit apparaître')
    assert.ok(/3\/\d+\s+tentative/.test(itemText), 'le compteur de tentatives doit apparaître')
    assert.ok(itemText.includes('E2E synthetic error'), 'la dernière erreur doit apparaître')

    // Clic « Retenter maintenant » → confirmation → drain.
    await page.locator('[data-testid="retry-now-btn"]').first().click()
    await page.locator('button:has-text("Retenter")').last().click()

    // Le module est inconnu de SYNC_FNS → processRetryQueue le supprime.
    // La liste passe à l'état vide après refresh côté serveur.
    await page.locator('[data-testid="retry-queue-empty"]').waitFor({ state: 'visible', timeout: 10000 })

    // Confirme côté API que la file est bien vidée de notre fixture.
    const stillThere = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/automations/${id}/retry-queue`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const b = await r.json()
      return b.items
    }, ROUTER_ID)
    assert.ok(
      !stillThere.some(i => i.id === FIXTURE_ID),
      'le fixture doit avoir été drainé par le retry'
    )
  })

  test('POST retry sur un retryId inexistant → 404', async () => {
    const res = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/automations/${id}/retry-queue/nope-does-not-exist/retry`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
      return r.status
    }, ROUTER_ID)
    assert.strictEqual(res, 404)
  })
})
