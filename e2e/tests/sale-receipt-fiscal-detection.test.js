const { test, before, after, describe } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Détection fiscale robuste (services/fiscalDetection.js) : la fiche d'un reçu affiche
// le type de transaction + code de taxe détectés (panneau « Détection »), présélectionne
// le type, et expose en CONFLIT tout signal (profil fournisseur…) qui contredit les
// montants du document.
//
// On met le reçu dans un scénario contrôlé (fournisseur synthétique inconnu → seuls les
// signaux « règles »/« profil » créés par le test jouent), puis on restaure TOUT :
// champs du reçu + suppression du profil fournisseur créé.

// Nom unique par run : vendor_profiles.name porte un index UNIQUE qui inclut les
// profils soft-deletés — re-créer le même nom qu'un run précédent échouerait.
const TEST_VENDOR = `Fournisseur Détection E2E ${Date.now()}`

let browser, ctx, page, token, receiptId, original, createdProfileId

const api = (path, opts = {}) => fetch(`${URL}/api${path}`, {
  ...opts,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
}).then(r => r.json())

describe('détection fiscale', () => {
  before(async () => {
    const login = await fetch(`${URL}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    }).then(r => r.json())
    token = login.token
    assert.ok(token, 'login a échoué')

    const list = await api('/sale-receipts?limit=all')
    const cand = list.data.find(r => r.status === 'done' && !r.quickbooks_id)
    assert.ok(cand, 'un reçu done non publié est requis')
    receiptId = cand.id
    original = {
      company: cand.company ?? null, currency: cand.currency ?? null,
      subtotal: cand.subtotal ?? null, tps: cand.tps ?? null, tvq: cand.tvq ?? null,
      other_taxes: cand.other_taxes ?? null, total: cand.total ?? null,
      tax_code_id: cand.tax_code_id ?? null, transaction_type: cand.transaction_type ?? null,
      items: cand.items || [],
    }

    // Scénario 1 : fournisseur inconnu + TPS/TVQ aux taux légaux → détection par règles.
    await api(`/sale-receipts/${receiptId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        company: TEST_VENDOR, currency: 'CAD',
        subtotal: 100, tps: 5, tvq: 9.98, other_taxes: 0, total: 114.98,
        tax_code_id: null, transaction_type: null, items: [],
      }),
    })

    browser = await chromium.launch()
    ctx = await browser.newContext()
    page = await ctx.newPage()
    await page.addInitScript(t => localStorage.setItem('erp_token', t), token)
  })

  after(async () => {
    if (createdProfileId && token) {
      await api(`/vendor-profiles/${createdProfileId}`, { method: 'DELETE' }).catch(() => {})
    }
    if (receiptId && token) {
      await api(`/sale-receipts/${receiptId}`, { method: 'PATCH', body: JSON.stringify(original) })
    }
    await browser?.close()
  })

  test('API : fournisseur canadien taxé → achat local taxable, code adapté aux montants', async () => {
    const rec = await api(`/sale-receipts/${receiptId}`)
    const d = rec.fiscal_detection
    assert.ok(d, 'fiscal_detection absent de la réponse API')
    assert.equal(d.transaction_type, 'achat_local_taxable')
    assert.equal(d.source, 'regles')
    assert.equal(d.tax_code_name, 'TPS/TVQ QC - 9,975')
    assert.equal(rec.suggested_transaction_type, 'achat_local_taxable')
  })

  test('UI : panneau de détection affiché + type présélectionné', async () => {
    await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'networkidle' })

    // Le formulaire QB charge accounts/vendors/tax-codes depuis QB — peut être lent.
    const txtype = page.getByTestId('qb-txtype-select')
    await txtype.waitFor({ state: 'visible', timeout: 30000 })

    const panel = page.getByTestId('fiscal-detection')
    await panel.waitFor({ state: 'visible', timeout: 10000 })
    const text = await panel.textContent()
    assert.match(text, /Achat local taxable/, 'type détecté absent du panneau')
    assert.match(text, /règles internes/, 'source absente du panneau')
    assert.match(text, /confiance/, 'badge de confiance absent')

    // Le type détecté est présélectionné dans le sélecteur.
    const selText = await txtype.textContent()
    assert.match(selText, /Achat local taxable/, 'type non présélectionné')
  })

  test('UI : profil fournisseur contredit par les montants → conflit affiché', async () => {
    // Profil du fournisseur synthétique : défaut « exemption B2B détaxée » alors que le
    // document facture TPS + TVQ → le profil doit être ÉCARTÉ et affiché en conflit.
    const created = await api('/vendor-profiles', {
      method: 'POST',
      body: JSON.stringify({ name: TEST_VENDOR }),
    })
    createdProfileId = created.id
    assert.ok(createdProfileId, 'création du profil fournisseur a échoué')
    // POST ne prend que le nom — le défaut fiscal se pose via PATCH.
    await api(`/vendor-profiles/${createdProfileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ default_transaction_type: 'achat_num_inscrit_b2b_exempte' }),
    })

    await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'networkidle' })
    await page.getByTestId('qb-txtype-select').waitFor({ state: 'visible', timeout: 30000 })

    const conflict = page.getByTestId('fiscal-detection-conflict').first()
    await conflict.waitFor({ state: 'visible', timeout: 10000 })
    const text = await conflict.textContent()
    assert.match(text, /profil fournisseur/i, 'le conflit doit citer le profil fournisseur')
    assert.match(text, /TPS/, 'le conflit doit citer les taxes facturées')

    // Le panneau de détection retombe sur les règles, pas sur le profil contredit.
    const panelText = await page.getByTestId('fiscal-detection').textContent()
    assert.match(panelText, /Achat local taxable/)
  })
})
