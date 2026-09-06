const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérificateur d'adresses postales.
//
// Serveur : services/addressCheck.js — toute adresse écrite dans l'ERP est
// contrôlée (champ manquant, code postal mal formé, province inexistante, code
// postal incohérent avec la province) ; les fautives déclenchent une
// notification. UI : Paramètres → Adresses (compteurs + liste à corriger) et
// pastille + détail des problèmes sur la fiche entreprise.
//
// IMPORTANT (CLAUDE.md) : la DB de test EST la DB de prod. Le test ne touche
// QUE l'entreprise + l'adresse jetables qu'il crée lui-même, supprimées dans
// after(). Il ne modifie aucune adresse existante, et marque lues les
// notifications qu'il a lui-même provoquées.
describe('Vérification des adresses postales', () => {
  let browser, ctx, page
  let companyId = null
  let adresseId = null
  const stamp = Date.now()
  const COMPANY_NAME = `E2E AddrCheck ${stamp}`

  // Appel API depuis la page (réutilise le token du localStorage).
  async function apiCall(method, path, body) {
    return page.evaluate(async ({ base, method, path, body }) => {
      const t = localStorage.getItem('erp_token')
      const r = await fetch(base + path, {
        method,
        headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await r.text()
      try { return { status: r.status, json: JSON.parse(text) } } catch { return { status: r.status, text } }
    }, { base: URL.replace(/\/erp$/, '') + '/api', method, path, body })
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Support jetable : une entreprise + une adresse volontairement fautive
    // (code postal montréalais déclaré en Ontario).
    const co = await apiCall('POST', '/companies', { name: COMPANY_NAME })
    companyId = co.json?.id
    assert.ok(companyId, `entreprise jetable créée (${JSON.stringify(co).slice(0, 200)})`)
    const adr = await apiCall('POST', '/projets/adresses', {
      company_id: companyId, address_type: 'Livraison',
      line1: '123 rue du Test', city: 'Montréal', province: 'ON', postal_code: 'H2X 1Y4', country: 'CA',
    })
    adresseId = adr.json?.id
    assert.ok(adresseId, 'adresse jetable créée')
  })

  after(async () => {
    try {
      if (adresseId) await apiCall('DELETE', `/projets/adresses/${adresseId}`)
      if (companyId) await apiCall('DELETE', `/companies/${companyId}`)
      // Les notifications provoquées par le test sont marquées lues (par id,
      // jamais de read-all qui toucherait celles de l'utilisateur).
      const notifs = await apiCall('GET', '/notifications?limit=50')
      for (const n of (notifs.json?.data || [])) {
        if (n.type === 'address_check' && n.title.includes(COMPANY_NAME) && !n.read) {
          await apiCall('PATCH', `/notifications/${n.id}/read`, {})
        }
      }
    } catch {}
    await browser?.close()
  })

  test('le serveur refuse l\'adresse incohérente et l\'explique', async () => {
    const r = await apiCall('GET', `/projets/adresses/${adresseId}`)
    assert.equal(r.json.check_status, 'error', 'verdict = error à la création')
    const issues = JSON.parse(r.json.check_issues || '[]')
    assert.deepEqual(issues.map(i => i.code), ['postal_province_mismatch'])
    assert.match(issues[0].message, /Ontario/, 'le message nomme la province du code postal')
  })

  test('une notification est créée pour l\'adresse fautive', async () => {
    const notifs = await apiCall('GET', '/notifications?limit=50')
    const mine = (notifs.json?.data || []).filter(n => n.type === 'address_check' && n.title.includes(COMPANY_NAME))
    assert.ok(mine.length >= 1, 'au moins une notification address_check pour cette adresse')
    assert.equal(mine[0].link, `/companies/${companyId}`, 'la notification renvoie à la fiche entreprise')
  })

  test('Paramètres → Adresses liste l\'adresse à corriger avec ses problèmes', async () => {
    await page.goto(URL + '/settings', { waitUntil: 'domcontentloaded' })
    await page.click('[data-testid="settings-section-adresses"]')
    await page.waitForSelector('[data-testid="address-check-stats"]', { timeout: 15000 })

    // Une passe complète pour repartir d'un état affiché à jour.
    await page.click('[data-testid="address-check-run"]')
    const row = page.locator(`[data-testid="address-check-problem-${adresseId}"]`)
    await row.waitFor({ state: 'visible', timeout: 30000 })

    await assert.doesNotReject(async () => row.locator('text=À corriger').first().waitFor({ timeout: 5000 }))
    const text = await row.innerText()
    assert.match(text, /H2X/, 'l\'adresse fautive est affichée')
    assert.match(text, /Ontario/, 'le problème est expliqué en clair')

    // Le compteur « À corriger » est non nul et le lien mène à l'entreprise.
    const errors = await page.locator('[data-testid="address-check-errors"]').innerText()
    assert.ok(parseInt(errors, 10) >= 1, `compteur à corriger >= 1 (got ${errors})`)
    const href = await row.locator(`a[href$="/companies/${companyId}"]`).getAttribute('href')
    assert.ok(href, 'lien vers la fiche entreprise présent')
  })

  test('la fiche entreprise porte la pastille et le détail, qui disparaissent après correction', async () => {
    await page.goto(`${URL}/companies/${companyId}`, { waitUntil: 'domcontentloaded' })
    const row = page.locator(`[data-testid="adresse-row-${adresseId}"]`)
    await row.waitFor({ state: 'visible', timeout: 20000 })
    assert.match(await row.innerText(), /À corriger/, 'pastille « À corriger » sur l\'adresse')
    assert.match(await row.innerText(), /Ontario/, 'problème expliqué sous l\'adresse')

    // Correction via le panneau d'édition (autosave) : province → QC.
    await row.locator('button').first().click()
    await page.waitForSelector('[data-testid="adresse-check-panel"]', { timeout: 10000 })
    await page.click('[data-testid="adresse-province-select"]')
    const menu = page.locator('[data-testid="adresse-province-select-menu"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    await menu.locator('input').fill('Québec')
    await menu.locator('button:has-text("QC")').first().click()

    // Le panneau d'alerte disparaît dès que le serveur revalide l'adresse.
    await page.waitForSelector('[data-testid="adresse-check-panel"]', { state: 'detached', timeout: 15000 })

    // Persistance : l'adresse est conforme ET aucun champ n'a été effacé par
    // l'autosave partielle (régression corrigée en même temps).
    const r = await apiCall('GET', `/projets/adresses/${adresseId}`)
    assert.equal(r.json.check_status, 'ok', 'verdict = ok après correction')
    assert.equal(r.json.province, 'QC')
    assert.equal(r.json.line1, '123 rue du Test', 'la rue n\'a pas été effacée')
    assert.equal(r.json.city, 'Montréal', 'la ville n\'a pas été effacée')
    assert.equal(r.json.postal_code, 'H2X 1Y4', 'le code postal n\'a pas été effacé')
    assert.equal(r.json.address_type, 'Livraison', 'le type n\'a pas été effacé')
  })
})
