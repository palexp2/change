// Travaux → carnet d'idées : changer l'ordre des idées.
//
// Couvre les deux affordances : les flèches monter / descendre (déjà là) et le
// glisser-déposer par la poignée (DragEvents HTML5 dispatchés à la main, comme
// travaux-queue-reorder).
//
// Sécurité : le test crée ses trois propres idées (titres horodatés) et ne
// déplace qu'elles. La route /ideas/reorder renumérote toutefois les positions
// de TOUTES les idées envoyées : l'ordre complet est donc capturé avant, puis
// restauré dans after(), en plus de la suppression des trois idées de test.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()

describe('Travaux — ordre du carnet d\'idées', () => {
  let browser, ctx, page
  const ids = {}          // A / B / C → id
  let originalOrder = []  // ordre (ids) de toutes les idées avant le test

  const apiFetch = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const opts = { method, headers: { Authorization: `Bearer ${tok}` } }
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
    const r = await fetch('/erp/api' + path, opts)
    return r.json()
  }, { method, path, body })

  // Ordre de mes trois idées tel que le serveur les renvoie.
  const serverOrder = async () => {
    const { ideas } = await apiFetch('GET', '/travaux/ideas')
    return ideas.map(i => i.id).filter(id => Object.values(ids).includes(id))
  }

  // Même ordre, mais tel qu'affiché (les cartes portent data-idea-id).
  const domOrder = () => page.locator('[data-idea-id]').evaluateAll((els, mine) =>
    els.map(el => el.getAttribute('data-idea-id')).filter(id => mine.includes(id)),
  Object.values(ids))

  const waitDom = (expected) => page.waitForFunction(({ expected, mine }) => {
    const shown = [...document.querySelectorAll('[data-idea-id]')]
      .map(el => el.getAttribute('data-idea-id')).filter(id => mine.includes(id))
    return shown.join(',') === expected.join(',')
  }, { expected, mine: Object.values(ids) }, { timeout: 10000 })

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Photo de l'ordre existant, pour le remettre tel quel en fin de test.
    originalOrder = (await apiFetch('GET', '/travaux/ideas')).ideas.map(i => i.id)

    for (const k of ['A', 'B', 'C']) {
      const created = await apiFetch('POST', '/travaux/ideas', { title: `E2E ordre ${k} ${STAMP}` })
      ids[k] = created.id
      assert.ok(ids[k], `création de l'idée ${k}`)
    }
  })

  after(async () => {
    if (page) {
      for (const id of Object.values(ids)) {
        await apiFetch('DELETE', `/travaux/ideas/${id}`).catch(() => {})
      }
      // Restaure l'ordre d'avant le test (le test a renuméroté les positions).
      if (originalOrder.length) {
        await apiFetch('POST', '/travaux/ideas/reorder', { ids: originalOrder }).catch(() => {})
      }
    }
    await browser?.close()
  })

  test('chaque idée porte une poignée de glissement et ses deux flèches', async () => {
    await page.goto(URL + '/travaux?onglet=idees', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`[data-idea-id="${ids.A}"]`, { timeout: 15000 })

    // Ordre de création = ordre d'affichage au départ.
    assert.deepEqual(await domOrder(), [ids.A, ids.B, ids.C], 'ordre initial')

    const card = page.locator(`[data-idea-id="${ids.B}"]`)
    assert.equal(await card.locator('[data-testid="idea-drag-handle"]').count(), 1, 'poignée de glissement absente')
    assert.equal(await card.getByTestId('idea-move-up').count(), 1, 'flèche monter absente')
    assert.equal(await card.getByTestId('idea-move-down').count(), 1, 'flèche descendre absente')
    assert.equal(await card.locator('[data-testid="idea-drag-handle"]').getAttribute('draggable'), 'true',
      'la poignée doit être réellement draggable')
  })

  test('glisser une idée par sa poignée change son rang et le persiste', async () => {
    // C (dernière) déposée AVANT A (première des miennes) → C, A, B.
    await page.evaluate(({ source, target }) => {
      const handle = document.querySelector(`[data-idea-id="${source}"] [data-testid="idea-drag-handle"]`)
      const dst = document.querySelector(`[data-idea-id="${target}"]`)
      const dt = new DataTransfer()
      handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      const rect = dst.getBoundingClientRect()
      // clientY près du haut → le handler retient le côté « before ».
      for (const type of ['dragover', 'drop']) {
        dst.dispatchEvent(new DragEvent(type, {
          bubbles: true, cancelable: true, dataTransfer: dt,
          clientX: rect.left + 20, clientY: rect.top + 2,
        }))
      }
      handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
    }, { source: ids.C, target: ids.A })

    await waitDom([ids.C, ids.A, ids.B])
    assert.deepEqual(await serverOrder(), [ids.C, ids.A, ids.B], 'ordre après glissement non persisté')

    // L'ordre survit à un rechargement complet (il vient de la DB, pas de l'écran).
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`[data-idea-id="${ids.A}"]`, { timeout: 15000 })
    assert.deepEqual(await domOrder(), [ids.C, ids.A, ids.B], 'ordre perdu au rechargement')
  })

  test('déposer sous une carte insère juste après elle', async () => {
    // C déposée APRÈS B (dernière) → A, B, C.
    await page.evaluate(({ source, target }) => {
      const handle = document.querySelector(`[data-idea-id="${source}"] [data-testid="idea-drag-handle"]`)
      const dst = document.querySelector(`[data-idea-id="${target}"]`)
      const dt = new DataTransfer()
      handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      const rect = dst.getBoundingClientRect()
      // clientY près du bas → côté « after ».
      for (const type of ['dragover', 'drop']) {
        dst.dispatchEvent(new DragEvent(type, {
          bubbles: true, cancelable: true, dataTransfer: dt,
          clientX: rect.left + 20, clientY: rect.bottom - 2,
        }))
      }
      handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
    }, { source: ids.C, target: ids.B })

    await waitDom([ids.A, ids.B, ids.C])
    assert.deepEqual(await serverOrder(), [ids.A, ids.B, ids.C], 'ordre après second glissement non persisté')
  })

  test('les flèches continuent de fonctionner', async () => {
    await page.locator(`[data-idea-id="${ids.C}"]`).getByTestId('idea-move-up').click()
    await waitDom([ids.A, ids.C, ids.B])
    assert.deepEqual(await serverOrder(), [ids.A, ids.C, ids.B], 'flèche monter non persistée')

    await page.locator(`[data-idea-id="${ids.C}"]`).getByTestId('idea-move-down').click()
    await waitDom([ids.A, ids.B, ids.C])
    assert.deepEqual(await serverOrder(), [ids.A, ids.B, ids.C], 'flèche descendre non persistée')
  })
})
