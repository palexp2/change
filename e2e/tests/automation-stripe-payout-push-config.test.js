const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const AUTO_ID = 'sys_stripe_weekly_payout_push'

// L'automation système « Comptabilisation QB des Stripe payouts (quotidienne) »
// pousse chaque payout réglé vers QuickBooks (CAD → Compte chèques Banque
// Nationale, USD → Venn USD), bornée par push_since (jamais l'historique) et
// max_batch, avec alerte Slack « en souffrance ». Sa config est éditable depuis
// la fiche automation via l'éditeur générique clé-valeur ; le trigger (cron)
// reste en lecture seule.
//
// ⚠️ Config partagée (pas un record jetable) : action_config + active sont
// capturés dans before() et restaurés dans after(), même en cas d'échec.
// Le test ne clique JAMAIS « Lancer maintenant » (créerait de vrais Deposits
// QB) — seule la présence du bouton est vérifiée.

describe('Automation configurable : comptabilisation QB des Stripe payouts', () => {
  let browser, ctx, page
  let token, original

  function authHeaders() {
    return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  }

  async function apiGet() {
    const resp = await page.request.get(URL + '/api/automations/' + AUTO_ID, {
      headers: { Authorization: 'Bearer ' + token },
    })
    return resp.json()
  }

  // Poll l'API jusqu'à ce que predicate(automation) soit vrai (autosave debounce 500ms).
  async function waitForSaved(predicate, timeoutMs = 8000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const auto = await apiGet()
      if (predicate(auto)) return auto
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
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    const auto = await apiGet()
    assert.ok(auto?.id === AUTO_ID, 'automation payout push seedée')
    original = { active: auto.active, action_config: auto.action_config }

    await page.goto(URL + '/automations/' + AUTO_ID, { waitUntil: 'networkidle' })
    await page.getByTestId('generic-config').waitFor({ state: 'visible', timeout: 10000 })
  })

  after(async () => {
    // Restaure toujours la config d'origine (action_config + active), même si
    // le test a échoué — la DB de test est la DB de prod.
    if (token && original) {
      await page.request.patch(URL + '/api/automations/' + AUTO_ID, {
        headers: authHeaders(), data: original,
      })
    }
    await browser?.close()
  })

  test('le panneau de config affiche les valeurs courantes', async () => {
    const ac = JSON.parse(original.action_config)
    assert.equal(
      await page.getByTestId('generic-config-push_since').inputValue(),
      String(ac.push_since ?? '')
    )
    assert.equal(
      await page.getByTestId('generic-config-max_batch').inputValue(),
      String(ac.max_batch ?? '')
    )
    assert.equal(
      await page.getByTestId('generic-config-slack_webhook_env').inputValue(),
      String(ac.slack_webhook_env ?? '')
    )
  })

  test('le déclencheur (cron) est en lecture seule', async () => {
    assert.equal(await page.getByTestId('configurable-system-trigger').count(), 0)
  })

  test('changer stale_alert_days persiste (autosave) sans toucher les autres clés', async () => {
    const before = JSON.parse(original.action_config)
    const newVal = String(before.stale_alert_days) === '4' ? '5' : '4'
    await page.getByTestId('generic-config-stale_alert_days').fill(newVal)
    const auto = await waitForSaved(a => {
      try { return JSON.parse(a.action_config).stale_alert_days === newVal } catch { return false }
    })
    const ac = JSON.parse(auto.action_config)
    assert.equal(ac.push_since, before.push_since, 'push_since intact')
    assert.equal(ac.max_batch, before.max_batch, 'max_batch intact')
  })

  test('les boutons Simuler et Lancer maintenant sont présents', async () => {
    await page.getByTestId('manual-dry-run').waitFor({ state: 'visible' })
    // Régression : `!id === CTB_AUTOMATION_ID` cachait « Lancer maintenant »
    // sur toutes les automations runnables. On vérifie la présence seulement —
    // cliquer créerait de vrais Deposits QuickBooks.
    assert.equal(await page.locator('button:has-text("Lancer maintenant")').count(), 1)
  })

  test('l\'API rejette une config invalide et un patch de trigger', async () => {
    const badDate = await page.request.patch(URL + '/api/automations/' + AUTO_ID, {
      headers: authHeaders(),
      data: { action_config: JSON.stringify({ push_since: 'pas-une-date' }) },
    })
    assert.equal(badDate.status(), 400)

    const badBatch = await page.request.patch(URL + '/api/automations/' + AUTO_ID, {
      headers: authHeaders(),
      data: { action_config: JSON.stringify({ max_batch: '0' }) },
    })
    assert.equal(badBatch.status(), 400)

    const badEnv = await page.request.patch(URL + '/api/automations/' + AUTO_ID, {
      headers: authHeaders(),
      data: { action_config: JSON.stringify({ slack_webhook_env: 'pas majuscules' }) },
    })
    assert.equal(badEnv.status(), 400)

    // Le trigger n'est pas éditable pour cette automation (cron défini par le code).
    const badTrigger = await page.request.patch(URL + '/api/automations/' + AUTO_ID, {
      headers: authHeaders(),
      data: { trigger_config: JSON.stringify({ column: 'status', op: 'eq', value: 'x' }) },
    })
    assert.equal(badTrigger.status(), 400)
  })
})
