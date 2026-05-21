// Bouton "Générer les documents" sur OrderDetail.
// Fusionne en un PDF les copies locales (lien_pdf_*_local) selon item_type
// (Remplacement → remplacement, sinon → installation) et la langue du contact
// à la ferme (orders.langue_du_contact_a_la_ferme).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('OrderDetail — Générer les documents (fusion PDF local)', () => {
  let browser, ctx, page, eligibleOrderId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Trouve une commande non-supprimée qui contient au moins un item dont le produit
    // a un lien_pdf_installation_*_local OU lien_pdf_remplacement_*_local renseigné.
    eligibleOrderId = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const list = await fetch('/erp/api/orders?limit=all', {
        headers: { Authorization: `Bearer ${tok}` },
      }).then(r => r.json())
      const orders = list.data || list
      // On essaie les plus récentes en premier (plus de chances d'avoir des produits courants)
      for (const o of orders) {
        const full = await fetch(`/erp/api/orders/${o.id}`, {
          headers: { Authorization: `Bearer ${tok}` },
        }).then(r => r.json())
        const items = full.items || []
        if (items.length === 0) continue
        // Récupère les products référencés
        const productIds = [...new Set(items.map(i => i.product_id).filter(Boolean))]
        const products = await Promise.all(productIds.map(pid =>
          fetch(`/erp/api/products/${pid}`, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json())
        ))
        const hasAnyLocal = products.some(p =>
          p.lien_pdf_installation_fr_local || p.lien_pdf_installation_en_local ||
          p.lien_pdf_remplacement_fr_local || p.lien_pdf_remplacement_en_local
        )
        if (hasAnyLocal) return o.id
      }
      return null
    })
  })

  after(async () => { await browser?.close() })

  test('Route POST /api/orders/:id/generate-installation-docs retourne un PDF non vide', async () => {
    if (!eligibleOrderId) return console.warn('  (skip — aucune commande avec items ayant des PDFs locaux)')
    const result = await page.evaluate(async (id) => {
      const tok = localStorage.getItem('erp_token')
      const res = await fetch(`/erp/api/orders/${id}/generate-installation-docs`, {
        method: 'POST', headers: { Authorization: `Bearer ${tok}` },
      })
      const contentType = res.headers.get('content-type')
      const included = parseInt(res.headers.get('x-docs-included') || '0', 10)
      const skipped = parseInt(res.headers.get('x-docs-skipped') || '0', 10)
      if (res.status === 409) {
        return { status: 409, contentType, included, skipped, body: await res.json() }
      }
      const ab = await res.arrayBuffer()
      // Header PDF = "%PDF-"
      const first5 = new TextDecoder().decode(ab.slice(0, 5))
      return { status: res.status, contentType, included, skipped, bytes: ab.byteLength, header: first5 }
    }, eligibleOrderId)

    if (result.status === 409) {
      // Tous les *_local existants en DB pointent peut-être vers des fichiers absents
      console.warn(`  (skip — 409 "aucun document local disponible". included=${result.included} skipped=${result.skipped})`)
      return
    }
    assert.strictEqual(result.status, 200, `Status attendu 200 ou 409, reçu ${result.status}`)
    assert.match(result.contentType || '', /^application\/pdf/, 'Content-Type doit être PDF')
    assert.ok(result.bytes > 1000, `PDF doit faire au moins 1 KB, reçu ${result.bytes} bytes`)
    assert.strictEqual(result.header, '%PDF-', 'Le contenu doit commencer par "%PDF-"')
    assert.ok(result.included >= 1, `X-Docs-Included doit être >= 1, reçu ${result.included}`)
  })

  test('UI : bouton "Générer les documents" présent quand il y a des items prêts, au-dessus de "Créer un envoi"', async () => {
    // Cible une commande qui a au moins un item Prélevé. Cherche dans les 100 plus récentes
    // pour rester rapide (au lieu de fetcher chacune des centaines de commandes).
    const targetOrderId = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const list = await fetch('/erp/api/orders?limit=100', {
        headers: { Authorization: `Bearer ${tok}` },
      }).then(r => r.json())
      const orders = (list.data || list).slice(0, 100)
      // Parallel fetch (jusqu'à 100) pour gagner du temps
      const fulls = await Promise.all(orders.map(o =>
        fetch(`/erp/api/orders/${o.id}`, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json())
      ))
      const match = fulls.find(f => (f.items || []).some(i => i.fulfillment_status === 'Prélevé'))
      return match?.id || null
    })
    if (!targetOrderId) return console.warn('  (skip — aucune commande récente avec items "Prélevé")')

    await page.goto(`${URL}/orders/${targetOrderId}`, { waitUntil: 'networkidle' })
    // Le bouton ne s'affiche qu'en "Mode expédition" (vue picker). Basculer.
    await page.click('button:has-text("Mode expédition")')
    // Attendre que la section "Sur la table" soit rendue (signal que picked items sont chargés)
    await page.locator('h2:has-text("Sur la table")').waitFor({ state: 'visible', timeout: 10000 })
    const btn = page.locator('button:has-text("Générer les documents")')
    await btn.waitFor({ state: 'visible', timeout: 5000 })
    // Le bouton doit précéder "Créer un envoi" dans le DOM
    const createBtn = page.locator('button:has-text("Créer un envoi")').first()
    const order = await page.evaluate(([a, b]) => {
      // eslint-disable-next-line no-bitwise
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 'before' : 'after'
    }, [await btn.elementHandle(), await createBtn.elementHandle()])
    assert.strictEqual(order, 'before', `"Générer les documents" doit précéder "Créer un envoi"`)
  })
})
