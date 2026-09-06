// Signalement /automations : une modale ouverte (ex. modification d'une
// automation système, gestion des vues) ne doit PAS se fermer quand la
// connexion au serveur est perdue.
//
// Avant le fix, ServerOfflineOverlay faisait window.location.reload() dans
// deux cas qui n'en avaient pas besoin :
//   1. Reprise après un blip réseau (boot_id inchangé) → reload « silencieux »
//      qui fermait toute modale ouverte et perdait l'état de la page.
//   2. pm2 restart SANS rebuild du client (boot_id changé, même bundle JS) —
//      le cas le plus fréquent ici (restarts serveur de l'agent) → reload
//      forcé 1.2 s après détection.
// Désormais le reload est réservé au seul cas où le bundle JS servi par
// index.html a réellement changé (vrai déploiement frontend).
//
// Note déterminisme : Layout poll /api/connectors/sync/status toutes les 5 s
// via api.js → son succès appelle markOnline() et masquerait l'overlay même
// dans l'ancien code. On le garde donc bloqué pendant la phase de reprise
// pour forcer le chemin « ping /api/health » — celui qui faisait reload.

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

describe('Modale ouverte + connexion serveur perdue → pas de reload, modale intacte', () => {
  let token, browser, ctx, page

  before(async () => {
    token = await login()
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.addInitScript((t) => localStorage.setItem('erp_token', t), token)
    await page.goto(`${URL}/automations`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Automations")', { timeout: 15000 })
  })

  after(async () => {
    // Cleanup : aucun record créé, aucune config modifiée — la modale de
    // gestion des vues n'a été qu'ouverte/fermée, sans écriture.
    try { await page.keyboard.press('Escape') } catch {}
    await browser?.close()
  })

  test('blip réseau : overlay affiché puis masqué sans reload, modale intacte', async () => {
    // Le crayon « Gérer les vues » n'est rendu que pour un admin.
    const pencil = page.locator('button[title="Gérer les vues"]')
    await pencil.waitFor({ state: 'visible', timeout: 10000 })

    // Marqueur volatile : il disparaît si la page recharge.
    await page.evaluate(() => { window.__noReloadMarker = 'alive' })

    // Le GET /views/automations de la page est mis en cache prefetch (TTL
    // 30 s). Pour que l'ouverture de la modale déclenche un vrai appel réseau
    // (qui échouera → markOffline), on attend l'expiration du cache.
    await page.waitForTimeout(31000)

    // 1. Couper la connexion au serveur (HTTP seulement — le WS reste up, la
    //    reprise ne peut donc venir que du ping /api/health de l'overlay,
    //    exactement le chemin qui faisait reload avant le fix).
    await page.route('**/erp/api/**', (route) => route.abort('failed'))

    // 2. Ouvrir la modale — son fetch des vues échoue → markOffline.
    await pencil.click()
    const dialog = page.locator('[role="dialog"]:has-text("Vues — Automations")')
    await dialog.waitFor({ state: 'visible', timeout: 5000 })

    // 3. L'overlay « Connexion au serveur perdue » apparaît (débounce 400 ms).
    await page.waitForSelector('text=Connexion au serveur perdue', { timeout: 8000 })

    // La modale est toujours montée sous l'overlay.
    assert.equal(await dialog.count(), 1, 'la modale doit rester montée pendant la coupure')

    // 4. Rétablir le réseau SAUF le poll sync-status (voir note en tête) —
    //    la reprise vient du ping /api/health de l'overlay (≤10 s), boot_id
    //    inchangé → masquage en place, PAS de reload.
    await page.unroute('**/erp/api/**')
    await page.route('**/erp/api/connectors/sync/status', (route) => route.abort('failed'))
    await page.waitForFunction(
      () => !document.body.textContent.includes('Connexion au serveur perdue'),
      { timeout: 20000 }
    )

    // 5. Pas de reload : le marqueur volatile est intact…
    const marker = await page.evaluate(() => window.__noReloadMarker)
    assert.equal(marker, 'alive', 'la page ne doit pas avoir été rechargée à la reprise')

    // …et la modale est toujours ouverte.
    assert.ok(await dialog.isVisible(), 'la modale doit rester ouverte après la reprise')

    // Stabilisation : rétablir aussi le poll sync-status (sinon ses échecs
    // re-affichent l'overlay), attendre un état en ligne stable, fermer la
    // modale (aucune écriture effectuée).
    await page.unroute('**/erp/api/connectors/sync/status')
    await page.waitForFunction(
      () => !document.body.textContent.includes('Connexion au serveur perdue'),
      { timeout: 20000 }
    )
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached', timeout: 5000 })
  })

  test('pm2 restart sans rebuild (boot_id changé, même bundle) : pas de reload, modale intacte', async () => {
    // Attendre qu'une réponse passée par api.js (poll sync-status du Layout)
    // ait fixé le boot_id de référence via noteBootId() — un fetch brut de
    // dataSync ne le fait pas.
    // Timeout généreux : le poll peut servir le cache prefetch (TTL 30 s)
    // sans toucher le réseau juste après le test précédent.
    await page.waitForResponse((r) => r.url().includes('/erp/api/connectors/sync/status') && r.ok(), { timeout: 40000 })
    await page.waitForTimeout(300)

    // Rouvrir la modale (réseau intact — elle charge normalement).
    const pencil = page.locator('button[title="Gérer les vues"]')
    await pencil.click()
    const dialog = page.locator('[role="dialog"]:has-text("Vues — Automations")')
    await dialog.waitFor({ state: 'visible', timeout: 5000 })

    await page.evaluate(() => { window.__noReloadMarker = 'alive' })

    // /api/health renvoie un boot_id différent (simule un pm2 restart) ; le
    // bundle servi par /erp/ reste le VRAI index.html → identique à celui
    // chargé → le client ne doit PAS recharger.
    await page.route('**/erp/api/health', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-Boot-Id': 'forced-e2e-restart-boot-id' },
      body: JSON.stringify({ boot_id: 'forced-e2e-restart-boot-id', started_at: '2026-01-01T00:00:00.000Z' }),
    }))
    // Couper le reste de l'API pour déclencher l'overlay (le poll sync-status
    // échoue → markOffline) ; seule voie de reprise : le ping /api/health.
    await page.route('**/erp/api/**', (route) => {
      if (route.request().url().includes('/api/health')) return route.fallback()
      return route.abort('failed')
    })

    // Timeout généreux : le dernier succès du poll sync-status est en cache
    // prefetch (TTL 30 s) — le premier échec réseau réel peut prendre ~35 s.
    await page.waitForSelector('text=Connexion au serveur perdue', { timeout: 45000 })
    assert.equal(await dialog.count(), 1, 'la modale doit rester montée pendant la coupure')

    // Le ping (≤10 s) voit le boot_id changé, vérifie le bundle (identique) →
    // ni écran « Mise à jour », ni reload.
    await page.waitForFunction(
      () => !document.body.textContent.includes('Connexion au serveur perdue'),
      { timeout: 25000 }
    )

    const sawUpdateScreen = await page.evaluate(
      () => document.body.textContent.includes("Mise à jour de l'app en cours")
    )
    assert.equal(sawUpdateScreen, false, 'pas d\'écran « Mise à jour » quand le bundle est inchangé')

    const marker = await page.evaluate(() => window.__noReloadMarker)
    assert.equal(marker, 'alive', 'la page ne doit pas avoir été rechargée (même bundle)')
    assert.ok(await dialog.isVisible(), 'la modale doit rester ouverte après le restart serveur')

    // Rétablir le réseau, attendre un état stable, fermer la modale.
    await page.unroute('**/erp/api/**')
    await page.unroute('**/erp/api/health')
    await page.waitForFunction(
      () => !document.body.textContent.includes('Connexion au serveur perdue'),
      { timeout: 20000 }
    )
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached', timeout: 5000 })
  })
})
