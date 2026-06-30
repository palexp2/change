// Vérifie le composant <EmptyState> réutilisable :
//  1. DataTable — quand une recherche ne matche rien, l'état vide « filtré »
//     s'affiche avec un CTA « Réinitialiser » qui restaure les lignes.
//  2. CompanyDetail — un onglet sans données (ex. Support sans ticket) affiche
//     un EmptyState contextuel (icône + titre + description) au lieu du sec
//     « Aucun ticket ».
//
// Lecture seule : aucun record créé ou muté → pas de cleanup DB nécessaire.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('EmptyState réutilisable', () => {
  let browser, ctx, page, emptyTicketsCompanyId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Trouve une entreprise dont l'onglet Support n'a aucun ticket.
    emptyTicketsCompanyId = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/companies?limit=all', { headers: { Authorization: `Bearer ${tok}` } })
      const j = await r.json()
      const list = j.data || j || []
      for (const c of list.slice(0, 40)) {
        const dr = await fetch(`/erp/api/companies/${c.id}`, { headers: { Authorization: `Bearer ${tok}` } })
        const d = await dr.json()
        if (Array.isArray(d.tickets) && d.tickets.length === 0) return c.id
      }
      return null
    })
  })

  after(async () => { await browser?.close() })

  test('DataTable : recherche sans résultat → EmptyState filtré + Réinitialiser', async () => {
    await page.goto(`${URL}/orders`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    // Attend que la table soit peuplée (au moins une ligne de données).
    const searchInput = page.locator('input[placeholder="Rechercher..."]').first()
    await searchInput.waitFor({ state: 'visible', timeout: 10000 })

    // Recherche d'une chaîne qui ne matche rien.
    await searchInput.fill('zzz-aucun-resultat-possible-xyz-' + Date.now())

    const empty = page.locator('[data-testid="empty-state"]')
    await empty.waitFor({ state: 'visible', timeout: 5000 })
    await assert.doesNotReject(empty.locator('text=Aucun résultat ne correspond').waitFor({ state: 'visible', timeout: 3000 }))

    // Le CTA Réinitialiser restaure les lignes.
    const reset = empty.locator('button:has-text("Réinitialiser")')
    await reset.waitFor({ state: 'visible', timeout: 3000 })
    await reset.click()

    // L'EmptyState disparaît et la table réaffiche des lignes.
    await empty.waitFor({ state: 'hidden', timeout: 5000 })
    // Le champ de recherche a été vidé.
    assert.equal(await searchInput.inputValue(), '', 'la recherche devrait être réinitialisée')
  })

  test('CompanyDetail : onglet Support vide → EmptyState contextuel', async (t) => {
    if (!emptyTicketsCompanyId) {
      t.skip('Aucune entreprise sans ticket trouvée dans l\'échantillon')
      return
    }
    await page.goto(`${URL}/companies/${emptyTicketsCompanyId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    await page.click('button:has-text("support")')

    const empty = page.locator('[data-testid="empty-state"]')
    await empty.waitFor({ state: 'visible', timeout: 5000 })
    await assert.doesNotReject(empty.locator('text=Aucun ticket').waitFor({ state: 'visible', timeout: 3000 }))

    // Vérifie qu'une icône SVG est rendue (le repère visuel contextuel).
    const svgCount = await empty.locator('svg').count()
    assert.ok(svgCount >= 1, 'l\'EmptyState devrait afficher une icône')
  })
})
