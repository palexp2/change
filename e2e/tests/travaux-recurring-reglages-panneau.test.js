// Travaux récurrents — les réglages d'une ligne ne dérangent plus la lecture.
//
// Avant : une barre de réglages flottait AU-DESSUS de la ligne dès qu'on la
// survolait (quand, dû le, pour qui, cadence, corbeille). Elle recouvrait le
// titre, et le « quand » comme le badge d'échéance devaient être masqués au
// survol pour ne pas se retrouver à moitié dessous : passer la souris sur une
// ligne pour la lire changeait ce qu'elle affichait.
//
// Maintenant : un bouton de réglages de 24 px, dont la place est réservée en
// permanence (rien ne se décale quand il apparaît), et un panneau libellé qui
// s'ouvre au clic sous le bouton — jamais par-dessus le texte de la ligne.
//
// Aucun record réel n'est touché : un travail jetable (label horodaté), créé et
// supprimé par le test.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const LABEL = `E2E réglages panneau ${Date.now()}`

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
}

function apiFetch(page, method, p, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const opts = { method, headers: { Authorization: `Bearer ${tok}` } }
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
    const r = await fetch('/erp/api' + path, opts)
    return r.json()
  }, { method, path: p, body })
}

async function waitFor(fn, { timeout = 20000, label = 'condition' } = {}) {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error(`timeout: ${label}`)
    await new Promise(r => setTimeout(r, 250))
  }
}

describe('Travaux récurrents — panneau de réglages de ligne', () => {
  let browser, ctx, page, task = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
    task = await apiFetch(page, 'POST', '/travaux/recurring', { label: LABEL, cadence: 'mensuel', owner: 'AL' })
    assert.ok(task?.id, 'travail jetable créé')
    await apiFetch(page, 'PATCH', `/travaux/recurring/${task.id}`, { day_hint: 'le 25', due_day: 25 })
    await page.goto(URL + '/travaux?onglet=recurrents', { waitUntil: 'domcontentloaded' })
    await page.locator(`[data-task-id="${task.id}"]`).waitFor({ timeout: 20000 })
  })

  after(async () => {
    if (page && task?.id) await apiFetch(page, 'DELETE', `/travaux/recurring/${task.id}`)
    await browser?.close()
  })

  const row = () => page.locator(`[data-task-id="${task.id}"]`)
  const title = () => row().locator('input[type="text"], input:not([type])').first()

  test('survoler la ligne ne recouvre ni ne décale rien', async () => {
    const before = await title().evaluate(el => el.getBoundingClientRect().width)
    const hint = row().locator('text=le 25').first()

    await row().hover()
    const after = await title().evaluate(el => el.getBoundingClientRect().width)
    assert.ok(Math.abs(after - before) < 1, `le titre se décale au survol (${before} → ${after})`)

    // Le « quand » reste visible pendant le survol (il était masqué avant).
    await hint.waitFor({ state: 'visible', timeout: 5000 })

    // Rien ne se superpose au titre : le bouton de réglages est entièrement à
    // droite de la zone de texte.
    const boxes = await row().evaluate(el => {
      const t = el.querySelector('input')
      const b = el.querySelector('[data-testid="recurring-settings"]')
      const r = x => { const k = x.getBoundingClientRect(); return { left: k.left, right: k.right } }
      return { title: r(t), btn: r(b) }
    })
    assert.ok(boxes.btn.left >= boxes.title.right - 1,
      `le bouton chevauche le titre (titre → ${boxes.title.right}, bouton ← ${boxes.btn.left})`)
  })

  test('le panneau s\'ouvre sous le bouton, se referme au clic ailleurs', async () => {
    await row().hover()
    await row().locator('[data-testid="recurring-settings"]').click()
    const panel = row().locator('[data-testid="recurring-settings-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 5000 })

    // Sous le bouton, pas par-dessus le titre.
    const geo = await row().evaluate(el => {
      const p = el.querySelector('[data-testid="recurring-settings-panel"]').getBoundingClientRect()
      const b = el.querySelector('[data-testid="recurring-settings"]').getBoundingClientRect()
      return { panelTop: p.top, btnBottom: b.bottom }
    })
    assert.ok(geo.panelTop >= geo.btnBottom - 1, 'le panneau remonte sur la ligne')

    // Tous les réglages y sont, libellés.
    const txt = await panel.innerText()
    for (const l of ['Quand', 'Dû le', 'Pour qui', 'Cadence', 'Retirer']) {
      assert.ok(txt.includes(l), `réglage « ${l} » absent du panneau`)
    }
    await panel.locator('[data-testid="recurring-owner"]').waitFor({ state: 'visible' })
    await panel.locator('[data-testid="recurring-cadence"]').waitFor({ state: 'visible' })

    await page.locator('h1').click()
    await waitFor(async () => (await panel.count()) === 0, { label: 'panneau refermé au clic ailleurs' })
  })

  test('le « quand » se modifie dans le panneau, en autosave', async () => {
    await row().hover()
    await row().locator('[data-testid="recurring-settings"]').click()
    const panel = row().locator('[data-testid="recurring-settings-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 5000 })

    const hint = panel.locator('input[placeholder="ex. mardi matin"]')
    await hint.fill('le 26 au matin')
    await hint.blur()
    const saved = await waitFor(async () => {
      const { tasks } = await apiFetch(page, 'GET', '/travaux/recurring?owner=AL')
      const x = tasks.find(x => x.id === task.id)
      return x?.day_hint === 'le 26 au matin' ? x : null
    }, { label: '« quand » enregistré' })
    assert.equal(saved.day_hint, 'le 26 au matin')

    await page.keyboard.press('Escape')
    await waitFor(async () => (await panel.count()) === 0, { label: 'panneau refermé (Échap)' })
    // Et la nouvelle valeur se lit sur la ligne, sans ouvrir quoi que ce soit.
    assert.ok((await row().textContent()).includes('le 26 au matin'), 'le « quand » se lit sur la ligne')
  })
})
