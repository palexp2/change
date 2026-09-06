// Comptes prépayés (/comptes-prepayes) — ledger fournisseurs prépayés + cédule FPA.
// Records jetables préfixés E2E, supprimés dans after() (jamais de mutation des
// vrais comptes Twilio / items FPA importés).
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
const VENDOR = `E2E Prepaid ${STAMP}`
const FPA_LABEL = `E2E FPA ${STAMP}`

describe('Comptes prépayés — ledger fournisseur + cédule FPA', () => {
  let browser, ctx, page, accountId, expenseId

  const apiFetch = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts })

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => {
    // Cleanup — s'exécute même en cas d'échec. Supprime les entrées du compte
    // jetable avant le compte lui-même, puis l'item FPA.
    try {
      if (accountId) {
        const r = await apiFetch(`/prepaid/accounts/${accountId}/entries`)
        for (const e of r.body?.entries || []) {
          await apiFetch(`/prepaid/entries/${e.id}`, { method: 'DELETE' })
        }
        await apiFetch(`/prepaid/accounts/${accountId}`, { method: 'DELETE' })
      }
    } catch {}
    try { if (expenseId) await apiFetch(`/prepaid/expenses/${expenseId}`, { method: 'DELETE' }) } catch {}
    await browser?.close()
  })

  test('la page affiche les deux volets et le compte Twilio importé', async () => {
    await page.goto(URL + '/comptes-prepayes', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Comptes prépayés")', { timeout: 15000 })
    await page.waitForSelector('[data-testid="tab-ledger"]')
    await page.waitForSelector('[data-testid="tab-fpa"]')
    // Le compte Twilio (import du sheet) existe et affiche un solde.
    await page.waitForSelector('button:has-text("Twilio")', { timeout: 15000 })
    await page.waitForSelector('[data-testid="prepaid-balance"]', { timeout: 15000 })
  })

  test('créer un compte jetable et un couple recharge/facture via l\'UI → solde exact', async () => {
    await page.click('[data-testid="prepaid-new-account"]')
    await page.fill('[data-testid="prepaid-vendor"]', VENDOR)
    await page.click('[data-testid="prepaid-create"]')
    // Le compte apparaît sélectionné (chip) — retrouver son id via l'API.
    await page.waitForSelector(`button:has-text("${VENDOR}")`, { timeout: 10000 })
    const accounts = await apiFetch('/prepaid/accounts')
    accountId = accounts.body.find(a => a.vendor === VENDOR)?.id
    assert.ok(accountId, 'compte jetable introuvable via API')

    // Recharge 100 $.
    await page.click('[data-testid="prepaid-new-entry"]')
    await page.selectOption('[data-testid="entry-type"]', 'recharge')
    await page.fill('[data-testid="entry-amount"]', '100')
    await page.fill('[data-testid="entry-description"]', 'E2E recharge')
    await page.click('[data-testid="entry-create"]')
    await page.waitForSelector('text=E2E recharge', { timeout: 10000 })

    // Facture 39,50 $.
    await page.click('[data-testid="prepaid-new-entry"]')
    await page.selectOption('[data-testid="entry-type"]', 'facture')
    await page.fill('[data-testid="entry-amount"]', '39.50')
    await page.fill('[data-testid="entry-description"]', 'E2E facture')
    await page.click('[data-testid="entry-create"]')
    await page.waitForSelector('text=E2E facture', { timeout: 10000 })

    // Solde = 100 − 39,50 = 60,50 (affiché et via API).
    let ok = false
    for (let i = 0; i < 30; i++) {
      const r = await apiFetch(`/prepaid/accounts/${accountId}/entries`)
      if (r.body?.balance === 60.5) { ok = true; break }
      await new Promise(res => setTimeout(res, 300))
    }
    assert.ok(ok, 'solde API ≠ 60.50')
    const txt = await page.textContent('[data-testid="prepaid-balance"]')
    assert.ok(txt.includes('60,50'), `solde affiché inattendu : ${txt}`)

    // Carte « Composition du solde » : recharges − factures = solde, lisible.
    const breakdown = await page.textContent('[data-testid="prepaid-breakdown"]')
    assert.ok(breakdown.includes('Recharges'), 'carte composition absente')
    assert.ok(breakdown.includes('100,00'), `recharges absentes de la composition : ${breakdown}`)
    assert.ok(breakdown.includes('39,50'), `factures absentes de la composition : ${breakdown}`)
    assert.ok(breakdown.includes('60,50'), `solde absent de la composition : ${breakdown}`)
  })

  test('vérification vs QB : bouton + rapport de complétude sur le compte Twilio (lecture seule)', async () => {
    // Compte réel Twilio — l'audit ne modifie rien (apply=false) : il recompare
    // le ledger aux transactions QB et affiche le rapport.
    await page.click('button:has-text("Twilio")')
    await page.waitForSelector('[data-testid="prepaid-audit"]')
    await page.click('[data-testid="prepaid-audit"]')
    await page.waitForSelector('[data-testid="prepaid-audit-result"]', { timeout: 60000 })
    const report = await page.textContent('[data-testid="prepaid-audit-result"]')
    // Rapport vert (complet) ou ambre (écarts listés) — dans les deux cas le
    // panneau doit parler de transactions/écarts, pas d'une erreur générique.
    assert.ok(/Ledger complet|écart/.test(report), `rapport d'audit inattendu : ${report}`)
    // Les entrées détectées de QB exposent qb_url (lien « Ouvrir dans QuickBooks »).
    const accounts = await apiFetch('/prepaid/accounts')
    const twilio = accounts.body.find(a => a.vendor === 'Twilio')
    const entries = await apiFetch(`/prepaid/accounts/${twilio.id}/entries`)
    for (const e of entries.body.entries) {
      assert.ok('qb_url' in e, 'qb_url absent de la réponse entries')
      if (e.source === 'qb') assert.ok(e.qb_url, `entrée QB sans qb_url : ${e.id}`)
    }
  })

  test('reclasser une entrée (facture → recharge) recalcule le solde', async () => {
    const r = await apiFetch(`/prepaid/accounts/${accountId}/entries`)
    const facture = r.body.entries.find(e => e.description === 'E2E facture')
    const upd = await apiFetch(`/prepaid/entries/${facture.id}`, { method: 'PUT', body: JSON.stringify({ type: 'recharge' }) })
    assert.equal(upd.status, 200)
    const after1 = await apiFetch(`/prepaid/accounts/${accountId}/entries`)
    assert.equal(after1.body.balance, 139.5)
    // Retour à l'état facture pour le reste du test.
    await apiFetch(`/prepaid/entries/${facture.id}`, { method: 'PUT', body: JSON.stringify({ type: 'facture' }) })
  })

  test('cédule FPA : créer un item prorata → mois répartis et fermeture à zéro', async () => {
    await page.click('[data-testid="tab-fpa"]')
    await page.waitForSelector('[data-testid="fpa-continuity"]', { timeout: 10000 })
    await page.click('[data-testid="fpa-new"]')
    await page.fill('[data-testid="fpa-label"]', FPA_LABEL)
    await page.fill('[data-testid="fpa-amount"]', '1200')
    // Période dans un exercice futur éloigné : n'interfère pas avec l'écriture
    // du mois courant (vrais items importés).
    await page.fill('[data-testid="fpa-start"]', '2031-04-01')
    await page.fill('[data-testid="fpa-end"]', '2031-09-30')
    await page.click('[data-testid="fpa-create"]')
    await page.waitForSelector(`text=${FPA_LABEL}`, { timeout: 10000 })

    const view = await apiFetch('/prepaid/expenses?fy=2031')
    const item = view.body.items.find(i => i.label === FPA_LABEL)
    assert.ok(item, 'item FPA introuvable via API')
    expenseId = item.id
    assert.equal(item.opening_balance, 1200)
    assert.equal(item.closing_balance, 0)
    const months = Object.values(item.months)
    assert.equal(months.length, 6)
    assert.equal(Math.round(months.reduce((s, m) => s + m.amount, 0) * 100) / 100, 1200)
  })

  test('l\'écriture d\'un mois de l\'item expose le montant et bloque sans compte de dépense', async () => {
    const m = await apiFetch('/prepaid/fpa/month/2031-05')
    assert.equal(m.status, 200)
    const line = m.body.lines.find(l => l.expense_id === expenseId)
    assert.ok(line, 'ligne du mois introuvable')
    assert.ok(line.amount > 0)
    // Pas de compte de dépense configuré → la publication doit refuser.
    assert.ok(m.body.missing_accounts.includes(FPA_LABEL))
    const pub = await apiFetch('/prepaid/fpa/month/2031-05/publish', { method: 'POST', body: '{}' })
    assert.equal(pub.status, 400)
  })
})
