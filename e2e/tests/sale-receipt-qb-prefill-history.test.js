const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// Auto-pré-sélection des comptes (dépense + paiement) depuis la dernière compta du
// même fournisseur. Comme le panneau de publication n'apparaît que sur un reçu
// `done` non publié — statut qu'on ne peut pas forcer sur un jetable (extraction
// asynchrone) — on s'appuie sur un reçu RÉEL done/non-publié EN LECTURE SEULE comme
// hôte, et on crée un reçu jetable publié portant SON fournisseur, daté très tard
// pour être garanti en tête de l'historique. On ne modifie jamais l'hôte réel.
describe('Fiche reçu — auto-pré-sélection des comptes depuis l\'historique fournisseur', () => {
  let browser, ctx, page
  let pastId = null   // transaction passée jetable (simulée publiée)
  let hostId = null   // reçu réel done non publié — LECTURE SEULE
  let expenseAcc = null, paymentAcc = null

  async function api(method, path, body) {
    return page.evaluate(async ({ method, path, body }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      const txt = await r.text()
      try { return JSON.parse(txt) } catch { return txt }
    }, { method, path, body })
  }
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

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Comptes QB pour semer un modèle déterministe.
    const accounts = await api('GET', '/connectors/quickbooks/accounts')
    if (Array.isArray(accounts)) {
      expenseAcc = accounts.find(a => ['Expense', 'Other Expense', 'Cost of Goods Sold', 'Other Current Asset'].includes(a.AccountType))
      paymentAcc = accounts.find(a => ['Bank', 'Credit Card'].includes(a.AccountType))
    }

    // Hôte réel : reçu done, non publié, avec un fournisseur. LECTURE SEULE.
    const host = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const list = (await (await fetch('/erp/api/sale-receipts?limit=all', { headers: { Authorization: `Bearer ${token}` } })).json()).data || []
      const h = list.find(x => x.status === 'done' && !x.quickbooks_id && (x.company || '').trim())
      return h ? { id: h.id, company: h.company } : null
    })
    if (host && expenseAcc && paymentAcc) {
      hostId = host.id
      pastId = await uploadDisposable(`__e2e_prefill_${Date.now()}.png`)
      // Daté très tard → garanti en tête de vendor-history (tri DESC). Porte des
      // comptes connus mais PAS de code de taxe (la déduction TPS/TVQ doit primer).
      await api('PATCH', `/sale-receipts/${pastId}`, {
        company: host.company,
        total: 42.5,
        receipt_date: '2030-01-01',
        quickbooks_id: 'E2E-PREFILL',
        quickbooks_type: 'purchase',
        expense_account_id: expenseAcc.Id,
        payment_account_id: paymentAcc.Id,
      })
    }
  })

  after(async () => {
    if (page && pastId) {
      await page.evaluate(async (id) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/sale-receipts/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      }, pastId)
    }
    await browser?.close()
  })

  test('le formulaire pré-remplit les comptes et affiche la note de pré-remplissage', async (t) => {
    if (!hostId) { t.skip('aucun hôte réel done/non publié, ou comptes QB indisponibles'); return }

    await page.goto(`${URL}/sale-receipts/${hostId}`, { waitUntil: 'networkidle' })
    await page.locator('[data-testid="qb-expense-select"]').waitFor({ state: 'visible', timeout: 10000 })

    // Note de pré-remplissage visible
    await page.locator('[data-testid="qb-prefill-note"]').waitFor({ state: 'visible', timeout: 5000 })

    // Le compte de dépense affiché correspond au modèle semé
    const expenseText = await page.locator('[data-testid="qb-expense-select"]').innerText()
    assert.match(expenseText, new RegExp(expenseAcc.Name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'compte de dépense pré-rempli depuis l\'historique')

    // Le compte de paiement aussi (type purchase → champ visible)
    const paymentText = await page.locator('[data-testid="qb-payment-select"]').innerText()
    assert.match(paymentText, new RegExp(paymentAcc.Name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'compte de paiement pré-rempli depuis l\'historique')
  })

  test('une édition manuelle masque la note de pré-remplissage (pas de clobber)', async (t) => {
    if (!hostId) { t.skip('aucun hôte disponible'); return }
    await page.goto(`${URL}/sale-receipts/${hostId}`, { waitUntil: 'networkidle' })
    await page.locator('[data-testid="qb-prefill-note"]').waitFor({ state: 'visible', timeout: 10000 })

    // Change le type → marque userTouched → la note disparaît
    await page.locator('[data-testid="qb-type-bill"]').click()
    await page.locator('[data-testid="qb-prefill-note"]').waitFor({ state: 'detached', timeout: 5000 }).catch(async () => {
      // selon le rendu, "hidden" plutôt que "detached"
      await page.locator('[data-testid="qb-prefill-note"]').waitFor({ state: 'hidden', timeout: 2000 })
    })
  })
})
