const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que "Copier le corps" écrit une version HTML dans le presse-papier où
// les URLs et emails sont enveloppés dans <a href="…">, pour que le coller
// dans Gmail/Outlook produise des liens cliquables.
describe('RelanceQualification — copie avec liens cliquables', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('markdown link [label](url) devient un vrai <a> sans crochets', async () => {
    await page.goto(`${URL}/relance-qualification`, { waitUntil: 'networkidle' })
    const card = page.locator('article').first()
    await card.waitFor({ timeout: 8000 })
    const body = card.locator('textarea.bg-slate-50').first()
    await body.waitFor({ timeout: 5000 })

    const label = 'Meet with Phil'
    const url = 'https://meetings.hubspot.com/philippe-chabot/meet-with-phil'
    const original = await body.inputValue()
    const newBody = `${original}\n\nYou can easily book a time that suits you here: [${label}](${url}).`
    await body.fill(newBody)

    const copyBtn = card.locator('button:has-text("Copier le corps")').first()
    await copyBtn.click()
    await card.locator('button:has-text("Copié")').first().waitFor({ timeout: 3000 })

    const clip = await page.evaluate(async () => {
      const items = await navigator.clipboard.read()
      const out = {}
      for (const it of items) {
        if (it.types.includes('text/html')) out.html = await (await it.getType('text/html')).text()
        if (it.types.includes('text/plain')) out.text = await (await it.getType('text/plain')).text()
      }
      return out
    })

    // HTML : vrai lien avec le label, pas de crochets ni parenthèses orphelins
    assert.ok(
      clip.html.includes(`<a href="${url}">${label}</a>`),
      `markdown link non transformé. HTML reçu: ${clip.html.slice(-400)}`
    )
    assert.ok(!clip.html.includes(`[${label}]`), `crochets résiduels dans le HTML: ${clip.html.slice(-200)}`)
    // L'URL ne doit pas être linkifiée DEUX fois (donc pas de <a> imbriqué)
    assert.ok(!/<a[^>]*><a/.test(clip.html), 'liens imbriqués détectés')

    // Plain text : "label (url)" sans les crochets
    assert.ok(
      clip.text.includes(`${label} (${url})`),
      `plain text non aplati: ${clip.text.slice(-200)}`
    )
    assert.ok(!clip.text.includes(`[${label}]`), `crochets résiduels en plain text: ${clip.text.slice(-200)}`)
  })

  test('URL et email injectés dans le corps deviennent <a> dans le HTML du presse-papier', async () => {
    await page.goto(`${URL}/relance-qualification`, { waitUntil: 'networkidle' })

    // Première carte d'email
    const card = page.locator('article').first()
    await card.waitFor({ timeout: 8000 })

    // Le corps est la 2e textarea de la carte (la 1re est "Instructions IA"
    // si visible ; mais le sélecteur ci-dessous cible la textarea du body
    // par sa classe bg-slate-50).
    const body = card.locator('textarea.bg-slate-50').first()
    await body.waitFor({ timeout: 5000 })

    // Injecter une URL + un email dans le corps
    const testUrl = 'https://orisha.io/demo'
    const testEmail = 'p.a.papillon@orisha.io'
    const original = await body.inputValue()
    const newBody = `${original}\n\nPlus d'info : ${testUrl}\nÉcris-moi : ${testEmail}`
    await body.fill(newBody)

    // Cliquer "Copier le corps"
    const copyBtn = card.locator('button:has-text("Copier le corps")').first()
    await copyBtn.click()
    // Attendre le badge "Copié"
    await card.locator('button:has-text("Copié")').first().waitFor({ timeout: 3000 })

    // Lire le presse-papier : text/html ET text/plain
    const clip = await page.evaluate(async () => {
      const items = await navigator.clipboard.read()
      const out = {}
      for (const it of items) {
        if (it.types.includes('text/html')) {
          const blob = await it.getType('text/html')
          out.html = await blob.text()
        }
        if (it.types.includes('text/plain')) {
          const blob = await it.getType('text/plain')
          out.text = await blob.text()
        }
      }
      return out
    })

    assert.ok(clip.html, 'clipboard text/html manquant')
    assert.ok(clip.text, 'clipboard text/plain manquant')

    // L'URL doit être dans un <a href="…">
    assert.ok(
      clip.html.includes(`<a href="${testUrl}">${testUrl}</a>`),
      `URL non transformée en lien. HTML reçu (extrait): ${clip.html.slice(0, 400)}`
    )
    // L'email doit être en mailto:
    assert.ok(
      clip.html.includes(`<a href="mailto:${testEmail}">${testEmail}</a>`),
      `Email non transformé en mailto. HTML reçu (extrait): ${clip.html.slice(0, 400)}`
    )
    // Les retours chariot doivent être convertis en <br>
    assert.ok(/<br>/.test(clip.html), 'retours chariot non convertis en <br>')

    // La version plain doit rester intacte (pas de balises HTML)
    assert.ok(clip.text.includes(testUrl), 'text/plain doit contenir l\'URL brute')
    assert.ok(!/<a /.test(clip.text), 'text/plain ne doit pas contenir de balise <a>')
  })
})
