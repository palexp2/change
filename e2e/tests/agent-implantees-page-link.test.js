// /agent — lien « Voir la page » sur les cartes de la colonne « Implantées ».
//
// Le lien existait déjà, mais il n'apparaissait que si la tâche portait une
// route dans sa colonne `context` (ou si son rapport ne citait qu'une seule
// page). Or les demandes déposées par le FAB « Modifier le système » collent
// leur contexte À LA FIN du prompt (« …\n\nContexte (ERP) : /factures »), en
// laissant `context` vide : leurs cartes n'offraient aucun lien. <PageLink> lit
// désormais aussi ce contexte embarqué dans le texte de la demande.
//
// Vérification en LECTURE SEULE sur des enregistrements réels déjà en base
// (aucune tâche n'est créée ni modifiée — voir CLAUDE.md : ne jamais muter un
// vrai record en E2E). Connexion via un JWT signé directement (compte
// claude@orisha.io) — voir server/src/middleware/auth.js.

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

function apiGet(page, p) {
  return page.evaluate(async path => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api' + path, { headers: { Authorization: `Bearer ${tok}` } })
    return r.json()
  }, p)
}

// Même lecture que <PageLink> côté front, refaite ici sur les données brutes de
// l'API pour désigner une carte dont le lien ne peut venir QUE du contexte
// embarqué dans le texte de la demande.
const SEP = / — (?:éléments? cibl[ée]s? par l'utilisateur|fiche affichée)/
function contextPage(c) {
  if (!c) return ''
  const i = c.search(SEP)
  return (i === -1 ? c : c.slice(0, i)).trim()
}
function routeFromContext(c) {
  if (!c || c.startsWith('Demande concernant l\'ensemble de l\'application')) return null
  const p = contextPage(c)
  return p.startsWith('/') ? p : null
}

describe('/agent — « Voir la page » sur les demandes implantées', () => {
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
    // Rien n'est créé ni modifié (lecture seule sur des records réels).
    await browser?.close()
  })

  test('une demande dont le contexte n\'est que dans son texte porte le lien vers sa page', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'domcontentloaded' })
    const [tasks, backlog] = await Promise.all([
      apiGet(page, '/agent/tasks'),
      apiGet(page, '/agent/backlog'),
    ])

    // Reconstitution de la colonne « Implantées » : fiches de backlog terminées
    // + tâches issues de la file de prompts.
    const linked = new Set(backlog.map(i => i.task_id).filter(Boolean))
    const byId = new Map(tasks.map(t => [t.id, t]))
    const implantees = [
      ...backlog.map(i => (i.task_id ? byId.get(i.task_id) : null)).filter(Boolean),
      ...tasks.filter(t => t.work_prompt_id && !linked.has(t.id)),
    ].filter(t => t.status === 'done')

    // Cible : contexte absent de la colonne `context`, mais présent dans le texte.
    const target = implantees
      .map(t => {
        const m = String(t.description || '').match(/Contexte \(ERP\)\s*:\s*([^\n]+)/)
        return { task: t, route: m ? routeFromContext(m[1].trim()) : null }
      })
      .find(x => x.route && !routeFromContext(x.task.context))

    assert.ok(target, 'au moins une demande implantée doit porter son contexte dans son texte (données réelles)')

    await page.waitForSelector('[data-testid="col-implantees"]', { timeout: 20000 })
    const card = page.locator(`[data-testid="col-implantees"] [data-task-id="${target.task.id}"]`)
    await card.waitFor({ timeout: 15000 })

    const link = card.locator('[data-testid="card-page-link"]')
    await link.waitFor({ timeout: 10000 })
    assert.equal(await link.getAttribute('href'), '/erp' + target.route,
      'le lien doit mener à la page d\'où la demande a été signalée')
    assert.equal(await link.getAttribute('target'), '_blank', 'le lien doit s\'ouvrir dans un nouvel onglet')
  })

  test('le lien est présent sur une large part des cartes implantées et reste navigable', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="col-implantees"] [data-testid="suggestion-card"]', { timeout: 20000 })
    const cards = await page.locator('[data-testid="col-implantees"] [data-testid="suggestion-card"]').count()
    const links = await page.locator('[data-testid="col-implantees"] [data-testid="card-page-link"]').count()
    assert.ok(cards > 0, 'la colonne « Implantées » doit contenir des cartes')
    assert.ok(links / cards > 0.6, `le lien doit couvrir la majorité des cartes (obtenu ${links}/${cards})`)

    // Le lien navigue vraiment : la page cible s'ouvre sans erreur d'application.
    const first = page.locator('[data-testid="col-implantees"] [data-testid="card-page-link"]').first()
    const href = await first.getAttribute('href')
    assert.ok(href && href.startsWith('/erp/'), `lien attendu vers une route de l'app, obtenu : ${href}`)
    await page.goto('http://localhost:3004' + href, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('main', { timeout: 15000 })
    assert.equal(await page.locator('text=Une erreur est survenue').count(), 0,
      'la page cible doit s\'afficher sans écran d\'erreur')
  })
})
