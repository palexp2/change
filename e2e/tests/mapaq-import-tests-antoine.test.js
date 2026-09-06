const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Import MAPAQ (page « Tests – Antoine », sous-section du flyout Espace finance).
//
// Le rapport est un aperçu : rien n'est écrit tant qu'on n'a pas coché des
// lignes. Le test vérifie le classement des trois catégories, puis la création
// d'un prospect + son projet de prospection.
//
// IMPORTANT (CLAUDE.md) : la DB de test EST la DB de prod. Le test ne touche que
// l'entreprise-appât qu'il crée lui-même et le prospect créé via le bouton ;
// les deux sont supprimés dans after(). Aucun record existant n'est modifié.
describe('Import MAPAQ — Tests – Antoine', () => {
  let browser, ctx, page
  const stamp = Date.now()
  // Nom volontairement improbable : aucune entreprise réelle ne peut matcher.
  const BAIT = `Serres Zzqxv ${stamp}`
  const NEAR = `Serres Zzqxv ${stamp} inc.`   // même nom + forme juridique → déjà existante
  const FRESH = `Ferme Wxyqk ${stamp}`        // sans correspondance → nouvelle
  let baitCompanyId = null
  const createdCompanyIds = []
  const createdProjectIds = []

  const CSV = [
    "Nom de l'exploitation;Adresse;Municipalité;Région administrative;Catégorie de production",
    `${NEAR};12 rang des Serres;Saint-Rémi;Montérégie;Cultures en serre`,
    `${FRESH};44 rang Neuf;Saint-Rémi;Montérégie;Cultures en serre`,
    `Ferme Laitière Wxyqk ${stamp};7 rang 2;Saint-Rémi;Montérégie;Bovins laitiers`,
  ].join('\n')

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
    ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })

    // Appât : une entreprise jetable que la ligne NEAR doit retrouver.
    const co = await apiCall('POST', '/companies', { name: BAIT })
    baitCompanyId = co.json?.id
    assert.ok(baitCompanyId, `entreprise appât créée (${JSON.stringify(co).slice(0, 200)})`)
  })

  after(async () => {
    try {
      for (const id of createdProjectIds) await apiCall('DELETE', `/projects/${id}`)
      for (const id of createdCompanyIds) await apiCall('DELETE', `/companies/${id}`)
      if (baitCompanyId) await apiCall('DELETE', `/companies/${baitCompanyId}`)
    } catch {}
    await browser?.close()
  })

  test("l'aperçu ne touche pas la base et classe les trois catégories", async () => {
    const r = await apiCall('POST', '/mapaq/preview', { csv: CSV })
    assert.equal(r.status, 200, `preview OK (${JSON.stringify(r).slice(0, 300)})`)
    const report = r.json

    // Filtre serre : la ligne « Bovins laitiers » est écartée.
    assert.equal(report.counts.total_source, 3, '3 lignes source')
    assert.equal(report.counts.greenhouse, 2, 'seules les 2 lignes en serre sont retenues')

    const near = report.entries.find(e => e.name === NEAR)
    const fresh = report.entries.find(e => e.name === FRESH)
    assert.ok(near && fresh, 'les 2 entrées en serre sont présentes')
    assert.equal(near.category, 'existante', 'la variante « inc. » retombe sur l\'entreprise appât')
    assert.equal(near.match_company_id, baitCompanyId, 'la correspondance pointe sur l\'appât')
    assert.equal(fresh.category, 'nouvelle', 'la ferme inconnue est nouvelle')

    // Aucune écriture : l'appât est toujours seul, aucun prospect n'est apparu.
    const search = await apiCall('GET', `/companies?search=${encodeURIComponent(String(stamp))}`)
    const names = (search.json?.data || search.json || []).map(c => c.name)
    assert.ok(!names.includes(FRESH), 'l\'aperçu n\'a créé aucune entreprise')
  })

  test('le filtre région écarte les autres régions', async () => {
    const r = await apiCall('POST', '/mapaq/preview', { csv: CSV, region: 'Outaouais' })
    assert.equal(r.status, 200)
    assert.equal(r.json.counts.greenhouse, 0, 'aucune exploitation en Outaouais dans ce fichier')
  })

  test('la page est joignable depuis le flyout Espace finance', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })

    // Déplier le groupe Comptabilité de la sidebar (il porte l'Espace finance).
    const groupBtn = page.locator('button:has-text("Comptabilité")').first()
    await groupBtn.waitFor({ state: 'visible', timeout: 15000 })
    if ((await groupBtn.getAttribute('aria-expanded')) !== 'true') await groupBtn.click()

    const trigger = page.locator('[data-testid="nav-flyout-trigger"]:has-text("Espace finance")').first()
    await trigger.waitFor({ state: 'visible', timeout: 10000 })
    await trigger.hover()

    const link = page.locator('a[href$="/tests-antoine"]').first()
    await link.waitFor({ state: 'visible', timeout: 10000 })
    await link.click()
    await page.waitForURL(u => u.toString().includes('/tests-antoine'), { timeout: 15000 })
    await page.waitForSelector('[data-testid="page-title"]', { timeout: 15000 })
    assert.match(await page.locator('[data-testid="page-title"]').innerText(), /Tests – Antoine/)
  })

  test("l'aperçu s'affiche puis la création du prospect sélectionné aboutit", async () => {
    await page.goto(URL + '/tests-antoine', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="mapaq-csv"]', { state: 'attached', timeout: 15000 })

    // Le bloc de collage est un <details> replié : l'ouvrir avant de saisir.
    await page.click('[data-testid="mapaq-paste-block"] summary')
    await page.fill('[data-testid="mapaq-csv"]', CSV)
    await page.click('[data-testid="mapaq-run"]')

    await page.waitForSelector('[data-testid="mapaq-counts"]', { timeout: 20000 })
    assert.match(await page.locator('[data-testid="mapaq-count-nouvelle"]').innerText(), /^1 /)
    assert.match(await page.locator('[data-testid="mapaq-count-existante"]').innerText(), /^1 /)

    // Les trois classements sont nommés dans le tableau.
    const body = await page.locator('body').innerText()
    assert.ok(body.includes(FRESH), 'la nouvelle exploitation est listée')
    assert.ok(body.includes('Déjà existante'), 'le classement « déjà existante » est affiché')

    // Cocher la seule ligne « nouvelle », puis créer. La case est contrôlée :
    // .click() et non .check() (cf. CLAUDE.md / cases autosave).
    const row = page.locator('[data-row-id]').filter({ hasText: FRESH }).first()
    await row.waitFor({ state: 'visible', timeout: 10000 })
    await row.locator('input[type="checkbox"]').click()
    await page.waitForSelector('button:has-text("Créer les prospects sélectionnés")', { timeout: 10000 })
    await page.click('button:has-text("Créer les prospects sélectionnés")')

    // Le serveur a créé l'entreprise + le projet de prospection.
    await page.waitForTimeout(3000)
    const search = await apiCall('GET', `/companies?search=${encodeURIComponent(FRESH)}`)
    const list = search.json?.data || search.json || []
    const created = list.find(c => c.name === FRESH)
    assert.ok(created, `le prospect ${FRESH} a été créé (${JSON.stringify(list).slice(0, 300)})`)
    createdCompanyIds.push(created.id)
    assert.equal(created.source, 'MAPAQ', "la provenance est 'MAPAQ'")

    const projects = await apiCall('GET', `/projects?search=${encodeURIComponent(FRESH)}`)
    const plist = projects.json?.data || projects.json || []
    const proj = plist.find(p => p.company_id === created.id)
    assert.ok(proj, 'un projet de prospection accompagne le prospect')
    createdProjectIds.push(proj.id)
    assert.equal(proj.status, 'Ouvert', 'stade initial de prospection')
    assert.equal(proj.probability, 0, 'probabilité au stade initial')
  })

  test("une entreprise déjà existante n'est jamais écrasée", async () => {
    const before = await apiCall('GET', `/companies/${baitCompanyId}`)
    const r = await apiCall('POST', '/mapaq/prospects', {
      entries: [{ name: NEAR, address: 'ADRESSE QUI NE DOIT PAS ATTERRIR', city: 'Nulle-Part' }],
    })
    assert.equal(r.status, 201)
    assert.equal(r.json.created.length, 0, 'aucune création')
    assert.equal(r.json.skipped.length, 1, 'l\'entrée est ignorée')
    assert.equal(r.json.skipped[0].company_id, baitCompanyId, 'elle pointe sur l\'entreprise existante')

    const after_ = await apiCall('GET', `/companies/${baitCompanyId}`)
    assert.equal(after_.json.name, before.json.name, 'le nom n\'a pas bougé')
    assert.equal(after_.json.address, before.json.address, 'l\'adresse n\'a pas été écrasée')
  })
})
