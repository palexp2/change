// Suggestions de Claude (/travaux, onglet « Suggestions de Claude ») : chaque carte,
// chantier comme intégration, porte un fil de discussion pour en savoir plus AVANT
// de décider. Rien ne part en exécution par ce chemin.
//
// Sécurité : la suggestion créée est jetable (titre horodaté) et supprimée dans le
// hook after(). Le seul appel réel au modèle est celui du dernier test (une question
// courte, sans outils, hors slot d'exécution) — il n'écrit rien dans le repo.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Travaux — discuter d\'une suggestion avec Claude', () => {
  let browser, ctx, page
  const stamp = Date.now()
  let suggestionId = null

  const api = (fn, arg) => page.evaluate(fn, arg)

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    const created = await api(async (stamp) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/travaux/suggestions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `E2E discussion intégration ${stamp}`,
          rationale: 'Suggestion jetable créée par un test E2E.',
          prompt: 'Ne rien faire — suggestion de test E2E.',
          area: 'technique',
          kind: 'integration',
        }),
      })
      return r.json()
    }, stamp)
    suggestionId = created.id
    if (!suggestionId) throw new Error('création de la suggestion de test impossible : ' + JSON.stringify(created))
  })

  after(async () => {
    if (page && suggestionId) {
      await api(async (id) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/travaux/suggestions/${id}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {})
      }, suggestionId)
    }
    await browser?.close()
  })

  // Repère la carte de NOTRE suggestion (le titre horodaté est unique).
  const card = () => page.locator('.rounded-xl', { hasText: `E2E discussion intégration ${stamp}` }).last()

  async function openSuggestionsTab() {
    await page.goto(URL + '/travaux?onglet=suggestions', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`text=E2E discussion intégration ${stamp}`, { timeout: 20000 })
  }

  test('le fil d\'une suggestion est vide au départ, et une question vide est refusée', async () => {
    const out = await api(async (id) => {
      const token = localStorage.getItem('erp_token')
      const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const r = await fetch(`/erp/api/travaux/suggestions/${id}/messages`, { headers: H })
      const empty = await r.json()
      const bad = await fetch(`/erp/api/travaux/suggestions/${id}/messages`, {
        method: 'POST', headers: H, body: JSON.stringify({ text: '   ' }),
      })
      const missing = await fetch('/erp/api/travaux/suggestions/inexistant-xyz/messages', { headers: H })
      return { empty, badStatus: bad.status, missingStatus: missing.status }
    }, suggestionId)

    assert.deepEqual(out.empty.messages, [], 'aucun message au départ')
    assert.equal(out.empty.pending, false, 'aucune réponse en vol au départ')
    assert.equal(out.badStatus, 400, 'une question vide doit être refusée')
    assert.equal(out.missingStatus, 404, 'une suggestion inconnue doit rendre 404')
  })

  test('la carte offre « Discuter avec Claude » et affiche la question puis la réponse', async () => {
    await openSuggestionsTab()
    const c = card()
    const toggle = c.getByTestId('suggestion-chat-toggle')
    await toggle.waitFor({ timeout: 10000 })
    assert.ok((await toggle.innerText()).includes('Discuter avec Claude'), 'libellé du bouton de discussion')
    await toggle.click()
    await c.getByTestId('suggestion-chat').waitFor({ timeout: 10000 })

    // L'envoi est intercepté : ce test valide l'affichage du fil, pas l'appel
    // réel au modèle (couvert par le test suivant) — aucun process Claude ici.
    const now = new Date().toISOString()
    const userMsg = { id: 'stub-user', suggestion_id: suggestionId, role: 'user', text: 'Ça coûte combien ?', created_at: now }
    const agentMsg = { id: 'stub-agent', suggestion_id: suggestionId, role: 'agent', text: 'Environ 20 $ par mois, à vérifier.', created_at: now }
    await page.route(`**/api/travaux/suggestions/${suggestionId}/messages`, async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ messages: [userMsg], pending: true }) })
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [userMsg, agentMsg], pending: false }) })
    })

    await c.getByTestId('suggestion-chat-input').fill('Ça coûte combien ?')
    await c.getByTestId('suggestion-chat-send').click()

    await c.getByTestId('suggestion-chat-thread').waitFor({ timeout: 10000 })
    assert.ok((await c.getByTestId('suggestion-chat-thread').innerText()).includes('Ça coûte combien ?'),
      'la question de l\'utilisateur doit apparaître dans le fil')
    await c.getByTestId('suggestion-chat-pending').waitFor({ timeout: 10000 })

    // La réponse arrive de façon asynchrone : le serveur diffuse l'id concerné et
    // la carte recharge son fil. On rejoue exactement cette diffusion.
    await page.evaluate((id) => {
      window.dispatchEvent(new CustomEvent('travaux:suggestion:messages', { detail: { suggestion_id: id } }))
    }, suggestionId)

    await page.waitForFunction((sel) => {
      const el = document.querySelector(sel)
      return el && el.innerText.includes('Environ 20 $ par mois')
    }, '[data-testid="suggestion-chat-thread"]', { timeout: 15000 })
    assert.equal(await c.getByTestId('suggestion-chat-pending').count(), 0,
      'l\'indicateur « Claude réfléchit » disparaît une fois la réponse arrivée')
    await page.unroute(`**/api/travaux/suggestions/${suggestionId}/messages`)
  })

  test('une vraie question reçoit une réponse de Claude, sans rien exécuter', async () => {
    const sent = await api(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/travaux/suggestions/${id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Réponds simplement « test reçu » — question de test E2E.' }),
      })
      return { status: r.status, body: await r.json() }
    }, suggestionId)
    assert.equal(sent.status, 201, 'la question doit être acceptée')
    assert.equal(sent.body.pending, true, 'une réponse est annoncée en préparation')
    assert.equal(sent.body.messages.at(-1).role, 'user', 'la question est enregistrée tout de suite')

    // La réponse est un appel modèle sans outils : long, mais borné côté serveur
    // (un message d'échec est écrit si l'appel rate — le fil se referme toujours).
    const answered = await api(async (id) => {
      const token = localStorage.getItem('erp_token')
      for (let i = 0; i < 90; i++) {
        const r = await fetch(`/erp/api/travaux/suggestions/${id}/messages`, { headers: { Authorization: `Bearer ${token}` } })
        const { messages, pending } = await r.json()
        if (!pending && messages.some(m => m.role === 'agent')) return messages
        await new Promise(res => setTimeout(res, 4000))
      }
      return null
    }, suggestionId)

    assert.ok(answered, 'Claude doit finir par répondre dans le fil')
    assert.equal(answered.at(-1).role, 'agent', 'le dernier message du fil est la réponse')
    assert.ok(answered.at(-1).text.trim().length > 0, 'la réponse ne doit pas être vide')

    // Garde-fou : discuter ne met RIEN dans la file de travaux.
    const promoted = await api(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/travaux/suggestions?status=new', { headers: { Authorization: `Bearer ${token}` } })
      const { suggestions } = await r.json()
      const s = suggestions.find(x => x.id === id)
      return { status: s?.status, workPromptId: s?.work_prompt_id, count: s?.message_count }
    }, suggestionId)
    assert.equal(promoted.status, 'new', 'la suggestion reste « nouvelle » après discussion')
    assert.equal(promoted.workPromptId, null, 'discuter ne crée aucun item de file')
    assert.ok(promoted.count >= 2, 'le fil est compté sur la carte')
  })
})
