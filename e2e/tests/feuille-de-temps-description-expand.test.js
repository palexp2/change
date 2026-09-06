// Feuille de temps — bouton « agrandir » sur la description d'une activité :
// visible uniquement quand le champ est sélectionné (focus), ouvre un petit
// cadre en overlay ancré sur le champ (pas une modale) qui autosauvegarde les
// retours de ligne.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Feuille de temps — description multiligne (bouton agrandir)', () => {
  let browser, ctx, page, pageErrors
  // Date future isolée pour ne pas polluer la vraie data
  const testDate = '2030-03-18'
  const createdDays = []
  let entryId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    pageErrors = []
    page.on('pageerror', err => pageErrors.push(err.message))
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Setup : jour détaillé jetable + 1 entrée
    const setup = await page.evaluate(async ({ date }) => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const day = await fetch('/erp/api/timesheets/day', {
        method: 'POST', headers: h, body: JSON.stringify({ date, mode: 'detailed' }),
      }).then(r => r.json())
      await fetch(`/erp/api/timesheets/day/${day.id}`, {
        method: 'PATCH', headers: h, body: JSON.stringify({ start_time: '08:00' }),
      })
      // Jour potentiellement laissé par un run précédent : on repart d'une feuille vide
      for (const e of (day.entries || [])) {
        await fetch(`/erp/api/timesheets/entries/${e.id}`, { method: 'DELETE', headers: h })
      }
      // POST /entries renvoie le JOUR complet, pas l'entrée → on prend la dernière
      const updated = await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST', headers: h, body: JSON.stringify({ description: 'Ligne expand', duration_minutes: 60 }),
      }).then(r => r.json())
      const entries = updated.entries || []
      return { dayId: day.id, entryId: entries[entries.length - 1]?.id }
    }, { date: testDate })
    createdDays.push(setup.dayId)
    entryId = setup.entryId
    assert.ok(entryId, 'setup : l’entrée de test doit avoir un id')

    await gotoTestDay()
  })

  // La nav de date se fait par chevrons / historique (pas d'input date) : on saute
  // au jour de test via sa ligne dans la sidebar historique.
  async function gotoTestDay() {
    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/Feuille de temps/', { timeout: 15000 })
    const row = page.locator(`[data-testid="history-day-row-${testDate}"]`)
    await row.waitFor({ state: 'visible', timeout: 15000 })
    await row.click()
    await page.waitForSelector(`[data-testid="entry-description-${entryId}"]`, { timeout: 10000 })
  }

  after(async () => {
    // Nettoyage : entrées puis jour jetable
    for (const id of createdDays) {
      await page.evaluate(async ({ id, date }) => { // eslint-disable-line no-loop-func
        const token = localStorage.getItem('erp_token')
        const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        const day = await fetch(`/erp/api/timesheets/day?date=${date}`, { headers: h }).then(r => r.json()).catch(() => null)
        for (const e of (day?.entries || [])) {
          await fetch(`/erp/api/timesheets/entries/${e.id}`, { method: 'DELETE', headers: h })
        }
        await fetch(`/erp/api/timesheets/day/${id}`, { method: 'DELETE', headers: h })
      }, { id, date: testDate })
    }
    await browser?.close()
  })

  test('le bouton agrandir n’apparaît qu’au focus du champ description', async () => {
    const input = page.locator(`[data-testid="entry-description-${entryId}"]`)
    const expandBtn = page.locator(`[data-testid="entry-description-${entryId}-expand"]`)

    assert.strictEqual(await expandBtn.count(), 0, 'le bouton agrandir ne doit pas être présent hors focus')

    await input.click()
    await expandBtn.waitFor({ state: 'visible', timeout: 3000 })
    assert.ok(await expandBtn.isVisible(), 'le bouton agrandir doit apparaître quand le champ est sélectionné')

    // Défocus → le bouton disparaît
    await input.evaluate(el => el.blur())
    await expandBtn.waitFor({ state: 'detached', timeout: 3000 })
    assert.strictEqual(await expandBtn.count(), 0, 'le bouton agrandir doit disparaître quand le champ perd le focus')
  })

  test('l’overlay s’ouvre en petit cadre ancré sur le champ, pas en modale plein écran', async () => {
    const input = page.locator(`[data-testid="entry-description-${entryId}"]`)
    const expandBtn = page.locator(`[data-testid="entry-description-${entryId}-expand"]`)
    const overlay = page.locator(`[data-testid="entry-description-${entryId}-overlay"]`)

    await input.click()
    await expandBtn.waitFor({ state: 'visible', timeout: 3000 })
    await expandBtn.click()
    await overlay.waitFor({ state: 'visible', timeout: 3000 })

    // Pas une modale : le composant Modal verrouille le scroll du body (overflow:hidden)
    const bodyOverflow = await page.evaluate(() => document.body.style.overflow)
    assert.notStrictEqual(bodyOverflow, 'hidden', 'le scroll de la page ne doit pas être verrouillé (signature d’une modale)')

    const inputBox = await input.boundingBox()
    const overlayBox = await overlay.boundingBox()
    assert.ok(inputBox && overlayBox, 'le champ et l’overlay doivent avoir une géométrie mesurable')
    // Ancré sur la cellule : même bord gauche (à quelques px près) et démarre à sa hauteur
    assert.ok(Math.abs(overlayBox.x - inputBox.x) <= 4, `overlay ancré à gauche du champ (${overlayBox.x} vs ${inputBox.x})`)
    assert.ok(Math.abs(overlayBox.y - inputBox.y) <= 6, `overlay ancré à la hauteur du champ (${overlayBox.y} vs ${inputBox.y})`)
    // Petit cadre : pas la largeur d'une modale, et une hauteur contenue
    const vp = page.viewportSize()
    assert.ok(overlayBox.width < vp.width * 0.5, `cadre étroit (${overlayBox.width} px pour un viewport de ${vp.width})`)
    assert.ok(overlayBox.height < vp.height * 0.5, `cadre court (${overlayBox.height} px pour un viewport de ${vp.height})`)

    // Le textarea est focus dès l'ouverture → on peut taper sans re-cliquer
    const focusedTestId = await page.evaluate(() => document.activeElement?.dataset?.testid || null)
    assert.strictEqual(focusedTestId, `entry-description-${entryId}-textarea`, 'le textarea doit avoir le focus à l’ouverture')

    // Un clic à l'extérieur referme l'overlay
    await page.mouse.click(20, 20)
    await overlay.waitFor({ state: 'detached', timeout: 3000 })
  })

  test('l’overlay sauvegarde les retours de ligne', async () => {
    const input = page.locator(`[data-testid="entry-description-${entryId}"]`)
    const expandBtn = page.locator(`[data-testid="entry-description-${entryId}-expand"]`)
    const overlay = page.locator(`[data-testid="entry-description-${entryId}-overlay"]`)
    const textarea = page.locator(`[data-testid="entry-description-${entryId}-textarea"]`)

    await input.click()
    await expandBtn.waitFor({ state: 'visible', timeout: 3000 })
    await expandBtn.click()

    await textarea.waitFor({ state: 'visible', timeout: 3000 })
    assert.strictEqual(await textarea.inputValue(), 'Ligne expand', 'la zone multiligne doit reprendre la valeur courante')

    const multi = 'Ligne 1\nLigne 2\nLigne 3'
    await textarea.fill(multi)
    // Ferme l'overlay → autosave
    await overlay.locator('button:has-text("Fermer")').click()
    await textarea.waitFor({ state: 'detached', timeout: 3000 })
    await page.waitForTimeout(800)

    const day = await page.evaluate(async ({ date }) => {
      const token = localStorage.getItem('erp_token')
      return await fetch(`/erp/api/timesheets/day?date=${date}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
    }, { date: testDate })
    const saved = (day.entries || []).find(e => e.id === entryId)
    assert.ok(saved, 'l’entrée de test doit exister')
    assert.strictEqual(saved.description, multi, 'les retours de ligne doivent être sauvegardés tels quels')
  })

  test('la valeur multiligne survit un rechargement et reste éditable en multiligne', async () => {
    await gotoTestDay()
    const input = page.locator(`[data-testid="entry-description-${entryId}"]`)
    await input.waitFor({ state: 'visible', timeout: 10000 })

    // L'input mono-ligne affiche une version aplatie (les navigateurs suppriment
    // les retours de ligne du value d'un input text).
    assert.strictEqual(await input.inputValue(), 'Ligne 1 Ligne 2 Ligne 3')

    // Un simple focus/blur sur l'input ne doit PAS écraser les retours de ligne
    await input.click()
    await input.evaluate(el => el.blur())
    await page.waitForTimeout(800)

    await input.click()
    const expandBtn = page.locator(`[data-testid="entry-description-${entryId}-expand"]`)
    await expandBtn.waitFor({ state: 'visible', timeout: 3000 })
    await expandBtn.click()
    const textarea = page.locator(`[data-testid="entry-description-${entryId}-textarea"]`)
    await textarea.waitFor({ state: 'visible', timeout: 3000 })
    assert.strictEqual(await textarea.inputValue(), 'Ligne 1\nLigne 2\nLigne 3', 'la zone multiligne doit retrouver les retours de ligne')

    // Échap ferme la modale
    await page.keyboard.press('Escape')
    await textarea.waitFor({ state: 'detached', timeout: 3000 })

    assert.deepStrictEqual(pageErrors, [], 'aucune erreur JS attendue')
  })
})
