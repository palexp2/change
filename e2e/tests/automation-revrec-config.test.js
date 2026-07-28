const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const AUTO_ID = 'sys_revenue_recognition'

// L'automation système « Constat de vente à l'expédition » est configurable :
// condition de déclenchement (table shipments OU factures — y compris un champ
// personnalisé de type lookup) et comptes QB (AcctNum) éditables depuis la fiche
// automation, avec autosave. Ce test édite la config puis vérifie la
// persistance via l'API, incluant le flux complet « créer un lookup “Date
// d'envoi de la commande liée” sur factures puis déclencher dessus ».
//
// ⚠️ Config partagée (pas un record jetable) : la valeur courante est capturée
// dans before() et restaurée dans after(), même en cas d'échec. L'automation est
// désactivée (active=0) pendant toute la durée du test pour qu'aucun constat
// réel ne parte avec une condition de test ; le champ custom créé est supprimé.

describe('Automation configurable : constat de vente à l\'expédition', () => {
  let browser, ctx, page
  let token, original
  let cfId = null

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
    original = {
      active: auto.active,
      trigger_config: auto.trigger_config,
      action_config: auto.action_config,
    }

    // Sécurité : suspendre le constat pendant que la condition de test est en
    // place (le watcher honore le toggle). La page chargée ensuite reflète
    // active=0, donc les autosaves ne réactivent pas l'automation.
    await page.request.patch(URL + '/api/automations/' + AUTO_ID, {
      headers: authHeaders(), data: { active: 0 },
    })

    await page.goto(URL + '/automations/' + AUTO_ID, { waitUntil: 'networkidle' })
    await page.getByTestId('configurable-system-trigger').waitFor({ state: 'visible', timeout: 10000 })
  })

  after(async () => {
    // Restaure toujours la config d'origine — le PATCH n'extrait que la condition
    // (erp_table/column/op/value) et les clés de comptes, donc renvoyer les JSON
    // originaux remet exactement l'état capturé (y compris active).
    if (token && original) {
      await page.request.patch(URL + '/api/automations/' + AUTO_ID, {
        headers: authHeaders(), data: original,
      })
    }
    // Supprime le champ custom créé par le test (après la restauration, pour ne
    // jamais laisser le trigger pointer un champ supprimé).
    if (token && cfId) {
      await page.request.delete(URL + '/api/custom-fields/' + cfId, { headers: authHeaders() })
    }
    await browser?.close()
  })

  test('la condition et les comptes sont affichés éditables', async () => {
    const tc = JSON.parse(original.trigger_config)
    const value = await page.getByTestId('revrec-trigger-value').inputValue()
    assert.equal(value, String(tc.value ?? ''))
    const ac = JSON.parse(original.action_config)
    const deferred = await page.getByTestId('revrec-account-deferred_acctnum').inputValue()
    assert.equal(deferred, String(ac.deferred_acctnum ?? ''))
  })

  test('éditer la valeur de la condition persiste (autosave)', async () => {
    const testValue = `E2E-${Date.now()}`
    await page.getByTestId('revrec-trigger-value').fill(testValue)
    const auto = await waitForSaved(a => {
      try { return JSON.parse(a.trigger_config).value === testValue } catch { return false }
    })
    const tc = JSON.parse(auto.trigger_config)
    assert.equal(tc.erp_table, 'shipments')
    assert.equal(tc.column, JSON.parse(original.trigger_config).column)
    // Le résumé est régénéré côté serveur à partir de la condition éditée.
    assert.ok(tc.summary.includes(testValue), 'summary régénéré avec la nouvelle valeur')
  })

  test('éditer un compte QB persiste (autosave)', async () => {
    await page.getByTestId('revrec-account-deferred_acctnum').fill('23999')
    const auto = await waitForSaved(a => {
      try { return JSON.parse(a.action_config).deferred_acctnum === '23999' } catch { return false }
    })
    // Les autres comptes ne sont pas touchés.
    const ac = JSON.parse(auto.action_config)
    assert.equal(ac.sale_acctnum, JSON.parse(original.action_config).sale_acctnum)
  })

  test('déclencher sur un champ personnalisé de factures (lookup date d\'envoi)', async () => {
    // 1. L'utilisateur crée le champ « Date d'envoi de la commande liée » :
    //    lookup factures.order_id → orders.date_du_premier_envoi.
    const cfName = `E2E Date envoi cmd ${Date.now()}`
    const createResp = await page.request.post(URL + '/api/custom-fields/factures/lookup', {
      headers: authHeaders(),
      data: {
        name: cfName,
        lookup_fk: 'order_id',
        lookup_target_table: 'orders',
        lookup_target_column: 'date_du_premier_envoi',
        result_type: 'date',
      },
    })
    assert.equal(createResp.status(), 201)
    const cf = await createResp.json()
    cfId = cf.id
    const cfColumn = cf.column_name

    // 2. Le champ custom est proposé dans les colonnes du déclencheur.
    const defsResp = await page.request.get(
      URL + '/api/automations/field-defs?erp_table=factures&include_custom=1',
      { headers: { Authorization: 'Bearer ' + token } },
    )
    const defs = await defsResp.json()
    assert.ok(
      defs.columns.some(c => c.column_name === cfColumn && c.custom),
      'le champ custom doit apparaître dans field-defs (include_custom=1)',
    )

    // 3. Depuis l'UI : table Factures → colonne = champ custom → op « est renseigné ».
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByTestId('configurable-system-trigger').waitFor({ state: 'visible', timeout: 10000 })
    await page.getByTestId('revrec-trigger-table').click()
    await page.getByTestId('revrec-trigger-table-menu')
      .getByRole('button', { name: 'Factures', exact: true }).click()
    await page.getByTestId('revrec-trigger-column').click()
    await page.getByTestId('revrec-trigger-column-menu').locator('input').fill(cfName)
    await page.getByTestId('revrec-trigger-column-menu')
      .locator('button', { hasText: cfName }).first().click()
    await page.getByTestId('revrec-trigger-op').selectOption('not_null')

    // 4. Persistance : erp_table=factures, colonne custom, op not_null, résumé facture.
    const auto = await waitForSaved(a => {
      try {
        const tc = JSON.parse(a.trigger_config)
        return tc.erp_table === 'factures' && tc.column === cfColumn && tc.op === 'not_null'
      } catch { return false }
    })
    const tc = JSON.parse(auto.trigger_config)
    assert.equal(tc.value, undefined, 'op not_null ne porte pas de valeur')
    assert.ok(tc.summary.includes('facture'), 'résumé régénéré côté facture')
  })

  test('l\'API rejette une colonne inexistante et un compte invalide', async () => {
    const bad1 = await page.request.patch(URL + '/api/automations/' + AUTO_ID, {
      headers: authHeaders(),
      data: { trigger_config: JSON.stringify({ column: 'colonne_inexistante', op: 'eq', value: 'x' }) },
    })
    assert.equal(bad1.status(), 400)
    const bad2 = await page.request.patch(URL + '/api/automations/' + AUTO_ID, {
      headers: authHeaders(),
      data: { action_config: JSON.stringify({ sale_acctnum: '40 000!' }) },
    })
    assert.equal(bad2.status(), 400)
    const bad3 = await page.request.patch(URL + '/api/automations/' + AUTO_ID, {
      headers: authHeaders(),
      data: { trigger_config: JSON.stringify({ erp_table: 'orders', column: 'status', op: 'not_null' }) },
    })
    assert.equal(bad3.status(), 400, 'table hors whitelist refusée')
  })

  test('les autres automations système restent en lecture seule', async () => {
    const resp = await page.request.patch(URL + '/api/automations/sys_gmail_sync', {
      headers: authHeaders(),
      data: { trigger_config: '{}' },
    })
    assert.equal(resp.status(), 403)
  })
})
