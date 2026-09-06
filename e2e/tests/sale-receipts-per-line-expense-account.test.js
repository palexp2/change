const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Compte de dépense PAR LIGNE d'article (certains achats concernent plus d'un compte
// de dépense — ex. pièces au stock + frais de transport). Vérifie le sélecteur dans la
// section Articles, sa persistance en DB, et la mention affichée dans le formulaire de
// publication. On NE PUBLIE JAMAIS (vrai side effect QuickBooks) et le test restaure
// items[] + montants du reçu en after() — la DB de test = la DB de prod (cf. CLAUDE.md).

describe('Extraction de données : compte de dépense par ligne d\'article', () => {
  let browser, ctx, page
  let token, receiptId, originalItems, originalAmounts, accountTarget

  function authFetch(path, opts = {}) {
    return fetch(`${URL}/api${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    })
  }

  before(async () => {
    const login = await fetch(`${URL}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    }).then(r => r.json())
    token = login.token
    assert.ok(token, 'login a échoué')

    // Reçu extrait mais pas encore publié → le formulaire de publication est affiché
    // (la mention « lignes avec leur propre compte » y est vérifiée).
    const list = await authFetch('/sale-receipts?limit=all').then(r => r.json())
    const candidate = (list.data || []).find(r => r.status === 'done' && !r.quickbooks_id)
    assert.ok(candidate, 'Préalable : au moins un reçu done non publié est requis')
    receiptId = candidate.id
    originalItems = candidate.items || []
    originalAmounts = {
      subtotal: candidate.subtotal ?? null,
      tps: candidate.tps ?? null,
      tvq: candidate.tvq ?? null,
      other_taxes: candidate.other_taxes ?? null,
      total: candidate.total ?? null,
    }

    // Compte de dépense QB réel — même filtre de types que le sélecteur du document.
    const accounts = await authFetch('/connectors/quickbooks/accounts').then(r => r.json())
    assert.ok(Array.isArray(accounts) && accounts.length, 'comptes QB requis')
    accountTarget = accounts.find(a =>
      ['Expense', 'Other Expense', 'Cost of Goods Sold', 'Other Current Asset'].includes(a.AccountType)
      && a.Id !== candidate.expense_account_id)
    assert.ok(accountTarget, 'un compte de dépense QB est requis')

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await page.addInitScript(t => localStorage.setItem('erp_token', t), token)
  })

  after(async () => {
    // Restaure toujours items + montants, même si le test a échoué.
    if (token && receiptId) {
      await authFetch(`/sale-receipts/${receiptId}`, {
        method: 'PATCH', body: JSON.stringify({ items: originalItems, ...originalAmounts }),
      }).catch(() => {})
    }
    await browser?.close()
  })

  const accountLabel = a => (a.AcctNum ? `${a.AcctNum} — ${a.Name}` : a.Name)

  test('chaque ligne d\'article offre un sélecteur de compte de dépense', async () => {
    await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'domcontentloaded' })
    await page.getByTestId('receipt-item-add').waitFor({ state: 'visible', timeout: 30000 })

    // S'assurer qu'au moins une ligne existe (ajout au besoin — restauré en after()).
    if (await page.locator('[data-testid^="receipt-item-row-"]').count() === 0) {
      await page.getByTestId('receipt-item-add').click()
      await page.getByTestId('receipt-item-row-0').waitFor({ state: 'visible', timeout: 10000 })
    }
    const select = page.getByTestId('receipt-item-account-0')
    await select.waitFor({ state: 'visible', timeout: 10000 })
    // Par défaut, la ligne suit le compte de dépense choisi à la publication.
    assert.match(await select.innerText(), /Compte du document/)
  })

  test('choisir un compte sur une ligne le persiste en DB', async () => {
    const select = page.getByTestId('receipt-item-account-0')
    await select.scrollIntoViewIfNeeded()
    await select.click()
    const menu = page.getByTestId('receipt-item-account-0-menu')
    await menu.waitFor({ state: 'visible', timeout: 10000 })
    await menu.locator('input').fill(accountLabel(accountTarget))
    await menu.getByRole('button', { name: accountTarget.Name, exact: false }).first().click()

    // L'autosave est asynchrone — on poll l'API plutôt que le DOM.
    const deadline = Date.now() + 15000
    let last
    while (Date.now() < deadline) {
      const body = await authFetch(`/sale-receipts/${receiptId}`).then(r => r.json())
      last = (body.items || [])[0]?.expense_account_id ?? null
      if (String(last) === String(accountTarget.Id)) break
      await new Promise(res => setTimeout(res, 300))
    }
    assert.equal(String(last), String(accountTarget.Id),
      `le compte de dépense de la ligne 0 doit être persisté (${accountTarget.Id})`)
  })

  test('le formulaire de publication signale les lignes à compte propre', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    const note = page.getByTestId('qb-line-accounts-note')
    await note.waitFor({ state: 'visible', timeout: 30000 })
    assert.match(await note.innerText(), /propre compte de dépense/)
  })

  test('vider le sélecteur remet la ligne sur le compte du document', async () => {
    const select = page.getByTestId('receipt-item-account-0')
    await select.scrollIntoViewIfNeeded()
    // Le compte choisi au test précédent est bien affiché avant qu'on le retire
    // (sinon l'assertion « redevenu vide » ci-dessous serait vraie par accident).
    assert.match(await select.innerText(), new RegExp(accountTarget.Name.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    await select.click()
    const menu = page.getByTestId('receipt-item-account-0-menu')
    await menu.waitFor({ state: 'visible', timeout: 10000 })
    await menu.getByRole('button', { name: 'Compte du document', exact: false }).first().click()

    const deadline = Date.now() + 15000
    let last = 'x'
    while (Date.now() < deadline) {
      const body = await authFetch(`/sale-receipts/${receiptId}`).then(r => r.json())
      last = (body.items || [])[0]?.expense_account_id ?? null
      if (last === null) break
      await new Promise(res => setTimeout(res, 300))
    }
    assert.equal(last, null, 'le compte de la ligne doit redevenir vide (compte du document)')
  })
})
