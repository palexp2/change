// Travaux (Espace finance, /travaux) — bouton « Voir la page » dans la section
// Conversation.
//
// Le bouton « Voir la page », déjà présent sur les cartes de tâche terminée de
// /agent, n'apparaissait jamais dans la file de prompts de /travaux : l'API
// /api/travaux/prompts ne renvoyait pas `context`/`agent_result` de la tâche
// liée, et la carte (PromptRow) ne montait pas <PageLink>. Ce test vérifie que
// la file « Ma file de prompts » de /travaux affiche bien ce bouton sur au
// moins une conversation terminée, avec un lien de navigation valide.
//
// Vérification en LECTURE SEULE sur des enregistrements réels déjà en base
// (aucune tâche n'est créée ni modifiée par ce test — voir CLAUDE.md : ne
// jamais muter un vrai record en E2E). Connexion via un JWT signé directement
// (compte claude@orisha.io) — voir server/src/middleware/auth.js.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const crypto = require('node:crypto')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) throw new Error('JWT_SECRET env var required (voir server/.env)')
const CLAUDE_USER_ID = '6c016118-aa19-45dc-9d90-0fb9ee26122e' // claude@orisha.io

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function signHS256(payload, secret) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${header}.${body}.${signature}`
}

function apiFetch(page, method, p) {
  return page.evaluate(async ({ method, path }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api' + path, { method, headers: { Authorization: `Bearer ${tok}` } })
    return r.json()
  }, { method, path: p })
}

describe('Travaux — « Voir la page » sur une conversation terminée', () => {
  let browser, ctx, page

  before(async () => {
    const token = signHS256({ id: CLAUDE_USER_ID, role: 'admin', name: 'Claude', exp: Math.floor(Date.now() / 1000) + 7200 }, JWT_SECRET)
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.evaluate(t => localStorage.setItem('erp_token', t), token)
  })

  after(async () => {
    // Rien n'est créé ni modifié par ce test (vérification en lecture seule
    // sur des enregistrements réels) — rien à nettoyer.
    await browser?.close()
  })

  test('l\'API expose context/agent_result et au moins une carte terminée porte le lien', async () => {
    // 1) L'API doit désormais transporter de quoi résoudre la page (avant le
    //    correctif, ces deux champs étaient absents de la réponse).
    const data = await apiFetch(page, 'GET', '/travaux/prompts?space=finance')
    const done = data.prompts.filter(p => p.status === 'done')
    assert.ok(done.length > 0, 'au moins une conversation terminée doit exister dans l\'espace finance (données réelles)')
    assert.ok(done.some(p => 'agent_result' in p), 'agent_result doit être exposé par /api/travaux/prompts')
    assert.ok(done.some(p => 'context' in p), 'context doit être exposé par /api/travaux/prompts')

    // 2) La carte correspondante, dans l'UI réelle, doit porter le bouton — dans
    //    la sous-vue « Conversations » (l'historique), pas la file active.
    await page.goto(URL + '/travaux', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Ma file de prompts', { timeout: 10000 })
    await page.click('[data-testid="travaux-view-conversations"]')
    await page.waitForSelector('[data-prompt-id]', { timeout: 10000 })

    const link = page.locator('[data-testid="card-page-link"]').first()
    await link.waitFor({ timeout: 10000 })
    const href = await link.getAttribute('href')
    assert.ok(href && href.startsWith('/erp/'), `lien « Voir la page » attendu vers une route de l'app, obtenu : ${href}`)
    assert.equal(await link.getAttribute('target'), '_blank', 'le lien doit s\'ouvrir dans un nouvel onglet')
  })
})
