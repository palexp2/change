const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const TABLE = 'factures'
const PILL_LABEL = 'Toutes les factures'

async function readCount(page) {
  const txt = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
  return parseInt(txt.match(/(\d+)/)[1], 10)
}

async function waitForCount(page, pred, { timeout = 10000 } = {}) {
  const start = Date.now()
  let last = NaN
  while (Date.now() - start < timeout) {
    last = await readCount(page)
    if (pred(last)) return last
    await page.waitForTimeout(150)
  }
  return last
}

async function apiGet(page, token, path) {
  return page.evaluate(async ({ t, p }) => {
    const r = await fetch('/erp/api' + p, { headers: { Authorization: 'Bearer ' + t } })
    return r.json().catch(() => null)
  }, { t: token, p: path })
}
async function apiPut(page, token, path, body) {
  return page.evaluate(async ({ t, p, b }) => {
    const r = await fetch('/erp/api' + p, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { t: token, p: path, b: body })
}

// Choisit un champ dans une FilterRow donnée. `scope` = locator parent (le
// sous-groupe), `btnIndex` = index du picker de champ dans ce scope.
async function pickField(page, scope, btnIndex, label) {
  await scope.locator('button.select').nth(btnIndex).click()
  await page.waitForSelector('#field-select-portal', { timeout: 2000 })
  await page.locator('#field-select-portal button', { hasText: label }).first().click()
  await page.waitForTimeout(250)
}

// Vérifie les GROUPES DE FILTRES IMBRIQUÉS (parenthèses) du FilterPanel. On
// ajoute un SOUS-GROUPE à la vue et on teste que sa conjonction PROPRE (ET/OU)
// est évaluée indépendamment — c'est exactement la capacité « (A ET B) OU C »
// impossible avec une conjonction plate.
//
// Astuce déterministe (indépendante des filtres déjà présents sur la vue, qui
// se combinent en ET avec le groupe) : on met dans le groupe deux conditions
// complémentaires sur le même champ date :
//   sous-groupe ( Date document Est vide  ET  Date document N'est pas vide )  → ∅
//     → racine ∩ ∅ = 0 ligne
//   sous-groupe ( Date document Est vide  OU  Date document N'est pas vide )  → tout
//     → racine ∩ tout = compte de base inchangé
//
// ⚠ L'édition du panneau s'auto-sauvegarde dans la pill active. On capture ses
// filtres AVANT et on les RESTAURE dans after() — même en cas d'échec (DB de
// test = DB de prod, règle CLAUDE.md). On lit l'id réel de la vue active en
// localStorage (useTableView l'auto-sélectionne) pour cibler la bonne pill.
describe('Filtres — groupes imbriqués (parenthèses)', () => {
  let browser, ctx, page, token
  let pillId, originalFilters

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token') || localStorage.getItem('token'))

    await page.goto(URL + '/' + TABLE, { waitUntil: 'networkidle' })
    await page.waitForSelector('button:has-text("Filtrer")', { timeout: 10000 })
    await page.locator(`button:has-text("${PILL_LABEL}")`).first().click()
    await page.waitForTimeout(500)

    pillId = await page.evaluate((t) => localStorage.getItem(`erp_lastView_${t}`), TABLE)
    assert.ok(pillId && pillId !== 'null', `vue active introuvable en localStorage (reçu ${pillId})`)
    const views = await apiGet(page, token, `/views/${TABLE}`)
    const pill = (views?.pills || []).find(p => p.id === pillId)
    assert.ok(pill, `pill active ${pillId} introuvable`)
    originalFilters = pill.filters
  })

  after(async () => {
    try {
      if (token && pillId && originalFilters !== undefined) {
        // Restaure puis ferme immédiatement : aucune interaction UI après → pas
        // de write-back d'autosave qui re-cloberait la valeur restaurée.
        await apiPut(page, token, `/views/${TABLE}/pills/${pillId}`, { filters: originalFilters })
      }
    } finally {
      await browser?.close()
    }
  })

  test('la conjonction propre d\'un sous-groupe filtre la grille indépendamment', async () => {
    const baseline = await waitForCount(page, c => c > 0)
    assert.ok(baseline > 0, `pas de factures (count=${baseline})`)

    await page.click('button:has-text("Filtrer")')
    await page.waitForSelector('text=Ajouter un filtre', { timeout: 3000 })

    // Ajoute un sous-groupe (parenthèses).
    await page.waitForSelector('button:has-text("Ajouter un groupe")', { timeout: 3000 })
    await page.click('button:has-text("Ajouter un groupe")')
    const group = page.locator('[data-filter-group="1"]')
    await group.first().waitFor({ state: 'visible', timeout: 3000 })

    // Le groupe démarre avec 1 règle ; on en ajoute une 2e.
    await group.locator('button:has-text("Ajouter un filtre")').first().click()
    await page.waitForTimeout(300)

    // Règle 1 : Date document Est vide.
    await pickField(page, group, 0, 'Date document')
    await group.locator('select').nth(0).selectOption({ label: 'Est vide' })
    await page.waitForTimeout(200)
    // Règle 2 : Date document N'est pas vide.
    await pickField(page, group, 1, 'Date document')
    await group.locator('select').nth(1).selectOption({ label: "N'est pas vide" })
    await page.waitForTimeout(300)

    // Conjonction du groupe par défaut = ET → (vide ET non-vide) = ∅ → 0 ligne.
    const andCount = await waitForCount(page, c => c === 0)
    assert.equal(andCount, 0, `(vide ET non-vide) doit donner 0 ligne, reçu ${andCount}`)

    // Bascule la conjonction DU GROUPE sur OU → (vide OU non-vide) = tout →
    // racine ∩ tout = compte de base.
    await group.locator('button:has-text("OU")').first().click()
    const orCount = await waitForCount(page, c => c === baseline)
    assert.equal(orCount, baseline, `(vide OU non-vide) doit ramener le compte de base (${baseline}), reçu ${orCount}`)

    // La structure imbriquée doit être persistée côté API (autosave debounce
    // 600ms) : un enfant de la racine est un sous-groupe {conjunction, rules}.
    let f = null
    const start = Date.now()
    while (Date.now() - start < 6000) {
      const views = await apiGet(page, token, `/views/${TABLE}`)
      const pill = (views?.pills || []).find(p => p.id === pillId)
      f = pill?.filters
      const subOk = f && !Array.isArray(f) && (f.rules || []).some(r => r && r.conjunction && Array.isArray(r.rules))
      if (subOk) break
      await page.waitForTimeout(300)
    }
    assert.ok(f && !Array.isArray(f), `filtres attendus au format imbriqué, reçu ${JSON.stringify(f)}`)
    const sub = (f.rules || []).find(r => r && r.conjunction && Array.isArray(r.rules))
    assert.ok(sub, `un enfant racine doit être un sous-groupe imbriqué, reçu ${JSON.stringify(f.rules)}`)
    assert.equal(sub.conjunction, 'OR', 'le sous-groupe doit avoir conservé sa conjonction OU')
    assert.equal(sub.rules.length, 2, 'le sous-groupe doit contenir 2 règles')
  })
})
