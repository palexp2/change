const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Comptabilisation de la paie : le détail des déductions (remboursements de
// dépenses par employé + téléphone de Martin) doit être visible dans l'encadré
// du montant passé au compte BNC. Test 100 % lecture — aucune publication QB,
// aucun record créé (la saisie du montant ne fait qu'un aperçu).
describe('Comptabilisation de la paie — déductions dans l\'encadré du montant BNC', () => {
  let browser, ctx, page

  const apiFetch = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts })

  const num = txt => Number(String(txt).replace(/[^\d,.-]/g, '').replace(/\s/g, '').replace(',', '.'))

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1200 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    await page.goto(URL + '/comptabilite', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="compta-paie"]', { state: 'attached', timeout: 30000 })
  })

  after(async () => {
    // Rien à nettoyer : aucun record créé, aucune écriture (aperçu seulement).
    await browser?.close()
  })

  test('l\'encadré du montant BNC ouvre le détail des déductions', async () => {
    if (await page.locator('[data-testid="compta-paie-empty"]').count()) {
      // Toutes les paies terminées sont comptabilisées — rien à afficher.
      return
    }
    const box = page.locator('[data-testid="compta-paie-deductions"]')
    await box.waitFor({ state: 'visible', timeout: 20000 })

    // Ouvert par défaut : le détail et le total à déduire sont visibles.
    const detail = page.locator('[data-testid="compta-paie-deductions-detail"]')
    await detail.waitFor({ state: 'visible', timeout: 5000 })
    assert.match(await detail.textContent(), /Total à déduire/)

    // Le repli/dépli fonctionne.
    await page.click('[data-testid="compta-paie-deductions-toggle"]')
    await detail.waitFor({ state: 'hidden', timeout: 5000 })
    await page.click('[data-testid="compta-paie-deductions-toggle"]')
    await detail.waitFor({ state: 'visible', timeout: 5000 })
  })

  test('la base des salaires = montant BNC − déductions', async () => {
    if (await page.locator('[data-testid="compta-paie-empty"]').count()) return

    const deducted = num(await page.locator('[data-testid="compta-paie-deductions-total"]').textContent())
    assert.ok(Number.isFinite(deducted) && deducted >= 0, 'total à déduire illisible')

    await page.fill('[data-testid="compta-paie-amount"]', '20000')
    await page.locator('[data-testid="compta-paie-amount"]').blur()
    const base = page.locator('[data-testid="compta-paie-base"]')
    await base.waitFor({ state: 'visible', timeout: 15000 })
    // Une paie déjà comptabilisée arrive avec son aperçu : attendre que la base
    // reflète le montant qu'on vient de saisir.
    const expected = 20000 - deducted
    await page.waitForFunction(exp => {
      const el = document.querySelector('[data-testid="compta-paie-base"]')
      if (!el) return false
      const v = Number(el.textContent.replace(/[^\d,.-]/g, '').replace(/\s/g, '').replace(',', '.'))
      return Math.abs(v - exp) < 0.02
    }, expected, { timeout: 15000 })
    assert.ok(Math.abs(num(await base.textContent()) - expected) < 0.02,
      'la base affichée ne vaut pas montant − déductions')
  })

  test('le téléphone de Martin apparaît avec sa TPS/TVQ en sus', async () => {
    if (await page.locator('[data-testid="compta-paie-empty"]').count()) return
    const detail = page.locator('[data-testid="compta-paie-deductions-detail"]')
    await detail.waitFor({ state: 'visible', timeout: 10000 })
    const phone = page.locator('[data-testid="compta-paie-phone"]')
    if (!(await phone.count())) return // paie sans remboursement téléphone ce cycle

    // 25 $ hors taxes + TPS/TVQ par-dessus, et les deux sortent du montant BNC.
    assert.equal(num(await phone.textContent()), 25)
    const txt = await detail.textContent()
    assert.match(txt, /TPS\/TVQ \(en sus\)/)
    const deducted = num(await page.locator('[data-testid="compta-paie-deductions-total"]').textContent())
    assert.ok(deducted >= 28.7 && deducted < 28.8, `total à déduire inattendu : ${deducted}`)
  })

  test('le bouton de rafraîchissement resynchronise les items Airtable', async () => {
    if (await page.locator('[data-testid="compta-paie-empty"]').count()) return
    const before = (await apiFetch('/paies?limit=1')).status
    assert.equal(before, 200)
    await page.click('[data-testid="compta-paie-deductions-refresh"]')
    // Le sync complet des items prend ~10 s : on attend le toast de succès.
    await page.waitForSelector('text=Items de paie resynchronisés depuis Airtable', { timeout: 60000 })
    await page.locator('[data-testid="compta-paie-deductions-detail"]').waitFor({ state: 'visible', timeout: 10000 })
  })

  test('l\'API des déductions ventile chaque remboursement vers son employé', async () => {
    const list = await apiFetch('/paies?limit=30')
    assert.equal(list.status, 200)
    const paies = list.body?.data || []
    assert.ok(paies.length, 'aucune paie disponible')

    let withReimb = null
    for (const p of paies) {
      const r = await apiFetch(`/paies/${p.id}/salary-expense/deductions`)
      assert.equal(r.status, 200)
      assert.ok(Array.isArray(r.body.reimbs), 'reimbs manquant')
      assert.equal(typeof r.body.total, 'number')
      // total = remboursements restants + téléphone taxes comprises.
      assert.ok(Math.abs(r.body.total - (r.body.reimb_total + r.body.phone_gross)) < 0.005)
      // Le 25 $ est hors taxes : la TPS/TVQ s'ajoute par-dessus.
      if (r.body.phone > 0) {
        assert.equal(r.body.phone_tax_included, false)
        assert.ok(Math.abs(r.body.phone_gross - (r.body.phone + r.body.phone_tax)) < 0.005)
        assert.ok(r.body.phone_tax > 0, 'TPS/TVQ du téléphone manquante')
        assert.equal(r.body.phone_acctnum, '76000')
      }
      if (r.body.total > 0 && !withReimb) withReimb = r.body
    }
    assert.ok(withReimb, 'aucune paie avec remboursement de dépenses parmi les 30 dernières')

    // Chaque remboursement porte l'employé et son compte « (rembourser à) ».
    for (const r of withReimb.reimbs) {
      assert.ok(r.employee_name, 'remboursement sans employé')
      assert.equal(r.account_label, `${r.employee_name} (rembourser à)`)
      assert.ok(r.amount > 0)
    }
    // Le téléphone de Martin, quand il est présent, est sorti des
    // remboursements (jamais compté deux fois) et porte le code TPS/TVQ.
    if (withReimb.phone > 0) {
      assert.match(withReimb.phone_taxcode, /TPS\/TVQ/)
      assert.equal(withReimb.reimbs.some(r => /martin/i.test(r.employee_name) && r.amount === withReimb.phone), false)
    }
  })
})
