const { test, before, after, describe } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Bouton « Relire » dans l'en-tête d'un document (Extraction de données) : relance la
// lecture IA et réextrait les données du fichier déjà téléversé.
//
// Le test s'exécute sur un VRAI reçu mais ne le mute JAMAIS : le POST
// /re-extract est intercepté et court-circuité côté navigateur (route.fulfill),
// donc aucune extraction OpenAI n'est déclenchée et aucune donnée n'est écrasée.
// Un contrôle avant/après (GET API) vérifie que le reçu est resté intact.

let browser, ctx, page, token, receiptId, before_

// `Connection: close` : le hook after() rejoue une requête après plusieurs secondes
// d'inactivité (fermeture du navigateur) et la socket keep-alive réutilisée se fait
// parfois réinitialiser (ECONNRESET). Une retentative couvre le résiduel.
async function authFetch(path, opts = {}) {
  const doFetch = () => fetch(`${URL}/api${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Connection: 'close', ...(opts.headers || {}) },
  })
  try {
    return await doFetch()
  } catch {
    return await doFetch()
  }
}

// describe() obligatoire : des hooks before/after top-level ne s'exécutent pas
// proprement (after jamais lancé, runner qui pend) — cf. gotcha E2E du repo.
describe('reçu — bouton « Relire » (relance de l\'extraction)', () => {
  before(async () => {
    const login = await fetch(`${URL}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    }).then(r => r.json())
    token = login.token
    assert.ok(token, 'login a échoué')

    const list = await authFetch('/sale-receipts?limit=all').then(r => r.json())
    const candidate = (list.data || []).find(r => r.status === 'done')
    assert.ok(candidate, 'aucun reçu extrait disponible pour le test')
    receiptId = candidate.id
    before_ = await authFetch(`/sale-receipts/${receiptId}`).then(r => r.json())

    browser = await chromium.launch()
    ctx = await browser.newContext()
    page = await ctx.newPage()
    await page.addInitScript(t => localStorage.setItem('erp_token', t), token)

    // Filet de sécurité global : aucune relance réelle ne doit partir depuis ce test.
    await ctx.route('**/api/sale-receipts/*/re-extract', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...before_, status: 'processing' }) }))
  })

  after(async () => {
    await browser?.close()
    // Le reçu doit être strictement intact (aucune relance réelle n'a pu partir).
    if (token && receiptId && before_) {
      const now = await authFetch(`/sale-receipts/${receiptId}`).then(r => r.json())
      assert.equal(now.status, before_.status, 'le statut du reçu ne doit pas avoir changé')
      assert.equal(now.total ?? null, before_.total ?? null, 'les montants du reçu ne doivent pas avoir changé')
    }
  })

  test('le bouton est dans l\'en-tête et demande confirmation avant de relancer', async () => {
    await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'domcontentloaded' })

    const btn = page.getByTestId('receipt-reread')
    await btn.waitFor({ state: 'visible', timeout: 30000 })

    // 1er clic → dialogue de confirmation, puis Annuler = aucune relance.
    let posted = false
    page.on('request', r => { if (r.url().includes('/re-extract') && r.method() === 'POST') posted = true })
    await btn.click()
    const dialog = page.locator('[role="dialog"]')
    await dialog.waitFor({ state: 'visible', timeout: 5000 })
    await assert.doesNotReject(dialog.getByText('Relire le document ?').first().waitFor({ timeout: 5000 }),
      'le dialogue doit annoncer la relecture du document')
    await dialog.getByRole('button', { name: 'Annuler' }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 5000 })
    assert.equal(posted, false, 'annuler ne doit déclencher aucune relance')

    // 2e clic + confirmation → POST /re-extract (intercepté) et passage en « en cours ».
    const req = page.waitForRequest(r => r.url().includes('/re-extract') && r.method() === 'POST', { timeout: 10000 })
    await btn.click()
    await dialog.waitFor({ state: 'visible', timeout: 5000 })
    await dialog.getByRole('button', { name: 'Relire' }).click()
    await assert.doesNotReject(req, 'confirmer doit déclencher la relance de l\'extraction')

    await assert.doesNotReject(page.getByText('Extraction en cours…').first().waitFor({ timeout: 10000 }),
      'la fiche doit basculer en « Extraction en cours »')
  })
})
