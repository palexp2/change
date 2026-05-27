// Vérifie deux comportements ajoutés au ServerOfflineOverlay :
//   1. Debounce 400 ms : un blip ultra-court (~150 ms) n'affiche jamais l'overlay.
//   2. Détection pm2 restart : si le boot_id renvoyé par /api/health change
//      entre le moment "avant l'outage" et "ping de récupération", l'overlay
//      passe à l'état "Mise à jour de l'app en cours" avant le reload.

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

describe('Server offline overlay — debounce + restart detection', () => {
  let token, browser, ctx, page

  before(async () => {
    token = await login()
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.addInitScript((t) => localStorage.setItem('erp_token', t), token)
    await page.goto(`${URL}/dashboard`, { waitUntil: 'domcontentloaded' })
    // Laisse le temps à au moins une réponse API de capturer le boot_id initial.
    await page.waitForLoadState('networkidle').catch(() => {})
  })

  after(async () => { await browser?.close() })

  test('un blip de 150 ms ne déclenche pas l\'overlay (debounce 400 ms)', async () => {
    // Bloque le réseau, déclenche un fetch (markOffline armé), puis débloque
    // bien avant la fin du debounce.
    await page.route('**/erp/api/**', (route) => route.abort('failed'))

    // Déclenche une requête qui passera par api.js (donc markOffline avec debounce).
    page.evaluate(() => {
      // Force un fetch via api.js : navigue vers une page qui charge des données.
      // On reste dans la même page pour éviter un full reload.
      fetch('/erp/api/companies?limit=10', {
        headers: { Authorization: `Bearer ${localStorage.getItem('erp_token')}` },
      }).catch(() => {})
    })

    // Attend 150 ms (bien sous le seuil de 400 ms) puis débloque.
    await page.waitForTimeout(150)
    await page.unroute('**/erp/api/**')

    // Déclenche une requête qui devrait réussir et call markOnline avant que
    // le timer de 400 ms ne tire.
    await page.evaluate(() => fetch('/erp/api/health').catch(() => {}))

    // Attend 600 ms supplémentaires — si l'overlay devait apparaître, ce serait
    // largement le cas après 400 ms.
    await page.waitForTimeout(600)

    const overlay = await page.$('text=Connexion au serveur perdue')
    assert.equal(overlay, null, 'overlay ne doit pas apparaître pour un blip < 400 ms')
  })

  test('boot_id différent au ping de récupération → "Mise à jour de l\'app en cours"', async () => {
    // Recharge le dashboard pour repartir d'un bundle propre, et attend la
    // 1ère réponse API (qui transporte le X-Boot-Id réel dans son header) —
    // c'est ce boot_id qui sera comparé avec celui de notre /health truqué.
    await page.goto(`${URL}/dashboard`, { waitUntil: 'domcontentloaded' })
    await page.waitForResponse((r) => r.url().includes('/erp/api/') && r.ok(), { timeout: 10000 })
    // Petit délai pour s'assurer que noteBootId() a été appelé.
    await page.waitForTimeout(200)

    // /api/health renvoie un boot_id différent → le client doit interpréter
    // ça comme un redémarrage du serveur.
    await page.route('**/erp/api/health', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Boot-Id': 'forced-different-boot-id' },
        body: JSON.stringify({
          boot_id: 'forced-different-boot-id',
          started_at: new Date().toISOString(),
        }),
      })
    })

    // Bloque tout sauf /health.
    await page.route('**/erp/api/**', (route) => {
      if (route.request().url().includes('/api/health')) return route.fallback()
      return route.abort('failed')
    })

    // Déclenche markOffline via SPA navigation (clic sur la nav, pas un reload).
    await page.click('a[href="/erp/companies"]').catch(() => {})

    await page.waitForSelector('text=Connexion au serveur perdue', { timeout: 8000 })

    // Le countdown est 10s — attend le ping /health et l'écran de redémarrage.
    await page.waitForSelector("text=Mise à jour de l'app en cours", { timeout: 15000 })

    await page.unroute('**/erp/api/**')
    await page.unroute('**/erp/api/health')
  })
})
