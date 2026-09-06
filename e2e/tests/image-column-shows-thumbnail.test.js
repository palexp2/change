const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Une colonne « Image » doit montrer l'image, jamais son URL. Les pièces jointes
// Airtable sont servies par des URL qui expirent en quelques heures (410 Gone) :
// la sync en garde donc une copie locale et stocke un chemin same-origin stable.
// Test 100 % lecture seule — aucun record créé ni modifié.
describe('Colonne Image — vignette et non URL', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
  })

  after(async () => { await browser?.close() })

  async function openAssemblages() {
    await page.goto(URL + '/assemblages', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 15000 })
    // Laisse le temps aux <img loading="lazy"> visibles de se décoder.
    await page.waitForTimeout(2500)
  }

  test('/assemblages affiche une colonne Image', async () => {
    await openAssemblages()
    const header = page.locator('text=/^Image$/i').first()
    await header.waitFor({ state: 'visible', timeout: 10000 })
  })

  test("la colonne Image rend des vignettes, pas l'URL en toutes lettres", async () => {
    await openAssemblages()

    // Prérequis : au moins un assemblage porte une image côté API.
    const withImage = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/assemblages?limit=50', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const d = await r.json()
      return (d.data || []).filter(a => a.image).length
    })
    assert.ok(withImage > 0, 'aucun assemblage avec image — impossible de vérifier la colonne')

    const thumbs = page.locator('[data-testid="cf-image-thumb"]')
    assert.ok(await thumbs.count() > 0, 'la colonne Image ne rend aucune vignette')

    // Le texte du tableau ne doit contenir aucune URL d'image en clair.
    const bodyText = await page.locator('body').innerText()
    assert.ok(!bodyText.includes('airtableusercontent'),
      "une URL d'attachment Airtable est affichée en toutes lettres")
    assert.ok(!/https?:\/\/\S+\.(png|jpe?g|webp|gif)/i.test(bodyText),
      "une URL d'image est affichée en toutes lettres")
  })

  test('les vignettes chargent réellement (source durable, pas une URL expirée)', async () => {
    await openAssemblages()

    const thumbs = page.locator('[data-testid="cf-image-thumb"]')
    const n = Math.min(await thumbs.count(), 5)
    assert.ok(n > 0, 'aucune vignette à vérifier')

    for (let i = 0; i < n; i++) {
      const img = thumbs.nth(i)
      const src = await img.getAttribute('src')
      assert.ok(src.startsWith('/'),
        `la vignette doit pointer vers une copie servie par l'app, pas une URL externe expirable (${src})`)
      const loaded = await img.evaluate(el => el.complete && el.naturalWidth > 0)
      assert.ok(loaded, `la vignette ${src} ne s'est pas chargée`)
    }

    // Aucune cellule ne doit être retombée sur le placeholder « image indisponible ».
    const broken = await page.locator('[data-testid="cf-image-unavailable"]').count()
    assert.equal(broken, 0, `${broken} cellule(s) Image affichent le placeholder au lieu de l'image`)
  })
})
