const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérification du statut fiscal avant publication QB (services/fiscalStatus.js).
// On choisit dynamiquement un reçu DONE non publié et on NE PUBLIE JAMAIS — publier
// serait un vrai side effect QB. Le formulaire ne sauvegarde pas transaction_type
// (persisté uniquement à la publication), donc aucun écrit DB sur le vrai record.
// Par prudence (règle CLAUDE.md), on capture/restaure quand même transaction_type.

let browser, ctx, page, token, receiptId, originalTransactionType

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

  // Un reçu extrait mais pas encore publié → le formulaire de publication s'affiche.
  const list = await authFetch('/sale-receipts?limit=all').then(r => r.json())
  const candidate = (list.data || []).find(r => r.status === 'done' && !r.quickbooks_id)
  assert.ok(candidate, 'aucun reçu done+non-publié disponible pour le test')
  receiptId = candidate.id
  originalTransactionType = candidate.transaction_type ?? null

  browser = await chromium.launch()
  ctx = await browser.newContext()
  page = await ctx.newPage()
  await page.addInitScript(t => localStorage.setItem('erp_token', t), token)
})

after(async () => {
  // Restaure transaction_type au cas où un changement aurait été persisté.
  if (token && receiptId) {
    await authFetch(`/sale-receipts/${receiptId}`, {
      method: 'PATCH', body: JSON.stringify({ transaction_type: originalTransactionType }),
    }).catch(() => {})
  }
  await browser?.close()
})

// Helpers pour piloter un SearchableSelect (portail partagé #qb-select-portal).
async function pickOption(selectTestId, optionText, { exact = true } = {}) {
  const select = page.getByTestId(selectTestId)
  await select.waitFor({ state: 'visible', timeout: 30000 })
  await select.click()
  const portal = page.locator('#qb-select-portal')
  await portal.waitFor({ state: 'visible', timeout: 5000 })
  await portal.getByText(optionText, { exact }).first().click()
}

test('l’indicateur fiscal reflète l’écart code de taxe vs type de transaction', async () => {
  await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'domcontentloaded' })

  // Le sélecteur de type de transaction doit être présent (formulaire QB chargé).
  await page.getByTestId('qb-txtype-select').waitFor({ state: 'visible', timeout: 30000 })

  // Choisit « Produits alimentaires de base » → statut attendu Détaxé.
  await pickOption('qb-txtype-select', 'Produits alimentaires de base', { exact: false })
  const expected = page.getByTestId('qb-fiscal-expected')
  await expected.waitFor({ state: 'visible', timeout: 5000 })
  await assert.doesNotReject(expected.getByText('Détaxé', { exact: false }).first().waitFor({ timeout: 5000 }),
    'le statut attendu Détaxé doit s’afficher')

  // Code de taxe non conforme (TPS/TVQ QC) → bannière d’écart rouge.
  await pickOption('qb-taxcode-select', 'TPS/TVQ QC - 9,975')
  await assert.doesNotReject(page.getByTestId('qb-fiscal-mismatch').waitFor({ state: 'visible', timeout: 5000 }),
    'l’écart fiscal doit être signalé')

  // Code conforme (Détaxé) → bannière verte de conformité.
  await pickOption('qb-taxcode-select', 'Détaxé')
  await assert.doesNotReject(page.getByTestId('qb-fiscal-ok').waitFor({ state: 'visible', timeout: 5000 }),
    'la conformité fiscale doit être confirmée')
})

test('la garde serveur bloque un code non conforme et exige le type (sans publier)', async () => {
  // Type manquant → 400 (jamais de POST QB).
  const noType = await authFetch(`/sale-receipts/${receiptId}/push-to-qb`, {
    method: 'POST',
    body: JSON.stringify({ type: 'purchase', expenseAccountId: 'x', paymentAccountId: 'x', taxCodeId: '8' }),
  })
  assert.equal(noType.status, 400, 'type de transaction requis')
  const noTypeBody = await noType.json()
  assert.match(noTypeBody.error, /[Tt]ype de transaction/, 'message explicite sur le type requis')

  // Type produits alimentaires (Détaxé) + code TPS/TVQ QC (id 8) → écart → 400 bloquant.
  // La garde lève AVANT tout POST QB → aucune transaction créée.
  const mismatch = await authFetch(`/sale-receipts/${receiptId}/push-to-qb`, {
    method: 'POST',
    body: JSON.stringify({ type: 'purchase', expenseAccountId: 'x', paymentAccountId: 'x', taxCodeId: '8', transactionType: 'produits_alimentaires_base' }),
  })
  assert.equal(mismatch.status, 400, 'écart fiscal bloqué')
  const mismatchBody = await mismatch.json()
  assert.match(mismatchBody.error, /[ÉéEe]cart de statut fiscal/, 'message explicite sur l’écart')

  // Le reçu ne doit PAS avoir été publié.
  const after = await authFetch(`/sale-receipts/${receiptId}`).then(r => r.json())
  assert.ok(!after.quickbooks_id, 'le reçu ne doit pas avoir été publié par le test')
})
