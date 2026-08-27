// Page Travaux : les onglets, le cochage par période d'un travail
// récurrent, et l'ajout d'un prompt dans la file.
//
// Aucun vrai record n'est touché : le travail récurrent et le prompt utilisés sont
// créés par le test puis supprimés (hook after). Le prompt est créé « de côté »
// (status paused) pour ne JAMAIS déclencher une exécution réelle de l'agent.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Travaux — file de prompts, suggestions, travaux récurrents', () => {
  let browser, ctx, page
  let taskId = null
  let promptId = null
  const label = `E2E travail jetable ${Date.now()}`

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => {
    await page.evaluate(async ({ taskId, promptId }) => {
      const token = localStorage.getItem('erp_token')
      const del = (p) => fetch(p, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
      if (taskId) await del(`/erp/api/travaux/recurring/${taskId}`)
      if (promptId) await del(`/erp/api/travaux/prompts/${promptId}`)
    }, { taskId, promptId })
    await browser?.close()
  })

  test('les onglets se chargent', async () => {
    await page.goto(URL + '/travaux', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Travaux")', { timeout: 10000 })
    for (const t of ['Ma file de prompts', 'Suggestions de Claude', 'Idées', 'Travaux récurrents']) {
      assert.ok(await page.locator(`button:has-text("${t}")`).count() > 0, `onglet manquant : ${t}`)
    }
  })

  test('cocher un travail récurrent enregistre la période courante', async () => {
    const created = await page.evaluate(async (label) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/travaux/recurring', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, cadence: 'hebdo', owner: 'AL' }),
      })
      return r.json()
    }, label)
    taskId = created.id
    assert.ok(taskId, 'création du travail récurrent')

    await page.goto(URL + '/travaux?onglet=recurrents', { waitUntil: 'domcontentloaded' })
    const row = page.locator(`input[value="${label}"]`)
    await row.waitFor({ timeout: 10000 })

    // Case contrôlée en autosave : .click() (pas .check()) — la case reverte le
    // temps du PATCH, l'état DOM immédiat n'est pas une preuve. On valide par API.
    //
    // La case doit être cherchée dans la LIGNE (`div.group`) et non dans le
    // premier div contenant le libellé : `locator('div', { has: row }).first()`
    // remonte jusqu'au conteneur de page, dont la première case appartient à un
    // AUTRE travail — la liste compte une vingtaine de lignes réelles.
    await page.locator('div.group', { has: row }).locator('input[type="checkbox"]').first().click()

    const state = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      for (let i = 0; i < 20; i++) {
        const r = await fetch('/erp/api/travaux/recurring?owner=AL', { headers: { Authorization: `Bearer ${token}` } })
        const { tasks } = await r.json()
        const t = tasks.find(x => x.id === id)
        if (t?.done) return t
        await new Promise(res => setTimeout(res, 300))
      }
      return null
    }, taskId)
    assert.ok(state, 'le cochage n\'a pas été persisté')
    assert.match(state.period_key, /^\d{4}-W\d{2}$/, 'clé de période hebdo attendue')
  })

  test('un prompt ajouté à la file apparaît dans la liste', async () => {
    // Créé directement en « de côté » (status: 'paused') : l'ordonnanceur ne
    // ramasse jamais un item paused, donc le test ne déclenche AUCUNE exécution
    // réelle de l'agent.
    const created = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/travaux/prompts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `E2E prompt jetable ${Date.now()}`,
          prompt: 'Ne rien faire — item de test E2E.',
          mode: 'question',
          status: 'paused',
        }),
      })
      return r.json()
    })
    promptId = created.id
    assert.ok(promptId, 'création du prompt')

    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`input[value="${created.title}"]`, { timeout: 10000 })
  })

  // Propriété load-bearing pour tout import en masse (ex. les prompts repris du
  // Google Doc « Procédés ctb à automatiser ») : déposé « de côté », un item
  // s'affiche comme tel et n'est JAMAIS ramassé par l'ordonnanceur — la
  // validation humaine reste le seul déclencheur.
  test('un prompt « de côté » reste de côté et s\'affiche comme tel', async () => {
    assert.ok(promptId, 'prompt du test précédent requis')
    const card = page.locator('div', { has: page.locator(`input[value^="E2E prompt jetable"]`) }).last()
    await card.locator('text=De côté').first().waitFor({ timeout: 10000 })

    const after = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      await new Promise(r => setTimeout(r, 3000))
      const res = await fetch('/erp/api/travaux/prompts', { headers: { Authorization: `Bearer ${token}` } })
      const { prompts } = await res.json()
      return prompts.find(p => p.id === id) || null
    }, promptId)
    assert.equal(after?.status, 'paused', 'l\'item de côté a changé d\'état tout seul')
    assert.equal(after?.agent_task_id, null, 'une exécution a été déclenchée pour un item de côté')
  })
})
