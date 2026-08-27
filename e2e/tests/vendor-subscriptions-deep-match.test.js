// Rapprochement approfondi des charges d'abonnement (« probablement comptabilisé »).
//
// Deux constats DISTINCTS, deux corrections distinctes — c'est le cœur du test :
//   1. « Comptabilisé sous un autre nom » : le fournisseur porte un autre nom dans
//      QuickBooks → le bouton retient ce nom comme alias du profil.
//   2. « Comptabilisé à une autre date » : même fournisseur, mais facturé hors de
//      la date prévue → poser un alias n'y changerait RIEN, c'est la cédule qu'il
//      faut caler sur la date réellement facturée.
//
// Le test crée des abonnements JETABLES adossés à des dépenses réellement
// comptabilisées, vérifie verdict + affichage + effet du bouton, puis restaure
// tout (alias du profil touché, suppression des abonnements de test).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Nom volontairement mal orthographié : le rapprochement STRICT échoue (aucune
// contenance), seul le rapprochement approfondi peut le relier à « Novo Express ».
const MISSPELLED_VENDOR = 'Novoo Expresss'
const REAL_VENDOR = 'Novo Express'

const iso = d => d.toISOString().slice(0, 10)
const shift = (s, n) => { const x = new Date(`${s}T12:00:00`); x.setDate(x.getDate() + n); return iso(x) }
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')

