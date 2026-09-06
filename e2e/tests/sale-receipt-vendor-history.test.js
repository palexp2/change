const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// IMPORTANT : ce test ne touche QUE des reçus jetables qu'il crée lui-même.
// Il ne modifie jamais un reçu réel existant (le champ `company` est une donnée
// de prod — l'écraser puis le restaurer est trop risqué, cf. incident antérieur).
describe('Fiche reçu — transactions passées du fournisseur (modèle de comptabilisation)', () => {
  let browser, ctx, page
  let currentId = null     // reçu courant jetable (test endpoint)
  let pastId = null        // transaction passée jetable, simulée publiée (test endpoint)
  let hostId = null        // reçu réel done non publié — LECTURE SEULE (test UI)
  let pastForHostId = null // transaction passée jetable portant le fournisseur de l'hôte
  const VENDOR = `__e2e_vendor_hist_${Date.now()}`

  async function uploadDisposable(label) {
    return page.evaluate(async ({ b64, name }) => {
      const token = localStorage.getItem('erp_token')
      const bin = atob(b64); const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const fd = new FormData()
      fd.append('file', new Blob([bytes], { type: 'image/png' }), name)
      const r = await fetch('/erp/api/sale-receipts/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })
      return (await r.json()).id
    }, { b64: PNG_1x1, name: label })
  }
  async function patch(id, body) {
    return page.evaluate(async ({ id, body }) => {
      const token = localStorage.getItem('erp_token')
      await fetch(`/erp/api/sale-receipts/${id}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
    }, { id, body })
  }
  async function getStatus(id) {
    return page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/sale-receipts/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      return (await r.json()).status
    }, id)
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    pastId = await uploadDisposable(`${VENDOR}_past.png`)
    currentId = await uploadDisposable(`${VENDOR}_current.png`)
    assert.ok(pastId && currentId, 'deux reçus jetables créés')

    // « past » : simulé publié, même fournisseur (quickbooks_id factice)
    await patch(pastId, { company: VENDOR, total: 42.5, receipt_date: '2026-01-15', quickbooks_id: 'E2E-9999', quickbooks_type: 'purchase' })
    // « current » : même fournisseur, non publié
    await patch(currentId, { company: VENDOR })

    // Pour le test UI : un reçu réel done non publié, utilisé EN LECTURE SEULE
    // (jamais modifié). On crée seulement un reçu jetable portant SON fournisseur.
    const host = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const list = (await (await fetch('/erp/api/sale-receipts?limit=all', { headers: { Authorization: `Bearer ${token}` } })).json()).data || []
      const h = list.find(x => x.status === 'done' && !x.quickbooks_id && (x.company || '').trim())
      return h ? { id: h.id, company: h.company } : null
    })
    if (host) {
      hostId = host.id
      pastForHostId = await uploadDisposable(`${VENDOR}_hostpast.png`)
      await patch(pastForHostId, { company: host.company, total: 42.5, receipt_date: '2026-06-07', quickbooks_id: 'E2E-8888', quickbooks_type: 'purchase' })
    }
  })

  after(async () => {
    if (page) {
      // On ne supprime QUE les reçus jetables créés ici — jamais l'hôte réel.
      for (const id of [pastId, currentId, pastForHostId]) {
        if (!id) continue
        await page.evaluate(async (id) => {
          const token = localStorage.getItem('erp_token')
          await fetch(`/erp/api/sale-receipts/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
        }, id)
      }
    }
    await browser?.close()
  })

  test('endpoint vendor-history retourne la transaction passée du même fournisseur', async () => {
    const data = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/sale-receipts/${id}/vendor-history`, { headers: { Authorization: `Bearer ${token}` } })
      return (await r.json()).data
    }, currentId)
    assert.ok(Array.isArray(data) && data.some(x => x.id === pastId), 'la transaction passée doit apparaître')
    assert.ok(!data.some(x => x.id === currentId), 'le reçu courant ne doit pas s\'inclure lui-même')
    const b = data.find(x => x.id === pastId)
    assert.equal(b.total, 42.5)
    assert.equal(b.quickbooks_type, 'purchase')
  })

  test('le formulaire de publication affiche le panneau des transactions passées', async (t) => {
    // Panneau dans QBPublishForm (visible seulement si status=done && non publié).
    // On s'appuie sur un reçu réel déjà « done » EN LECTURE SEULE (jamais modifié),
    // et sur un reçu jetable publié portant son fournisseur. Si aucun hôte réel
    // adéquat n'existe, on skip.
    if (!hostId) { t.skip('aucun reçu done/non publié avec fournisseur disponible comme hôte'); return }

    await page.goto(`${URL}/sale-receipts/${hostId}`, { waitUntil: 'networkidle' })
    const panel = page.locator('[data-testid="vendor-history"]')
    await panel.waitFor({ state: 'visible', timeout: 10000 })
    const txt = await panel.innerText()
    assert.match(txt, /42,50/, 'le montant de la transaction passée (jetable) doit être affiché')
  })
})
