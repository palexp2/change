// Vérifie que les fiches détail affichent un état d'erreur visible avec bouton
// « Réessayer » quand le GET de la fiche échoue (réponse HTTP 500 applicative),
// au lieu d'un spinner infini, d'une page vide ou d'un faux « introuvable ».
//
// Couvre les 4 fiches d'origine (Order/Product/Company/Contact) + les fiches
// étendues au même pattern : Facture, Reçu de vente, Soumission, Retour, Envoi,
// Employé, Achat, Payout Stripe, Projet, Billet, Numéro de série.
//
// Important : on renvoie un 500 JSON (pas un abort réseau). api.js appelle
// markOnline() sur toute réponse HTTP reçue → l'overlay global « Connexion au
// serveur perdue » ne s'affiche PAS ; c'est l'état par-page (catch dans load())
// qui doit prendre le relais. Un abort réseau, lui, déclenche l'overlay global
// (testé ailleurs : server-offline-overlay.test.js).
//
// Lecture seule : aucune fiche n'est créée ni mutée (on n'intercepte que le GET
// côté navigateur), donc pas de cleanup de records ni de restauration de config.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login() {
  const r = await fetch(`${URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  })
  if (!r.ok) throw new Error(`Login failed: ${r.status}`)
  const { token } = await r.json()
  return token
}

// Récupère le premier id existant via l'endpoint list. Retourne null si la
// ressource est vide (le test correspondant est alors ignoré, pas en échec).
async function firstId(token, listPath, idField = 'id') {
  const sep = listPath.includes('?') ? '&' : '?'
  const r = await fetch(`${URL}/api${listPath}${sep}limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!r.ok) return null
  const j = await r.json()
  const row = (j.data || [])[0]
  return row ? (row[idField] ?? null) : null
}

// name      — libellé du cas
// list      — endpoint list pour piocher un id existant
// route     — chemin client de la fiche détail (sous /erp)
// api       — chemin du GET de la fiche à faire échouer (sans query)
// idField   — champ id à lire dans la liste (stripe-payouts = stripe_id)
const CASES = [
  { name: 'orders',         list: '/orders',                route: (id) => `orders/${id}`,         api: (id) => `/erp/api/orders/${id}` },
  { name: 'products',       list: '/products',              route: (id) => `products/${id}`,        api: (id) => `/erp/api/products/${id}` },
  { name: 'companies',      list: '/companies',             route: (id) => `companies/${id}`,       api: (id) => `/erp/api/companies/${id}` },
  { name: 'contacts',       list: '/contacts',              route: (id) => `contacts/${id}`,        api: (id) => `/erp/api/contacts/${id}` },
  { name: 'factures',       list: '/projets/factures',      route: (id) => `factures/${id}`,        api: (id) => `/erp/api/projets/factures/${id}` },
  { name: 'sale-receipts',  list: '/sale-receipts',         route: (id) => `sale-receipts/${id}`,   api: (id) => `/erp/api/sale-receipts/${id}` },
  { name: 'soumissions',    list: '/documents/soumissions', route: (id) => `soumissions/${id}`,     api: (id) => `/erp/api/documents/soumissions/${id}` },
  { name: 'retours',        list: '/projets/retours',       route: (id) => `retours/${id}`,         api: (id) => `/erp/api/projets/retours/${id}` },
  { name: 'envois',         list: '/shipments',             route: (id) => `envois/${id}`,          api: (id) => `/erp/api/shipments/${id}` },
  { name: 'employees',      list: '/employees',             route: (id) => `employees/${id}`,       api: (id) => `/erp/api/employees/${id}` },
  { name: 'purchases',      list: '/purchases',             route: (id) => `purchases/${id}`,       api: (id) => `/erp/api/purchases/${id}` },
  { name: 'stripe-payouts', list: '/stripe-payouts',        route: (id) => `stripe-payouts/${id}`,  api: (id) => `/erp/api/stripe-payouts/${id}`, idField: 'stripe_id' },
  { name: 'projects',       list: '/projects',              route: (id) => `projects/${id}`,        api: (id) => `/erp/api/projects/${id}` },
  { name: 'tickets',        list: '/tickets',               route: (id) => `tickets/${id}`,         api: (id) => `/erp/api/tickets/${id}` },
  { name: 'serials',        list: '/serials',               route: (id) => `serials/${id}`,         api: (id) => `/erp/api/serials/${id}` },
]

describe('Fiches détail — état d\'erreur de chargement + Réessayer', () => {
  let token, browser, ctx
  const ids = {}

  before(async () => {
    token = await login()
    for (const c of CASES) {
      ids[c.name] = await firstId(token, c.list, c.idField || 'id')
    }
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    // Token injecté dans chaque page (lecture seule : aucun record créé/muté).
    await ctx.addInitScript((t) => localStorage.setItem('erp_token', t), token)
  })

  after(async () => { await browser?.close() })

  for (const c of CASES) {
    test(`${c.name} : 500 → état d'erreur visible, puis Réessayer recharge`, async (t) => {
      const id = ids[c.name]
      if (!id) {
        t.skip(`aucun record ${c.name} en DB`)
        return
      }
      const detailPath = c.api(id)
      const page = await ctx.newPage()
      try {
        // 1. Forcer un échec HTTP 500 (JSON applicatif) sur le GET de la fiche
        //    exacte. On laisse passer les sous-ressources (/.../discounts, etc.).
        let failing = true
        await page.route(`**${detailPath}**`, (route) => {
          const path = route.request().url().split('?')[0]
          if (failing && path.endsWith(detailPath)) {
            return route.fulfill({
              status: 500,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'Erreur simulée (test E2E)' }),
            })
          }
          return route.continue()
        })

        // 2. Naviguer vers la fiche.
        await page.goto(`${URL}/${c.route(id)}`, { waitUntil: 'domcontentloaded' })

        // 3. L'état d'erreur par-page apparaît avec un bouton Réessayer.
        await page.waitForSelector('text=Impossible de charger cette fiche', { timeout: 10000 })
        const retryBtn = await page.waitForSelector('button:has-text("Réessayer")', { timeout: 5000 })
        assert.ok(retryBtn, 'bouton Réessayer visible')

        // 4. L'overlay global « serveur perdu » ne doit PAS s'afficher (markOnline).
        const body = await page.textContent('body')
        assert.ok(
          !body.includes('Connexion au serveur perdue'),
          'overlay global ne doit pas masquer l\'état par-page',
        )

        // 5. Lever la panne et cliquer Réessayer → la fiche se charge.
        failing = false
        await retryBtn.click()
        await page.waitForFunction(
          () => !document.body.textContent.includes('Impossible de charger cette fiche'),
          { timeout: 10000 },
        )
        const after = await page.textContent('body')
        assert.ok(
          !after.includes('Impossible de charger cette fiche'),
          'l\'état d\'erreur disparaît après rechargement réussi',
        )
      } finally {
        await page.close()
      }
    })
  }
})
