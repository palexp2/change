// Rapprochement bancaire — panneau « façon QuickBooks » : solde du relevé
// calculé automatiquement, solde QuickBooks à la même date, écart et
// décomposition de l'écart.
//
// Test strictement en lecture : aucun record créé ni modifié (on ne clique
// jamais « Rapprocher automatiquement », qui apparierait de vraies écritures).
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Rapprochement bancaire — panneau de rapprochement automatique', () => {
  let browser, ctx, page

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
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    // Aucun record à nettoyer : le test ne fait que lire.
    await browser?.close()
  })

  test('le panneau affiche solde du relevé, solde QuickBooks et écart', async () => {
    await page.goto(URL + '/rapprochement', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Rapprochement bancaire")', { timeout: 20000 })
    await page.waitForSelector('[data-testid="reconcile-panel"]', { timeout: 20000 })

    // Le solde du relevé est calculé côté serveur à partir des lignes importées :
    // il doit s'afficher sans action de l'utilisateur.
    const stmt = page.locator('[data-testid="reconcile-statement-balance"]')
    await stmt.waitFor({ timeout: 20000 })
    // Le montant remplace le « … » de chargement dès la réponse de /summary.
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="reconcile-statement-balance"]')
      return !!el && /\d/.test(el.textContent || '')
    }, null, { timeout: 20000 })
    const txt = (await stmt.innerText()).trim()
    assert.ok(/\d/.test(txt), `solde du relevé non calculé : « ${txt} »`)

    // Les anciens boutons séparés ont fusionné dans le panneau.
    assert.equal(await page.locator('button:has-text("Matching auto")').count(), 0)
    await page.waitForSelector('[data-testid="reconcile-auto-btn"]', { timeout: 5000 })
  })

  test('la comparaison QuickBooks se charge seule et remplit l\'écart', async () => {
    // L'appel Intuit prend quelques secondes : on attend soit l'écart chiffré,
    // soit le message d'indisponibilité (QB déconnecté).
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="reconcile-difference"]')
      if (el && /\d/.test(el.textContent || '')) return true
      return !!document.body.innerText.includes('Comparaison QuickBooks indisponible')
    }, null, { timeout: 120000 })

    const diff = await page.locator('[data-testid="reconcile-difference"]').innerText()
    const unavailable = (await page.locator('text=Comparaison QuickBooks indisponible').count()) > 0
    assert.ok(/\d/.test(diff) || unavailable, `écart ni chiffré ni expliqué : « ${diff} »`)
  })

  test('l\'endpoint /summary renvoie un solde et des anomalies cohérents', async () => {
    const accounts = await apiFetch('/bank/accounts')
    assert.equal(accounts.status, 200)
    const withTxns = accounts.body.filter(a => a.txn_count > 0)
    assert.ok(withTxns.length > 0, 'aucun compte avec transactions')

    for (const acc of withTxns.slice(0, 4)) {
      const r = await apiFetch(`/bank/accounts/${acc.id}/summary`)
      assert.equal(r.status, 200, `summary ${acc.name}`)
      const s = r.body
      assert.equal(s.count, acc.txn_count, `nombre de transactions ${acc.name}`)
      assert.equal(typeof s.statement.balance_signed, 'number', `solde calculé ${acc.name}`)
      assert.match(s.statement.date, /^\d{4}-\d{2}-\d{2}$/)
      // Convention de solde déduite : +1 pour un compte de banque (solde
      // disponible), -1 pour une carte (solde dû) — donc un solde signé négatif
      // quand on doit de l'argent, comme QuickBooks.
      assert.ok([1, -1].includes(s.convention.direction))
      assert.ok(Array.isArray(s.anomalies))
      for (const a of s.anomalies) {
        assert.ok(['chaine_solde', 'doublon'].includes(a.kind), `anomalie inconnue ${a.kind}`)
        assert.ok(a.date >= s.anomalies_since, 'anomalie hors de la fenêtre annoncée')
      }
      // Les compteurs partitionnent les transactions du compte.
      const t = s.totals
      assert.ok(t.reconciled_count + t.pending_count <= s.count)
      assert.ok(t.no_document_count <= t.pending_count)
    }
  })

  test('l\'écart QuickBooks est exactement solde du relevé − solde QuickBooks', async () => {
    const accounts = await apiFetch('/bank/accounts')
    const acc = accounts.body.find(a => a.txn_count > 0 && a.qb_account_id)
    assert.ok(acc, 'aucun compte mappé à QuickBooks')
    const r = await apiFetch(`/bank/accounts/${acc.id}/qb-compare`)
    if (r.status === 502) {
      // QuickBooks indisponible : l'erreur doit être explicite, pas un plantage.
      assert.ok(r.body?.error, 'erreur QB sans message')
      return
    }
    assert.equal(r.status, 200)
    const b = r.body.balance
    assert.ok(b && !b.error, `solde QB indisponible : ${b?.error}`)
    assert.equal(Math.round((b.statement - b.qb_as_of) * 100) / 100, b.difference)
    // La décomposition de l'écart : ce qui est au relevé sans écriture QB, et
    // l'inverse. Les deux listes doivent être exploitables (date + montant).
    for (const m of r.body.missing_in_qb) {
      assert.match(m.date, /^\d{4}-\d{2}-\d{2}$/)
      assert.equal(typeof m.amount, 'number')
      assert.ok(m.txn_id)
    }
    for (const m of r.body.missing_in_statement) {
      assert.match(m.date, /^\d{4}-\d{2}-\d{2}$/)
      assert.equal(typeof m.amount, 'number')
      assert.ok(String(m.url).startsWith('https://'))
    }
    assert.ok(r.body.matched <= r.body.scanned)
  })

  test('cliquer une anomalie ouvre la transaction concernée dans le side-peek', async () => {
    // On cible un compte qui a effectivement des anomalies (le résumé est local,
    // donc la réponse est immédiate et le test déterministe).
    const accounts = await apiFetch('/bank/accounts')
    let target = null
    for (const acc of accounts.body.filter(a => a.txn_count > 0)) {
      const s = await apiFetch(`/bank/accounts/${acc.id}/summary`)
      if (s.body?.anomalies?.length) { target = acc; break }
    }
    if (!target) return // Aucun compte en anomalie : rien à déplier.

    await page.goto(`${URL}/rapprochement?compte=${target.id}`, { waitUntil: 'domcontentloaded' })
    const gap = page.locator('[data-testid="reconcile-gap-anomalies"]')
    await gap.waitFor({ timeout: 30000 })
    await gap.click()
    const firstRow = page.locator('[data-testid="reconcile-gap-anomalies"] ~ div button').first()
    await firstRow.waitFor({ timeout: 10000 })
    await firstRow.click()
    // Le side-peek de la DataTable s'ouvre sur la transaction cliquée : son
    // corps (TxnPeek) porte toujours la zone de commentaire.
    await page.waitForSelector('text=Commentaire', { timeout: 15000 })
  })
})
