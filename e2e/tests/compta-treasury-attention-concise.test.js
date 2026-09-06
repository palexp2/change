// Trésorerie — panneau « points à vérifier » condensé (22 août 2026).
//
// Demande utilisateur : « je veux que cette section soit beaucoup plus concise
// […] très rapide à lire, efficace, sans perdre d'informations essentielles ».
// Le panneau est passé de phrases complètes à une grille étiquette / valeur.
// Ce test verrouille les deux moitiés de la promesse :
//   1. plus de prose — les anciennes phrases bavardes ont disparu, chaque bloc
//      est introduit par une étiquette courte ;
//   2. rien n'a été perdu — chaque élément renvoyé par l'API est toujours à
//      l'écran (montants appris, rentrées, sorties confirmées, propositions).
//
// Lecture seule : aucun record créé ni modifié.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Comptabilité — panneau d\'attention trésorerie concis', () => {
  let browser, ctx, page, panelText, proj, learning

  const apiFetch = path => page.evaluate(async p => {
    const tok = localStorage.getItem('erp_token')
    const res = await fetch(`/erp/api${p}`, { headers: { Authorization: `Bearer ${tok}` } })
    return res.json().catch(() => null)
  }, path)

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
    await page.goto(URL + '/comptabilite', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="treasury-attention-toggle"]', { timeout: 30000 })
    // Le panneau peut déjà être ouvert d'office (anomalie dure) — ne pas le refermer.
    if (await page.locator('[data-testid="treasury-sheet-sync"]').count() === 0) {
      await page.click('[data-testid="treasury-attention-toggle"]')
    }
    await page.waitForSelector('[data-testid="treasury-sheet-sync"]', { state: 'visible', timeout: 15000 })
    panelText = (await page.locator('[data-testid="treasury-attention"]').innerText()).replace(/\s+/g, ' ')
    proj = await apiFetch('/treasury/projection')
    learning = await apiFetch('/treasury/learning')
  })

  after(async () => { await browser?.close() })

  test('les phrases bavardes ont disparu', async () => {
    const banned = [
      /Montants pris sur le relevé/i,
      /Détecté au relevé, absent de la projection/i,
      /Jamais retrouvé au relevé/i,
      /Confirmés? passés? au compte/i,
      /Montant à saisir/i,
      /exclu\(s\) de la projection/i,
      /du fichier ne sont pas comptés/i,
      /sorties? encore dues? depuis le solde/i,
    ]
    for (const re of banned) {
      assert.doesNotMatch(panelText, re, `phrase bavarde encore affichée : ${re}`)
    }
    // Un pluriel faux ralentit la lecture autant qu'une phrase de trop.
    assert.doesNotMatch(panelText, /\b1 rentrées\b/)
  })

  test('chaque bloc porte une étiquette courte', async () => {
    const labels = await page.locator('[data-testid="treasury-attention"] .uppercase').allInnerTexts()
    assert.ok(labels.length > 0, 'aucune étiquette de rubrique dans le panneau')
    const known = ['LECTURE', 'ENCORE DÛ', 'RENTRÉES', 'À SAISIR', 'RELEVÉ', 'PASSÉS',
      'JAMAIS VU', 'PROPOSÉ', 'AJUSTÉ', 'FICHIER']
    for (const l of labels) {
      const up = l.trim().toUpperCase()
      assert.ok(known.includes(up), `étiquette inattendue : « ${l} »`)
      assert.ok(up.length <= 12, `étiquette trop longue : « ${l} »`)
    }
    // Le fichier est toujours en bas du panneau : la rubrique existe donc.
    assert.ok(labels.some(l => l.trim().toUpperCase() === 'FICHIER'))
  })

  test('aucune information essentielle perdue', async () => {
    // Montants appris au relevé.
    for (const l of proj.learned || []) {
      assert.ok(panelText.includes(l.label), `montant appris disparu : ${l.label}`)
    }
    // Sorties que la banque a confirmées d'elle-même.
    for (const e of proj.auto_cleared || []) {
      assert.ok(panelText.includes(e.label), `sortie confirmée disparue : ${e.label}`)
    }
    // Rentrées comptées / écartées, avec leur motif.
    const inflows = proj.inflows || {}
    if ((inflows.counted || []).length) {
      assert.match(panelText, new RegExp(`Rentrées\\s+${inflows.counted.length} comptée`, 'i'))
    }
    for (const p of inflows.excluded || []) {
      assert.ok(panelText.includes(p.reason.slice(0, 30)), `motif d'exclusion disparu : ${p.reason}`)
    }
    // Propositions issues du relevé, avec leur bouton d'adoption.
    const ignored = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('treasury_ignored_suggestions') || '[]') } catch { return [] }
    })
    const shown = (learning?.suggestions || []).filter(s => !ignored.includes(s.key))
    for (const s of shown) {
      assert.ok(panelText.includes(s.label), `proposition disparue : ${s.label}`)
    }
    if (shown.length) {
      assert.ok(await page.locator('[data-testid="treasury-suggestions"] button:has-text("ajouter")').count() > 0)
    }
    // Sorties encore dues : la date du solde reste lisible quelque part.
    if ((proj.late_events || []).length) {
      assert.match(panelText, /depuis le solde du/)
    }
  })
})
