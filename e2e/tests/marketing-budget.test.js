const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Page Budget marketing (/budget-marketing) — file de validation des dépenses
// QB, règles d'exclusion par fournisseur, Budget vs Réel, aperçu Slack.
//
// IMPORTANT (CLAUDE.md) : prod DB = test DB. Le test ne touche qu'à des
// records jetables : une règle d'exclusion au nom improbable (créée puis
// supprimée), et une dépense réelle dont le statut est restauré à l'identique
// via l'API dans after(). Aucun envoi Slack n'est déclenché.
const RULE_VENDOR = 'E2E Vendeur Jetable ~ ne pas utiliser'

describe('Budget marketing — page et flux de validation', () => {
  let browser, ctx, page, token
  let createdRuleId = null
  let decidedExpenseId = null // dépense réelle passée relevant → à restaurer pending

  const apiCall = (method, path, body) => page.evaluate(async ({ base, method, path, body, t }) => {
    const r = await fetch(base + '/api' + path, {
      method,
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: r.status, json: await r.json().catch(() => null) }
  }, { base: URL, method, path, body, t: token })

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
  })

  after(async () => {
    // Nettoyage inconditionnel : règle jetable supprimée, statut de la dépense
    // restauré à « pending » (son état d'origine), même si un test a échoué.
    try { if (createdRuleId) await apiCall('DELETE', `/marketing-budget/rules/${createdRuleId}`) } catch {}
    try {
      if (decidedExpenseId) await apiCall('PATCH', `/marketing-budget/expenses/${decidedExpenseId}`, { status: 'pending' })
    } catch {}
    await browser?.close()
  })

  test('la page rend ses trois sections', async () => {
    await page.goto(URL + '/budget-marketing', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Budget marketing")', { timeout: 10000 })
    await page.waitForSelector('text=Dépenses détectées', { timeout: 10000 })
    await page.waitForSelector('text=Budget vs Réel', { timeout: 10000 })
    await page.waitForSelector('text=Fournisseurs jamais pertinents', { timeout: 10000 })
  })

  // La détection ne doit PAS dépendre du bouton : elle tourne plusieurs fois par
  // jour toute seule. Le test vérifie les deux faces de cette garantie —
  // l'automation système planifiée à plusieurs heures dans la journée (et
  // active, sinon rien ne tournerait), et la mention visible sur la page avec
  // l'heure du dernier passage automatique. Lecture seule : rien n'est modifié.
  test('la détection est planifiée plusieurs fois par jour et la page le montre', async () => {
    const auto = await apiCall('GET', '/automations/sys_marketing_expense_sync')
    assert.equal(auto.status, 200, JSON.stringify(auto.json))
    assert.equal(auto.json.active, 1, "l'automation de détection doit être active")
    const cron = JSON.parse(auto.json.trigger_config).cron
    // Plusieurs heures de déclenchement dans le champ « heures » du cron : une
    // seule valeur (ex. « 30 11 * * * ») = un seul passage par jour.
    const hours = cron.trim().split(/\s+/)[1].split(',')
    assert.ok(hours.length >= 3, `cron « ${cron} » doit déclencher plusieurs fois par jour`)

    // L'API annonce la cadence et le dernier passage automatique (les clics sur
    // le bouton sont exclus : ils masqueraient un cron en panne).
    const list = await apiCall('GET', '/marketing-budget/expenses?limit=1')
    const sync = list.json.last_sync
    assert.ok(sync, 'la réponse expose last_sync')
    assert.equal(sync.active, true)
    assert.match(sync.schedule, /par jour/)

    await page.goto(URL + '/budget-marketing', { waitUntil: 'domcontentloaded' })
    const note = page.locator('[data-auto-sync]')
    await note.waitFor({ timeout: 10000 })
    const text = await note.innerText()
    assert.match(text, /Détection automatique/, `mention visible : ${text}`)
    assert.doesNotMatch(text, /désactivée/, 'la détection automatique doit être annoncée comme active')
    if (sync.at) assert.match(text, /dernier passage \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, `heure du dernier passage : ${text}`)
  })

  test('le tableau Budget vs Réel affiche les 5 catégories de comptes QB', async () => {
    for (const label of ['Consultants', 'Partenaires', 'Publicité et promotion', 'Événements/Conférences', 'Repas aux fins de promotion']) {
      assert.ok(await page.locator(`table >> text=${label}`).first().isVisible(), `catégorie ${label} visible`)
    }
    // Lignes Budget (éditable) et Réel présentes pour chaque catégorie.
    assert.equal(await page.locator('td:text-is("Budget")').count(), 5)
    assert.equal(await page.locator('td:text-is("Réel")').count(), 5)
  })

  test("l'aperçu du message Slack s'ouvre sans rien envoyer", async () => {
    await page.click('button:has-text("Aperçu du message Slack")')
    await page.waitForSelector('text=Message Slack du mardi', { timeout: 10000 })
    const preview = await page.locator('pre').innerText()
    assert.match(preview, /Budget marketing — semaine du/)

    // Le canal Slack doit être reconnu comme configuré : sans webhook, l'aperçu
    // affiche un avertissement et l'envoi du mardi échouerait.
    const summary = await page.locator('[role="dialog"] .text-xs').first().innerText()
    assert.match(summary, /configuré/, `aperçu : ${summary}`)
    assert.doesNotMatch(summary, /absent de server/, 'le webhook ne doit plus être signalé manquant')

    await page.click('button:has-text("Fermer")')
    await page.waitForSelector('text=Message Slack du mardi', { state: 'detached', timeout: 5000 })
  })

  // Le bouton d'envoi doit agir au PREMIER clic : aucune boîte de confirmation.
  // L'appel d'envoi est intercepté et simulé — aucun message réel ne part vers
  // le Slack d'Émilie, et la base n'est pas touchée (notified_at intact).
  test('« Envoyer maintenant » part au premier clic, sans confirmation', async () => {
    let dialogSeen = false
    const onDialog = async d => { dialogSeen = true; await d.dismiss() }
    page.on('dialog', onDialog)

    let sendCalls = 0
    const sendRoute = /\/api\/marketing-budget\/slack\/send$/
    await page.route(sendRoute, async route => {
      sendCalls++
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, sent: true, count: 0, pending: 0, message: 'simulé' }),
      })
    })

    try {
      await page.goto(URL + '/budget-marketing', { waitUntil: 'domcontentloaded' })
      await page.click('button:has-text("Aperçu du message Slack")')
      await page.waitForSelector('text=Message Slack du mardi', { timeout: 10000 })
      await page.click('button:has-text("Envoyer maintenant")')

      // Si un confirm() subsistait, Playwright le rejetterait par défaut et
      // AUCUNE requête ne partirait : ce compteur est la preuve du clic unique.
      const deadline = Date.now() + 5000
      while (sendCalls === 0 && Date.now() < deadline) await page.waitForTimeout(100)
      assert.equal(sendCalls, 1, "l'envoi doit partir au premier clic, sans autre interaction")
      assert.equal(dialogSeen, false, 'aucune fenêtre de confirmation ne doit s\'ouvrir')

      // La modale se referme : retour visible que l'action a bien eu lieu.
      await page.waitForSelector('text=Message Slack du mardi', { state: 'detached', timeout: 10000 })
    } finally {
      page.off('dialog', onDialog)
      await page.unroute(sendRoute)
    }
  })

  test('règle d\'exclusion : création (API), affichage, suppression (UI)', async () => {
    const out = await apiCall('POST', '/marketing-budget/rules', { vendor_label: RULE_VENDOR })
    assert.equal(out.status, 200, JSON.stringify(out.json))
    createdRuleId = out.json.rule.id
    assert.equal(out.json.applied_to_pending, 0, 'le fournisseur jetable ne doit matcher aucune vraie dépense')

    await page.reload({ waitUntil: 'domcontentloaded' })
    // Ciblage par id : un sélecteur basé sur le texte remonterait jusqu'au
    // panneau entier et sa « dernière » corbeille pourrait être celle d'une
    // VRAIE règle de l'utilisateur — sa suppression rouvrirait ses dépenses.
    const row = page.locator(`div[data-rule-id="${createdRuleId}"]`)
    await row.waitFor({ timeout: 10000 })
    assert.match(await row.innerText(), new RegExp(RULE_VENDOR.slice(0, 20).replace(/[.*+?^${}()|[\]\\~]/g, '\\$&')))

    // Suppression par le bouton corbeille de CETTE ligne.
    await row.locator('button').click()
    await row.waitFor({ state: 'detached', timeout: 10000 })

    // Vérifie côté API que la règle est bien soft-deletée.
    const rules = await apiCall('GET', '/marketing-budget/rules')
    assert.ok(!rules.json.some(r => r.id === createdRuleId), 'règle absente de la liste')
    createdRuleId = null
  })

  test('décision « Pertinente » : la dépense quitte la file à valider (puis restauration)', async (t) => {
    // Prend une dépense réellement en attente ; s'il n'y en a aucune, on saute.
    const list = await apiCall('GET', '/marketing-budget/expenses?status=pending')
    const target = list.json.expenses[0]
    if (!target) { t.skip('aucune dépense en attente'); return }
    decidedExpenseId = target.id

    await page.goto(URL + '/budget-marketing', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=Dépenses détectées', { timeout: 10000 })
    const pendingBefore = list.json.pending

    // Clique « Pertinente » sur la première ligne de la file.
    await page.locator('tbody tr').first().locator('button:has-text("Pertinente")').click()

    // Validation par l'API (pas le DOM immédiat — cf. gotcha autosave E2E).
    await page.waitForFunction(async ({ base, id, t: tok }) => {
      const r = await fetch(`${base}/api/marketing-budget/expenses?status=relevant`, { headers: { Authorization: 'Bearer ' + tok } })
      const d = await r.json()
      return d.expenses.some(e => e.id === id)
    }, { base: URL, id: target.id, t: token }, { timeout: 10000 })

    const afterList = await apiCall('GET', '/marketing-budget/expenses?status=pending')
    assert.equal(afterList.json.pending, pendingBefore - 1, 'compteur à valider décrémenté')

    // Restauration immédiate à l'état d'origine (pending, décision effacée).
    const restore = await apiCall('PATCH', `/marketing-budget/expenses/${target.id}`, { status: 'pending' })
    assert.equal(restore.status, 200)
    assert.equal(restore.json.status, 'pending')
    assert.equal(restore.json.decided_at, null)
    decidedExpenseId = null
  })

  // Le clic doit être INSTANTANÉ : la ligne quitte la liste sans attendre la
  // réponse du serveur. On retarde volontairement la requête de 2,5 s et on
  // exige que la ligne ait disparu bien avant — sinon le test échoue.
  test('la ligne disparaît immédiatement, avant la réponse du serveur', async (t) => {
    const list = await apiCall('GET', '/marketing-budget/expenses?status=pending')
    const target = list.json.expenses[0]
    if (!target) { t.skip('aucune dépense en attente'); return }
    decidedExpenseId = target.id

    await page.goto(URL + '/budget-marketing', { waitUntil: 'domcontentloaded' })
    const row = page.locator(`tr[data-expense-id="${target.id}"]`)
    await row.waitFor({ timeout: 10000 })

    await page.route(/\/api\/marketing-budget\/expenses\/[^/?]+$/, async route => {
      if (route.request().method() !== 'PATCH') return route.continue()
      await new Promise(r => setTimeout(r, 2500))
      await route.continue()
    })

    const t0 = Date.now()
    await row.locator('button:has-text("Non")').click()
    // 700 ms : largement au-dessus du coût d'un rendu React, très en dessous du
    // délai réseau simulé — ne passe que si l'affichage n'attend pas le serveur.
    await row.waitFor({ state: 'detached', timeout: 700 })
    const elapsed = Date.now() - t0
    assert.ok(elapsed < 2000, `disparition en ${elapsed} ms (doit précéder la réponse serveur)`)

    // Laisse l'enregistrement se terminer, puis restaure l'état d'origine.
    await page.waitForFunction(async ({ base, id, t: tok }) => {
      const r = await fetch(`${base}/api/marketing-budget/expenses?status=not_relevant`, { headers: { Authorization: 'Bearer ' + tok } })
      const d = await r.json()
      return d.expenses.some(e => e.id === id)
    }, { base: URL, id: target.id, t: token }, { timeout: 15000 })
    await page.unroute(/\/api\/marketing-budget\/expenses\/[^/?]+$/)

    const restore = await apiCall('PATCH', `/marketing-budget/expenses/${target.id}`, { status: 'pending' })
    assert.equal(restore.json.status, 'pending')
    decidedExpenseId = null
  })

  // « Jamais » doit agir en UN clic : aucune fenêtre de confirmation, la règle
  // est créée directement. Réversible : supprimer la règle remet les dépenses
  // qu'elle a écartées en attente — c'est ce qui restaure l'état d'origine.
  test('« Jamais » : aucune confirmation, exclusion appliquée en un clic', async (t) => {
    const before = await apiCall('GET', '/marketing-budget/expenses?status=pending')
    // La création de règle est idempotente : si le fournisseur en avait déjà
    // une, l'API renverrait la règle EXISTANTE — la supprimer au nettoyage
    // détruirait une décision réelle de l'utilisateur. On ne cible donc qu'un
    // fournisseur sans règle, et on s'assure de ne supprimer que la nôtre.
    const rulesBefore = await apiCall('GET', '/marketing-budget/rules')
    const ruleIdsBefore = new Set(rulesBefore.json.map(r => r.id))
    const excluded = new Set(rulesBefore.json.map(r => r.vendor_label))
    const target = before.json.expenses.find(e => e.vendor && !excluded.has(e.vendor))
    if (!target) { t.skip('aucune dépense en attente dont le fournisseur soit sans règle'); return }
    const pendingIdsBefore = before.json.expenses.map(e => e.id).sort()

    // Un dialog natif (confirm/alert) ferait échouer le test : on le refuse.
    let dialogSeen = false
    const onDialog = async d => { dialogSeen = true; await d.dismiss() }
    page.on('dialog', onDialog)

    await page.goto(URL + '/budget-marketing', { waitUntil: 'domcontentloaded' })
    const row = page.locator(`tr[data-expense-id="${target.id}"]`)
    await row.waitFor({ timeout: 10000 })
    await row.locator('button:has-text("Jamais")').click()

    // La ligne part tout de suite, et la règle apparaît dans le panneau latéral
    // sans qu'aucun autre bouton n'ait été touché.
    await row.waitFor({ state: 'detached', timeout: 700 })
    await page.locator('div:has-text("Fournisseurs jamais pertinents")')
      .locator(`text=${target.vendor}`).first().waitFor({ timeout: 10000 })
    assert.equal(dialogSeen, false, 'aucune fenêtre de confirmation ne doit s\'ouvrir')
    page.off('dialog', onDialog)

    // Aucune modale de confirmation dans le DOM non plus.
    assert.equal(await page.locator('[role="dialog"]').count(), 0)

    const rules = await apiCall('GET', '/marketing-budget/rules')
    const rule = rules.json.find(r => r.vendor_label === target.vendor)
    assert.ok(rule, 'la règle d\'exclusion existe')
    assert.ok(!ruleIdsBefore.has(rule.id), 'la règle a bien été créée par le test (jamais une règle préexistante)')
    createdRuleId = rule.id

    // Nettoyage : supprimer la règle rouvre exactement les dépenses écartées.
    const del = await apiCall('DELETE', `/marketing-budget/rules/${rule.id}`)
    assert.equal(del.status, 200)
    createdRuleId = null
    const after = await apiCall('GET', '/marketing-budget/expenses?status=pending')
    assert.deepEqual(after.json.expenses.map(e => e.id).sort(), pendingIdsBefore,
      'file à valider restaurée à l\'identique')
  })
})
