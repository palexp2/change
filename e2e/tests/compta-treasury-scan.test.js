// Trésorerie — carte « scannable » et projection apprise du relevé (18 août 2026).
//
// Demande utilisateur : « je veux que ce soit très simple à scanner », « pas de
// texte partout », et une sync du fichier qui se fait toute seule. Ce test
// verrouille les trois promesses :
//   1. trois chiffres en haut, et rien d'autre au premier regard (le détail est
//      derrière le panneau d'attention, replié) ;
//   2. la projection utilise les montants VUS AU COMPTE, pas les arrondis saisis ;
//   3. la sync du Google Sheet n'exige aucun clic (endpoint idempotent appelé à
//      l'ouverture, et automation horaire active).
//
// Lecture seule : aucun record créé ni modifié (la sync est appelée avec une
// fenêtre de fraîcheur de 24 h, donc elle ne fait rien).
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Comptabilité — trésorerie scannable et apprise du relevé', () => {
  let browser, ctx, page

  const apiFetch = (path, opts = {}) => page.evaluate(async ([p, o]) => {
    const tok = localStorage.getItem('erp_token')
    const res = await fetch(`/erp/api${p}`, {
      ...o,
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }, [path, opts])

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    await page.goto(URL + '/comptabilite', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="treasury-min-balance"]', { timeout: 30000 })
  })

  after(async () => { await browser?.close() })

  test('trois chiffres, et le détail replié', async () => {
    // Les trois décisions : combien j'ai, quand ça devient serré, combien virer.
    for (const id of ['treasury-min-balance', 'treasury-transfer-suggestion']) {
      await page.waitForSelector(`[data-testid="${id}"]`, { state: 'visible', timeout: 15000 })
    }
    const section = page.locator('[data-testid="treasury-section"]')
    const txt = (await section.innerText()).replace(/\s+/g, ' ')
    assert.match(txt, /Solde BNC noté/i)

    // Replié par défaut : le détail (état du fichier, anomalies, propositions)
    // ne s'affiche pas tant qu'on ne le demande pas.
    await page.waitForSelector('[data-testid="treasury-attention-toggle"]', { timeout: 10000 })
    assert.equal(await page.locator('[data-testid="treasury-sheet-sync"]').count(), 0,
      'le détail du fichier ne doit pas être visible carte fermée')

    // La description bavarde de la carte a disparu.
    assert.doesNotMatch(txt, /Rentrées certaines uniquement/i)

    await page.click('[data-testid="treasury-attention-toggle"]')
    await page.waitForSelector('[data-testid="treasury-sheet-sync"]', { state: 'visible', timeout: 10000 })
  })

  test('la projection prend les montants vus au compte', async () => {
    const proj = (await apiFetch('/treasury/projection')).body
    assert.ok(Array.isArray(proj.learned), 'projection.learned manquant')
    for (const l of proj.learned) {
      assert.ok(l.to > 0, `montant appris invalide pour ${l.label}`)
      // Un montant appris n'existe que s'il diffère de la saisie (sinon c'est du bruit).
      if (l.from) assert.ok(Math.abs(l.to - l.from) > Math.max(1, l.from * 0.01))
    }
    // Une sortie retirée de la projection parce que la banque la montre passée
    // reste tracée : rien ne disparaît en silence.
    assert.ok(Array.isArray(proj.auto_cleared))
    for (const e of proj.auto_cleared) {
      assert.ok(e.bank_date && e.bank_amount < 0, 'confirmation bancaire incomplète')
    }

    const learning = (await apiFetch('/treasury/learning')).body
    assert.ok(Array.isArray(learning.learned))
    // Les propositions sont des propositions : elles portent tout ce qu'il faut
    // pour créer la récurrente, et rien n'est créé sans clic.
    for (const s of learning.suggestions) {
      assert.ok(['monthly', 'biweekly'].includes(s.frequency))
      assert.ok(s.n >= 3, 'proposition sur moins de 3 occurrences')
      assert.ok(s.amount > 0 && s.monthly_cost > 0)
    }
    const ids = new Set((await apiFetch('/treasury/recurring')).body.map(r => r.id))
    for (const l of learning.learned) assert.ok(ids.has(l.id), 'apprentissage sur une récurrente inconnue')
  })

  // Désactivée le 2026-08-29 (Charles : le fichier créait des paiements en
  // double avec Pmt_Suivi/la cédule — [[reference_solde_sheet_sync]]). Le test
  // vérifie maintenant qu'elle reste bien inerte, pas qu'elle tourne.
  test('la sync du fichier reste désactivée (doublons Pmt_Suivi)', async () => {
    const status = (await apiFetch('/treasury/solde-sheet/status')).body
    assert.equal(status.active, false, 'la sync du fichier de solde doit rester désactivée')
    const r = await apiFetch('/treasury/solde-sheet/sync-if-stale', {
      method: 'POST', body: JSON.stringify({ max_age_minutes: 1440 }),
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.skipped, true, 'automation désactivée doit rester sans effet')
  })
})
