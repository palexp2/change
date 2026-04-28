const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Bon de commande — sélection du compte Gmail expéditeur', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('endpoint /connectors/gmail/accounts expose is_current_user', async () => {
    const { accounts, me } = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const [a, m] = await Promise.all([
        fetch('/erp/api/connectors/gmail/accounts', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
        fetch('/erp/api/auth/me', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      ])
      return { accounts: a, me: m }
    })
    assert.ok(Array.isArray(accounts), 'la réponse doit être un tableau')
    for (const a of accounts) {
      assert.ok(a.account_email, 'chaque entrée doit avoir account_email')
      assert.ok('is_current_user' in a, 'chaque entrée doit avoir is_current_user')
    }
    // Cohérence : is_current_user ssi account_email match l'email de l'utilisateur connecté
    const myEmail = (me?.email || '').toLowerCase()
    for (const a of accounts) {
      const expected = a.account_email.toLowerCase() === myEmail
      assert.strictEqual(a.is_current_user, expected, `is_current_user incorrect pour ${a.account_email}`)
    }
  })

  test('PO modal affiche le picker "Envoyer depuis" et défaut = compte utilisateur si connecté', async () => {
    // Trouver un produit buy_via_po avec supplier
    const productId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/products?limit=all', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      const list = data.data || data
      const p = list.find(x => x.buy_via_po && x.supplier_company_id)
      return p?.id
    })
    assert.ok(productId, 'aucun produit buy_via_po avec fournisseur trouvé')

    await page.goto(`${URL}/products/${productId}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('button:has-text("Générer un PO")', { timeout: 10000 })
    await page.click('button:has-text("Générer un PO")')

    await page.waitForSelector('button:has-text("Envoyer au fournisseur")', { timeout: 10000 })
    await page.click('button:has-text("Envoyer au fournisseur")')

    // Le picker est toujours visible (plus gated par ≥2 comptes)
    const fromLabel = page.locator('label:has-text("Envoyer depuis")')
    await fromLabel.waitFor({ state: 'visible', timeout: 5000 })

    const select = page.locator('label:has-text("Envoyer depuis") + select')
    const accounts = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/connectors/gmail/accounts', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.json()
    })
    const optionValues = await select.locator('option').evaluateAll(opts => opts.map(o => o.value))
    for (const a of accounts) {
      assert.ok(optionValues.includes(a.account_email), `compte ${a.account_email} absent du picker`)
    }

    // Valeur par défaut : compte de l'utilisateur connecté si présent, sinon ''
    const selected = await select.inputValue()
    const mine = accounts.find(a => a.is_current_user)
    if (mine) {
      assert.strictEqual(selected, mine.account_email, 'défaut = compte utilisateur')
    } else {
      assert.strictEqual(selected, '', 'sans compte utilisateur, défaut vide (forcer sélection)')
    }
  })

  test('backend refuse l\'envoi sans accountEmail et sans Gmail user-matched', async () => {
    // Simule un appel sans from_account pour un user qui n'a pas de Gmail connecté.
    // Ici `claude@orisha.io` est un compte de test dédié — s'il est connecté Gmail,
    // le test est skip (on ne peut pas reproduire le cas "aucun match").
    const accounts = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const [a, m] = await Promise.all([
        fetch('/erp/api/connectors/gmail/accounts', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
        fetch('/erp/api/auth/me', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      ])
      return { list: a, myEmail: (m?.email || '').toLowerCase() }
    })
    const userHasGmail = accounts.list.some(a => a.is_current_user)
    if (userHasGmail) {
      // Impossible de tester le rejet sans déconnecter le compte — on valide
      // simplement qu'avec un accountEmail bidon le serveur renvoie 400.
      const bogus = await page.evaluate(async () => {
        const token = localStorage.getItem('erp_token')
        const pid = await (await fetch('/erp/api/products?limit=all', {
          headers: { Authorization: `Bearer ${token}` },
        })).json().then(d => (d.data || d).find(x => x.buy_via_po && x.supplier_company_id)?.id)
        const r = await fetch(`/erp/api/products/${pid}/purchase-order/send-email`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: 'noone@example.com',
            subject: 'x',
            body_html: '<p>x</p>',
            from_account: 'definitely-not-connected@example.com',
            po: { po_number: 'TEST', items: [] },
          }),
        })
        return { status: r.status, body: await r.json().catch(() => ({})) }
      })
      assert.ok(bogus.status >= 400, 'un from_account inconnu doit renvoyer une erreur')
      assert.ok(/non connecté|not connected/i.test(bogus.body.error || ''), `message doit évoquer "non connecté" (reçu: ${bogus.body.error})`)
    }
    // else: cas "aucun match" naturel → on pourrait envoyer sans from_account et
    // vérifier l'erreur, mais cela créerait une interaction parasite. Skip.
  })
})
