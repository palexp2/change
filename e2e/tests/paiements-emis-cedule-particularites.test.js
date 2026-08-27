// /paiements-emis?onglet=cedule — la remarque ambre d'une ligne est éditable, et
// l'édition écrit dans le PROFIL du fournisseur.
//
// Ce que ça garantit :
//   1. la remarque du profil s'affiche sous la facture et se corrige sur place
//      (clic → champ, autosave au blur) — pas de bouton « Enregistrer » ;
//   2. la correction est enregistrée sur le profil fournisseur (/fournisseurs)
//      et remonte partout où il sert (indices fournisseur de /paiements-emis) ;
//   3. vider la remarque la retire du profil ET de la ligne — aucune affordance
//      d'ajout sur la cédule (l'ajout se fait sur le profil fournisseur), et une
//      remarque remise sur le profil réapparaît sur la ligne.
//
// Aucun record réel n'est touché : un profil fournisseur et une facture jetables
// marqués E2E, la facture créée en Brouillon puis passée à « Reçue » pour ne PAS
// écrire dans le Google Sheet CTB, tous deux supprimés dans after().
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
const VENDOR = `E2E Particularite ${STAMP}`
const P1 = `Facture à ctb le 30 du mois précédent ${STAMP}`
const P2 = `Facture à payer à la date d'échéance seulement ${STAMP}`
const P3 = `Réécrite après effacement ${STAMP}`
const TODAY = new Date().toISOString().slice(0, 10)

