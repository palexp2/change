const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Modale « Mapping Stripe » (/factures) : les libellés Stripe longs doivent être
// tronqués (mise en page uniforme, colonnes minmax(0,1fr)) avec un tooltip natif
// (attribut title) exposant le libellé complet. Le test ne clique jamais
// « Enregistrer » — seul le draft local est modifié, rien à nettoyer.
describe('Factures — modale mapping Stripe : troncature + tooltip', () => {
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

    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    await page.click('[data-testid="factures-stripe-map-open"]')
    await page.waitForSelector('[data-testid="stripemap-headers"]', { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  // Sélecteur des déclencheurs de select (exclut save/reset/menu portail)
  const TRIGGERS = 'button[data-testid^="stripemap-"]:not([data-testid$="-reset"]):not([data-testid="stripemap-save"])'

  async function triggerWidths() {
    return page.$$eval(TRIGGERS, els => els.map(el => el.getBoundingClientRect().width))
  }

  test('mise en page uniforme : tous les selects ont la même largeur, sans débordement du modal', async () => {
    const widths = await triggerWidths()
    assert.ok(widths.length >= 5, `au moins 5 lignes de mapping attendues (trouvé ${widths.length})`)
    const spread = Math.max(...widths) - Math.min(...widths)
    assert.ok(spread <= 2, `largeurs de selects non uniformes (écart ${spread.toFixed(1)}px) : ${widths.map(w => w.toFixed(1)).join(', ')}`)

    // Aucun select ne dépasse le bord droit du modal
    const overflow = await page.evaluate((sel) => {
      const modal = document.querySelector('[data-testid="stripemap-headers"]').closest('.bg-white')
      const right = modal.getBoundingClientRect().right
      return [...document.querySelectorAll(sel)]
        .filter(el => el.getBoundingClientRect().right > right + 1).length
    }, TRIGGERS)
    assert.equal(overflow, 0, 'aucun select ne doit déborder du modal')
  })

  test('champ Stripe long : texte tronqué, tooltip title avec libellé complet, largeurs intactes', async () => {
    const widthsBefore = await triggerWidths()

    // Sélectionner le candidat au libellé le plus long de « Date du document »
    // (status_transitions.finalized_at — date de finalisation). Draft local
    // seulement — on n'enregistre pas.
    await page.click('[data-testid="stripemap-document_date"]')
    await page.waitForSelector('[data-testid="stripemap-document_date-menu"]')
    const longOption = page.locator('[data-testid="stripemap-document_date-menu"] button[title*="status_transitions.finalized_at"]')
    const fullLabel = await longOption.getAttribute('title')
    assert.ok(fullLabel && fullLabel.length > 40, `libellé candidat long attendu (obtenu: ${fullLabel})`)
    await longOption.click()
    await page.waitForSelector('[data-testid="stripemap-document_date-menu"]', { state: 'detached' })

    const trigger = page.locator('[data-testid="stripemap-document_date"]')

    // Tooltip : le title du déclencheur expose le libellé complet
    assert.equal(await trigger.getAttribute('title'), fullLabel, 'le select doit porter le libellé complet en title (tooltip)')

    // Troncature réelle : le span interne est en overflow (ellipsis)
    const truncated = await trigger.locator('span').first().evaluate(el => ({
      clipped: el.scrollWidth > el.clientWidth + 1,
      ellipsis: getComputedStyle(el).textOverflow === 'ellipsis',
    }))
    assert.ok(truncated.ellipsis, 'le libellé sélectionné doit être stylé text-overflow: ellipsis')
    assert.ok(truncated.clipped, 'le libellé long doit être réellement tronqué (scrollWidth > clientWidth)')

    // La mise en page reste uniforme : aucune colonne ne s'est élargie
    const widthsAfter = await triggerWidths()
    assert.equal(widthsAfter.length, widthsBefore.length)
    widthsAfter.forEach((w, i) => {
      assert.ok(Math.abs(w - widthsBefore[i]) <= 2,
        `le select #${i} a changé de largeur après sélection d'un champ long (${widthsBefore[i].toFixed(1)} → ${w.toFixed(1)})`)
    })
  })

  test('bouton « Défaut : … » : tronqué dans sa colonne, tooltip avec le champ par défaut complet', async () => {
    // Après la sélection du test précédent, si le choix diffère du défaut le
    // bouton reset apparaît ; sinon on force un choix différent (period_start).
    let reset = page.locator('[data-testid="stripemap-document_date-reset"]')
    if (!(await reset.isVisible().catch(() => false))) {
      await page.click('[data-testid="stripemap-document_date"]')
      await page.waitForSelector('[data-testid="stripemap-document_date-menu"]')
      await page.click('[data-testid="stripemap-document_date-menu"] button[title*="period_start"]')
      await page.waitForSelector('[data-testid="stripemap-document_date-menu"]', { state: 'detached' })
      reset = page.locator('[data-testid="stripemap-document_date-reset"]')
    }
    await reset.waitFor({ state: 'visible', timeout: 3000 })

    const title = await reset.getAttribute('title')
    assert.ok(/défaut/i.test(title || ''), `title du reset doit mentionner le défaut complet (obtenu: ${title})`)

    // Le texte du reset est dans un span tronquable et le bouton reste dans sa colonne
    const info = await reset.evaluate(el => {
      const span = el.querySelector('span')
      const col = el.closest('.min-w-0')
      return {
        hasTruncSpan: !!span && getComputedStyle(span).textOverflow === 'ellipsis',
        fitsColumn: col ? el.getBoundingClientRect().width <= col.getBoundingClientRect().width + 1 : false,
      }
    })
    assert.ok(info.hasTruncSpan, 'le texte du bouton Défaut doit être dans un span text-overflow: ellipsis')
    assert.ok(info.fitsColumn, 'le bouton Défaut ne doit pas déborder de sa colonne')

    // Fermer sans enregistrer — le draft est jeté, aucune config modifiée
    await page.keyboard.press('Escape')
  })
})
