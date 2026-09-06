// Écritures de fin de mois — deux corrections signalées par la comptable :
//
//  1. Frais payés d'avance : le fichier 26-27_FPA_Continuité impute le MÊME
//     montant chaque mois (Intact : 515,91 $, résidu en novembre), alors que
//     l'ERP proratisait sur les jours réels du mois (533,12 $ en juillet).
//     Nouvelle méthode d'amortissement « Montant mensuel fixe ».
//  2. Heures R&D : c'est l'ERP qui refait le total de chaque personne à partir
//     des lignes de feuille_de_temps_{mois}_{année}.xlsx — les formules de total
//     du fichier ne sont pas fiables (juillet 2026 : SUM qui saute le 31). Tout
//     écart entre la valeur retenue, l'addition des lignes et la ligne « total »
//     du fichier est affiché sur la carte des heures.
//
// Juillet 2026 avait été comptabilisé (JE #17828) à 20 100 $ AVANT que la
// feuille de temps soit corrigée (642,05 h → 20 500 $) ; l'écriture a depuis
// été alignée via le bouton « Corriger » (sparse update QB, même JE).
//
// Lecture seule sur les vraies données, SAUF un frais payé d'avance jetable créé
// puis supprimé dans after() pour vérifier la nouvelle méthode de bout en bout.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Espaces insécables et fines des formats fr-CA → espace normale.
const norm = s => (s || '').replace(/[   ]/g, ' ').trim()

