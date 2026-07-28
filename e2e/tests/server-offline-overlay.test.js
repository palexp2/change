// Vérifie que l'overlay « Connexion au serveur perdue » s'affiche quand
// fetch() retourne une erreur réseau (simulée via route abort) et disparaît
// quand le serveur redevient joignable (sans reload si le boot_id n'a pas
// changé — voir server-offline-modal-persists.test.js).

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

describe('Server offline overlay', () => {
  let token, browser, ctx, page

  before(async () => {
    token = await login()
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.addInitScript((t) => localStorage.setItem('erp_token', t), token)
    await page.goto(`${URL}/dashboard`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=Tableau de bord, text=Dashboard', { timeout: 10000 }).catch(() => {})
  })

  after(async () => { await browser?.close() })

  test("l'overlay apparaît quand une requête API échoue avec une erreur réseau", async () => {
    // 1. Simuler une coupure : toute requête /erp/api/* est abortée.
    await page.route('**/erp/api/**', (route) => route.abort('failed'))

    // 2. Déclencher un GET API (n'importe lequel via api.js).
    await page.evaluate(async () => {
      try {
        const r = await fetch('/erp/api/auth/me', {
          headers: { Authorization: `Bearer ${localStorage.getItem('erp_token')}` },
        })
        return r.ok
      } catch { return false }
    })

    // L'overlay est monté côté UI sur erreur api.js. Mais pour reproduire le
    // chemin de prod, déclenchons via lib/api : l'appel ci-dessus utilise un
    // fetch natif. Forcer le code production via window.dispatchEvent serait
    // trop intrusif → on importe le helper directement.
    await page.evaluate(() => {
      // Le bundle expose serverStatus en mode module → markOffline n'est pas
      // global, mais on peut déclencher via une vraie requête API. On vide
      // le cache de prefetch pour s'assurer qu'un nouveau GET passe.
      window.location.hash = '#trigger-offline-test'
    })

    // Méthode robuste : naviguer vers une page qui déclenche des GET via api.js.
    await page.goto(`${URL}/companies`, { waitUntil: 'domcontentloaded' }).catch(() => {})

    // 3. Vérifier que l'overlay apparaît (timeout généreux car react render).
    const overlayText = await page.waitForSelector(
      'text=Connexion au serveur perdue',
      { timeout: 8000 }
    )
    assert.ok(overlayText, 'overlay should be visible')

    // 4. Le countdown affiche bien des secondes.
    const countdownText = await page.textContent('body')
    assert.match(countdownText, /Nouvelle tentative dans \d+/, 'countdown visible')
  })

  test("l'overlay disparaît quand le serveur redevient joignable", async () => {
    // Lever la simulation de panne.
    await page.unroute('**/erp/api/**')

    // L'overlay ping /api/health toutes les 10s. Attendre jusqu'au prochain
    // tick (max ~12s).
    await page.waitForFunction(
      () => !document.body.textContent.includes('Connexion au serveur perdue'),
      { timeout: 20000 }
    )

    const stillVisible = await page.$('text=Connexion au serveur perdue')
    assert.equal(stillVisible, null, 'overlay should be gone after reload')
  })
})
