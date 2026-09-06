// Anomalies transactions (/comptabilite) : les messages doivent rester courts.
// Le type d'anomalie est déjà porté par l'étiquette de couleur à gauche — le texte
// ne le répète plus et n'explique plus la marche à suivre en trois phrases.
// Lecture seule : aucun record créé ni modifié.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Tournures retirées : elles rallongeaient le message sans rien apprendre.
const VERBOSE = [
  /Ce n'est PAS un document/i,
  /Il peut être archivé/i,
  /Doublon probable :/i,
  /Doublon possible :/i,
  /Déjà comptabilisée dans QuickBooks :/i,
  /Peut-être déjà comptabilisée dans QuickBooks/i,
  /Ne pas la publier une seconde fois/i,
  /L'écriture existante est déjà payée/i,
  /exposerait à un double paiement/i,
  /Montant inhabituel :/i,
  /Devise inhabituelle :/i,
  /Vérifier que les montants ne sont pas dans la mauvaise devise/i,
  /Lien QuickBooks périmé :/i,
  /Écriture disparue de QuickBooks :/i,
  /se dit publiée sous/i,
  /jour\(s\) d'écart/i,
]

const MAX_LEN = 200

describe('Anomalies transactions — messages concis', () => {
  let browser, ctx, page

  const apiFetch = (path) => page.evaluate(async (path) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, { headers: { Authorization: `Bearer ${tok}` } })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, path)

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('la section anomalies du dashboard compta affiche des textes courts', async () => {
    await page.goto(URL + '/comptabilite', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="compta-anomalies"]', { state: 'attached', timeout: 20000 })
    const section = page.locator('[data-testid="compta-anomalies"]')
    // Le chargement de la liste est asynchrone : attendre soit des lignes, soit le vide.
    await section.locator('li, p:has-text("Aucune anomalie")').first().waitFor({ timeout: 20000 })

    const texts = await section.locator('li p.text-sm').allInnerTexts()
    for (const t of texts) {
      assert.ok(t.length <= MAX_LEN, `message trop long (${t.length} car.) : ${t}`)
      for (const re of VERBOSE) assert.ok(!re.test(t), `tournure verbeuse ${re} dans : ${t}`)
    }
  })

  test('tous les messages d\'anomalies servis par l\'API sont concis', async () => {
    const r = await apiFetch('/anomalies?status=all')
    assert.equal(r.status, 200)
    const rows = r.body?.data || []
    // Seules les anomalies ouvertes sont affichées ; les rejetées/résolues gardent
    // leur texte d'origine jusqu'au prochain scan, on ne les juge pas.
    const open = rows.filter(a => a.status === 'open')
    for (const a of open) {
      assert.ok(a.message.length <= MAX_LEN, `[${a.kind}] message trop long (${a.message.length}) : ${a.message}`)
      for (const re of VERBOSE) assert.ok(!re.test(a.message), `[${a.kind}] tournure verbeuse ${re} : ${a.message}`)
    }
  })
})
