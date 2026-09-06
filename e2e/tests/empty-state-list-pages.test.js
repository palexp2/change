// Vérifie les empty states contextuels ajoutés aux pages-listes DataTable.
//
//  1. Pages chargées via loadProgressive (api.X.list) : on intercepte l'endpoint
//     pour renvoyer une liste vide, puis on vérifie que le <DataTable> rend
//     l'EmptyState CONTEXTUEL (titre métier + icône + CTA), et non le générique
//     « Aucune donnée ».
//  2. Companies : le CTA « Nouvelle entreprise » de l'empty state ouvre bien la
//     modale de création.
//  3. Smoke : les pages basées sur useTable (qui ont des données réelles) rendent
//     toujours leur DataTable sans erreur après l'ajout des imports/props.
//
// Lecture seule : interception réseau côté navigateur uniquement, aucun record
// créé ni muté en DB → pas de cleanup nécessaire. La modale Companies est ouverte
// puis refermée (Échap) sans enregistrer.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Pages chargées via loadProgressive → interceptables au niveau réseau.
const LP_PAGES = [
  { route: '/companies',           api: '**/api/companies?*',           title: 'Aucune entreprise',        cta: 'Nouvelle entreprise' },
  { route: '/envois',              api: '**/api/shipments?*',           title: 'Aucun envoi',              cta: 'Nouvel envoi' },
  { route: '/achats-fournisseurs', api: '**/api/achats-fournisseurs?*', title: 'Aucun achat fournisseur',  cta: 'Nouvelle facture fournisseur' },
  { route: '/sale-receipts',       api: '**/api/sale-receipts?*',       title: 'Aucun reçu de vente',      cta: 'Prendre en photo' },
  { route: '/factures',            api: '**/api/projets/factures?*',    title: 'Aucune facture',           cta: null },
  { route: '/abonnements',         api: '**/api/projets/abonnements?*', title: 'Aucun abonnement',         cta: null },
]

// Pages basées sur useTable (données réelles) → simple smoke render.
const SMOKE_PAGES = [
  { route: '/orders',    label: 'Commandes' },
  { route: '/products',  label: 'Produits' },
  { route: '/tickets',   label: 'Billets' },
  { route: '/retours',   label: 'Retours' },
  { route: '/purchases', label: 'Achats' },
]

describe('Empty states contextuels — pages-listes DataTable', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  for (const p of LP_PAGES) {
    test(`${p.route} : liste vide → EmptyState contextuel « ${p.title} »`, async () => {
      // Force l'endpoint de liste à renvoyer une collection vide.
      await page.route(p.api, route =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: [], total: 0 }),
        }),
      )
      try {
        await page.goto(URL + p.route, { waitUntil: 'domcontentloaded' })
        await page.waitForLoadState('networkidle')

        const empty = page.locator('[data-testid="empty-state"]')
        await empty.waitFor({ state: 'visible', timeout: 10000 })

        // Titre contextuel métier (pas le générique « Aucune donnée »).
        // exact:true cible le <p> titre et non la description qui peut commencer
        // par le même libellé (« Aucune facture n'a encore… »).
        await assert.doesNotReject(
          empty.getByText(p.title, { exact: true }).first().waitFor({ state: 'visible', timeout: 4000 }),
          `le titre contextuel « ${p.title} » devrait s'afficher`,
        )

        // Icône contextuelle présente.
        assert.ok(await empty.locator('svg').count() >= 1, "l'EmptyState devrait afficher une icône")

        // CTA de création le cas échéant.
        if (p.cta) {
          await assert.doesNotReject(
            empty.locator(`button:has-text("${p.cta}")`).waitFor({ state: 'visible', timeout: 4000 }),
            `le CTA « ${p.cta} » devrait s'afficher`,
          )
        }
      } finally {
        await page.unroute(p.api)
      }
    })
  }

  test('/companies : le CTA de l\'empty state ouvre la modale de création', async () => {
    const api = '**/api/companies?*'
    await page.route(api, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], total: 0 }) }),
    )
    try {
      await page.goto(URL + '/companies', { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle')

      const empty = page.locator('[data-testid="empty-state"]')
      await empty.waitFor({ state: 'visible', timeout: 10000 })

      await empty.locator('button:has-text("Nouvelle entreprise")').click()

      // La modale de création s'ouvre (role=dialog).
      const dialog = page.locator('[role="dialog"]')
      await dialog.waitFor({ state: 'visible', timeout: 5000 })
      await assert.doesNotReject(
        dialog.locator('text=Nouvelle entreprise').first().waitFor({ state: 'visible', timeout: 3000 }),
      )

      // Referme sans enregistrer (lecture seule, aucun record créé).
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden', timeout: 5000 })
    } finally {
      await page.unroute(api)
    }
  })

  for (const p of SMOKE_PAGES) {
    test(`${p.route} : la page rend son DataTable sans erreur`, async () => {
      await page.goto(URL + p.route, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle')
      // La barre d'outils DataTable (champ de recherche) doit être présente :
      // confirme que les nouveaux imports/props n'ont pas cassé le rendu.
      const search = page.locator('input[placeholder="Rechercher..."]').first()
      await search.waitFor({ state: 'visible', timeout: 10000 })
      assert.ok(await search.isVisible(), `${p.label} : la barre de recherche DataTable devrait être visible`)
    })
  }
})
