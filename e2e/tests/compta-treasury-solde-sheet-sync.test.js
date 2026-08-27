// Comptabilité → Projection BNC : lecture du Google Sheet « Maintien du solde
// disponible BNC » (le fichier tenu à la main fait foi).
//
// Vérifie surtout la RIGUEUR de la lecture, parce qu'une sync qui « réussit »
// en ayant mal lu une ligne est pire que pas de sync du tout :
//   - chaque ligne est recoupée avec la colonne « Solde disponible » du fichier
//     lui-même (chaîne de vérification), et le compte est affiché ;
//   - toute ligne illisible produit une anomalie visible à l'écran, jamais un
//     silence, avec le montant qui n'entre pas dans la projection ;
//   - les rentrées d'argent comptées dans la projection sont toutes justifiées
//     (payout Stripe déjà en route / versé), les autres écartées et expliquées.
//
// Lecture seule — la seule écriture est la ligne de journal de la simulation,
// exactement ce que produit le bouton « Simuler » de la page Automations.
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

  test('le bandeau de sync affiche son état et le nombre de lignes vérifiées', async () => {
    await page.goto(URL + '/comptabilite', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="treasury-section"]', { state: 'attached', timeout: 20000 })
    await openAttention()
    const bar = page.locator('[data-testid="treasury-sheet-sync"]')
    const text = await bar.textContent()
    assert.match(text, /Maintien du solde disponible BNC/)
    // Une sync a déjà tourné (elle est horaire) : l'état affiché est soit la
    // date de la dernière sync, soit « aucune sync encore exécutée ».
    assert.match(text, /synchronisé le|aucune sync|échec/)

    const status = (await apiFetch('/treasury/solde-sheet/status')).body
    const run = status.last_run
    if (run && run.status === 'success' && run.chain) {
      // La preuve de bonne lecture est AFFICHÉE, pas seulement calculée.
      const chainEl = page.locator('[data-testid="treasury-sheet-chain"]')
      await chainEl.waitFor({ state: 'visible', timeout: 15000 })
      assert.match(await chainEl.textContent(), new RegExp(`${run.chain.checked}\\s*ligne`))
    }

    // Le bouton de sync manuelle est présent et actif.
    const btn = page.locator('[data-testid="treasury-sheet-sync-run"]')
    await btn.waitFor({ state: 'visible', timeout: 5000 })
    assert.equal(await btn.isEnabled(), true)
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

  test('la simulation (dry-run) rend compte de la vérification, sans rien écrire', async () => {
    const before = await apiFetch('/treasury/balances')
    const r = await apiFetch('/treasury/solde-sheet/sync', {
      method: 'POST',
      body: JSON.stringify({ dry_run: true }),
    })
    assert.equal(r.status, 200)
    const body = r.body
    assert.match(body.summary, /Simulation/)
    assert.ok(Array.isArray(body.differences), 'differences doit être un tableau')
    assert.equal(body.applied, null, 'dry-run ne doit rien appliquer')

    // Rigueur : la chaîne de vérification du fichier est rapportée ligne à ligne.
    assert.ok(['ok', 'warn', 'error'].includes(body.health), `health inattendu : ${body.health}`)
    assert.ok(body.chain, 'le rapport doit contenir la vérification de chaîne')
    assert.equal(typeof body.chain.checked, 'number')
    assert.ok(Array.isArray(body.chain.breaks))
    assert.match(body.summary, /vérifiée\(s\) par la chaîne du fichier/)
    for (const b of body.chain.breaks) {
      assert.equal(typeof b.expected, 'number')
      assert.equal(typeof b.actual, 'number')
      assert.ok(b.row, 'une incohérence doit pointer la ligne du fichier')
    }
    // Une chaîne rompue ou une ligne illisible DOIT produire une anomalie :
    // c'est ce qui interdit à une lecture douteuse de passer pour un succès.
    assert.ok(Array.isArray(body.anomalies))
    if (!body.chain.ok) {
      assert.ok(body.anomalies.some(a => a.code === 'chaine_rompue' && a.severity === 'error'))
      assert.equal(body.health, 'error')
    }
    // Toute ligne illisible est signalée. Rouge si la sortie n'est nulle part
    // ailleurs dans l'ERP, ambre si une facture / récurrente la couvre déjà —
    // l'alerte reste crédible au lieu de crier au loup sur un dollar compté.
    const notCountedRows = new Set((body.not_counted?.lines || []).map(l => l.row))
    for (const u of body.unparsed || []) {
      const a = body.anomalies.find(x => x.row === u.row)
      assert.ok(a, `ligne illisible ${u.row} sans anomalie`)
      assert.equal(a.severity, notCountedRows.has(u.row) ? 'error' : 'warn')
    }
    // Le montant annoncé comme non compté est bien la somme de ses lignes.
    const sumNotCounted = (body.not_counted?.lines || [])
      .reduce((s, l) => s + Math.abs(Number(l.amount) || 0), 0)
    assert.ok(Math.abs((body.not_counted?.total || 0) - sumNotCounted) < 0.005)

    // Aucune saisie de solde créée par la simulation.
    const after = await apiFetch('/treasury/balances')
    assert.equal(after.body.length, before.body.length, 'la simulation a créé une saisie de solde')
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
