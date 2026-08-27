// Sondage de satisfaction — page publique /s/:token.
//
// PORTÉE DÉLIBÉRÉMENT LIMITÉE : ce test ne clique JAMAIS sur le bouton d'envoi
// et ne crée aucun sondage. Créer un sondage exige un envoi, et le serveur
// déployé tourne en NODE_ENV de production : un envoi ici ferait partir un
// vrai SMS vers le téléphone d'un vrai client. Les tests unitaires
// (server/src/services/ticketSurveys.test.js) couvrent la logique d'envoi ;
// ici on vérifie ce qui est vérifiable sans effet de bord :
//
//   • la route publique existe et rend la page sans authentification
//   • un jeton inconnu donne un message propre, pas une page blanche ni un 500
//   • l'API publique répond 404 sur un jeton inconnu, sans fuiter d'information
//   • le bouton d'envoi est présent dans la fiche d'un billet
//
// Le parcours étoiles → question de rappel → commentaire se valide à la main
// avec un vrai envoi vers son propre cellulaire.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const BOGUS_TOKEN = 'ZzTestInvalid9'

describe('Sondage de satisfaction — page publique', () => {
  let browser, page

  before(async () => {
    browser = await chromium.launch()
    page = await browser.newPage()
  })

  after(async () => {
    if (browser) await browser.close()
  })

  test('jeton inconnu → message « Lien invalide », sans authentification', async () => {
    // Contexte neuf : aucune session, on vérifie vraiment l'accès public.
    const ctx = await browser.newContext()
    const p = await ctx.newPage()
    await p.goto(`${URL}/s/${BOGUS_TOKEN}`, { waitUntil: 'networkidle' })

    assert.ok(!p.url().includes('/login'), 'la page publique ne doit jamais rediriger vers /login')
    await p.waitForSelector('text=Lien invalide', { timeout: 10000 })
    await ctx.close()
  })

  test("l'API publique répond 404 sur un jeton inconnu", async () => {
    const ctx = await browser.newContext()
    const p = await ctx.newPage()
    const res = await p.request.get(`${URL}/api/public/ticket-survey/${BOGUS_TOKEN}`)
    assert.equal(res.status(), 404)
    const body = await res.json()
    // 404 indifférencié : aucune donnée client ne doit transiter.
    assert.ok(!('phone' in body) && !('contact_id' in body))
    await ctx.close()
  })

  test('le webhook Telnyx refuse une requête non signée', async () => {
    const ctx = await browser.newContext()
    const p = await ctx.newPage()
    const res = await p.request.post(`${URL}/api/hooks/telnyx/dlr`, { data: {} })
    assert.equal(res.status(), 401)
    await ctx.close()
  })

  test("le bouton de sondage est présent dans la fiche d'un billet", async () => {
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    const ticketId = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/tickets?limit=1', { headers: { Authorization: `Bearer ${tok}` } })
      const j = await r.json()
      return j.data?.[0]?.id || null
    })
    assert.ok(ticketId, 'au moins un billet attendu')

    await page.goto(`${URL}/tickets/${ticketId}`, { waitUntil: 'networkidle' })
    // Lecture seule : on constate la présence du bouton, on ne le clique pas.
    await page.waitForSelector('[data-testid="ticket-survey-button"]', { timeout: 10000 })
  })
})
