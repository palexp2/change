// Journal des nouveautés obligatoire — garde affichée sur /changelog.
//
// Couvre :
//  1. GET /api/changelog/status répond avec la forme attendue.
//  2. La page /changelog affiche le bandeau d'état de la garde, cohérent avec
//     l'API (vert « à jour » / orange « non décrites »).
//  3. L'état violation (mocké côté réseau) rend bien le bandeau orange avec le
//     décompte et le rappel que la livraison est bloquée.
//
// Aucun record DB créé ni muté : la garde est en lecture seule (git + fichier
// versionné). Le seul état touché est localStorage (`erp.changelog.lastSeen`),
// éphémère — il meurt avec le contexte navigateur fermé dans after().

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('Changelog — garde « toute modification est documentée »', () => {
  let browser, ctx, page, apiStatus

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    await browser?.close()
  })

  test('GET /api/changelog/status renvoie l’état de la garde', async () => {
    apiStatus = await page.evaluate(async () => {
      const res = await fetch('/erp/api/changelog/status', {
        headers: { Authorization: `Bearer ${localStorage.getItem('erp_token')}` },
      })
      return { status: res.status, body: await res.json() }
    })

    assert.equal(apiStatus.status, 200, `attendu 200, obtenu ${apiStatus.status}`)
    const b = apiStatus.body
    assert.equal(typeof b.ok, 'boolean')
    assert.equal(typeof b.skipped, 'boolean')
    assert.equal(typeof b.changedCount, 'number')
    assert.ok(Array.isArray(b.changedFiles), 'changedFiles doit être un tableau')
    assert.ok(Array.isArray(b.commits), 'commits doit être un tableau')
    assert.ok(Array.isArray(b.newEntries), 'newEntries doit être un tableau')
    // Si du code a changé sans nouvelle entrée, la garde doit être rouge.
    if (b.changedCount > 0 && b.newEntries.length === 0) assert.equal(b.ok, false)
  })

  test('la page /changelog affiche un bandeau de garde cohérent avec l’API', async () => {
    await page.goto(URL + '/changelog', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Nouveautés")', { timeout: 10000 })

    const banner = page.locator('[data-testid="changelog-guard"]')
    if (apiStatus.body.skipped) {
      assert.equal(await banner.count(), 0, 'hors contexte git : aucun bandeau attendu')
      return
    }

    await banner.waitFor({ state: 'visible', timeout: 10000 })
    const state = await banner.getAttribute('data-state')
    assert.equal(state, apiStatus.body.ok ? 'ok' : 'violation', 'état du bandeau ≠ état API')

    const txt = await banner.innerText()
    if (apiStatus.body.ok) {
      assert.match(txt, /Journal à jour/, `texte inattendu : ${txt}`)
    } else {
      assert.match(txt, /pas encore décrite/, `texte inattendu : ${txt}`)
      assert.match(txt, /obligatoire/, 'le bandeau doit rappeler que le journal est obligatoire')
    }
  })

  test('état « modifications non décrites » : bandeau orange + livraison bloquée', async () => {
    // On force la réponse de l'API (aucune écriture, aucun record touché) pour
    // rendre l'état violation déterministe quel que soit l'état réel du repo.
    await page.route('**/api/changelog/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          skipped: false,
          reason: 'test',
          base: 'abc1234567',
          changedCount: 3,
          changedFiles: ['client/src/pages/Foo.jsx'],
          commits: [{ sha: 'abc1234', subject: 'Sujet de test' }],
          newEntries: [],
          invalidCount: 0,
          latestEntryDate: '2026-08-28',
        }),
      })
    )

    try {
      await page.goto(URL + '/changelog', { waitUntil: 'networkidle' })
      const banner = page.locator('[data-testid="changelog-guard"]')
      await banner.waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await banner.getAttribute('data-state'), 'violation')

      const txt = await banner.innerText()
      assert.match(txt, /3 modifications de l’app ne sont pas encore décrites ici/, `texte inattendu : ${txt}`)
      assert.match(txt, /bloquée/, 'le bandeau doit dire que la livraison est bloquée')

      // Le détail technique est replié derrière « Voir le détail ».
      await page.click('summary:has-text("Voir le détail")')
      await page.waitForSelector('text=Sujet de test', { timeout: 5000 })
    } finally {
      await page.unroute('**/api/changelog/status')
    }
  })
})