describe('Cédule — particularités du fournisseur éditables sur place', () => {
  let browser, ctx, page
  let profileId = null
  let billId = null

  const apiFetch = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts })

  // La donnée fait foi, pas le DOM : on interroge le profil fournisseur.
  const profile = async () => {
    const r = await apiFetch('/vendor-profiles')
    assert.equal(r.status, 200, `profils : ${JSON.stringify(r.body)}`)
    return (r.body?.data || []).find(p => p.id === profileId) || null
  }

  const waitForProfile = async (pred, label) => {
    for (let i = 0; i < 25; i++) {
      const p = await profile()
      if (pred(p)) return p
      await new Promise(r => setTimeout(r, 400))
    }
    assert.fail(`condition jamais atteinte sur le profil : ${label}`)
  }

  const openSchedule = async () => {
    await page.goto(`${URL}/paiements-emis?onglet=cedule`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="schedule-view"]', { timeout: 20000 })
    await page.waitForSelector(`[data-testid="schedule-item-${billId}"]`, { timeout: 20000 })
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Décor : un profil fournisseur avec sa particularité + une facture ouverte.
    let r = await apiFetch('/vendor-profiles', { method: 'POST', body: JSON.stringify({ name: VENDOR }) })
    assert.equal(r.status, 201, `création du profil : ${JSON.stringify(r.body)}`)
    profileId = r.body.id
    r = await apiFetch(`/vendor-profiles/${profileId}`, {
      method: 'PATCH', body: JSON.stringify({ particularites: P1 }),
    })
    assert.equal(r.status, 200, `particularité initiale : ${JSON.stringify(r.body)}`)

    r = await apiFetch('/achats-fournisseurs', {
      method: 'POST',
      body: JSON.stringify({
        type: 'bill', date_achat: TODAY, due_date: TODAY, vendor: VENDOR,
        vendor_invoice_number: `E2E-PART-${STAMP}`, amount_cad: 42.42, tax_cad: 0, total_cad: 42.42,
        status: 'Brouillon', notes: 'Record jetable créé par un test E2E',
      }),
    })
    assert.equal(r.status, 201, `création de la facture : ${JSON.stringify(r.body)}`)
    billId = r.body.id
    r = await apiFetch(`/achats-fournisseurs/${billId}`, { method: 'PUT', body: JSON.stringify({ status: 'Reçue' }) })
    assert.equal(r.status, 200, `statut de la facture : ${JSON.stringify(r.body)}`)

    await openSchedule()
  })

  after(async () => {
    // Cleanup — s'exécute même en cas d'échec.
    if (billId) {
      try { await apiFetch(`/treasury/payment-schedule/${billId}/pay`, { method: 'DELETE' }) } catch { /* pas de paiement */ }
      try { await apiFetch(`/achats-fournisseurs/${billId}`, { method: 'DELETE' }) } catch { /* déjà parti */ }
    }
    if (profileId) { try { await apiFetch(`/vendor-profiles/${profileId}`, { method: 'DELETE' }) } catch { /* déjà parti */ } }
    await browser?.close()
  })

  test('la remarque du profil s\'affiche sous la facture et se corrige sur place', async () => {
    const shown = await page.textContent(`[data-testid="schedule-particularites-${billId}"]`)
    assert.ok(shown.includes(P1), `remarque initiale absente de la ligne : ${shown}`)

    // Clic sur le texte → champ d'édition, aucun bouton « Enregistrer ».
    await page.click(`[data-testid="schedule-particularites-edit-${billId}"]`)
    await page.waitForSelector(`[data-testid="schedule-particularites-input-${billId}"]`, { timeout: 10000 })
    await page.fill(`[data-testid="schedule-particularites-input-${billId}"]`, P2)
    await page.keyboard.press('Enter')   // autosave au blur

    const p = await waitForProfile(x => x?.particularites === P2, 'remarque corrigée sur le profil')
    assert.equal(p.particularites, P2)

    // La ligne affiche la version à jour…
    await page.waitForFunction(
      ({ id, text }) => document.querySelector(`[data-testid="schedule-particularites-${id}"]`)?.textContent.includes(text),
      { id: billId, text: P2 }, { timeout: 20000 },
    )
    // …et la remarque remonte là où le profil sert (formulaire de paiement).
    const hints = await apiFetch('/treasury/payments/vendor-hints')
    assert.equal(hints.status, 200)
    const hint = (hints.body || []).find(h => h.profile_id === profileId)
    assert.ok(hint, 'le fournisseur doit exister dans les indices de paiement')
    assert.equal(hint.particularites, P2, 'la remarque corrigée doit remonter dans les indices')
  })

  test('vider la remarque la retire de la ligne, sans bouton d\'ajout sur la cédule', async () => {
    await page.click(`[data-testid="schedule-particularites-edit-${billId}"]`)
    await page.waitForSelector(`[data-testid="schedule-particularites-input-${billId}"]`, { timeout: 10000 })
    await page.fill(`[data-testid="schedule-particularites-input-${billId}"]`, '')
    await page.keyboard.press('Enter')

    await waitForProfile(x => x && !x.particularites, 'remarque retirée du profil')
    // Plus d'alerte ambre sur la ligne — et surtout, plus d'affordance d'ajout :
    // la remarque s'ajoute sur le profil du fournisseur.
    await page.waitForSelector(`[data-testid="schedule-particularites-${billId}"]`, { state: 'detached', timeout: 20000 })
    assert.equal(
      await page.locator(`[data-testid="schedule-particularites-add-${billId}"]`).count(), 0,
      'aucun bouton « + particularité » ne doit rester sur la ligne',
    )

    // Remise sur le profil, elle réapparaît sur la ligne (et redevient éditable).
    const r = await apiFetch(`/vendor-profiles/${profileId}`, { method: 'PATCH', body: JSON.stringify({ particularites: P3 }) })
    assert.equal(r.status, 200, `remarque remise sur le profil : ${JSON.stringify(r.body)}`)
    const p = await waitForProfile(x => x?.particularites === P3, 'remarque remise sur le profil')
    assert.equal(p.particularites, P3)
    await openSchedule()
    await page.waitForFunction(
      ({ id, text }) => document.querySelector(`[data-testid="schedule-particularites-${id}"]`)?.textContent.includes(text),
      { id: billId, text: P3 }, { timeout: 20000 },
    )
  })

  test('Échap annule la correction en cours (rien n\'est écrit sur le profil)', async () => {
    await page.click(`[data-testid="schedule-particularites-edit-${billId}"]`)
    await page.fill(`[data-testid="schedule-particularites-input-${billId}"]`, 'À jeter — jamais enregistré')
    await page.keyboard.press('Escape')
    await page.waitForSelector(`[data-testid="schedule-particularites-${billId}"]`, { timeout: 10000 })

    const shown = await page.textContent(`[data-testid="schedule-particularites-${billId}"]`)
    assert.ok(shown.includes(P3), `la remarque doit être inchangée après Échap : ${shown}`)
    const p = await profile()
    assert.equal(p.particularites, P3, 'Échap ne doit rien écrire sur le profil')
  })
})
