// Subscribe-card : validation de l'adresse de la ferme.
//
// Vérifie que POST /qualification-calls/:id/subscribe-card refuse de créer
// la souscription tant que la company n'a pas d'adresse Ferme structurée
// (postal_code + province + country). Une fois l'adresse persistée via
// POST /qualification-calls/:id/farm-address, la validation passe et l'erreur
// suivante du pipeline (payment_method_id manquant, ou Stripe non configuré)
// est retournée — ce qui prouve que la barrière adresse a été franchie.
//
// Test purement API (page.evaluate pour récupérer le token JWT), pas d'UI.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

async function apiFetch(page, path, init = {}) {
  return await page.evaluate(async ({ path, init }) => {
    const tok = localStorage.getItem('erp_token')
    const headers = Object.assign({}, init.headers || {}, { Authorization: `Bearer ${tok}` })
    if (init.body) headers['Content-Type'] = 'application/json'
    const r = await fetch('/erp' + path, { ...init, headers })
    const text = await r.text()
    try { return { status: r.status, body: JSON.parse(text) } } catch { return { status: r.status, body: text } }
  }, { path, init })
}

describe('Subscribe-card — validation de l\'adresse Ferme', () => {
  let browser, ctx, page
  let companyId = null
  let callId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    // Crée une company de test avec un nom unique pour pouvoir la retrouver/supprimer
    const companyName = `E2E Subscribe Card ${Date.now()}`
    const cRes = await apiFetch(page, '/api/companies', {
      method: 'POST',
      body: JSON.stringify({ name: companyName }),
    })
    assert.ok(cRes.status === 200 || cRes.status === 201,
      `company creation failed (status ${cRes.status}): ${JSON.stringify(cRes.body)}`)
    companyId = cRes.body.id

    // Crée un qualification call pour cette company
    const qRes = await apiFetch(page, '/api/qualification-calls', {
      method: 'POST',
      body: JSON.stringify({ company_id: companyId }),
    })
    assert.ok(qRes.status === 200 || qRes.status === 201,
      `qualification-call creation failed (status ${qRes.status}): ${JSON.stringify(qRes.body)}`)
    callId = qRes.body.id
  })

  after(async () => {
    // Cleanup : DELETE call puis company (soft-delete pour les deux).
    // Sans cleanup, chaque run laisse une "E2E Subscribe Card …" company en DB.
    if (callId) {
      try { await apiFetch(page, `/api/qualification-calls/${callId}`, { method: 'DELETE' }) } catch {}
    }
    if (companyId) {
      try { await apiFetch(page, `/api/companies/${companyId}`, { method: 'DELETE' }) } catch {}
    }
    await browser?.close()
  })

  test('subscribe-card refuse 400 quand aucune adresse Ferme structurée n\'existe', async () => {
    const res = await apiFetch(page, `/api/qualification-calls/${callId}/subscribe-card`, {
      method: 'POST',
      body: JSON.stringify({
        payment_method_id: 'pm_test_fake',
        helper: 1,
        chief: 0,
        currency: 'CAD',
      }),
    })
    assert.equal(res.status, 400, `attendu 400, reçu ${res.status} : ${JSON.stringify(res.body)}`)
    assert.match(
      String(res.body?.error || ''),
      /[Aa]dresse.*ferme.*incompl/i,
      `message d'erreur doit mentionner l'adresse incomplète, reçu : ${res.body?.error}`
    )
  })

  test('subscribe-card refuse aussi quand l\'adresse Ferme manque postal_code', async () => {
    // Crée une row Ferme partielle (sans postal_code)
    const upsertRes = await apiFetch(page, `/api/qualification-calls/${callId}/farm-address`, {
      method: 'POST',
      body: JSON.stringify({
        line1: '123 Test Street',
        city: 'Montréal',
        province: 'QC',
        country: 'CA',
        // postal_code omis volontairement
      }),
    })
    assert.equal(upsertRes.status, 200, `farm-address upsert failed: ${JSON.stringify(upsertRes.body)}`)

    const res = await apiFetch(page, `/api/qualification-calls/${callId}/subscribe-card`, {
      method: 'POST',
      body: JSON.stringify({
        payment_method_id: 'pm_test_fake',
        helper: 1,
        chief: 0,
        currency: 'CAD',
      }),
    })
    assert.equal(res.status, 400)
    assert.match(String(res.body?.error || ''), /[Aa]dresse.*ferme.*incompl/i)
  })

  test('subscribe-card franchit la validation d\'adresse quand tous les champs sont présents', async () => {
    // Maintenant on upserte une adresse Ferme complète
    const upsertRes = await apiFetch(page, `/api/qualification-calls/${callId}/farm-address`, {
      method: 'POST',
      body: JSON.stringify({
        line1: '123 Test Street',
        city: 'Montréal',
        province: 'QC',
        postal_code: 'H2X 1Y4',
        country: 'CA',
      }),
    })
    assert.equal(upsertRes.status, 200)

    const res = await apiFetch(page, `/api/qualification-calls/${callId}/subscribe-card`, {
      method: 'POST',
      body: JSON.stringify({
        payment_method_id: 'pm_test_fake',
        helper: 1,
        chief: 0,
        currency: 'CAD',
      }),
    })
    // Adresse OK → la requête traverse la validation. L'erreur suivante doit
    // venir soit de Stripe non configuré (503), soit d'une erreur Stripe sur
    // le payment_method_id bidon (400 avec un autre message). Ce qui compte :
    // on ne doit PLUS recevoir le message « Adresse de la ferme incomplète ».
    assert.notEqual(res.status, 200, `subscribe-card ne doit pas réussir avec un PM bidon (reçu ${res.status})`)
    assert.doesNotMatch(
      String(res.body?.error || ''),
      /[Aa]dresse.*ferme.*incompl/i,
      `la validation d'adresse aurait dû passer, reçu : ${res.body?.error}`
    )
  })

  test('GET /farm-address renvoie la row Ferme structurée (utilisé par l\'iframe au load)', async () => {
    const res = await apiFetch(page, `/api/qualification-calls/${callId}/farm-address`, { method: 'GET' })
    assert.equal(res.status, 200)
    assert.ok(res.body, 'la response doit contenir l\'adresse Ferme persistée par les tests précédents')
    assert.equal(res.body.postal_code, 'H2X 1Y4')
    assert.equal(res.body.province, 'QC')
    assert.equal(res.body.country, 'CA')
  })

  test('GET fallback : Facturation est préférée à Ferme si elle existe', async () => {
    // Crée une company fraîche avec UNIQUEMENT une row Facturation (pas de
    // Ferme). Le GET doit la résoudre via le fallback (priorité Facturation
    // > Ferme > Livraison).
    const cName = `E2E Fallback ${Date.now()}`
    const c = await apiFetch(page, '/api/companies', { method: 'POST', body: JSON.stringify({ name: cName }) })
    assert.ok(c.status === 200 || c.status === 201)
    const fbCompanyId = c.body.id
    const q = await apiFetch(page, '/api/qualification-calls', { method: 'POST', body: JSON.stringify({ company_id: fbCompanyId }) })
    assert.ok(q.status === 200 || q.status === 201)
    const fbCallId = q.body.id

    try {
      // Écrit une row Facturation via POST /farm-address (address_type explicite)
      const w = await apiFetch(page, `/api/qualification-calls/${fbCallId}/farm-address`, {
        method: 'POST',
        body: JSON.stringify({
          line1: '111 Facturation Blvd',
          city: 'Montréal',
          province: 'QC',
          postal_code: 'H3A 0G4',
          country: 'CA',
          address_type: 'Facturation',
        }),
      })
      assert.equal(w.status, 200)

      // GET doit renvoyer la Facturation (pas null, vu qu'il n'y a pas de Ferme)
      const r = await apiFetch(page, `/api/qualification-calls/${fbCallId}/farm-address`, { method: 'GET' })
      assert.equal(r.status, 200)
      assert.equal(r.body?.line1, '111 Facturation Blvd')
      assert.equal(r.body?.address_type, 'Facturation')

      // subscribe-card doit aussi traverser la validation avec la Facturation
      const sc = await apiFetch(page, `/api/qualification-calls/${fbCallId}/subscribe-card`, {
        method: 'POST',
        body: JSON.stringify({ payment_method_id: 'pm_test_fake', helper: 1, currency: 'CAD' }),
      })
      assert.notEqual(sc.status, 200)
      assert.doesNotMatch(String(sc.body?.error || ''), /[Aa]dresse.*ferme.*incompl/i)
    } finally {
      await apiFetch(page, `/api/qualification-calls/${fbCallId}`, { method: 'DELETE' })
      await apiFetch(page, `/api/companies/${fbCompanyId}`, { method: 'DELETE' })
    }
  })

  test('subscribe-card accepte farm_address en payload et persiste avant la validation', async () => {
    // Crée une nouvelle company sans aucune row Ferme → subscribe-card devrait
    // d'abord refuser, puis accepter quand on passe farm_address dans le body.
    const cName = `E2E SC Override ${Date.now()}`
    const c = await apiFetch(page, '/api/companies', { method: 'POST', body: JSON.stringify({ name: cName }) })
    assert.ok(c.status === 200 || c.status === 201)
    const newCompanyId = c.body.id
    const q = await apiFetch(page, '/api/qualification-calls', { method: 'POST', body: JSON.stringify({ company_id: newCompanyId }) })
    assert.ok(q.status === 200 || q.status === 201)
    const newCallId = q.body.id

    try {
      // 1) Sans payload, sans DB row → 400 adresse incomplète
      const fail = await apiFetch(page, `/api/qualification-calls/${newCallId}/subscribe-card`, {
        method: 'POST',
        body: JSON.stringify({ payment_method_id: 'pm_test_fake', helper: 1, currency: 'CAD' }),
      })
      assert.equal(fail.status, 400)
      assert.match(String(fail.body?.error || ''), /[Aa]dresse.*ferme.*incompl/i)

      // 2) Avec payload farm_address → la row Ferme est upsertée puis la
      //    validation passe (l'erreur suivante vient de Stripe, pas de l'adresse).
      const pass = await apiFetch(page, `/api/qualification-calls/${newCallId}/subscribe-card`, {
        method: 'POST',
        body: JSON.stringify({
          payment_method_id: 'pm_test_fake',
          helper: 1,
          currency: 'CAD',
          farm_address: {
            line1: '999 Override Lane',
            city: 'Québec',
            province: 'QC',
            postal_code: 'G1R 5K9',
            country: 'CA',
          },
        }),
      })
      assert.notEqual(pass.status, 200)
      assert.doesNotMatch(String(pass.body?.error || ''), /[Aa]dresse.*ferme.*incompl/i,
        `la validation d'adresse aurait dû passer avec le payload, reçu : ${pass.body?.error}`)

      // 3) Vérifie que la row Ferme a bien été persistée par le payload
      const check = await apiFetch(page, `/api/qualification-calls/${newCallId}/farm-address`, { method: 'GET' })
      assert.equal(check.status, 200)
      assert.equal(check.body?.postal_code, 'G1R 5K9')
      assert.equal(check.body?.line1, '999 Override Lane')
    } finally {
      await apiFetch(page, `/api/qualification-calls/${newCallId}`, { method: 'DELETE' })
      await apiFetch(page, `/api/companies/${newCompanyId}`, { method: 'DELETE' })
    }
  })

  test('subscribe-card refuse les souscriptions sans Helper ni Chief même avec adresse OK', async () => {
    // Régression : la validation d'adresse passe en premier mais la suivante
    // (au moins un plan) doit toujours marcher.
    const res = await apiFetch(page, `/api/qualification-calls/${callId}/subscribe-card`, {
      method: 'POST',
      body: JSON.stringify({
        payment_method_id: 'pm_test_fake',
        helper: 0,
        chief: 0,
        currency: 'CAD',
      }),
    })
    assert.equal(res.status, 400)
    assert.match(String(res.body?.error || ''), /[Hh]elper|[Cc]hief/)
  })
})
