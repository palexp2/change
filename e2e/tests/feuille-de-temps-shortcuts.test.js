const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

function todayStr() { return new Date().toISOString().slice(0, 10) }
function shift(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

// Vérifie les raccourcis clavier de la page Feuille de temps :
// flèche gauche = jour précédent, flèche droite = jour suivant, a = aujourd'hui,
// Enter = ajoute une nouvelle activité (passe en mode detailed si besoin).
describe('FeuilleDeTemps — raccourcis clavier', () => {
  let browser, ctx, page, token

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
  })

  after(async () => {
    // Nettoie les jours créés par le test
    if (token) {
      const dates = [todayStr(), shift(todayStr(), -1), shift(todayStr(), -2), shift(todayStr(), 1)]
      for (const d of dates) {
        try {
          await page.evaluate(async ({ tok, date }) => {
            const r = await fetch(`/erp/api/timesheets/day?date=${date}`, { headers: { Authorization: `Bearer ${tok}` } })
            const day = await r.json()
            if (day?.id) {
              await fetch(`/erp/api/timesheets/day/${day.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } })
            }
          }, { tok: token, date: d })
        } catch {}
      }
    }
    await browser?.close()
  })

  async function gotoTimesheet() {
    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    await page.evaluate(() => document.activeElement?.blur())
  }

  function weekdayLabel(dateStr) {
    const d = new Date(dateStr + 'T00:00:00')
    return d.toLocaleDateString('fr-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  }

  async function waitForDate(dateStr, timeout = 5000) {
    const expected = weekdayLabel(dateStr)
    await page.waitForFunction(
      label => Array.from(document.querySelectorAll('div')).some(el => el.textContent?.trim() === label),
      expected,
      { timeout },
    )
  }

  test('flèche gauche / droite = jour précédent / suivant', async () => {
    await gotoTimesheet()
    await waitForDate(todayStr())
    await page.keyboard.press('ArrowLeft')
    await waitForDate(shift(todayStr(), -1))
    await page.keyboard.press('ArrowRight')
    await waitForDate(todayStr())
  })

  test('a = aujourd\'hui', async () => {
    await gotoTimesheet()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await waitForDate(shift(todayStr(), -2))
    await page.keyboard.press('a')
    await waitForDate(todayStr())
  })

  test('Enter = ajoute une nouvelle activité et focus le picker code d\'activité', async () => {
    await gotoTimesheet()
    // Compte les boutons "Supprimer" (un par entry).
    const before = await page.locator('button[title="Supprimer"]').count()
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      b => document.querySelectorAll('button[title="Supprimer"]').length > b,
      before,
      { timeout: 5000 },
    )
    const after = await page.locator('button[title="Supprimer"]').count()
    assert.ok(after > before, `une nouvelle entrée doit avoir été ajoutée (${before} → ${after})`)

    // Le focus doit être sur le picker "Code…" (le bouton de la dernière ligne).
    const focusInfo = await page.evaluate(() => {
      const ae = document.activeElement
      if (!ae) return null
      return {
        tag: ae.tagName,
        text: ae.textContent?.trim() || '',
        type: ae.getAttribute('type') || null,
      }
    })
    assert.ok(focusInfo, 'Un élément doit avoir le focus')
    assert.equal(focusInfo.tag, 'BUTTON', `Le focus doit être sur un bouton, vu : ${focusInfo.tag}`)
    assert.match(focusInfo.text, /Code/, `Le bouton focus doit être le picker "Code…", vu : "${focusInfo.text}"`)
  })

  test('sélectionner un code via Enter dans le picker ne crée pas de nouvelle entrée', async () => {
    await gotoTimesheet()
    // Crée une première entrée avec Enter — ça ouvre le focus sur le picker.
    const initial = await page.locator('button[title="Supprimer"]').count()
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      n => document.querySelectorAll('button[title="Supprimer"]').length > n,
      initial,
      { timeout: 5000 },
    )
    const afterAdd = await page.locator('button[title="Supprimer"]').count()
    // Active le picker (le bouton a déjà le focus suite au add).
    await page.keyboard.press('Enter') // ouvre le popup
    // Attends que l'input de recherche du popup apparaisse + soit focusé.
    const popupSearch = page.locator('input[placeholder="Rechercher…"]').first()
    await popupSearch.waitFor({ state: 'visible', timeout: 5000 })
    // Sélectionne le premier item via Enter.
    await page.keyboard.press('Enter')
    // Attente courte pour laisser un éventuel addEntry se produire.
    await page.waitForTimeout(500)
    const finalCount = await page.locator('button[title="Supprimer"]').count()
    assert.equal(finalCount, afterAdd, `Sélectionner un code ne doit PAS créer de nouvelle ligne (${afterAdd} → ${finalCount})`)
  })

  test('les raccourcis ne se déclenchent pas quand un input a le focus', async () => {
    await gotoTimesheet()
    await waitForDate(todayStr())
    // Trouve un input texte sur la page (note du jour, ou autre).
    const anyInput = page.locator('input[type="text"], textarea').first()
    await anyInput.waitFor({ state: 'visible', timeout: 5000 })
    await anyInput.click()
    // Tape 'a' et 'ArrowLeft' — la date ne doit PAS bouger.
    await page.keyboard.type('a')
    await page.keyboard.press('ArrowLeft')
    // Attente courte pour laisser un éventuel changement de date se produire.
    await page.waitForTimeout(300)
    // La date affichée doit toujours être aujourd'hui.
    const stillToday = await page.evaluate(label => {
      return Array.from(document.querySelectorAll('div')).some(el => el.textContent?.trim() === label)
    }, weekdayLabel(todayStr()))
    assert.ok(stillToday, "La date affichée ne devrait pas avoir changé alors que l'input a le focus")
  })
})
