// Travaux de l'agent (/agent/travaux) : une file de prompts DISTINCTE de celle de
// l'Espace finance (space='agent'), avec les onglets Suggestions et Idées partagés.
//
// Sécurité : tous les prompts créés le sont « de côté » (status paused) —
// l'ordonnanceur ne les ramasse JAMAIS, donc aucune exécution réelle de l'agent.
// L'idée promue arrive elle aussi « de côté » par construction (promoteIdea).
// Tout est supprimé dans le hook after().
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Travaux — file distincte de la section Agent', () => {
  let browser, ctx, page
  const stamp = Date.now()
  let agentPromptId = null
  let financePromptId = null
  let ideaId = null
  let promotedPromptId = null

  const api = (fn, arg) => page.evaluate(fn, arg)
  const createPrompt = (body) => api(async (body) => {
    const token = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api/travaux/prompts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return r.json()
  }, body)
  const listPrompts = (space) => api(async (space) => {
    const token = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api/travaux/prompts' + (space ? `?space=${space}` : ''), {
      headers: { Authorization: `Bearer ${token}` },
    })
    return (await r.json()).prompts
  }, space)

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    if (page) {
      await api(async (ids) => {
        const token = localStorage.getItem('erp_token')
        const H = { Authorization: `Bearer ${token}` }
        for (const id of ids.prompts.filter(Boolean)) {
          await fetch(`/erp/api/travaux/prompts/${id}`, { method: 'DELETE', headers: H }).catch(() => {})
        }
        if (ids.idea) await fetch(`/erp/api/travaux/ideas/${ids.idea}`, { method: 'DELETE', headers: H }).catch(() => {})
      }, { prompts: [agentPromptId, financePromptId, promotedPromptId], idea: ideaId })
    }
    await browser?.close()
  })

  test('un prompt créé pour la file agent ne pollue pas la file finance (et inversement)', async () => {
    const agent = await createPrompt({
      title: `E2E agent-space ${stamp}`,
      prompt: 'Ne rien faire — item de test E2E (file agent).',
      mode: 'question',
      status: 'paused',
      space: 'agent',
    })
    agentPromptId = agent.id
    assert.ok(agentPromptId, 'création du prompt agent')
    assert.equal(agent.space, 'agent', 'le prompt doit porter sa file')

    const finance = await createPrompt({
      title: `E2E finance-space ${stamp}`,
      prompt: 'Ne rien faire — item de test E2E (file finance).',
      mode: 'question',
      status: 'paused',
    })
    financePromptId = finance.id
    assert.equal(finance.space, 'finance', 'sans space explicite, un prompt va dans la file finance')

    const agentList = await listPrompts('agent')
    assert.ok(agentList.some(p => p.id === agentPromptId), 'le prompt agent doit être dans sa file')
    assert.ok(!agentList.some(p => p.id === financePromptId), 'le prompt finance ne doit PAS apparaître dans la file agent')

    const financeList = await listPrompts('finance')
    assert.ok(financeList.some(p => p.id === financePromptId), 'le prompt finance doit être dans sa file')
    assert.ok(!financeList.some(p => p.id === agentPromptId), 'le prompt agent ne doit PAS apparaître dans la file finance')
  })

  test('la page /agent/travaux montre la file agent, sans l\'onglet récurrents', async () => {
    await page.goto(URL + '/agent/travaux', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Travaux de l\'agent")', { timeout: 15000 })

    for (const t of ['Ma file de prompts', 'Suggestions de Claude', 'Idées']) {
      assert.ok(await page.locator(`button:has-text("${t}")`).count() > 0, `onglet manquant : ${t}`)
    }
    assert.equal(await page.locator('button:has-text("Travaux récurrents")').count(), 0,
      'les travaux récurrents restent propres à l\'Espace finance')

    await page.waitForSelector(`[data-prompt-id="${agentPromptId}"]`, { timeout: 10000 })
    assert.equal(await page.locator(`[data-prompt-id="${financePromptId}"]`).count(), 0,
      'un item de la file finance ne doit pas s\'afficher sur la page agent')
  })

  test('la page /travaux (finance) ne montre pas la file agent', async () => {
    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`[data-prompt-id="${financePromptId}"]`, { timeout: 15000 })
    assert.equal(await page.locator(`[data-prompt-id="${agentPromptId}"]`).count(), 0,
      'un item de la file agent ne doit pas s\'afficher sur la page finance')
  })

  test('la page Agent offre un lien vers ses travaux', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'domcontentloaded' })
    const link = page.locator('[data-testid="agent-travaux-link"]')
    await link.waitFor({ timeout: 15000 })
    await link.click()
    await page.waitForURL(u => u.toString().includes('/agent/travaux'), { timeout: 10000 })
    await page.waitForSelector('h1:has-text("Travaux de l\'agent")', { timeout: 10000 })
  })

  test('promouvoir une idée depuis la section agent dépose l\'item dans SA file, de côté', async () => {
    const idea = await api(async (stamp) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/travaux/ideas', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `E2E idée agent ${stamp}`, notes: 'Idée jetable E2E.' }),
      })
      return r.json()
    }, stamp)
    ideaId = idea.id
    assert.ok(ideaId, 'création de l\'idée')

    // Promotion depuis l'onglet Idées de la page AGENT : l'item doit naître dans
    // la file agent (space='agent'), et « de côté » (jamais exécuté).
    await page.goto(URL + '/agent/travaux?onglet=idees', { waitUntil: 'domcontentloaded' })
    const card = page.locator(`[data-idea-id="${ideaId}"]`)
    await card.waitFor({ timeout: 15000 })
    await card.getByTestId('idea-promote').click()

    const created = await api(async (ideaId) => {
      const token = localStorage.getItem('erp_token')
      for (let i = 0; i < 20; i++) {
        const r = await fetch('/erp/api/travaux/ideas', { headers: { Authorization: `Bearer ${token}` } })
        const { ideas } = await r.json()
        const idea = ideas.find(x => x.id === ideaId)
        if (idea?.work_prompt_id) {
          const rp = await fetch('/erp/api/travaux/prompts?space=agent', { headers: { Authorization: `Bearer ${token}` } })
          const { prompts } = await rp.json()
          return prompts.find(p => p.id === idea.work_prompt_id) || null
        }
        await new Promise(res => setTimeout(res, 400))
      }
      return null
    }, ideaId)
    assert.ok(created, 'l\'item promu doit exister dans la file AGENT')
    promotedPromptId = created.id
    assert.equal(created.space, 'agent', 'l\'item promu doit porter space=agent')
    assert.equal(created.status, 'paused', 'l\'item promu doit être de côté (jamais lancé d\'office)')
  })

  // L'entrée « Agent » de la sidebar n'a plus de sous-menu (voir
  // sidebar-agent-direct-link.test.js) : le chemin vers les travaux de l'agent
  // passe par la page Agent elle-même, couvert plus haut.
})
