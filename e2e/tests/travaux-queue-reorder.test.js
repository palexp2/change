// Travaux → « Ma file de prompts » : changer la priorité des items en attente.
//
// Couvre les deux affordances : les flèches monter / descendre, et le glisser
// (DragEvents HTML5 dispatchés à la main, comme dashboard-customization-reorder).
//
// Sécurité : les trois items du test sont créés « de côté » (status paused) —
// l'ordonnanceur ne les ramasse JAMAIS, donc aucune exécution réelle de l'agent.
// Ils se classent entre eux (même groupe), en queue de liste, donc le test ne
// déplace aucun vrai item de la file. L'ordre initial complet est tout de même
// capturé puis restauré dans after(), la route /reorder renumérotant les
// positions de tous les items envoyés.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Travaux — priorité dans la file de prompts', () => {
  let browser, ctx, page
  const stamp = Date.now()
  const ids = {}          // A / B / C → id
  let originalOrder = []  // ordre (ids) des items en attente avant le test

  const apiIn = (fn, arg) => page.evaluate(fn, arg)

  // Ordre des ids de mes trois items telles que le serveur les renvoie.
  const serverOrder = () => apiIn(async (mine) => {
    const token = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api/travaux/prompts', { headers: { Authorization: `Bearer ${token}` } })
    const { prompts } = await r.json()
    return prompts.filter(p => mine.includes(p.id)).map(p => p.id)
  }, Object.values(ids))

  // Même ordre, mais tel qu'affiché (les cartes portent data-prompt-id).
  const domOrder = () => page.locator('[data-prompt-id]').evaluateAll((els, mine) =>
    els.map(el => el.getAttribute('data-prompt-id')).filter(id => mine.includes(id)),
  Object.values(ids))

  const waitDom = (expected) => page.waitForFunction(({ expected, mine }) => {
    const shown = [...document.querySelectorAll('[data-prompt-id]')]
      .map(el => el.getAttribute('data-prompt-id')).filter(id => mine.includes(id))
    return shown.join(',') === expected.join(',')
  }, { expected, mine: Object.values(ids) }, { timeout: 10000 })

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Photo de l'ordre existant, pour le remettre tel quel en fin de test.
    originalOrder = await apiIn(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/travaux/prompts', { headers: { Authorization: `Bearer ${token}` } })
      const { prompts } = await r.json()
      return prompts.filter(p => ['running', 'queued', 'paused'].includes(p.status)).map(p => p.id)
    })

    for (const k of ['A', 'B', 'C']) {
      const created = await apiIn(async ({ k, stamp }) => {
        const token = localStorage.getItem('erp_token')
        const r = await fetch('/erp/api/travaux/prompts', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: `E2E priorité ${k} ${stamp}`,
            prompt: 'Ne rien faire — item de test E2E.',
            mode: 'question',
            status: 'paused',
          }),
        })
        return r.json()
      }, { k, stamp })
      ids[k] = created.id
      assert.ok(ids[k], `création de l'item ${k}`)
    }
  })

  after(async () => {
    if (page) {
      await apiIn(async ({ mine, originalOrder }) => {
        const token = localStorage.getItem('erp_token')
        const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        for (const id of mine) {
          await fetch(`/erp/api/travaux/prompts/${id}`, { method: 'DELETE', headers: H }).catch(() => {})
        }
        // Restaure l'ordre d'avant le test (le test a renuméroté les positions).
        if (originalOrder.length) {
          await fetch('/erp/api/travaux/prompts/reorder', {
            method: 'POST', headers: H, body: JSON.stringify({ ids: originalOrder }),
          }).catch(() => {})
        }
      }, { mine: Object.values(ids), originalOrder })
    }
    await browser?.close()
  })

  test('les items en attente portent une poignée et des flèches de priorité', async () => {
    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`[data-prompt-id="${ids.A}"]`, { timeout: 15000 })

    // Ordre de création = ordre d'affichage au départ.
    assert.deepEqual(await domOrder(), [ids.A, ids.B, ids.C], 'ordre initial')

    const card = page.locator(`[data-prompt-id="${ids.B}"]`)
    assert.equal(await card.locator('[data-testid="travaux-drag-handle"]').count(), 1, 'poignée de glissement absente')
    assert.equal(await card.getByTestId('travaux-move-up').count(), 1, 'flèche monter absente')
    assert.equal(await card.getByTestId('travaux-move-down').count(), 1, 'flèche descendre absente')
    // La poignée doit être réellement draggable.
    assert.equal(await card.locator('[data-testid="travaux-drag-handle"]').getAttribute('draggable'), 'true')
  })

  test('la flèche « monter » remonte l\'item d\'un cran et le persiste', async () => {
    await page.locator(`[data-prompt-id="${ids.C}"]`).getByTestId('travaux-move-up').click()
    await waitDom([ids.A, ids.C, ids.B])
    assert.deepEqual(await serverOrder(), [ids.A, ids.C, ids.B], 'nouvel ordre non persisté côté serveur')
  })

  test('la flèche « descendre » redescend l\'item d\'un cran', async () => {
    await page.locator(`[data-prompt-id="${ids.C}"]`).getByTestId('travaux-move-down').click()
    await waitDom([ids.A, ids.B, ids.C])
    assert.deepEqual(await serverOrder(), [ids.A, ids.B, ids.C], 'retour à l\'ordre initial non persisté')
  })

  test('les flèches sont désactivées aux extrémités du groupe', async () => {
    // Le groupe « de côté » peut contenir de vrais items avant les miens : on
    // interroge donc ses bornes réelles, pas les items du test.
    const group = page.locator('[data-prompt-status="paused"]')
    const n = await group.count()
    assert.ok(n >= 3, `groupe « de côté » trop petit : ${n}`)
    assert.equal(await group.first().getByTestId('travaux-move-up').isDisabled(), true,
      'la flèche monter devrait être désactivée sur le premier du groupe')
    assert.equal(await group.last().getByTestId('travaux-move-down').isDisabled(), true,
      'la flèche descendre devrait être désactivée sur le dernier du groupe')
    // Mon item du milieu, lui, peut bouger dans les deux sens.
    const mid = page.locator(`[data-prompt-id="${ids.B}"]`)
    assert.equal(await mid.getByTestId('travaux-move-up').isDisabled(), false)
    assert.equal(await mid.getByTestId('travaux-move-down').isDisabled(), false)
  })

  test('glisser une carte par sa poignée change la priorité', async () => {
    // C (dernier) déposé AVANT A (premier) → C, A, B.
    await page.evaluate(({ source, target }) => {
      const handle = document.querySelector(`[data-prompt-id="${source}"] [data-testid="travaux-drag-handle"]`)
      const dst = document.querySelector(`[data-prompt-id="${target}"]`)
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
    await page.waitForSelector(`[data-prompt-id="${ids.A}"]`, { timeout: 15000 })
    assert.deepEqual(await domOrder(), [ids.C, ids.A, ids.B], 'ordre perdu au rechargement')
  })
})
