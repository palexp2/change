const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que le prénom du contact de l'entreprise est utilisé pour la
// personnalisation du courriel de relance (template statique). S'il y a
// plusieurs contacts pour une entreprise, on prend le plus ancien (ORDER BY
// created_at ASC LIMIT 1). Fallback sur decision_maker_name si pas de contact.
//
// Pas de cleanup : test en lecture seule (on lit l'API et on vérifie l'UI).
describe('RelanceQualification — prénom du contact', () => {
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
    await browser?.close()
  })

  test('API renvoie le champ contact (1er contact de la company)', async () => {
    const data = await page.evaluate(async (tk) => {
      const r = await fetch('/erp/api/email-relance/qualification-calls', {
        headers: { Authorization: 'Bearer ' + tk },
      })
      return r.json()
    }, token)

    const list = data.data || []
    assert.ok(list.length > 0, 'la liste doit avoir au moins une entrée')

    // Au moins un item doit avoir un contact (sinon la feature n'a pas d'effet
    // dans cette DB, mais on peut vérifier que la clé existe quand même).
    const withContact = list.filter(it => it.contact && it.contact.first_name)
    assert.ok(withContact.length > 0,
      'au moins une entrée doit avoir un contact avec first_name pour pouvoir tester')

    // Pour chaque item avec contact, le template du courriel doit contenir le
    // prénom du contact dans la salutation (Bonjour X, ou Hi X,).
    for (const it of withContact.slice(0, 5)) {
      const firstName = it.contact.first_name.trim().split(/\s+/)[0]
      const body = it.template.body
      const greetingFR = `Bonjour ${firstName},`
      const greetingEN = `Hi ${firstName},`
      const matches = body.includes(greetingFR) || body.includes(greetingEN)
      assert.ok(matches,
        `Le template de ${it.company.name} devrait inclure "${greetingFR}" ou "${greetingEN}". Body: ${body.slice(0, 120)}…`)
    }
  })

  test("UI affiche le nom du contact dans l'entête de carte", async () => {
    await page.goto(`${URL}/relance-qualification`, { waitUntil: 'networkidle' })
    await page.locator('article').first().waitFor({ timeout: 8000 })

    // Cherche au moins une carte avec "Contact :" dans l'entête. Le label est
    // présent dès qu'il y a un contact lié à la company.
    const contactSpans = page.locator('article >> text=/^Contact :/')
    const count = await contactSpans.count()
    assert.ok(count > 0,
      'au moins une carte doit afficher "Contact : ..." dans son entête')

    // Vérifie que le contact est rendu comme un lien (Link vers /contacts/:id)
    const firstLink = page.locator('article a[href*="/contacts/"]').first()
    await firstLink.waitFor({ timeout: 3000 })
    const href = await firstLink.getAttribute('href')
    assert.match(href, /\/contacts\/.+/, 'le contact doit être un lien vers /contacts/:id')
  })
})