async function login() {
  const r = await fetch(`${URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  })
  if (!r.ok) throw new Error(`Login failed: ${r.status}`)
  const { token } = await r.json()
  return token
}

describe('Abonnements fournisseurs — rapprochement approfondi', () => {
  let token, browser, ctx, page
  let subName = null      // abonnement jetable « autre nom »
  let subDate = null      // abonnement jetable « autre date »
  let profile = null      // profil « Novo Express »
  let originalAliases = null
  let offWindow = null    // { vendor, chargeDate, expectedDate }

  // Node réutilise les connexions keep-alive ; entre deux étapes du test le
  // serveur peut fermer la sienne au même instant (ECONNRESET). Une reprise
  // immédiate suffit — c'est un aléa de socket, pas une panne de l'API.
  const authed = async (path, init = {}) => {
    const opts = {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    }
    try {
      return await fetch(`${URL}/api${path}`, opts)
    } catch {
      return fetch(`${URL}/api${path}`, opts)
    }
  }

  // Attend l'EFFET de l'action (l'API fait foi), plutôt qu'un délai fixe qui
  // devient trop court dès que la machine est chargée.
  const waitFor = async (probe, label, timeout = 20000) => {
    const deadline = Date.now() + timeout
    let last
    for (;;) {
      last = await probe()
      if (last) return last
      if (Date.now() > deadline) throw new Error(`délai dépassé : ${label}`)
      await new Promise(r => setTimeout(r, 500))
    }
  }

  const createSub = async body => {
    const r = await authed('/vendor-subscriptions', {
      method: 'POST',
      body: JSON.stringify({ currency: 'CAD', active: 1, comments: 'Record de test E2E — supprimé automatiquement', ...body }),
    })
    assert.equal(r.status, 201, `création abonnement : ${r.status}`)
    return r.json()
  }

  before(async () => {
    token = await login()
    const achats = await (await authed('/achats-fournisseurs?limit=all')).json()
    const booked = (achats.data || []).filter(a => a.quickbooks_id && a.vendor && a.date_achat)
    const today = iso(new Date())

    // ── Cas 1 : dépense « Novo Express » comptabilisée, assez vieille pour dépasser
    // le délai de grâce et assez récente pour tomber dans la rétrospection.
    const charge = booked
      .filter(a => a.vendor === REAL_VENDOR && a.date_achat >= shift(today, -40) && a.date_achat <= shift(today, -8))
      .sort((a, b) => (a.date_achat < b.date_achat ? 1 : -1))[0]
    assert.ok(charge, `aucune dépense ${REAL_VENDOR} comptabilisée dans la fenêtre utile`)
    subName = await createSub({
      vendor: MISSPELLED_VENDOR,
      frequency: 'Mensuel',
      billing_day: Number(charge.date_achat.slice(8, 10)),
      amount: charge.total_cad,
    })

    // ── Cas 2 : un fournisseur dont une dépense comptabilisée tombe ~45 jours
    // APRÈS la date de cédule, sans aucune dépense du même fournisseur dans la
    // fenêtre attendue. Choisi dans les données réelles pour rester valide dans
    // le temps.
    const cand = booked.find(a => {
      if (a.date_achat > shift(today, -45) || a.date_achat < shift(today, -140)) return false
      const expected = shift(a.date_achat, -45)
      const key = norm(a.vendor)
      return !booked.some(o => {
        const k = norm(o.vendor)
        const sameVendor = k === key || (key.length >= 4 && k.includes(key)) || (k.length >= 4 && key.includes(k))
        return sameVendor && o.date_achat >= shift(expected, -10) && o.date_achat <= shift(expected, 30)
      })
    })
    assert.ok(cand, 'aucun fournisseur avec une dépense isolée hors fenêtre')
    const expected = shift(cand.date_achat, -45)
    offWindow = { vendor: cand.vendor, chargeDate: cand.date_achat, expectedDate: expected }
    subDate = await createSub({
      vendor: cand.vendor,
      frequency: 'Annuel',
      billing_day: Number(expected.slice(8, 10)),
      billing_month: Number(expected.slice(5, 7)),
      amount: cand.total_cad,
      currency: cand.currency || 'CAD',
    })

    const profiles = await (await authed('/vendor-profiles')).json()
    profile = (profiles.data || []).find(p => p.name === REAL_VENDOR)
    assert.ok(profile, `profil fournisseur ${REAL_VENDOR} introuvable`)
    originalAliases = profile.aliases || []

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    page = await ctx.newPage()
    await page.goto(`${URL}/login`)
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button[type="submit"]')
    await page.waitForURL(/\/erp\/(?!login)/, { timeout: 20000 })
  })

  after(async () => {
    await browser?.close()
    // Restauration : l'alias appris par le test est retiré du profil réel.
    if (profile && originalAliases) {
      await authed(`/vendor-profiles/${profile.id}`, {
        method: 'PATCH', body: JSON.stringify({ aliases: originalAliases }),
      }).catch(() => {})
    }
    for (const s of [subName, subDate]) {
      if (s) await authed(`/vendor-subscriptions/${s.id}`, { method: 'DELETE' }).catch(() => {})
    }
  })

  test('API : autre nom → « other_name », autre date → « off_window »', async () => {
    const data = await (await authed('/vendor-subscriptions/missing-receipts')).json()
    assert.ok(typeof data.counts.likely_booked === 'number', 'counts.likely_booked absent')

    const byName = data.missing.find(m => m.subscription_id === subName.id && m.status === 'likely_booked')
    assert.ok(byName, 'nom mal orthographié non rapproché')
    assert.equal(byName.evidence.vendor, REAL_VENDOR)
    assert.equal(byName.evidence.reason, 'other_name')
    assert.equal(byName.evidence.in_window, true)

    const byDate = data.missing.find(m => m.subscription_id === subDate.id && m.status === 'likely_booked')
    assert.ok(byDate, 'dépense hors fenêtre non rapprochée')
    assert.equal(byDate.evidence.reason, 'off_window')
    assert.equal(byDate.evidence.name_match, 'same')
    assert.equal(byDate.evidence.date, offWindow.chargeDate)

    // Contrat : une charge « aucune trace » ne porte jamais de pièce.
    for (const m of data.missing.filter(m => m.status === 'missing')) {
      assert.equal(m.evidence, null, `${m.vendor} : missing avec evidence`)
    }
  })

  test('un simple jeton en commun ne rapproche pas deux fournisseurs distincts', async () => {
    // « ZZ Express » partage « express » avec « Novo Express » — et rien d'autre.
    const decoy = await createSub({
      vendor: 'ZZ Expresss', frequency: 'Mensuel',
      billing_day: Number(offWindow.chargeDate.slice(8, 10)),
    })
    try {
      const data = await (await authed('/vendor-subscriptions/missing-receipts')).json()
      const rows = data.missing.filter(m => m.subscription_id === decoy.id)
      assert.ok(rows.length, 'aucune charge attendue pour le leurre')
      assert.ok(rows.every(m => m.status === 'missing' && m.evidence === null),
        `leurre rapproché à tort : ${JSON.stringify(rows.map(r => r.evidence))}`)
    } finally {
      await authed(`/vendor-subscriptions/${decoy.id}`, { method: 'DELETE' })
    }
  })

  test('UI : « C\'est le même fournisseur » retient le nom QuickBooks', async () => {
    await page.goto(`${URL}/fournisseurs/abonnements`)
    const section = page.locator('[data-testid="missing-receipts"]')
    await section.waitFor({ timeout: 20000 })

    const row = section.locator('tr', { hasText: MISSPELLED_VENDOR }).first()
    await row.waitFor({ timeout: 20000 })
    const text = await row.innerText()
    assert.ok(text.includes('Comptabilisé sous un autre nom'), `badge « autre nom » absent : ${text}`)
    assert.ok(text.includes(REAL_VENDOR), `pièce trouvée non affichée : ${text}`)

    await row.locator(`[data-testid="link-vendor-${subName.id}"]`).click()

    await waitFor(async () => {
      const profiles = await (await authed('/vendor-profiles')).json()
      const updated = (profiles.data || []).find(p => p.id === profile.id)
      return updated?.aliases?.includes(MISSPELLED_VENDOR) ? updated : null
    }, `alias ${MISSPELLED_VENDOR} appris sur ${REAL_VENDOR}`)

    // Nom appris → rapprochement strict → la charge sort de la liste.
    const data = await (await authed('/vendor-subscriptions/missing-receipts')).json()
    assert.equal(data.missing.filter(m => m.subscription_id === subName.id).length, 0)
  })

  test('UI : « Caler la cédule » corrige la date au lieu de poser un alias inutile', async () => {
    await page.goto(`${URL}/fournisseurs/abonnements`)
    const section = page.locator('[data-testid="missing-receipts"]')
    await section.waitFor({ timeout: 20000 })

    const row = section.locator(`tr:has([data-testid="fix-schedule-${subDate.id}"])`).first()
    await row.waitFor({ timeout: 20000 })
    const text = await row.innerText()
    assert.ok(text.includes('Comptabilisé à une autre date'), `badge « autre date » absent : ${text}`)
    // Le bouton d'alias n'a pas lieu d'être ici : il ne corrigerait rien.
    assert.equal(await row.locator(`[data-testid="link-vendor-${subDate.id}"]`).count(), 0)

    await row.locator(`[data-testid="fix-schedule-${subDate.id}"]`).click()

    const sub = await waitFor(async () => {
      const s = await (await authed(`/vendor-subscriptions/${subDate.id}`)).json()
      return s.billing_day === Number(offWindow.chargeDate.slice(8, 10)) ? s : null
    }, 'cédule calée sur la date de la dépense')
    assert.equal(sub.billing_month, Number(offWindow.chargeDate.slice(5, 7)), 'mois de facturation non calé')

    // Cédule calée sur la dépense réelle → la charge sort de la liste.
    const data = await (await authed('/vendor-subscriptions/missing-receipts')).json()
    assert.equal(data.missing.filter(m => m.subscription_id === subDate.id).length, 0)
  })
})
