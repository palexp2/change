// Travaux — écrire à Claude PENDANT qu'une tâche s'exécute (steering).
//
// Comme dans l'interface de Claude Code : un message envoyé en plein milieu d'une
// exécution est livré à l'agent sans rien interrompre. Côté UI, la carte « En
// cours » (et « En attente ») porte un composeur dédié une fois dépliée ; ce test
// vérifie son rendu et le POST qu'il émet. Il n'y a plus de raccourci d'envoi sur
// la ligne repliée (retiré à la demande) — on déplie la carte.
//
// La liste ET l'envoi sont INTERCEPTÉS pour les tests UI : rien n'est écrit en
// base et aucun message n'atteint une vraie exécution. Le dernier test exerce la
// vraie route sur un prompt « de côté » (jamais ramassé par l'ordonnanceur) pour
// vérifier le garde-fou 409, puis le supprime (after()).
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const BASE = {
  prompt: 'Refactore la page des achats.',
  position: 1,
  mode: 'implement',
  preset: 'deep',
  same_context: 0,
  title_auto: 0,
  stop_after: 0,
  created_at: '2026-08-05T00:00:00.000Z',
  started_at: '2026-08-05T00:01:00.000Z',
  completed_at: null,
  user_summary: null,
  pending_question: null,
  wait_rank: null,
  lane: 'exec',
  messages: [],
}
const EXECUTING = {
  ...BASE,
  id: 'e2e-steer-executing',
  title: 'E2E steering — en cours',
  status: 'running',
  agent_status: 'in_progress',
  run_state: 'executing',
}
const WAITING = {
  ...BASE,
  id: 'e2e-steer-waiting',
  title: 'E2E steering — en attente',
  status: 'running',
  agent_status: 'approved',
  run_state: 'waiting',
  wait_rank: 2,
}

describe('Travaux — message à Claude en cours de tâche', () => {
  let browser, ctx, page
  let steerBody = null
  let steerUrl = null
  let realPromptId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Liste factice : une carte en cours d'exécution, une en attente de poste.
    await page.route('**/api/travaux/prompts*', async (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            prompts: [EXECUTING, WAITING], agent_enabled: true, runner_busy: true,
            queue_paused: false, running_questions: 0, max_parallel_questions: 2,
          }),
        })
      }
      return route.continue()
    })
    // L'envoi est capturé puis court-circuité : le vrai POST écrirait un message en
    // base et déposerait une inbox de steering pour une tâche inexistante.
    await page.route('**/api/travaux/prompts/*/message', async (route) => {
      steerBody = route.request().postDataJSON()
      steerUrl = route.request().url()
      await route.fulfill({
        status: 201, contentType: 'application/json',
        body: JSON.stringify({ ...EXECUTING, delivered: 'live' }),
      })
    })
  })

  after(async () => {
    // Prompt réel du test de garde-fou : créé « de côté », jamais exécuté — on le retire.
    if (page && realPromptId) {
      await page.evaluate(async (id) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/travaux/prompts/${id}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {})
      }, realPromptId)
    }
    await browser?.close()
  })

  test('la carte en cours d\'exécution offre le composeur de steering', async () => {
    await page.goto(URL + '/travaux', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Travaux")', { timeout: 10000 })

    const card = page.locator('[data-prompt-id="e2e-steer-executing"]')
    await card.waitFor({ timeout: 10000 })
    // Plus de raccourci dédié sur la ligne repliée (retiré) : on déplie la carte.
    assert.equal(await card.locator('[data-testid="travaux-steer"]').count(), 0,
      'la ligne repliée ne porte plus de bouton de steering')
    await card.locator('[data-testid="travaux-toggle"]').click()
    const input = card.locator('[data-testid="travaux-steer-input"]')
    await input.waitFor({ timeout: 5000 })
    // La consigne dit bien que rien ne sera interrompu.
    await assert.doesNotReject(
      card.locator('text=sans interrompre le travail').first().waitFor({ timeout: 5000 }))
  })

  test('envoyer poste le message sur la route de steering (pas la relance)', async () => {
    steerBody = null
    const card = page.locator('[data-prompt-id="e2e-steer-executing"]')
    await card.locator('[data-testid="travaux-steer-input"]').fill('Pense aussi aux factures en USD')
    await card.locator('[data-testid="travaux-steer-send"]').click()
    for (let i = 0; i < 20 && !steerBody; i++) await new Promise(r => setTimeout(r, 200))
    assert.ok(steerBody, 'l\'envoi doit émettre un POST')
    assert.equal(steerBody.text, 'Pense aussi aux factures en USD')
    assert.match(steerUrl, /\/prompts\/e2e-steer-executing\/message$/,
      'le message part sur la route de steering de la bonne carte')
  })

  test('la carte en attente offre aussi le composeur, avec la consigne « au départ »', async () => {
    const card = page.locator('[data-prompt-id="e2e-steer-waiting"]')
    await card.locator('[data-testid="travaux-toggle"]').click()
    await card.locator('[data-testid="travaux-steer-input"]').waitFor({ timeout: 5000 })
    await assert.doesNotReject(
      card.locator('text=intégré au brief').first().waitFor({ timeout: 5000 }))
  })

  test('garde-fou réel : steering refusé (409) sur une tâche qui ne tourne pas', async () => {
    // Vraie route, vrai prompt — créé « de côté » (paused) : l'ordonnanceur ne le
    // ramasse jamais, aucune exécution ne démarre. L'interception des tests UI est
    // levée d'abord, sinon elle capturerait aussi cet appel réel.
    await page.unroute('**/api/travaux/prompts/*/message')
    const out = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const created = await (await fetch('/erp/api/travaux/prompts', {
        method: 'POST', headers: H,
        body: JSON.stringify({ title: 'E2E steering garde-fou', prompt: 'Ne jamais exécuter.', status: 'paused' }),
      })).json()
      const resp = await fetch(`/erp/api/travaux/prompts/${created.id}/message`, {
        method: 'POST', headers: H, body: JSON.stringify({ text: 'trop tard ?' }),
      })
      return { id: created.id, status: resp.status, body: await resp.json() }
    })
    realPromptId = out.id
    assert.equal(out.status, 409, 'une carte qui ne tourne pas refuse le steering')
    assert.match(out.body.error, /Répondre et relancer/)
  })
})
