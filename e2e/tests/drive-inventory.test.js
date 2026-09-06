// Inventaire Drive — recensement décisionnel, à la granularité de l'ONGLET.
//
// Le test n'appelle JAMAIS le recensement (il taperait sur l'API Google puis sur
// le modèle, pour plusieurs minutes) : il crée un document jetable ajouté à la
// main, vérifie l'affichage, l'autosave des décisions au niveau fichier ET au
// niveau onglet, puis nettoie tout.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Inventaire Drive — onglets, suggestions et décisions', () => {
  let browser, ctx, page, itemId
  const stamp = Date.now()
  const NAME = `E2E Inventaire Drive ${stamp}`

  const apiFetch = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts })

  const inventory = async () => (await apiFetch('/drive-inventory')).body

  // L'autosave part au blur / au change : on interroge l'API jusqu'à ce que la
  // valeur soit posée, plutôt que de lire le DOM tout de suite.
  const poll = async (read, predicate, label) => {
    for (let i = 0; i < 25; i++) {
      const v = await read()
      if (v && predicate(v)) return v
      await new Promise(res => setTimeout(res, 400))
    }
    throw new Error(`Timeout en attendant : ${label}`)
  }
  const pollItem = (predicate, label) =>
    poll(async () => (await inventory()).items.find(x => x.id === itemId), predicate, label)

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    // Nettoyage — s'exécute même si un test a échoué. La suppression du document
    // emporte ses onglets.
    try { if (itemId) await apiFetch(`/drive-inventory/items/${itemId}`, { method: 'DELETE' }) } catch {}
    await browser?.close()
  })

  test("l'inventaire répond avec ses statistiques d'onglets et l'état du dernier passage", async () => {
    const r = await apiFetch('/drive-inventory')
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.items), 'items manquant')
    assert.ok(Array.isArray(r.body.suggestions), 'suggestions manquantes')
    assert.ok(Array.isArray(r.body.modules) && r.body.modules.length > 5, 'catalogue de modules manquant')
    for (const k of ['total', 'synced', 'partial', 'candidate', 'ignore', 'tabs_total', 'tabs_to_import']) {
      assert.equal(typeof r.body.stats[k], 'number', `stat ${k} manquante`)
    }
    assert.equal(r.body.stats.synced + r.body.stats.partial + r.body.stats.candidate + r.body.stats.ignore,
      r.body.stats.total, 'les statuts ne couvrent pas tout l\'inventaire')
  })

  test('un classeur partiellement repris n\'est PAS annoncé comme déjà synchronisé', async () => {
    const inv = await inventory()
    const ctb = inv.items.find(i => i.name === 'CTB - Suivi')
    if (!ctb) {
      // Le recensement n'a jamais tourné sur cette base : rien à vérifier ici.
      assert.ok(true, 'CTB - Suivi absent de l\'inventaire — recensement non exécuté')
      return
    }
    assert.ok(ctb.tab_details.length > 2, 'les onglets de CTB - Suivi devraient être détaillés')
    assert.equal(ctb.status, 'partial', 'un classeur dont des onglets restent ouverts doit être « partiellement repris »')

    const bySt = s => ctb.tab_details.filter(t => t.status === s).length
    assert.ok(bySt('synced') >= 1, 'au moins un onglet doit être reconnu comme repris')
    assert.ok(bySt('candidate') >= 1, 'au moins un onglet doit rester à trancher')

    // « Pmt_Suivi » est lu par l'ERP ; « Abonn. » ne l'est pas.
    const pmt = ctb.tab_details.find(t => t.tab_name === 'Pmt_Suivi')
    if (pmt) assert.equal(pmt.status, 'synced')
    const abonn = ctb.tab_details.find(t => t.tab_name === 'Abonn.')
    if (abonn) assert.notEqual(abonn.status, 'synced', '« Abonn. » n\'est repris par aucun sync')
  })

  test('les suggestions désignent un onglet précis et sa destination dans l\'ERP', async () => {
    const inv = await inventory()
    if (!inv.suggestions.length) {
      assert.ok(true, 'aucune suggestion — analyse non exécutée sur cette base')
      return
    }
    for (const s of inv.suggestions.slice(0, 10)) {
      assert.ok(s.tab_name, 'une suggestion doit nommer son onglet')
      assert.ok(s.file_name, 'une suggestion doit nommer son classeur')
      assert.equal(s.verdict, 'importer')
      assert.ok(s.relevance >= 0 && s.relevance <= 100, 'note de pertinence hors bornes')
      assert.ok(inv.modules.includes(s.target_module) || s.target_module === null,
        `module inventé : ${s.target_module}`)
    }
    // Les suggestions sont ordonnées de la plus pertinente à la moins.
    const scores = inv.suggestions.map(s => s.relevance)
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a))
  })

  test('un document ajouté à la main entre dans l\'inventaire comme candidat', async () => {
    const r = await apiFetch('/drive-inventory/items', {
      method: 'POST', body: JSON.stringify({ name: NAME }),
    })
    assert.equal(r.status, 201)
    itemId = r.body.id
    assert.equal(r.body.status, 'candidate')
    assert.equal(r.body.decision, null)
    assert.deepEqual(r.body.tab_details, [])
  })

  test('la page affiche le document et sa décision s\'autosauvegarde', async () => {
    await page.goto(`${URL}/inventaire-drive?onglet=documents`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Inventaire Drive")', { timeout: 20000 })
    const row = page.locator(`[data-testid="drive-item-${itemId}"]`)
    await row.waitFor({ state: 'visible', timeout: 20000 })
    assert.ok((await row.innerText()).includes(NAME))

    await page.locator(`[data-testid="decision-${itemId}"]`).selectOption('import')
    const saved = await pollItem(i => i.decision === 'import', 'décision fichier = importer')
    assert.ok(saved.decided_at && saved.decided_by, 'traçabilité de la décision manquante')

    const note = page.locator(`[data-testid="decision-note-${itemId}"]`)
    await note.click()
    await note.fill('Rapatrier après le chantier trésorerie')
    await page.keyboard.press('Tab')
    await pollItem(i => i.decision_note === 'Rapatrier après le chantier trésorerie', 'note fichier sauvegardée')

    // Règle d'autosave du projet : aucun bouton « Enregistrer » sur la page.
    assert.equal(await page.locator('button:has-text("Enregistrer")').count(), 0)
  })

  test('la décision se prend aussi ONGLET par ONGLET', async () => {
    const inv = await inventory()
    const withTabs = inv.items.find(i => (i.tab_details || []).length > 1)
    if (!withTabs) {
      assert.ok(true, 'aucun classeur détaillé — recensement non exécuté sur cette base')
      return
    }
    const target = withTabs.tab_details.find(t => !t.decision) || withTabs.tab_details[0]
    const previous = { decision: target.decision, decision_note: target.decision_note }

    try {
      await page.goto(`${URL}/inventaire-drive?onglet=documents`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('h1:has-text("Inventaire Drive")', { timeout: 20000 })
      await page.locator(`[data-testid="expand-${withTabs.id}"]`).click()
      const select = page.locator(`[data-testid="tab-decision-${target.id}"]`)
      await select.waitFor({ state: 'visible', timeout: 10000 })
      await select.selectOption('keep_drive')

      const saved = await poll(
        async () => (await inventory()).items.find(i => i.id === withTabs.id)?.tab_details.find(t => t.id === target.id),
        t => t.decision === 'keep_drive',
        'décision onglet = garder dans Drive',
      )
      assert.equal(saved.decision, 'keep_drive')
      // La décision d'un onglet ne déteint pas sur son classeur.
      const parent = (await inventory()).items.find(i => i.id === withTabs.id)
      assert.equal(parent.decision, withTabs.decision)
    } finally {
      // Restauration : cet onglet appartient à un vrai classeur de la compta.
      await apiFetch(`/drive-inventory/tabs/${target.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ decision: previous.decision, decision_note: previous.decision_note }),
      })
    }
  })

  test('le volet Suggestions s\'affiche et se cherche', async () => {
    await page.goto(`${URL}/inventaire-drive?onglet=suggestions`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="drive-suggestions"]', { timeout: 20000 })
    const inv = await inventory()
    if (!inv.suggestions.length) return

    const first = inv.suggestions[0]
    await page.locator(`[data-testid="suggestion-${first.id}"]`).waitFor({ state: 'visible', timeout: 10000 })
    await page.fill('[data-testid="drive-search"]', 'zzz-aucun-resultat-zzz')
    await page.waitForTimeout(400)
    assert.equal(await page.locator('[data-testid^="suggestion-"]').count(), 0)
  })

  test('une décision invalide est refusée, au fichier comme à l\'onglet', async () => {
    const r = await apiFetch(`/drive-inventory/items/${itemId}`, {
      method: 'PATCH', body: JSON.stringify({ decision: 'supprimer_le_drive' }),
    })
    assert.equal(r.status, 400)
    assert.equal((await inventory()).items.find(x => x.id === itemId).decision, 'import')

    const bad = await apiFetch('/drive-inventory/tabs/inexistant', {
      method: 'PATCH', body: JSON.stringify({ decision: 'import' }),
    })
    assert.equal(bad.status, 404)
  })
})
