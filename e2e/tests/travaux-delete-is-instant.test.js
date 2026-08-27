// Travaux — la corbeille retire la carte instantanément et définitivement.
//
// Signalement : dans la vue « Conversations », cliquer la corbeille laissait la
// carte à l'écran une bonne seconde, et il arrivait qu'elle revienne ensuite.
// Deux causes : la réponse de la file pèse ~285 Ko (tout l'historique et ses
// fils) et on attendait le DELETE **puis** ce rechargement avant de retirer la
// ligne ; et un chargement parti AVANT la suppression, arrivé après, la remettait
// à l'écran.
//
// Vérifie :
//   1. DELETE ralenti (1,5 s), liste ralentie (6 s), et un chargement de liste
//      lancé AVANT le clic : la carte disparaît en moins de 1,2 s (donc avant
//      toute réponse du serveur) et ne réapparaît pas quand ces réponses en
//      retard arrivent. Suppression bien enregistrée côté serveur.
//   2. Si le DELETE échoue (500), la carte revient et l'item reste côté serveur —
//      pas de disparition mensongère.
//
// L'agent est forcé OFF (capturé/restauré en after()) : les items créés sont
// « de côté » puis « annulés », rien ne s'exécute. Cleanup en after().

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

const STAMP = Date.now()
const MARKER_OK = `E2E corbeille instantanee ${STAMP}`
const MARKER_FAIL = `E2E corbeille echec ${STAMP}`

// Ralentissements pilotés depuis les tests. Les routes sont posées une fois pour
// toutes : les retirer en cours de route ferait échouer les handlers encore en
// sommeil (leur `continue()` arrive alors sur une route déjà relâchée).
const net = { listDelay: 0, deleteDelay: 0, deleteFails: false }

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

async function installRoutes(page) {
  // `*` ne traverse pas le `/` : le premier glob ne voit que la liste, le second
  // que `/prompts/:id`.
  await page.route('**/api/travaux/prompts*', async route => {
    if (route.request().method() === 'GET' && net.listDelay) {
      await new Promise(r => setTimeout(r, net.listDelay))
    }
    try { await route.continue() } catch { /* page/route déjà relâchée */ }
  })
  await page.route('**/api/travaux/prompts/*', async route => {
    if (route.request().method() === 'DELETE') {
      if (net.deleteDelay) await new Promise(r => setTimeout(r, net.deleteDelay))
      if (net.deleteFails) {
        try {
          await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom E2E' }) })
        } catch { /* idem */ }
        return
      }
    }
    try { await route.continue() } catch { /* idem */ }
  })
}

async function api(page, method, p, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: body ? JSON.stringify(body) : undefined,
    })
    return r.json()
  }, { method, path: p, body })
}

// Item jetable, terminé (« annulé ») : il apparaît dans la vue Conversations et
// l'ordonnanceur ne le reprendra jamais.
async function makeFinishedPrompt(page, title) {
  const created = await api(page, 'POST', '/travaux/prompts', {
    prompt: `${title} — corps du prompt de test, ne pas exécuter.`,
    title,
    status: 'paused',
  })
  assert.ok(created.id, `création de l'item de test « ${title} »`)
  await api(page, 'PATCH', `/travaux/prompts/${created.id}`, { status: 'cancelled' })
  return created.id
}

// Ouvre la vue Conversations et isole l'item de test (l'historique est paginé).
async function showInConversations(page, promptId, marker) {
  await page.goto(URL + '/travaux', { waitUntil: 'networkidle' })
  await page.click('[data-testid="travaux-view-conversations"]')
  await page.fill('[data-testid="travaux-search"]', marker)
  const card = page.locator(`[data-prompt-id="${promptId}"]`)
  await card.waitFor({ timeout: 15000 })
  return card
}

describe('Travaux — la corbeille retire la carte instantanément', () => {
  let browser, ctx, page
  let originalEnabled = false
  let okId = null
  let failId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
    const s = await api(page, 'GET', '/agent/settings')
    originalEnabled = !!s.enabled
    await api(page, 'PUT', '/agent/settings', { enabled: false })
    okId = await makeFinishedPrompt(page, MARKER_OK)
    failId = await makeFinishedPrompt(page, MARKER_FAIL)
    await installRoutes(page)
  })

  after(async () => {
    net.listDelay = 0; net.deleteDelay = 0; net.deleteFails = false
    for (const id of [okId, failId]) {
      try { if (id) await api(page, 'DELETE', `/travaux/prompts/${id}`) } catch {}
    }
    try { await api(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('serveur lent : la carte part en moins de 1,2 s et ne revient pas', async () => {
    const card = await showInConversations(page, okId, MARKER_OK)

    net.listDelay = 6000
    net.deleteDelay = 1500

    // Chargement de liste parti AVANT le clic : il répondra APRÈS la suppression,
    // avec la carte encore dedans. C'est lui qui la remettait à l'écran.
    await page.evaluate(() => window.dispatchEvent(new Event('travaux:prompts:updated')))
    await page.waitForTimeout(400)

    const t0 = Date.now()
    await card.locator('[data-testid="travaux-delete"]').click()
    await card.waitFor({ state: 'detached', timeout: 1200 })
    const elapsed = Date.now() - t0
    assert.ok(elapsed < 1200,
      `la carte doit disparaître avant la réponse du serveur (mesuré ${elapsed} ms)`)

    // Le chargement en retard, puis celui qui suit la suppression, finissent par
    // arriver : la carte ne doit réapparaître ni pour l'un ni pour l'autre.
    await page.waitForTimeout(9000)
    assert.equal(await card.count(), 0, 'la carte ne revient pas après les rechargements en retard')

    // Et la suppression a bien été enregistrée côté serveur.
    net.listDelay = 0
    net.deleteDelay = 0
    const list = await api(page, 'GET', '/travaux/prompts')
    assert.ok(!(list.prompts || []).some(p => p.id === okId), 'item supprimé côté serveur')
    okId = null
  })

  test('DELETE en erreur : la carte revient et l\'item reste côté serveur', async () => {
    const card = await showInConversations(page, failId, MARKER_FAIL)

    net.deleteFails = true
    await card.locator('[data-testid="travaux-delete"]').click()
    // Disparition optimiste, puis retour de la carte quand l'échec est connu.
    await card.waitFor({ state: 'detached', timeout: 2000 })
    net.deleteFails = false
    await card.waitFor({ state: 'attached', timeout: 15000 })

    const list = await api(page, 'GET', '/travaux/prompts')
    assert.ok((list.prompts || []).some(p => p.id === failId), 'item non supprimé après échec')
  })
})
