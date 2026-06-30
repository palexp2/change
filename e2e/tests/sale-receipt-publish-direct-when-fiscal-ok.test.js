const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Comportement « Publier sur QuickBooks » (SaleReceiptDetail / QBPublishForm) :
// - statut fiscal CONFORME → la publication part DIRECTEMENT, sans modale de confirmation ;
// - ÉCART fiscal → la modale s'ouvre (correction du code / justification forceReason).
//
// On NE publie JAMAIS pour de vrai : l'appel POST /push-to-qb est INTERCEPTÉ côté
// navigateur (route mock) — il n'atteint jamais le serveur, donc aucune transaction QB.
// La route est posée dans before() pour couvrir tout le test. On cale temporairement
// receipt_date dans la fenêtre de publication (≤30 j, pas future) et on la RESTAURE.

let browser, ctx, page, token, receiptId, originalDate, originalTransactionType
let pushCount = 0

function authFetch(path, opts = {}) {
  return fetch(`${URL}/api${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
}

// Première option « réelle » d'un SearchableSelect (on saute l'option vide « — … — »).
async function pickFirstReal(testId) {
  const select = page.getByTestId(testId)
  await select.waitFor({ state: 'visible', timeout: 30000 })
  await select.click()
  const menu = page.getByTestId(`${testId}-menu`)
  await menu.waitFor({ state: 'visible', timeout: 5000 })
  await menu.locator('button').filter({ hasNotText: '—' }).first().click()
}

async function pickOption(testId, text, { exact = true } = {}) {
  const select = page.getByTestId(testId)
  await select.waitFor({ state: 'visible', timeout: 30000 })
  await select.click()
  const menu = page.getByTestId(`${testId}-menu`)
  await menu.waitFor({ state: 'visible', timeout: 5000 })
  await menu.getByText(text, { exact }).first().click()
}

before(async () => {
  const login = await fetch(`${URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  }).then(r => r.json())
  token = login.token
  assert.ok(token, 'login a échoué')

  const list = await authFetch('/sale-receipts?limit=all').then(r => r.json())
  const candidate = (list.data || []).find(r => r.status === 'done' && !r.quickbooks_id)
  assert.ok(candidate, 'aucun reçu done+non-publié disponible')
  receiptId = candidate.id
  originalDate = candidate.receipt_date ?? null
  originalTransactionType = candidate.transaction_type ?? null

  // Date dans la fenêtre de publication (3 j avant aujourd'hui — marge anti-fuseau).
  const within = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10)
  await authFetch(`/sale-receipts/${receiptId}`, {
    method: 'PATCH', body: JSON.stringify({ receipt_date: within }),
  })

  browser = await chromium.launch()
  ctx = await browser.newContext()
  page = await ctx.newPage()
  await page.addInitScript(t => localStorage.setItem('erp_token', t), token)

  // GARDE-FOU : tout POST /push-to-qb est ABORTÉ → jamais de vraie transaction QB, et
  // l'app ne navigue pas (onSuccess n'est jamais atteint), ce qui évite un teardown qui
  // bloque sur browser.close(). On compte quand même l'appel (la requête est bien émise).
  await page.route('**/push-to-qb', route => { pushCount++; route.abort() })
})

after(async () => {
  // Restaurer AVANT de fermer le navigateur — pour que la restauration parte même si
  // browser.close() venait à traîner.
  if (token && receiptId) {
    await authFetch(`/sale-receipts/${receiptId}`, {
      method: 'PATCH',
      body: JSON.stringify({ receipt_date: originalDate, transaction_type: originalTransactionType }),
    }).catch(() => {})
    // Filet de sécurité : le reçu ne doit jamais avoir été publié par le test.
    const r = await authFetch(`/sale-receipts/${receiptId}`).then(r => r.json()).catch(() => ({}))
    assert.ok(!r.quickbooks_id, 'le reçu ne doit pas avoir été publié par le test')
  }
  await page?.unroute('**/push-to-qb').catch(() => {})
  await ctx?.close().catch(() => {})
  await browser?.close().catch(() => {})
})

test('écart fiscal → modale ; conforme → publication directe sans modale', async () => {
  await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'domcontentloaded' })

  // Formulaire QB chargé (comptes/vendors/tax-codes depuis QB — peut être lent).
  await page.getByTestId('qb-txtype-select').waitFor({ state: 'visible', timeout: 30000 })

  // Remplir les champs requis par la validation (fournisseur + comptes).
  await page.getByText('Existant', { exact: true }).click()
  await pickFirstReal('qb-vendor-select')
  await pickFirstReal('qb-expense-select')
  await pickFirstReal('qb-payment-select')

  // Type « Produits alimentaires de base » → statut attendu Détaxé.
  await pickOption('qb-txtype-select', 'Produits alimentaires de base', { exact: false })

  // ── Cas 1 : code NON conforme (TPS/TVQ QC) → écart → clic Publier ouvre la modale.
  await pickOption('qb-taxcode-select', 'TPS/TVQ QC - 9,975')
  await page.getByTestId('qb-fiscal-mismatch').waitFor({ state: 'visible', timeout: 5000 })
  await page.getByTestId('qb-publish-open').click()
  await page.getByTestId('qb-confirm-modal').waitFor({ state: 'visible', timeout: 5000 })
  assert.equal(pushCount, 0, 'aucune publication ne doit partir tant qu’il y a un écart fiscal')
  // Fermer la modale pour repartir propre.
  await page.getByRole('button', { name: 'Annuler' }).click()
  await page.getByTestId('qb-confirm-modal').waitFor({ state: 'hidden', timeout: 5000 })

  // ── Cas 2 : code conforme (Détaxé) → clic Publier publie DIRECTEMENT, sans modale.
  await pickOption('qb-taxcode-select', 'Détaxé')
  await page.getByTestId('qb-fiscal-ok').waitFor({ state: 'visible', timeout: 5000 })
  const pushReq = page.waitForRequest(u => u.url().includes('/push-to-qb'), { timeout: 8000 })
  await page.getByTestId('qb-publish-open').click()
  await pushReq // la publication est partie directement
  assert.equal(pushCount, 1, 'la publication doit partir au clic quand le statut fiscal est conforme')
  assert.equal(await page.getByTestId('qb-confirm-modal').count(), 0, 'aucune modale de confirmation ne doit s’afficher quand c’est conforme')
})
