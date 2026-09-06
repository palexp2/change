// Recharges de crédit Twilio : le libellé publié sur QuickBooks doit rester court
// (nature de la dépense uniquement), pas la phrase de provenance « Recharge auto
// détectée — banque Venn USD (…) » qui n'a rien à faire dans les livres.
// Test 100 % lecture seule : il n'écrit ni ne supprime aucun record.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const SHORT = 'Recharge de crédit Twilio'
const VERBOSE = 'Recharge auto détectée'

describe('Recharges Twilio — libellé QuickBooks court', () => {
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

  test('aucune dépense Twilio ne porte le libellé de provenance verbeux', async () => {
    const r = await apiFetch('/achats-fournisseurs?limit=all')
    assert.equal(r.status, 200)
    const twilio = (r.body?.data || []).filter(a => /twilio/i.test(a.vendor || ''))
    assert.ok(twilio.length > 0, 'aucune dépense Twilio trouvée')
    const verbeuses = twilio.filter(a => String(a.description || '').includes(VERBOSE))
    assert.deepEqual(verbeuses.map(a => `${a.date_achat} ${a.description}`), [],
      'des dépenses Twilio portent encore le libellé de provenance')
  })

  test('la dernière recharge détectée porte le libellé court', async () => {
    const r = await apiFetch('/achats-fournisseurs?limit=all')
    const recharges = (r.body?.data || [])
      .filter(a => /twilio/i.test(a.vendor || '') && String(a.description || '').startsWith('Recharge'))
      .sort((a, b) => String(b.date_achat).localeCompare(String(a.date_achat)))
    assert.ok(recharges.length > 0, 'aucune recharge Twilio détectée automatiquement')
    assert.equal(recharges[0].description, SHORT)
    assert.ok(recharges[0].quickbooks_id, 'la recharge devrait être publiée sur QuickBooks')
    // Le même libellé doit partir dans le champ « Memo » de QuickBooks, pas
    // seulement sur la description de la ligne.
    assert.equal(recharges[0].qb_memo, SHORT)
    // « Comptant » → PaymentType 'Cash' → DÉPENSE dans QuickBooks. « Chèque » ou
    // « Virement » en feraient un CHÈQUE, ce qui n'est pas la nature de l'opération.
    assert.equal(recharges[0].payment_method, 'Comptant')
  })

  test('toutes les recharges Twilio sont comptabilisées en dépense, jamais en chèque', async () => {
    const r = await apiFetch('/achats-fournisseurs?limit=all')
    const cheques = (r.body?.data || [])
      .filter(a => /twilio/i.test(a.vendor || '') && a.payment_method === 'Chèque')
    assert.deepEqual(cheques.map(a => `${a.date_achat} ${a.quickbooks_id}`), [])
  })

  // Recherche seulement (pas de filtre sauvegardé, pas d'ouverture de fiche) :
  // la barre de recherche de la liste balaie le champ `description`, donc elle
  // prouve le libellé stocké sans dépendre des colonnes visibles.
  test('la liste des achats retrouve le libellé court et plus le verbeux', async () => {
    await page.goto(URL + '/fournisseurs/achats', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Achats fournisseurs")', { timeout: 20000 })
    const search = page.locator('input[placeholder="Rechercher..."]').first()
    await search.waitFor({ timeout: 20000 })

    // La liste se remplit page par page (loadProgressive) : on laisse le temps au
    // chargement complet avant de conclure sur une absence.
    await search.fill(SHORT)
    await page.waitForFunction(() => document.body.innerText.includes('Twilio'), null, { timeout: 60000 })
      .catch(() => { throw new Error('la recherche du libellé court ne retrouve aucune recharge Twilio') })

    await search.fill(VERBOSE)
    await page.waitForTimeout(1500)
    assert.ok(!(await page.locator('body').innerText()).includes('Twilio'),
      'le libellé de provenance verbeux existe encore sur un achat Twilio')
    await search.fill('')
  })
})
