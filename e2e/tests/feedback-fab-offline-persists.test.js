// Signalement /automations : la modale « Modifier le système » (FeedbackFab)
// ne doit PAS se fermer quand la connexion au serveur est perdue.
//
// Deux vecteurs de fermeture corrigés :
//   1. Échap pendant que l'overlay hors-ligne recouvre la modale — le handler
//      keydown document-level de Modal fermait la modale sous l'overlay et
//      effaçait le brouillon. close() ignore désormais toute fermeture tant
//      que getIsOffline() est vrai.
//   2. Reload forcé (vrai déploiement frontend : bundle JS changé — le cas
//      fréquent ici puisque l'agent rebuild le client à chaque fix). L'état
//      de la modale (ouverte + brouillon) est persisté en sessionStorage et
//      restauré au chargement.
//
// Cleanup : AUCUN record créé — le formulaire n'est jamais soumis, seul le
// textarea est rempli. Rien à restaurer.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const DRAFT = `E2E brouillon offline ${Date.now()} — ne pas envoyer`

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

describe('Modale « Modifier le système » + connexion serveur perdue', () => {
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
    // Aucun record créé (formulaire jamais soumis) ; on purge juste l'état
    // persisté de la modale pour ne rien laisser traîner dans l'onglet.
    try { await page.evaluate(() => sessionStorage.removeItem('erp_feedback_fab_state')) } catch {}
    await browser?.close()
  })

  test('Échap pendant la coupure : la modale reste ouverte, brouillon intact', async () => {
    // Ouvrir la modale (le FAB ouvre directement le formulaire) et taper un brouillon.
    await page.locator('[data-testid="feedback-fab"]').click()
    const textarea = page.locator('[data-testid="feedback-fab-text"]')
    await textarea.waitFor({ state: 'visible', timeout: 5000 })
    await textarea.fill(DRAFT)

    // Couper la connexion HTTP au serveur. Le poll sync-status du Layout
    // (toutes les 5 s, cache prefetch TTL 30 s → premier échec réseau réel
    // possible ~35 s) échoue → markOffline → overlay.
    await page.route('**/erp/api/**', (route) => route.abort('failed'))
    await page.waitForSelector('text=Connexion au serveur perdue', { timeout: 45000 })

    // Échap — avant le fix, le handler de Modal fermait la modale sous
    // l'overlay et effaçait le texte.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    assert.equal(await textarea.count(), 1, 'la modale doit rester montée après Échap hors-ligne')
    assert.equal(await textarea.inputValue(), DRAFT, 'le brouillon doit être intact après Échap hors-ligne')

    // Rétablir le réseau ; la reprise vient du ping /api/health (≤10 s).
    await page.unroute('**/erp/api/**')
    await page.waitForFunction(
      () => !document.body.textContent.includes('Connexion au serveur perdue'),
      { timeout: 20000 }
    )

    // La modale est toujours ouverte avec le brouillon après la reprise.
    assert.ok(await textarea.isVisible(), 'la modale doit rester ouverte après la reprise')
    assert.equal(await textarea.inputValue(), DRAFT, 'le brouillon doit survivre à la coupure')
  })

  test('reload forcé (déploiement frontend) : la modale se restaure avec le brouillon', async () => {
    // Simule le seul cas où ServerOfflineOverlay recharge encore la page :
    // bundle JS réellement changé.
    await page.reload({ waitUntil: 'domcontentloaded' })
    const textarea = page.locator('[data-testid="feedback-fab-text"]')
    await textarea.waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(await textarea.inputValue(), DRAFT, 'le brouillon doit être restauré après un reload')
  })

  test('fermeture volontaire en ligne : fonctionne et ne se restaure pas', async () => {
    // En ligne, « Annuler » ferme normalement et purge l'état persisté.
    await page.locator('[role="dialog"] button:has-text("Annuler")').click()
    const textarea = page.locator('[data-testid="feedback-fab-text"]')
    await textarea.waitFor({ state: 'detached', timeout: 5000 })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="feedback-fab"]', { timeout: 15000 })
    await page.waitForTimeout(500)
    assert.equal(await textarea.count(), 0, 'la modale fermée volontairement ne doit pas réapparaître au reload')
  })
})
