const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

describe('Dashboard — Billets par mois (YoY + toggle)', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('le widget s\'affiche avec 12 mois et la légende des deux périodes', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    const card = page.locator('.card').filter({ has: page.locator('h2:has-text("Billets par mois")') })
    await card.waitFor({ state: 'visible', timeout: 8000 })

    const cardText = await card.innerText()
    assert.ok(cardText.includes('12 derniers mois'), `Devrait mentionner « 12 derniers mois ». Reçu: ${cardText.slice(0, 300)}`)
    assert.ok(cardText.includes('12 mois précédents'), `Devrait mentionner « 12 mois précédents ». Reçu: ${cardText.slice(0, 300)}`)

    // 12 mois rendus
    const monthGroups = card.locator('[data-testid^="tickets-month-"]')
    const count = await monthGroups.count()
    assert.equal(count, 12, `Devrait afficher 12 mois, reçu ${count}`)

    // Les deux boutons de toggle existent
    await assert.doesNotReject(card.locator('[data-testid="tickets-metric-count"]').waitFor({ state: 'visible', timeout: 2000 }))
    await assert.doesNotReject(card.locator('[data-testid="tickets-metric-minutes"]').waitFor({ state: 'visible', timeout: 2000 }))
  })

  test('basculer le toggle change la métrique affichée', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    const card = page.locator('.card').filter({ has: page.locator('h2:has-text("Billets par mois")') })
    await card.waitFor({ state: 'visible', timeout: 8000 })

    const totalCurr = card.locator('[data-testid="tickets-total-curr"]')
    const totalPrev = card.locator('[data-testid="tickets-total-prev"]')

    // Lecture initiale (count)
    const countCurr = (await totalCurr.textContent())?.trim() || ''
    const countPrev = (await totalPrev.textContent())?.trim() || ''

    // En mode count, le total doit être un entier nu (pas de "h" ni "m")
    assert.match(countCurr, /^\d+$/, `Le total en mode "Billets" devrait être un entier. Reçu: ${countCurr}`)

    // Passe en mode minutes
    await card.locator('[data-testid="tickets-metric-minutes"]').click()
    await page.waitForTimeout(150)

    const minCurr = (await totalCurr.textContent())?.trim() || ''
    const minPrev = (await totalPrev.textContent())?.trim() || ''

    // En mode minutes, le format est soit "<n>m" (sub-1h) soit "<h>h" / "<h>h<mm>" (>=1h) soit "0"
    assert.match(minCurr, /^(0|\d+m|\d+h(\d{2})?)$/, `Le total en mode "Temps" devrait être au format minutes/heures. Reçu: ${minCurr}`)

    // Au moins une des deux totaux doit avoir changé entre les deux modes (sauf si tout est à 0,
    // auquel cas count=='0' et minutes=='0' — on tolère l'égalité dans ce cas)
    const allZero = countCurr === '0' && countPrev === '0' && minCurr === '0' && minPrev === '0'
    if (!allZero) {
      const changed = countCurr !== minCurr || countPrev !== minPrev
      assert.ok(changed, `Le toggle devrait changer l'affichage. count=${countCurr}/${countPrev} minutes=${minCurr}/${minPrev}`)
    }

    // Retour en mode count
    await card.locator('[data-testid="tickets-metric-count"]').click()
    await page.waitForTimeout(150)
    const backCurr = (await totalCurr.textContent())?.trim() || ''
    assert.equal(backCurr, countCurr, `Le retour en mode "Billets" devrait restaurer le total initial`)
  })
})
