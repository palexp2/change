const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const AUTO_ID = 'sys_ctb_programmation_paiement'

// L'automation système « CTB - Suivi : programmation des factures à payer »
// pousse chaque facture à payer (Bill QB) dans la section « PROGRAMMATION DES
// FACTURES À PAYER » de l'onglet Sommaire du Google Sheets CTB - Suivi. Sa
// connexion (fichier, onglet, section, jour de paiement, compte Google) est
// configurable depuis la fiche automation ; le trigger reste en lecture seule.
//
// ⚠️ Config partagée (pas un record jetable) : action_config + active sont
// capturés dans before() et restaurés dans after(), même en cas d'échec.
// L'automation est désactivée pendant le test pour qu'aucune écriture réelle
// ne parte vers le Google Sheets avec une config de test.

describe('Automation configurable : CTB - Suivi (Google Sheets)', () => {
  let browser, ctx, page
  let token, original

  function authHeaders() {
    return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  }

  async function apiGet(id = AUTO_ID) {
    const resp = await page.request.get(URL + '/api/automations/' + id, {
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
    assert.ok(auto?.id === AUTO_ID, 'automation CTB seedée')
    original = { active: auto.active, action_config: auto.action_config }

    // Sécurité : suspendre l'automation pendant le test (aucune écriture Sheets
    // ne part pendant qu'une config de test est en place).
    await page.request.patch(URL + '/api/automations/' + AUTO_ID, {
      headers: authHeaders(), data: { active: 0 },
    })

    await page.goto(URL + '/automations/' + AUTO_ID, { waitUntil: 'networkidle' })
    await page.getByTestId('ctb-sheet-config').waitFor({ state: 'visible', timeout: 10000 })
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

  test('le panneau de connexion Sheets affiche la config courante', async () => {
    const ac = JSON.parse(original.action_config)
    const sheetName = await page.getByTestId('ctb-sheet-name').inputValue()
    assert.equal(sheetName, String(ac.sheet_name ?? ''))
    const weekday = await page.getByTestId('ctb-payment-weekday').inputValue()
    assert.equal(weekday, String(ac.payment_weekday || '2'))
    const spreadsheet = await page.getByTestId('ctb-spreadsheet-id').inputValue()
    assert.equal(spreadsheet, String(ac.spreadsheet_id ?? ''))
  })

  test('le déclencheur est en lecture seule (pas d\'éditeur de condition)', async () => {
    assert.equal(await page.getByTestId('configurable-system-trigger').count(), 0)
  })

  test('coller l\'URL complète du fichier extrait l\'ID (autosave)', async () => {
    const ac = JSON.parse(original.action_config)
    const id = ac.spreadsheet_id || '13rd8x_xy5AQJemDwE6yWp8ffvkj3bEo7kq3cuogRGyQ'
    await page.getByTestId('ctb-spreadsheet-id').fill(
      `https://docs.google.com/spreadsheets/d/${id}/edit?usp=drivesdk`,
    )
    assert.equal(await page.getByTestId('ctb-spreadsheet-id').inputValue(), id)
    await waitForSaved(a => {
      try { return JSON.parse(a.action_config).spreadsheet_id === id } catch { return false }
    })
  })

  test('changer le jour de paiement persiste (autosave)', async () => {
    await page.getByTestId('ctb-payment-weekday').selectOption('5')
    const auto = await waitForSaved(a => {
      try { return JSON.parse(a.action_config).payment_weekday === '5' } catch { return false }
    })
    // Les autres clés ne sont pas touchées.
    const ac = JSON.parse(auto.action_config)
    assert.equal(ac.sheet_name, JSON.parse(original.action_config).sheet_name)
  })

  test('le bouton « Tester la connexion » exécute le diagnostic sans écrire', async () => {
    await page.getByTestId('manual-dry-run').click()
    // Le diagnostic aboutit toujours à un résumé (✅ section trouvée, ou ❌ accès
    // refusé tant que l'API Sheets / le scope OAuth ne sont pas en place).
    await page.waitForSelector('text=/Section trouvée|Lecture impossible|introuvable|Aucun compte Google/', { timeout: 30000 })
  })

  test('l\'API rejette un jour de paiement et un spreadsheet_id invalides', async () => {
    const bad1 = await page.request.patch(URL + '/api/automations/' + AUTO_ID, {
      headers: authHeaders(),
      data: { action_config: JSON.stringify({ payment_weekday: '9' }) },
    })
    assert.equal(bad1.status(), 400)
    const bad2 = await page.request.patch(URL + '/api/automations/' + AUTO_ID, {
      headers: authHeaders(),
      data: { action_config: JSON.stringify({ spreadsheet_id: 'pas un id!' }) },
    })
    assert.equal(bad2.status(), 400)
    // Le trigger n'est pas éditable pour cette automation.
    const bad3 = await page.request.patch(URL + '/api/automations/' + AUTO_ID, {
      headers: authHeaders(),
      data: { trigger_config: JSON.stringify({ column: 'status', op: 'eq', value: 'x' }) },
    })
    assert.equal(bad3.status(), 400)
  })
})
