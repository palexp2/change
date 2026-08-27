const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// L'audit de réconciliation factures↔QB est exposé hors de la route admin :
// GET /api/projets/factures/reconciliation-audit doit être accessible à tout
// utilisateur connecté (même non-admin), et l'ancienne route admin a disparu.
describe('Audit de réconciliation factures↔QB — accessible hors admin', () => {
  let browser, ctx, page
  const tag = Date.now().toString(36)
  const opsEmail = `e2e-recon-audit-${tag}@test.local`
  const opsPass = `E2e-${tag}-Xy!`
  let opsUserId = null
  let opsToken = null

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
    // Nettoyage : désactive l'utilisateur jetable créé pour le test.
    if (opsUserId) {
      await page.evaluate(async (id) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/admin/users/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {})
      }, opsUserId)
    }
    await browser?.close()
  })

  test('setup : création d\'un utilisateur jetable non-admin (ops)', async () => {
    const res = await page.evaluate(async ({ email, password }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/admin/users', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name: 'E2E Recon Audit', password, role: 'ops' }),
      })
      return { status: r.status, body: await r.json() }
    }, { email: opsEmail, password: opsPass })
    assert.strictEqual(res.status, 201, JSON.stringify(res.body))
    opsUserId = res.body.id
    assert.ok(opsUserId)

    const login = await page.evaluate(async ({ email, password }) => {
      const r = await fetch('/erp/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      return { status: r.status, body: await r.json() }
    }, { email: opsEmail, password: opsPass })
    assert.strictEqual(login.status, 200, JSON.stringify(login.body))
    opsToken = login.body.token
    assert.ok(opsToken)
  })

  test('GET /projets/factures/reconciliation-audit → 200 pour un non-admin', async () => {
    const res = await page.evaluate(async (token) => {
      const r = await fetch('/erp/api/projets/factures/reconciliation-audit', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return { status: r.status, body: await r.json() }
    }, opsToken)
    assert.strictEqual(res.status, 200, JSON.stringify(res.body).slice(0, 300))
    assert.ok(res.body.generated_at, 'generated_at attendu')
    assert.ok(res.body.defs && typeof res.body.defs === 'object', 'defs attendu')
    assert.strictEqual(typeof res.body.summary?.total_factures, 'number')
    assert.strictEqual(typeof res.body.summary?.flagged, 'number')
    assert.ok(Array.isArray(res.body.factures), 'factures[] attendu')
    assert.strictEqual(res.body.factures.length, res.body.summary.flagged)
  })

  test('sans token → 401', async () => {
    const res = await page.evaluate(async () => {
      const r = await fetch('/erp/api/projets/factures/reconciliation-audit')
      return { status: r.status }
    })
    assert.strictEqual(res.status, 401)
  })

  test('ancienne route admin /admin/facture-reconciliation-audit → 404 (même en admin)', async () => {
    const res = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/admin/facture-reconciliation-audit', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return { status: r.status }
    })
    assert.strictEqual(res.status, 404)
  })

  test('/factures/:id reste intact (pas d\'ombrage par la nouvelle route)', async () => {
    // La nouvelle route est déclarée avant /factures/:id — vérifie qu'un id
    // réel passe toujours et qu'un id bidon donne bien 404 (pas l'audit).
    const res = await page.evaluate(async (token) => {
      const list = await fetch('/erp/api/projets/factures?limit=1', {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => r.json())
      const first = (list.data || []).find(f => f.source !== 'pending')
      let detailStatus = null
      if (first) {
        const r = await fetch(`/erp/api/projets/factures/${first.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        detailStatus = r.status
      }
      const bogus = await fetch('/erp/api/projets/factures/id-inexistant-e2e', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return { detailStatus, bogusStatus: bogus.status }
    }, opsToken)
    if (res.detailStatus !== null) assert.strictEqual(res.detailStatus, 200)
    assert.strictEqual(res.bogusStatus, 404)
  })
})
