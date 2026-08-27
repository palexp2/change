const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const TREASURY_ID = 'sys_treasury_alert'
const TRX_SHEET_ID = 'sys_bank_trx_sheet'
const SOLDE_SHEET_ID = 'sys_treasury_solde_sheet'
const PAYOUT_PUSH_ID = 'sys_stripe_weekly_payout_push'

// Canal comptabilité quasi silencieux (demande utilisateur du 11 août 2026) :
//   - rapprochement bancaire + lecture du fichier de solde : AUCUNE alerte ;
//   - trésorerie : alerte seulement si découvert projeté d'ici 3 jours ;
//   - comptabilisation des payouts Stripe : Slack seulement quand ça coince.
// Le test vérifie que ces réglages sont bien en place (et visibles/éditables sur
// la fiche de l'automation trésorerie).
//
// ⚠️ Config partagée, pas un record jetable : action_config de l'automation
// trésorerie est capturé dans before() et restauré dans after(), même en cas
// d'échec. Aucun bouton « Lancer maintenant » n'est cliqué (enverrait un vrai
// message Slack / créerait de vrais Deposits QB).

describe('Canal comptabilité : alertes Slack réduites au découvert imminent', () => {
  let browser, ctx, page
  let token, originalTreasury

  const authHeaders = () => ({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' })

  async function apiGet(id) {
    const resp = await page.request.get(URL + '/api/automations/' + id, {
      headers: { Authorization: 'Bearer ' + token },
    })
    assert.equal(resp.status(), 200, 'GET automation ' + id)
    return resp.json()
  }

  const cfgOf = auto => { try { return JSON.parse(auto.action_config || '{}') } catch { return {} } }

  async function waitForSaved(id, predicate, timeoutMs = 8000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const auto = await apiGet(id)
      if (predicate(cfgOf(auto))) return auto
      await new Promise(r => setTimeout(r, 300))
    }
    throw new Error('Autosave non persisté dans le délai imparti')
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    const auto = await apiGet(TREASURY_ID)
    originalTreasury = { active: auto.active, action_config: auto.action_config }
  })

  after(async () => {
    if (token && originalTreasury) {
      await page.request.patch(URL + '/api/automations/' + TREASURY_ID, {
        headers: authHeaders(), data: originalTreasury,
      })
    }
    await browser?.close()
  })

  test('trésorerie : Slack limité au découvert projeté d\'ici 3 jours', async () => {
    const cfg = cfgOf(await apiGet(TREASURY_ID))
    assert.equal(cfg.slack_negative_only, '1', 'aucune alerte « sous le seuil »')
    assert.equal(cfg.slack_negative_days, '3', 'fenêtre du découvert = 3 jours')
    assert.equal(cfg.variance_slack, '0', 'écart de réconciliation journalisé, pas envoyé')
    assert.equal(cfg.stale_reminder_slack, '0', 'rappel « solde non noté » journalisé, pas envoyé')
  })

  test('rapprochement bancaire et fichier de solde : aucune alerte Slack', async () => {
    assert.equal(cfgOf(await apiGet(TRX_SHEET_ID)).slack_anomalies, '0')
    assert.equal(cfgOf(await apiGet(SOLDE_SHEET_ID)).slack_anomalies, '0')
  })

  test('payouts Stripe : pas de résumé Slack sur un passage sans anicroche', async () => {
    assert.equal(cfgOf(await apiGet(PAYOUT_PUSH_ID)).slack_on_success, '0')
  })

  test('la fiche automation affiche les réglages de bruit Slack', async () => {
    await page.goto(URL + '/automations/' + TREASURY_ID, { waitUntil: 'networkidle' })
    await page.getByTestId('generic-config').waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(await page.getByTestId('generic-config-slack_negative_only').inputValue(), '1')
    assert.equal(await page.getByTestId('generic-config-slack_negative_days').inputValue(), '3')
    assert.equal(await page.getByTestId('generic-config-variance_slack').inputValue(), '0')
    // La description de l'automation dit la nouvelle règle.
    assert.match(await page.locator('body').innerText(), /DÉCOUVERT IMMINENT/)
  })

  test('la fenêtre du découvert est éditable et persiste (autosave)', async () => {
    const before = cfgOf(await apiGet(TREASURY_ID))
    const newVal = before.slack_negative_days === '4' ? '5' : '4'
    await page.getByTestId('generic-config-slack_negative_days').fill(newVal)
    const cfg = cfgOf(await waitForSaved(TREASURY_ID, c => c.slack_negative_days === newVal))
    assert.equal(cfg.slack_negative_only, before.slack_negative_only, 'slack_negative_only intact')
    assert.equal(cfg.threshold, before.threshold, 'seuil intact')
  })

  test('l\'API refuse une valeur non booléenne pour slack_negative_only', async () => {
    const bad = await page.request.patch(URL + '/api/automations/' + TREASURY_ID, {
      headers: authHeaders(),
      data: { action_config: JSON.stringify({ slack_negative_only: 'oui' }) },
    })
    assert.equal(bad.status(), 400)
  })
})
