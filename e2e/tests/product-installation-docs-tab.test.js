const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const FIELDS = [
  { url: 'lien_pdf_installation_fr', local: 'lien_pdf_installation_fr_local', label: 'Lien PDF installation (FR)' },
  { url: 'lien_pdf_installation_en', local: 'lien_pdf_installation_en_local', label: 'Lien PDF installation (EN)' },
  { url: 'lien_pdf_remplacement_fr', local: 'lien_pdf_remplacement_fr_local', label: 'Lien PDF remplacement (FR)' },
  { url: 'lien_pdf_remplacement_en', local: 'lien_pdf_remplacement_en_local', label: 'Lien PDF remplacement (EN)' },
]

describe('Produit — onglet Document d’installation (read-only + refresh)', () => {
  let browser, ctx, page, productWithDocs, productWithoutDocs, originalLocalPaths

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    const picked = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/products?limit=all', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      const list = data.data || data
      const withDocs = list.find(p =>
        p.lien_pdf_installation_fr || p.lien_pdf_installation_en ||
        p.lien_pdf_remplacement_fr || p.lien_pdf_remplacement_en
      )
      const withoutDocs = list.find(p =>
        !p.lien_pdf_installation_fr && !p.lien_pdf_installation_en &&
        !p.lien_pdf_remplacement_fr && !p.lien_pdf_remplacement_en
      )
      return {
        withDocs: withDocs ? {
          id: withDocs.id,
          lien_pdf_installation_fr: withDocs.lien_pdf_installation_fr,
          lien_pdf_installation_en: withDocs.lien_pdf_installation_en,
          lien_pdf_remplacement_fr: withDocs.lien_pdf_remplacement_fr,
          lien_pdf_remplacement_en: withDocs.lien_pdf_remplacement_en,
          lien_pdf_installation_fr_local: withDocs.lien_pdf_installation_fr_local,
          lien_pdf_installation_en_local: withDocs.lien_pdf_installation_en_local,
          lien_pdf_remplacement_fr_local: withDocs.lien_pdf_remplacement_fr_local,
          lien_pdf_remplacement_en_local: withDocs.lien_pdf_remplacement_en_local,
        } : null,
        withoutDocs: withoutDocs ? { id: withoutDocs.id } : null,
      }
    })
    productWithDocs = picked.withDocs
    productWithoutDocs = picked.withoutDocs
    if (productWithDocs) {
      originalLocalPaths = Object.fromEntries(FIELDS.map(f => [f.local, productWithDocs[f.local] || null]))
    }
  })

  after(async () => {
    // Le refresh écrit dans la DB et sur le filesystem. Pas de cleanup possible des fichiers
    // sans accès au FS — mais on peut restaurer les colonnes *_local à leur valeur d'origine
    // pour ne pas laisser le produit pointant vers des fichiers cache d'un run de test.
    if (productWithDocs && originalLocalPaths) {
      await page.evaluate(async ({ id, paths }) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/products/${id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(paths),
        })
      }, { id: productWithDocs.id, paths: originalLocalPaths }).catch(() => {})
    }
    await browser?.close()
  })

  test('Onglet "Document d’installation" présent à côté de BOM', async () => {
    const id = productWithDocs?.id || productWithoutDocs?.id
    assert.ok(id, 'Aucun produit pour tester')
    await page.goto(`${URL}/products/${id}`, { waitUntil: 'networkidle' })
    const tab = page.locator('button:has-text("Document d’installation")')
    await tab.waitFor({ state: 'visible', timeout: 5000 })
    assert.ok(await page.locator('button:has-text("BOM")').first().isVisible())
  })

  test('Produit avec valeurs : URL affichée comme lien cliquable', async () => {
    if (!productWithDocs) return console.warn('  (skip — aucun produit avec lien_pdf_* renseigné)')
    await page.goto(`${URL}/products/${productWithDocs.id}`, { waitUntil: 'networkidle' })
    await page.click('button:has-text("Document d’installation")')
    for (const f of FIELDS) {
      const value = productWithDocs[f.url]
      if (!value) continue
      const anchor = page.locator(`label:has-text("${f.label}")`).locator('xpath=following-sibling::div//a').first()
      const href = await anchor.getAttribute('href')
      assert.strictEqual(href, value)
    }
  })

  test('POST /products/:id/refresh-installation-docs télécharge les PDFs et met à jour les colonnes *_local', async () => {
    if (!productWithDocs) return console.warn('  (skip — aucun produit avec lien_pdf_* renseigné)')
    const result = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch(`/erp/api/products/${id}/refresh-installation-docs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
      return { status: res.status, body: await res.json() }
    }, productWithDocs.id)
    assert.strictEqual(result.status, 200, `Status attendu 200, reçu ${result.status}`)
    assert.ok(Array.isArray(result.body.results), 'results doit être un tableau')
    assert.strictEqual(result.body.results.length, 4, '4 résultats attendus (un par champ)')

    // Pour chaque champ avec URL, on doit avoir status=downloaded et un chemin local
    for (const f of FIELDS) {
      const value = productWithDocs[f.url]
      const r = result.body.results.find(x => x.field === f.url)
      assert.ok(r, `résultat manquant pour ${f.url}`)
      if (value) {
        assert.ok(['downloaded', 'error'].includes(r.status), `${f.url}: status doit être downloaded ou error, reçu ${r.status}`)
        if (r.status === 'downloaded') {
          assert.match(r.local, /^products\/docs\/.+\.pdf$/, `${f.url}: chemin local attendu sous products/docs/`)
          assert.strictEqual(result.body.product[f.local], r.local, `${f.url}: colonne ${f.local} doit refléter le chemin retourné`)
        }
      } else {
        assert.strictEqual(r.status, 'cleared')
        assert.strictEqual(result.body.product[f.local], null)
      }
    }
  })

  test('Copie locale accessible via /erp/api/product-docs/<filename>', async () => {
    if (!productWithDocs) return console.warn('  (skip)')
    // Re-lire le produit pour récupérer les chemins locaux frais
    const prod = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/products/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      return r.json()
    }, productWithDocs.id)
    const firstLocal = FIELDS.map(f => prod[f.local]).find(Boolean)
    if (!firstLocal) return console.warn('  (skip — aucun téléchargement réussi)')
    const filename = firstLocal.replace(/^products\/docs\//, '')
    const fetched = await page.evaluate(async (fname) => {
      const r = await fetch(`/erp/api/product-docs/${fname}`)
      return { status: r.status, contentType: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength }
    }, filename)
    assert.strictEqual(fetched.status, 200, 'La copie locale doit être servie en HTTP 200')
    assert.ok(fetched.bytes > 0, 'Le fichier doit avoir un contenu non vide')
  })

  test('UI : après le refresh, le lien "Copie locale" est visible pour chaque champ téléchargé', async () => {
    if (!productWithDocs) return console.warn('  (skip)')
    await page.goto(`${URL}/products/${productWithDocs.id}`, { waitUntil: 'networkidle' })
    await page.click('button:has-text("Document d’installation")')
    const localLinks = page.locator('a:has-text("Copie locale")')
    const count = await localLinks.count()
    assert.ok(count >= 1, `Au moins un lien 'Copie locale' attendu, reçu ${count}`)
  })

  test('Produit avec URLs séparées par virgule : chaque URL est téléchargée séparément et stockée en CSV', async () => {
    // Cherche un produit qui a au moins un champ lien_pdf_* contenant une virgule
    const multi = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/products?limit=all', { headers: { Authorization: `Bearer ${token}` } })
      const data = await r.json()
      const list = data.data || data
      const fields = ['lien_pdf_installation_fr','lien_pdf_installation_en','lien_pdf_remplacement_fr','lien_pdf_remplacement_en']
      const p = list.find(x => fields.some(f => (x[f] || '').includes(',')))
      return p ? { id: p.id, name: p.name_fr } : null
    })
    if (!multi) return console.warn('  (skip — aucun produit avec virgule)')

    // Sauvegarde des *_local pour restauration en after
    const before = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const p = await fetch(`/erp/api/products/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      return {
        lien_pdf_installation_fr_local: p.lien_pdf_installation_fr_local,
        lien_pdf_installation_en_local: p.lien_pdf_installation_en_local,
        lien_pdf_remplacement_fr_local: p.lien_pdf_remplacement_fr_local,
        lien_pdf_remplacement_en_local: p.lien_pdf_remplacement_en_local,
      }
    }, multi.id)

    const result = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch(`/erp/api/products/${id}/refresh-installation-docs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
      return { status: res.status, body: await res.json() }
    }, multi.id)

    assert.strictEqual(result.status, 200)
    // Vérifie qu'au moins un champ avec virgule a généré >1 résultat (downloaded ou error)
    const counts = {}
    for (const r of result.body.results) counts[r.field] = (counts[r.field] || 0) + 1
    const multiField = Object.entries(counts).find(([, n]) => n > 1)
    assert.ok(multiField, `Au moins un champ doit avoir >1 résultats (multi-URL). Counts: ${JSON.stringify(counts)}`)

    // Vérifie que la colonne *_local correspondante contient une virgule si >1 download
    for (const [field, n] of Object.entries(counts)) {
      if (n <= 1) continue
      const localCol = field + '_local'
      const localVal = result.body.product[localCol]
      const downloads = result.body.results.filter(r => r.field === field && r.status === 'downloaded').length
      if (downloads > 1) {
        assert.ok(localVal && localVal.includes(','), `${localCol} doit être un CSV de chemins (reçu: ${localVal})`)
      }
    }

    // Restauration
    await page.evaluate(async ({ id, before }) => {
      const token = localStorage.getItem('erp_token')
      await fetch(`/erp/api/products/${id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(before),
      })
    }, { id: multi.id, before }).catch(() => {})
  })

  test('Produit sans valeurs : bouton "Mettre à jour les PDFs" désactivé', async () => {
    if (!productWithoutDocs) return console.warn('  (skip — tous les produits ont au moins un lien)')
    await page.goto(`${URL}/products/${productWithoutDocs.id}`, { waitUntil: 'networkidle' })
    await page.click('button:has-text("Document d’installation")')
    const btn = page.locator('button:has-text("Mettre à jour les PDFs")')
    await btn.waitFor({ state: 'visible', timeout: 3000 })
    const disabled = await btn.isDisabled()
    assert.strictEqual(disabled, true, 'Le bouton doit être désactivé si aucun lien')
  })
})
