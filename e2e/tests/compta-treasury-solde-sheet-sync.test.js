// Comptabilité → Projection BNC : lecture du Google Sheet « Maintien du solde
// disponible BNC » (le fichier tenu à la main).
//
// Désactivée le 2026-08-29 : elle créait des treasury_payments en double avec
// Pmt_Suivi et la cédule (même paiement importé deux fois, sous deux
// import_key différents) — voir memory reference_solde_sheet_sync et
// gotcha_solde_sheet_duplicates. Ce fichier vérifie surtout qu'elle RESTE
// inerte (bandeau explicite, bouton manuel absent, endpoint qui refuse) —
// plus la lecture des anomalies/rentrées historiques, qui reste utile.
//
// Lecture seule.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Comptabilité — sync du fichier Maintien du solde disponible BNC', () => {
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
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    await browser?.close()
  })

  // Le détail de la sync (état du fichier, anomalies, différences) vit dans le
  // panneau d'attention replié — la carte ne montre plus que trois chiffres et
  // les mouvements (refonte « simple à scanner » du 18 août 2026). On l'ouvre.
  async function openAttention() {
    await page.waitForSelector('[data-testid="treasury-attention-toggle"]', { timeout: 20000 })
    if (await page.locator('[data-testid="treasury-sheet-sync"]').count() === 0) {
      await page.click('[data-testid="treasury-attention-toggle"]')
    }
    await page.waitForSelector('[data-testid="treasury-sheet-sync"]', { state: 'visible', timeout: 15000 })
  }

  // Désactivée le 2026-08-29 (Charles : le fichier créait des paiements en
  // double avec Pmt_Suivi/la cédule — [[reference_solde_sheet_sync]]). Le
  // bandeau dit pourquoi, et n'offre plus de bouton pour la relancer.
  test('le bandeau affiche que la sync est désactivée, sans bouton pour la relancer', async () => {
    await page.goto(URL + '/comptabilite', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="treasury-section"]', { state: 'attached', timeout: 20000 })
    await openAttention()
    const bar = page.locator('[data-testid="treasury-sheet-sync"]')
    const text = await bar.textContent()
    assert.match(text, /Maintien du solde disponible BNC/)
    assert.match(text, /désactivée/)

    const status = (await apiFetch('/treasury/solde-sheet/status')).body
    assert.equal(status.active, false, 'la sync du fichier de solde doit rester désactivée')

    assert.equal(await page.locator('[data-testid="treasury-sheet-sync-run"]').count(), 0,
      'aucun bouton ne doit permettre de relancer une sync désactivée')
  })

  test('une ligne illisible du fichier est affichée, jamais avalée en silence', async () => {
    await page.goto(URL + '/comptabilite', { waitUntil: 'domcontentloaded' })
    await openAttention()
    const run = (await apiFetch('/treasury/solde-sheet/status')).body.last_run
    if (!run || run.status !== 'success') return // sync en échec : couvert ailleurs
    const anomalies = run.anomalies || []
    const block = page.locator('[data-testid="treasury-sheet-anomalies"]')
    if (!anomalies.length) {
      assert.equal(await block.count(), 0, 'aucune anomalie mais le bloc est affiché')
      return
    }
    await block.waitFor({ state: 'visible', timeout: 5000 })
    const shown = await block.textContent()
    for (const a of anomalies) {
      assert.ok(['error', 'warn'].includes(a.severity), `sévérité inattendue : ${a.severity}`)
      // Chaque anomalie du rapport est réellement sous les yeux de l'utilisateur.
      assert.ok(shown.includes(a.text.slice(0, 40)), `anomalie non affichée : ${a.text}`)
    }
    // Le montant qui n'entre pas dans la projection est chiffré à l'écran.
    if (run.not_counted?.total > 0) {
      const el = page.locator('[data-testid="treasury-sheet-not-counted"]')
      await el.waitFor({ state: 'visible', timeout: 5000 })
      assert.match(await el.textContent(), /non comptés/)
    }
  })

  test('la sync manuelle refuse de tourner tant que l\'automation est désactivée', async () => {
    const r = await apiFetch('/treasury/solde-sheet/sync', {
      method: 'POST',
      body: JSON.stringify({ dry_run: true }),
    })
    assert.equal(r.status, 409, 'le bouton manuel ne doit pas être une porte de derrière pour la sync désactivée')
  })

  test('la projection ne compte que des rentrées certaines, et dit ce qu\'elle écarte', async () => {
    const r = await apiFetch('/treasury/projection')
    assert.equal(r.status, 200)
    const inflows = r.body.inflows
    assert.ok(inflows, 'la projection doit exposer le détail des rentrées')

    let sum = 0
    for (const p of inflows.counted) {
      // Chaque dollar compté est justifié : argent déjà chez Stripe et en route.
      assert.ok(p.certainty, 'une rentrée comptée doit dire pourquoi elle est sûre')
      assert.ok(['pending', 'in_transit', 'paid'].includes(p.status), `statut non certain compté : ${p.status}`)
      assert.ok(p.date >= new Date().toISOString().slice(0, 10), 'rentrée datée dans le passé')
      sum += p.amount
    }
    assert.ok(Math.abs(sum - inflows.total_counted) < 0.005)
    // Rien n'est écarté sans motif.
    for (const p of inflows.excluded) assert.ok(p.reason, 'rentrée écartée sans raison affichée')
    // Donnée Stripe périmée = aucune rentrée comptée (on ne mise pas sur un
    // statut qu'on n'a pas revérifié).
    if (inflows.stripe_stale) assert.equal(inflows.counted.length, 0)

    // Ce détail est visible sur la page, pas seulement dans l'API.
    await page.goto(URL + '/comptabilite', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="treasury-section"]', { state: 'attached', timeout: 20000 })
    const banner = page.locator('[data-testid="treasury-inflows"]')
    if (inflows.counted.length || inflows.excluded.length) {
      await openAttention()
      await banner.waitFor({ state: 'visible', timeout: 15000 })
      // Libellés raccourcis (22 août 2026) : « Rentrées » est l'étiquette de la
      // ligne, la valeur ne répète plus le mot.
      const txt = await banner.textContent()
      if (inflows.counted.length) assert.match(txt, /Rentrées.*comptée/s)
      if (inflows.excluded.length) assert.match(txt, /non compté/)
    }
  })
})
