// Vérifie que le champ "date" du modal "Nouvelle écriture de journal" affiche
// la date LOCALE de l'utilisateur, pas l'UTC. Reproduit le scénario du bug : un
// utilisateur à Montréal qui ouvre le modal à 23:00 EST le 25 — la date par
// défaut doit être le 25, pas le 26. On force le fuseau via Playwright pour
// que le test soit reproductible quel que soit le TZ du serveur.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Nouvelle écriture de journal — date par défaut en fuseau local', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    // 23:00 EDT le 25 mai = 03:00 UTC le 26 mai. On verrouille l'heure
    // côté browser pour rendre le test déterministe.
    ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      timezoneId: 'America/Toronto',
    })
    await ctx.addInitScript(() => {
      const fixedNow = new Date('2026-05-26T03:00:00Z').getTime() // 23:00 EDT le 25
      const OriginalDate = Date
      // eslint-disable-next-line no-global-assign
      Date = class extends OriginalDate {
        constructor(...args) {
          if (args.length === 0) return new OriginalDate(fixedNow)
          return new OriginalDate(...args)
        }
        static now() { return fixedNow }
      }
      Date.UTC = OriginalDate.UTC
      Date.parse = OriginalDate.parse
    })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    await page.goto(URL + '/journal-entries', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Écritures de journal', { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('le champ date du modal "Nouvelle écriture" reflète la date locale, pas UTC', async () => {
    await page.click('button:has-text("Nouvelle écriture")')
    await page.waitForSelector('text=Nouvelle écriture de journal', { timeout: 5000 })
    const dateInput = page.locator('label:has-text("Date") + input[type="date"], input[type="date"]').first()
    const value = await dateInput.inputValue()
    assert.equal(value, '2026-05-25', `date par défaut devrait être 2026-05-25 (heure locale 23:00 EDT le 25), trouvé ${value}`)
    await page.keyboard.press('Escape')
  })
})
