// Dashboard comptabilité → « Projection du solde BNC » : retour de la vue
// calendrier à côté de la vue liste.
//
// La bascule Liste / Calendrier avait disparu lors d'un nettoyage de la carte.
// Ce test verrouille : les deux vues existent, le calendrier affiche bien une
// grille mensuelle navigable avec les mêmes mouvements que la liste, et le
// choix de vue est mémorisé d'un chargement à l'autre.
//
// Lecture seule — aucun record créé. Seule écriture : la préférence de vue en
// localStorage, restaurée à sa valeur initiale par le hook after().
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const KEY = 'treasury_proj_view'

describe('Comptabilité — vue calendrier de la projection', () => {
  let browser, ctx, page
  let initialView = null // préférence de l'utilisateur avant le test

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    await page.goto(URL + '/comptabilite', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="treasury-section"]', { timeout: 20000 })
    await page.waitForSelector('[data-testid="treasury-min-balance"]', { timeout: 20000 })
    initialView = await page.evaluate(k => localStorage.getItem(k), KEY)
  })

  after(async () => {
    // Restauration de la préférence écrasée par le test.
    if (page && !page.isClosed()) {
      await page.evaluate(([k, v]) => {
        if (v === null) localStorage.removeItem(k)
        else localStorage.setItem(k, v)
      }, [KEY, initialView]).catch(() => {})
    }
    await browser?.close()
  })

  test('la bascule Liste / Calendrier est présente, la liste est la vue par défaut', async () => {
    await page.evaluate(k => localStorage.removeItem(k), KEY)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="treasury-min-balance"]', { timeout: 20000 })

    assert.equal(await page.locator('[data-testid="treasury-view-list"]').count(), 1, 'bouton Liste absent')
    assert.equal(await page.locator('[data-testid="treasury-view-calendar"]').count(), 1, 'bouton Calendrier absent')
    // Sans préférence enregistrée : liste, donc pas de grille calendrier.
    assert.equal(await page.locator('[data-testid="treasury-calendar"]').count(), 0)
    assert.equal(await page.locator('[data-testid="treasury-view-list"]').getAttribute('aria-selected'), 'true')
  })

  test('le calendrier affiche le mois courant, ses jours et les mouvements de la liste', async () => {
    // Mouvements visibles en liste — on en garde un pour le retrouver au calendrier.
    const listText = (await page.locator('[data-testid="treasury-section"]').innerText()).replace(/\s+/g, ' ')

    await page.click('[data-testid="treasury-view-calendar"]')
    const cal = page.locator('[data-testid="treasury-calendar"]')
    await cal.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await page.locator('[data-testid="treasury-view-calendar"]').getAttribute('aria-selected'), 'true')

    // En-tête : mois courant en toutes lettres + jours de la semaine.
    const expectedMonth = new Date().toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' })
    assert.equal((await page.locator('[data-testid="treasury-calendar-month"]').innerText()).trim().toLowerCase(),
      expectedMonth.toLowerCase())
    const calText = (await cal.innerText()).replace(/\s+/g, ' ')
    for (const d of ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam']) {
      assert.match(calText.toLowerCase(), new RegExp(`\\b${d}\\b`), `jour de semaine manquant : ${d}`)
    }
    // Grille complète : 4 à 6 semaines de 7 cellules.
    const cells = await cal.locator('div.min-h-\\[4\\.5rem\\]').count()
    assert.ok(cells >= 28 && cells % 7 === 0, `grille inattendue : ${cells} cellules`)

    // Le jour du mois courant est marqué (pastille « aujourd'hui »).
    const today = String(new Date().getDate())
    assert.ok(calText.split(' ').includes(today) || calText.includes(today), 'jour courant absent de la grille')

    // Au moins un mouvement de la liste se retrouve au calendrier, quand la
    // projection en contient pour le mois affiché.
    const pill = cal.locator('button, a').filter({ hasText: /\$/ })
    if (await pill.count() > 0) {
      const label = (await pill.first().innerText()).replace(/\s+/g, ' ').trim()
      const word = label.replace(/^[+−-]\s*[\d\s,.$]+/, '').trim().split(' ')[0]
      if (word.length > 3) {
        assert.match(listText.toLowerCase(), new RegExp(word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          `mouvement « ${word} » présent au calendrier mais pas en liste`)
      }
    }
  })

  test('navigation entre les mois et retour à aujourd\'hui', async () => {
    const monthLabel = page.locator('[data-testid="treasury-calendar-month"]')
    const current = (await monthLabel.innerText()).trim()

    await page.click('[data-testid="treasury-calendar-next"]')
    const next = (await monthLabel.innerText()).trim()
    assert.notEqual(next, current, 'le mois suivant n\'a pas changé l\'en-tête')

    // Un lien « Aujourd'hui » apparaît dès qu'on quitte le mois courant.
    const todayBtn = page.locator('[data-testid="treasury-calendar"] button:has-text("Aujourd\'hui")')
    assert.equal(await todayBtn.count(), 1)
    await todayBtn.click()
    assert.equal((await monthLabel.innerText()).trim(), current)

    await page.click('[data-testid="treasury-calendar-prev"]')
    assert.notEqual((await monthLabel.innerText()).trim(), current, 'le mois précédent n\'a pas changé l\'en-tête')
    await page.locator('[data-testid="treasury-calendar"] button:has-text("Aujourd\'hui")').click()
    assert.equal((await monthLabel.innerText()).trim(), current)
  })

  test('le choix de vue est mémorisé au rechargement, et le retour en liste aussi', async () => {
    assert.equal(await page.evaluate(k => localStorage.getItem(k), KEY), 'calendar')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="treasury-calendar"]', { timeout: 20000 })

    // Retour en liste : le tableau des mouvements revient, la grille disparaît.
    await page.click('[data-testid="treasury-view-list"]')
    await page.locator('[data-testid="treasury-calendar"]').waitFor({ state: 'detached', timeout: 10000 })
    assert.equal(await page.evaluate(k => localStorage.getItem(k), KEY), 'list')
    const txt = (await page.locator('[data-testid="treasury-section"]').innerText()).replace(/\s+/g, ' ')
    assert.match(txt, /Mouvements à venir/i)
  })
})
