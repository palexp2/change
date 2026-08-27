// Collecte de factures — bouton « copier » sur le message d'erreur et le journal
// d'une tournée.
//
// Le test ne crée AUCUN compte de collecte et ne lance AUCUNE tournée (elle
// taperait sur un vrai portail fournisseur) : les deux appels de la page sont
// interceptés pour servir un compte et une tournée factices, ce qui rend le
// contenu à copier déterministe. Aucune écriture en base.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const ACC_ID = 'e2e-copy-acc'
const RUN_ID = 'e2e-copy-run'
const ERROR_TEXT = "locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator('#invoice-list a')"
const LOG_LINES = ['Connexion au portail…', 'Session réutilisée', '3 factures listées', 'Échec sur la 2e facture']

describe('Collecte de factures — copie du journal et de l\'erreur', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })

    // Compte + tournée factices : la page reste en lecture seule côté serveur.
    await page.route('**/api/scrapers/runs**', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{
        id: RUN_ID, account_id: ACC_ID, vendor: 'amazon', status: 'error',
        started_at: '2026-08-20T12:00:00.000Z', finished_at: '2026-08-20T12:01:00.000Z',
        duration_ms: 60000, imported: 1, skipped: 0,
        error: ERROR_TEXT, log: LOG_LINES, artifacts: [],
      }]),
    }))
    await page.route(/\/api\/scrapers\/?(\?.*)?$/, route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        accounts: [{
          id: ACC_ID, vendor: 'amazon', vendor_label: 'Amazon Business', label: 'E2E Copie — compte factice',
          username: 'e2e@example.com', enabled: 1, lookback_days: 60, running: false,
          last_run_at: '2026-08-20T12:00:00.000Z', last_status: 'error', last_error: ERROR_TEXT,
          last_imported: 1, has_password: true, has_totp: false, has_session: false,
        }],
        vendors: [{ key: 'amazon', label: 'Amazon Business', fields: {} }],
        pending_otp: [], chromium: true,
      }),
    }))
  })

  after(async () => {
    // Rien à nettoyer : aucune écriture. On coupe juste les interceptions.
    try { await page?.unrouteAll?.() } catch {}
    await browser?.close()
  })

  test("le journal d'une tournée se copie en un clic", async () => {
    await page.goto(`${URL}/collecte-factures`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Collecte de factures")', { timeout: 20000 })

    // La ligne du compte affiche déjà son erreur, avec son propre bouton de copie.
    const card = page.locator('text=E2E Copie — compte factice').first()
    await card.waitFor({ state: 'visible', timeout: 20000 })

    await page.click('button:has-text("Historique des tournées")')
    const runRow = page.locator('button:has-text("importée(s) avant l\'échec")').first()
    await runRow.waitFor({ state: 'visible', timeout: 10000 })
    await runRow.click()

    const logPre = page.locator('[data-run-log]').first()
    await logPre.waitFor({ state: 'visible', timeout: 10000 })

    const copyLog = page.locator('[data-testid="copy-run-log"]').first()
    await copyLog.waitFor({ state: 'visible', timeout: 10000 })
    await copyLog.click()

    const clip = await page.evaluate(() => navigator.clipboard.readText())
    assert.ok(clip.includes(LOG_LINES[0]), 'la première ligne du journal doit être copiée')
    assert.ok(clip.includes(LOG_LINES[3]), 'la dernière ligne du journal doit être copiée')
    assert.ok(clip.includes('Timeout 30000ms exceeded'), 'le message d\'erreur doit accompagner le journal')

    // Retour visuel : le bouton confirme la copie.
    assert.ok((await copyLog.innerText()).includes('Copié'), 'le bouton doit confirmer « Copié »')
  })

  test("le message d'erreur seul se copie aussi", async () => {
    const errBlock = page.locator('[data-run-error]').first()
    await errBlock.waitFor({ state: 'visible', timeout: 10000 })
    // Vider le presse-papiers pour ne pas relire la copie précédente.
    await page.evaluate(() => navigator.clipboard.writeText('vide'))
    await errBlock.locator('button:has-text("Copier")').click()

    const clip = await page.evaluate(() => navigator.clipboard.readText())
    assert.ok(clip.startsWith('locator.click: Timeout 30000ms exceeded.'), `copie inattendue : ${clip.slice(0, 60)}`)
    assert.ok(!clip.includes('Connexion au portail'), 'le bouton de l\'erreur ne doit pas emporter le journal')
  })
})
