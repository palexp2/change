// Travaux récurrents — titres et notes lisibles.
//
// La note d'un travail vivait dans un champ d'une ligne coincé entre « quand »
// et une colonne de réglages invisibles : « Mastercard : paiement pré-programmé
// le 4-5 du mois. Garder le solde so… » se coupait au milieu d'un mot, et le
// titre lui-même se faisait tronquer. La note occupe désormais toute la largeur
// sous le titre et revient à la ligne ; le titre est plus gros et plus
// contrasté ; les réglages (quand, dû le, propriétaire, cadence) ne se montrent
// qu'au survol.
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

const STAMP = Date.now()
const LABEL = `E2E lisibilité ${STAMP}`
const LONG_NOTE = 'Mastercard : paiement pré-programmé le 4-5 du mois. Garder le solde sous 10 000 $ '
  + '(limite de crédit 15 000 $). Vérifier aussi le relevé Visa USD avant de payer quoi que ce soit.'

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

async function waitFor(fn, { timeout = 25000, label = 'condition' } = {}) {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error(`timeout: ${label}`)
    await new Promise(r => setTimeout(r, 300))
  }
}

describe('Travaux récurrents — lisibilité des titres et des notes', () => {
  let browser, ctx, page, task = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
    task = await apiFetch(page, 'POST', '/travaux/recurring', { label: LABEL, cadence: 'mensuel', owner: 'AL' })
    assert.ok(task?.id, 'travail jetable créé')
    await apiFetch(page, 'PATCH', `/travaux/recurring/${task.id}`, { notes: LONG_NOTE, day_hint: 'le 25' })
    await page.goto(URL + '/travaux?onglet=recurrents', { waitUntil: 'domcontentloaded' })
    await page.locator(`[data-task-id="${task.id}"]`).waitFor({ timeout: 20000 })
  })

  after(async () => {
    if (page && task?.id) await apiFetch(page, 'DELETE', `/travaux/recurring/${task.id}`)
    await browser?.close()
  })

  test('la note longue s\'affiche en entier, sur plusieurs lignes', async () => {
    const note = page.locator(`[data-task-id="${task.id}"] [data-testid="recurring-note"]`)
    await note.waitFor({ timeout: 15000 })
    assert.equal(await note.inputValue(), LONG_NOTE, 'la note complète est dans le champ')

    const box = await note.evaluate(el => {
      const cs = getComputedStyle(el)
      return {
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        width: el.clientWidth,
        fontSize: parseFloat(cs.fontSize),
        lineHeight: parseFloat(cs.lineHeight),
        overflow: cs.overflowY,
      }
    })
    // Rien de coupé : le champ est aussi haut que son contenu.
    assert.ok(box.scrollHeight <= box.clientHeight + 2,
      `note tronquée (contenu ${box.scrollHeight}px dans ${box.clientHeight}px)`)
    // Et elle a bien été renvoyée à la ligne plutôt que rognée à droite.
    assert.ok(box.clientHeight >= box.lineHeight * 1.5,
      `note sur une seule ligne (${box.clientHeight}px pour une ligne de ${box.lineHeight}px)`)
    assert.ok(box.fontSize >= 13, `note trop petite (${box.fontSize}px)`)
    // Toute la largeur de la ligne, plus une gouttière entre deux colonnes.
    assert.ok(box.width > 700, `note trop étroite (${box.width}px)`)
  })

  test('le titre est plus gros et sur toute la largeur', async () => {
    const title = page.locator(`[data-task-id="${task.id}"] input[type="text"], [data-task-id="${task.id}"] input:not([type])`).first()
    const m = await title.evaluate(el => ({
      value: el.value,
      fontSize: parseFloat(getComputedStyle(el).fontSize),
      // Un titre tronqué déborde de son champ : scrollWidth > clientWidth.
      clipped: el.scrollWidth > el.clientWidth + 2,
      width: el.clientWidth,
    }))
    assert.equal(m.value, LABEL)
    assert.ok(m.fontSize >= 15, `titre trop petit (${m.fontSize}px)`)
    assert.ok(!m.clipped, 'titre tronqué dans son champ')
    assert.ok(m.width > 700, `titre trop étroit (${m.width}px)`)
  })

  test('les réglages (quand, dû le) s\'ouvrent depuis le bouton de la ligne', async () => {
    const row = page.locator(`[data-task-id="${task.id}"]`)
    const btn = row.locator('[data-testid="recurring-settings"]')
    const panel = row.locator('[data-testid="recurring-settings-panel"]')
    // Bouton effacé au repos (opacité 0 : il reste atteignable au clavier, ce
    // que `display:none` interdirait). Souris et focus ailleurs, sinon le survol
    // de l'assertion précédente le garderait allumé.
    await page.mouse.move(5, 5)
    await page.locator('h1').click()
    const opacity = () => btn.evaluate(el => getComputedStyle(el).opacity)
    await waitFor(async () => (await opacity()) === '0', { timeout: 5000, label: 'bouton effacé au repos' })
    assert.equal(await panel.count(), 0, 'aucun panneau ouvert au repos')

    await row.hover()
    await waitFor(async () => (await opacity()) === '1', { timeout: 5000, label: 'bouton révélé au survol' })
    await btn.click()
    await panel.waitFor({ state: 'visible', timeout: 5000 })
    await panel.locator('[data-testid="recurring-due-day"]').waitFor({ state: 'visible', timeout: 5000 })
    // Le « quand » reste lisible sur la ligne, y compris pendant le survol.
    assert.ok((await row.textContent()).includes('le 25'), 'le « quand » se lit sur la ligne')
    // Échap referme le panneau.
    await page.keyboard.press('Escape')
    await waitFor(async () => (await panel.count()) === 0, { timeout: 5000, label: 'panneau refermé' })
  })

  test('la note reste modifiable (autosave)', async () => {
    const note = page.locator(`[data-task-id="${task.id}"] [data-testid="recurring-note"]`)
    const edited = LONG_NOTE + ' Modifié par le test.'
    await note.fill(edited)
    await note.blur()
    const saved = await waitFor(async () => {
      const { tasks } = await apiFetch(page, 'GET', '/travaux/recurring?owner=AL')
      const x = tasks.find(x => x.id === task.id)
      return x?.notes === edited ? x : null
    }, { label: 'note enregistrée' })
    assert.equal(saved.notes, edited)
  })
})
