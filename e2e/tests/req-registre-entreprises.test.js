const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Registre des entreprises du Québec (REQ) — bloc de la fiche entreprise +
// page « Prospects REQ » (sous-route de Tests – Antoine).
//
// IMPORTANT (CLAUDE.md) : la DB de test EST la DB de prod. Le test n'écrit que
// des records qu'il crée lui-même — quatre lignes de registre aux NEQ 9999…
// (impossibles à confondre avec de vraies entreprises), une entreprise appât et
// le prospect créé via le bouton. Tout est retiré dans after(). Aucun record
// existant n'est modifié, et l'import ne supprime jamais de ligne.
describe('Registre des entreprises du Québec', () => {
  let browser, ctx, page
  const stamp = Date.now()
  const BAIT = `Serres Zzqxvreq ${stamp}`               // nom improbable → aucun vrai match
  // NEQ dérivés de l'horodatage : uniques à chaque exécution. Le nettoyage de
  // la passe précédente retire ses lignes en SOFT DELETE, et un ré-import ne
  // ressuscite pas une ligne écartée à la main (c'est voulu) — des NEQ figés
  // rendraient donc le test non rejouable.
  const NEQS = [1, 2, 3, 4].map(i => `9${String(stamp).slice(-8)}${i}`)
  const createdCompanyIds = []
  const createdProjectIds = []
  let baitCompanyId = null

  // CSV au format du fichier Entreprise du REQ (colonne de nom incluse, comme
  // pour un fichier assemblé à la main).
  const CSV = [
    'NEQ,NOM_ASSUJ,DAT_IMMAT,COD_STAT_IMMAT,COD_FORME_JURI,COD_ACT_ECON_CAE,DESC_ACT_ECON_ASSUJ,ADR_DOMCL_LIGN1_ADR,ADR_DOMCL_LIGN2_ADR,ADR_DOMCL_LIGN3_ADR,ADR_DOMCL_LIGN4_ADR',
    // Correspond à l'entreprise appât (même nom normalisé + même ville).
    `${NEQS[0]},"${BAIT} inc.",2011-03-14,Immatriculée,Société par actions,0126,"Culture de légumes en serre","120 rang des Érables","Sainte-Zzqreq (Québec)","J0L 2L0",`,
    // Sans correspondance ERP → doit apparaître dans Prospects REQ.
    `${NEQS[1]},"Pépinière Wxyqkreq ${stamp}",2015-07-02,Immatriculée,Entreprise individuelle,0126,"Horticulture ornementale et pépinière","8 route 132","Sainte-Zzqreq (Québec)","G0R 1A0",`,
    // Radiée → exclue des prospects, bandeau ambre sur la fiche.
    `${NEQS[2]},"Serres Radieereq ${stamp}",2001-01-05,Radiée d'office,Société par actions,0126,"Culture en serre","1 rue Test","Sainte-Zzqreq (Québec)","H7A 1A1",`,
    // Hors horticulture → exclue des prospects.
    `${NEQS[3]},"Garage Zzqxvreq ${stamp}",2018-09-09,Immatriculée,Société par actions,5511,"Réparation de véhicules","5 rue Auto","Sainte-Zzqreq (Québec)","H7A 1A1",`,
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

    const imported = await apiCall('POST', '/req/import', { csv: CSV })
    assert.equal(imported.status, 200, `import REQ OK (${JSON.stringify(imported).slice(0, 300)})`)
    assert.equal(imported.json.written, 4, '4 lignes de registre écrites')

    const co = await apiCall('POST', '/companies', { name: BAIT, city: 'Sainte-Zzqreq' })
    baitCompanyId = co.json?.id
    assert.ok(baitCompanyId, `entreprise appât créée (${JSON.stringify(co).slice(0, 200)})`)
  })

  after(async () => {
    try {
      for (const id of createdProjectIds) await apiCall('DELETE', `/projects/${id}`)
      for (const id of createdCompanyIds) await apiCall('DELETE', `/companies/${id}`)
      if (baitCompanyId) await apiCall('DELETE', `/companies/${baitCompanyId}`)
      for (const neq of NEQS) await apiCall('DELETE', `/req/entreprises/${neq}`)
    } catch { /* nettoyage best-effort */ }
    await browser?.close()
  })

  test("l'import est idempotent et ne détruit rien", async () => {
    const before = await apiCall('GET', '/req/status')
    const again = await apiCall('POST', '/req/import', { csv: CSV })
    assert.equal(again.status, 200)
    const after = await apiCall('GET', '/req/status')
    assert.equal(after.json.total, before.json.total, 'le re-import ne change pas la volumétrie')
  })

  test('la fiche entreprise propose la correspondance et affiche le NEQ', async () => {
    await page.goto(`${URL}/companies/${baitCompanyId}`, { waitUntil: 'domcontentloaded' })
    const card = page.getByTestId('req-registry-card')
    await card.waitFor({ state: 'visible', timeout: 20000 })
    await page.getByTestId('req-link-button').waitFor({ state: 'visible', timeout: 15000 })

    await assert.doesNotReject(card.getByText(NEQS[0]).first().waitFor({ timeout: 10000 }))
    await assert.doesNotReject(card.getByText(`${BAIT} inc.`).first().waitFor({ timeout: 10000 }))
    // Correspondance proposée, pas encore liée : rien n'a été écrit sur la fiche.
    const before = await apiCall('GET', `/req/match/${baitCompanyId}`)
    assert.equal(before.json.linked, false, 'la correspondance reste une proposition')
    assert.equal(before.json.exact_city, true, 'la municipalité concorde')

    // Attribution au Registraire : exigée par le « BY » de CC BY-NC-SA, donc
    // elle doit être présente partout où les données du registre s'affichent.
    const notice = card.getByTestId('req-source-notice')
    await notice.waitFor({ state: 'visible', timeout: 10000 })
    assert.match(await notice.innerText(), /CC BY-NC-SA 4\.0/, 'la licence est citée sur la fiche')
    // La fiche sert à vérifier une entreprise avec qui on fait déjà affaire :
    // pas d'avertissement « usage commercial » ici, il vise la prospection.
    assert.equal(await card.getByTestId('req-notice-commercial').count(), 0)
  })

  test('« Lier » enregistre le NEQ sur l\'entreprise', async () => {
    await page.getByTestId('req-link-button').click()
    await page.getByTestId('req-unlink-button').waitFor({ state: 'visible', timeout: 15000 })

    const after = await apiCall('GET', `/req/match/${baitCompanyId}`)
    assert.equal(after.json.linked, true)
    assert.equal(after.json.neq, NEQS[0], 'le NEQ est stocké sur la compagnie')
  })

  test('« Corriger la correspondance » ouvre un picker recherchable', async () => {
    await page.getByTestId('req-fix-match-button').click()
    const input = page.getByTestId('req-picker-input')
    await input.waitFor({ state: 'visible', timeout: 10000 })
    await input.fill(`Serres Radieereq ${stamp}`)

    const option = page.getByTestId(`req-picker-option-${NEQS[2]}`)
    await option.waitFor({ state: 'visible', timeout: 15000 })
    await option.click()

    // Entreprise radiée → bandeau d'alerte ambre sur la fiche.
    await page.getByTestId('req-struck-off-banner').waitFor({ state: 'visible', timeout: 15000 })
    const after = await apiCall('GET', `/req/match/${baitCompanyId}`)
    assert.equal(after.json.neq, NEQS[2], 'la correspondance corrigée est enregistrée')

    // On délie pour laisser l'appât dans l'état où le prochain test l'attend.
    await page.getByTestId('req-unlink-button').click()
    await page.getByTestId('req-link-button').waitFor({ state: 'visible', timeout: 15000 })
  })

  test('« Prospects REQ » vit dans le sous-menu Tests – Antoine de l\'Espace finance', async () => {
    await page.goto(`${URL}/dashboard`, { waitUntil: 'domcontentloaded' })
    // Le groupe Comptabilité est replié par défaut : on le déplie comme le
    // ferait l'utilisateur avant d'atteindre l'Espace finance.
    await page.waitForSelector('nav button:has-text("Comptabilité")', { timeout: 20000 })
    if (await page.locator('[data-testid="nav-flyout-trigger"]').count() === 0) {
      await page.click('nav button:has-text("Comptabilité")')
    }
    await page.locator('[data-testid="nav-flyout-trigger"]').waitFor({ state: 'visible', timeout: 10000 })

    await page.hover('[data-testid="nav-flyout-trigger"]')
    const panel = page.locator('[data-testid="nav-flyout-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 10000 })
    await panel.locator('a[href$="/erp/tests-antoine"]').hover()

    const sub = page.locator('[data-testid="nav-subsection-panel"][data-route="/tests-antoine"]')
    await sub.waitFor({ state: 'visible', timeout: 20000 })
    await sub.getByRole('link', { name: 'Prospects REQ', exact: true }).click()
    await page.waitForURL(/\/tests-antoine\/prospects-req/, { timeout: 20000 })
  })

  test('Projets mène à la page Prospects REQ', async () => {
    await page.goto(`${URL}/pipeline`, { waitUntil: 'domcontentloaded' })
    const link = page.getByTestId('pipeline-req-prospects-link')
    await link.waitFor({ state: 'visible', timeout: 20000 })
    await link.click()
    await page.waitForURL(/\/tests-antoine\/prospects-req/, { timeout: 20000 })
  })

  test('Prospects REQ ne liste que les horticoles actives sans correspondance', async () => {
    await page.goto(`${URL}/tests-antoine/prospects-req`, { waitUntil: 'domcontentloaded' })
    // Marge large : cette page monte après un aller-retour réseau, et le serveur
    // partagé avec la suite de tests peut être chargé.
    await page.getByTestId('req-prospects-search').waitFor({ state: 'visible', timeout: 45000 })
    await page.getByTestId('req-prospects-search').fill(`Wxyqkreq ${stamp}`)

    const row = page.getByTestId(`req-prospect-row-${NEQS[1]}`)
    await row.waitFor({ state: 'visible', timeout: 45000 })

    // La radiée et le garage ne doivent jamais apparaître, ni l'entreprise appât
    // (son nom existe déjà dans l'ERP).
    const listed = await apiCall('GET', '/req/prospects')
    const neqs = (listed.json.data || []).map(r => r.neq)
    assert.ok(neqs.includes(NEQS[1]), 'la pépinière est proposée')
    assert.ok(!neqs.includes(NEQS[2]), 'une entreprise radiée est exclue')
    assert.ok(!neqs.includes(NEQS[3]), 'une activité hors horticulture est exclue')
    assert.ok(!neqs.includes(NEQS[0]), "l'entreprise déjà présente dans l'ERP est exclue")

    // La prospection EST un usage commercial : la restriction de la licence
    // doit être sous les yeux de qui s'en sert, pas seulement dans le code.
    const notice = page.getByTestId('req-source-notice')
    await notice.waitFor({ state: 'visible', timeout: 15000 })
    const text = await notice.innerText()
    assert.match(text, /CC BY-NC-SA 4\.0/, 'la licence est citée sur la page Prospects')
    assert.match(text, /exclut l'utilisation commerciale/, "l'avertissement d'usage commercial est affiché")
  })

  test('« Créer la compagnie + le projet » crée les deux records', async () => {
    // Le POST peut faire la queue derrière le bootstrap `dataSync` de l'app
    // (limite de connexions du navigateur, ~8 s au chargement d'une page) :
    // on attend la réponse réseau elle-même, puis seulement le rendu React.
    const posted = page.waitForResponse(
      r => r.url().includes('/api/req/prospects') && r.request().method() === 'POST',
      { timeout: 90000 },
    )
    await page.getByTestId(`req-create-${NEQS[1]}`).click({ timeout: 45000 })
    await posted
    await page.getByText('Ouvrir la fiche').first().waitFor({ state: 'visible', timeout: 20000 })

    const co = await apiCall('GET', `/companies?search=Wxyqkreq ${stamp}&limit=all`)
    const created = (co.json?.data || []).find(c => String(c.name || '').includes(`Wxyqkreq ${stamp}`))
    assert.ok(created, `entreprise créée (${JSON.stringify(co).slice(0, 300)})`)
    createdCompanyIds.push(created.id)
    assert.equal(created.neq, NEQS[1], 'la nouvelle entreprise porte son NEQ')

    const projects = await apiCall('GET', `/projects?company_id=${created.id}&limit=all`)
    const project = (projects.json?.data || []).find(p => String(p.name || '').startsWith('Prospection REQ'))
    assert.ok(project, `projet de prospection créé (${JSON.stringify(projects).slice(0, 300)})`)
    createdProjectIds.push(project.id)
  })
})
