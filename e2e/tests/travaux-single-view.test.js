// Navigateur sur le build local, API simulée : aucune connexion à la production.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

describe('Travaux — même vue pour tous les comptes', () => {
  let server, browser, base
  before(async () => {
    const root = path.resolve(__dirname, '../../client/dist')
    server = http.createServer((req, res) => {
      const relative = new URL(req.url, 'http://localhost').pathname.replace(/^\/erp\/?/, '')
      let file = path.resolve(root, relative)
      if (!file.startsWith(root + '/') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
      res.setHeader('Content-Type', { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream')
      fs.createReadStream(file).pipe(res)
    })
    server.on('upgrade', (_req, socket) => socket.destroy())
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}/erp`
    browser = await chromium.launch({ headless: true })
  })
  after(async () => {
    await browser?.close()
    server?.closeAllConnections()
    await new Promise(resolve => server ? server.close(resolve) : resolve())
  })


  async function setup(t, { antoine = false, mobile = false, failCriteriaSave = false, tab = 'file' } = {}) {
    const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1360, height: 1000 } })
    t.after(() => ctx.close())
    const page = await ctx.newPage()
    const errors = [], mutations = []
    page.on('pageerror', e => errors.push(e.message))
    t.after(() => assert.deepEqual(errors, []))
    // Le compte d’Antoine et un autre admin doivent voir exactement la même page.
    const user = { id: 'test', name: 'Antoine Lambert', role: 'admin', email: antoine ? 'antoine.lambert96@gmail.com' : 'other@example.test' }
    const token = `test.${Buffer.from(JSON.stringify(user)).toString('base64')}.test`
    await ctx.addInitScript(token => localStorage.setItem('erp_token', token), token)
    let accepted = false
    let criteria = 'Priorité à la fiabilité.'
    await page.route('**/api/**', async route => {
      const req = route.request()
      const url = new URL(req.url())
      const endpoint = url.pathname.replace(/^.*\/api/, '')
      if (endpoint === '/auth/me') return route.fulfill({ json: user })
      if (endpoint === '/travaux/review-settings') {
        if (req.method() === 'PUT') {
          mutations.push({ endpoint, body: req.postDataJSON() })
          if (failCriteriaSave) return route.fulfill({ status: 503, json: { error: 'Échec sauvegarde' } })
          await new Promise(resolve => setTimeout(resolve, 100))
          criteria = req.postDataJSON().criteria.trim()
        }
        return route.fulfill({ json: { criteria, defaultCriteria: 'Bugs et fiabilité', maxLength: 4000 } })
      }
      if (req.method() !== 'GET') {
        mutations.push({ endpoint, body: req.postDataJSON(), criteriaAtLaunch: criteria })
        if (endpoint === '/travaux/suggestions/review-1/accept') accepted = true
        return route.fulfill({ json: { ok: true, id: 'created' } })
      }
      if (endpoint === '/travaux/cpu') return route.fulfill({ json: { percent: 12, cores: 2, load: [0.2, 0.2, 0.2] } })
      if (endpoint === '/travaux/code-stats') return route.fulfill({ json: { files: 10, lines: 1000, history: [] } })
      if (endpoint === '/travaux/recurring') return route.fulfill({ json: { tasks: [], week: null, weeks: [] } })
      if (endpoint === '/travaux/prompts') return route.fulfill({ json: { prompts: [], queue_paused: false } })
      if (endpoint === '/travaux/suggestions') {
        assert.equal(url.searchParams.get('source'), null)
        return route.fulfill({ json: { suggestions: accepted ? [] : [{ id: 'review-1', title: '[P2] Vérifier les dates', rationale: 'Revue statique · fichier:12', prompt: 'Vérifier la date avant enregistrement.', status: 'new', kind: 'chantier', area: 'technique' }] } })
      }
      if (endpoint.endsWith('/messages')) return route.fulfill({ json: { messages: [] } })
      if (endpoint === '/agent/settings') return route.fulfill({ json: { enabled: true } })
      if (endpoint.startsWith('/bootstrap')) return route.fulfill({ json: { tables: {}, snapshot_ts: new Date().toISOString() } })
      if (endpoint.includes('/preferences')) return route.fulfill({ json: {} })
      return route.fulfill({ json: { data: [], total: 0 } })
    })
    await page.goto(`${base}/travaux?onglet=${tab}`)
    return { page, mutations }
  }

  for (const antoine of [false, true]) {
    test(`compte ${antoine ? 'd’Antoine' : 'autre admin'} : quatre onglets et les commandes`, async t => {
      const { page } = await setup(t, { antoine, tab: 'recurrents' })
      const tabs = page.getByRole('navigation', { name: 'Sections des travaux' }).getByRole('button')
      await tabs.first().waitFor()
      assert.equal(await tabs.count(), 4)
      assert.equal(await page.getByRole('button', { name: 'Travaux récurrents', exact: true }).count(), 1)
      await page.getByRole('button', { name: 'Suggestions de Claude', exact: true }).click()
      await page.waitForURL(/onglet=suggestions$/)
      await page.getByRole('button', { name: 'Intégrations', exact: true }).waitFor()
      await page.getByText('[P2] Vérifier les dates', { exact: true }).waitFor()
      assert.equal(await page.getByTestId('suggestion-accept-first').count(), 1)
    })
  }

  test('mobile : acceptation d’une suggestion et génération', async t => {
    const { page, mutations } = await setup(t, { mobile: true, tab: 'suggestions' })
    await page.getByText('[P2] Vérifier les dates', { exact: true }).waitFor()
    await page.getByTestId('suggestion-accept-last').click()
    await page.getByTestId('suggestions-empty').waitFor()
    assert.equal(mutations[0].endpoint, '/travaux/suggestions/review-1/accept')
    assert.equal(mutations[0].body.space, 'finance')
    await Promise.all([page.waitForResponse(r => r.url().includes('/suggestions/generate')), page.getByRole('button', { name: 'Générer maintenant', exact: true }).click()])
    assert.equal(mutations.at(-1).body.source, undefined)
  })

  test('critères enregistrés avant analyse et conservés au rechargement', async t => {
    const { page, mutations } = await setup(t, { tab: 'suggestions' })
    const field = page.getByLabel('Critères d’analyse', { exact: true })
    await field.fill('Simplifier les formulaires. Ignorer les couleurs.')
    await Promise.all([
      page.waitForResponse(r => r.url().includes('/suggestions/generate')),
      page.getByRole('button', { name: 'Générer maintenant', exact: true }).click(),
    ])
    const run = mutations.find(m => m.endpoint === '/travaux/suggestions/generate')
    assert.equal(run.criteriaAtLaunch, 'Simplifier les formulaires. Ignorer les couleurs.')
    assert.equal(mutations[0].endpoint, '/travaux/review-settings')
    await page.reload()
    await page.waitForFunction(() => document.querySelector('#app-review-criteria')?.value === 'Simplifier les formulaires. Ignorer les couleurs.')
  })

  test('sauvegarde en échec : conserver la saisie et ne pas lancer avec les anciens critères', async t => {
    const { page, mutations } = await setup(t, { tab: 'suggestions', failCriteriaSave: true })
    const field = page.getByLabel('Critères d’analyse', { exact: true })
    await field.fill('Accessibilité uniquement.')
    await page.getByRole('button', { name: 'Générer maintenant', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Critères non enregistrés : Échec sauvegarde' }).waitFor()
    assert.equal(await field.inputValue(), 'Accessibilité uniquement.')
    assert.equal(mutations.some(m => m.endpoint === '/travaux/suggestions/generate'), false)
  })

})