describe('Fin de mois — FPA à montant mensuel fixe et heures du fichier', () => {
  let browser, ctx, page, throwawayId

  async function apiFetch(path, init) {
    return page.evaluate(async ({ base, path, init }) => {
      const t = localStorage.getItem('erp_token')
      const r = await fetch(base + '/api' + path, {
        ...(init || {}),
        headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      })
      return { status: r.status, body: await r.json().catch(() => null) }
    }, { base: URL, path, init })
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
  })

  after(async () => {
    // Le frais payé d'avance de test ne doit jamais rester dans la cédule.
    try { if (throwawayId) await apiFetch(`/prepaid/expenses/${throwawayId}`, { method: 'DELETE' }) } catch { /* nettoyage best-effort */ }
    await browser?.close()
  })

  test('juillet 2026 : l\'imputation Intact vaut 515,91 $, comme au fichier', async () => {
    await page.goto(URL + '/fin-de-mois', { waitUntil: 'domcontentloaded' })
    await page.locator('h2:has-text("Heures R&D du mois")').waitFor({ state: 'visible', timeout: 30000 })

    // La page s'ouvre sur le mois écoulé ; on recule jusqu'à juillet 2026.
    const label = page.locator('[data-testid="month-label"]')
    const prevBtn = label.locator('..').locator('button').first()
    for (let i = 0; i < 24 && !(await label.innerText()).includes('Juillet 2026'); i++) {
      const before = await label.innerText()
      await prevBtn.click()
      await page.waitForFunction(p => document.querySelector('[data-testid="month-label"]')?.innerText !== p, before, { timeout: 15000 })
    }
    assert.ok((await label.innerText()).includes('Juillet 2026'), 'juillet 2026 introuvable')

    const row = page.locator('tr', { has: page.locator('td', { hasText: 'Intact Assurances' }) }).first()
    await row.waitFor({ state: 'visible', timeout: 15000 })
    const amount = norm(await row.locator('td.text-right.tabular-nums').first().innerText())
    assert.ok(amount.includes('515,91'), `imputation Intact attendue à 515,91 $, lue « ${amount} »`)
  })

  test('juillet 2026 : le total est celui recalculé par l\'ERP (642,05 h)', async () => {
    const total = norm(await page.locator('tr', { has: page.locator('td', { hasText: 'Total employés (base de la provision)' }) })
      .locator('td.text-right').first().innerText())
    assert.ok(total.includes('642,05'), `total des heures attendu à 642,05 h, lu « ${total} »`)

    // La feuille de Pierre-Alexandre totalise encore 43,25 h par formule alors
    // que ses lignes font 46,25 h : c'est l'addition qui est retenue, et la
    // formule du fichier est signalée pour être corrigée à la source.
    const card = page.locator('div.rounded-xl', { has: page.locator('h2:has-text("Heures R&D du mois")') })
    const warn = norm(await card.locator('div.bg-amber-50').first().innerText())
    assert.match(warn, /Pierre-Alexandre Papillon/)
    assert.match(warn, /43,25 h/)
    assert.match(warn, /46,25 h/)
    assert.match(warn, /formule du fichier/)
  })

  test('juillet 2026 : l\'écriture déjà comptabilisée a été corrigée à 20 500 $, plus d\'écart', async () => {
    // L'écriture JE #17828 avait été publiée à 20 100 $ (631,05 h) avant que la
    // formule de Guillaume soit corrigée dans le fichier ; elle a depuis été
    // alignée sur 20 500 $ (642,05 h) via le bouton « Corriger ». Le bouton et
    // l'avertissement de dérive disparaissent une fois l'écriture alignée.
    const rd = page.locator('div.rounded-xl', { has: page.locator('h2:has-text("crédit d\'impôt R&D")') })
    const provision = norm(await rd.locator('[data-testid^="amount-"]').first().innerText())
    assert.ok(provision.includes('20 500'), `provision R&D attendue à 20 500 $ après correction, lue « ${provision} »`)

    const text = norm(await rd.innerText())
    assert.match(text, /JE #17828/)
    assert.equal(await rd.locator('[data-testid="correct-prov_rd_credit"]').count(), 0, 'le bouton de correction ne devrait plus apparaître, l\'écart étant résorbé')
  })

  test('nouvelle méthode « Montant mensuel fixe » : cédule constante puis résidu', async () => {
    const created = await apiFetch('/prepaid/expenses', {
      method: 'POST',
      body: JSON.stringify({
        label: 'ZZ Test agent — mensuel fixe',
        amount: 250, method: 'mensuel_fixe', monthly_amount: 100,
        amort_start: '2026-04-01', amort_end: '2027-03-31',
        expense_acctnum: '60000', fpa_acctnum: '13000',
      }),
    })
    assert.equal(created.status, 201, `création refusée : ${JSON.stringify(created.body)}`)
    throwawayId = created.body.id

    const view = await apiFetch('/prepaid/expenses?fy=2026')
    const item = view.body.items.find(i => i.id === throwawayId)
    assert.ok(item, 'frais de test absent de la cédule de continuité')
    assert.deepEqual(
      Object.entries(item.months).map(([m, v]) => [m, v.amount]),
      [['2026-04', 100], ['2026-05', 100], ['2026-06', 50]],
      'cédule mensuelle fixe inattendue',
    )
    assert.equal(item.closing_balance, 0, 'le solde de fermeture doit être nul')
  })

  test('la fiche d\'un frais payé d\'avance offre la méthode et son montant mensuel', async () => {
    // La cédule vit derrière l'onglet « Cédule FPA » (piloté par l'URL).
    await page.goto(URL + '/comptes-prepayes?onglet=fpa', { waitUntil: 'domcontentloaded' })
    const row = page.locator('[data-testid="fpa-continuity"] tr', { hasText: 'ZZ Test agent' }).first()
    await row.waitFor({ state: 'visible', timeout: 30000 })
    await row.click()

    const method = page.locator('[data-testid="fpa-method"]')
    await method.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await method.inputValue(), 'mensuel_fixe')
    assert.equal(await page.locator('[data-testid="fpa-monthly"]').inputValue(), '100')

    // Le champ mensuel n'a de sens que pour cette méthode : il disparaît sur les autres.
    await method.selectOption('prorata_jours')
    await page.waitForTimeout(300)
    assert.equal(await page.locator('[data-testid="fpa-monthly"]').count(), 0)
  })
})
