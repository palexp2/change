const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
}

async function apiFetch(page, method, path, body) {
  return await page.evaluate(async ({ method, path, body }) => {
    const token = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api' + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const j = await r.json().catch(() => null)
    return { status: r.status, body: j }
  }, { method, path, body })
}

describe('FactureDetail — champ Notes éditable avec autosave + visibilité dans la liste', () => {
  let browser, ctx, page
  let factureId, originalNotes

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    // Récupère une facture existante (pas une pending). On veut un record
    // factures réel pour pouvoir PATCH notes dessus.
    const list = await apiFetch(page, 'GET', '/projets/factures?limit=all')
    assert.equal(list.status, 200, 'list factures OK')
    const real = (list.body.data || []).find(f => f.source !== 'pending')
    assert.ok(real, 'au moins une facture (non-pending) requise')
    factureId = String(real.id)

    // Capture la valeur originale pour restauration dans after().
    const detail = await apiFetch(page, 'GET', `/projets/factures/${factureId}`)
    assert.equal(detail.status, 200)
    originalNotes = detail.body.notes ?? null
  })

  after(async () => {
    // Restaure toujours la valeur originale — règle CLAUDE.md
    // « sauvegarder/restaurer les configurations utilisateur écrasées ».
    if (factureId) {
      await apiFetch(page, 'PATCH', `/projets/factures/${factureId}`, {
        notes: originalNotes,
      }).catch(() => {})
    }
    await browser?.close()
  })

  test('Saisir + blur sauvegarde les notes (autosave), reload conserve la valeur', async () => {
    await page.goto(URL + '/factures/' + factureId, { waitUntil: 'domcontentloaded' })
    const ta = page.locator('[data-testid="facture-notes-input"]')
    await ta.waitFor({ state: 'visible', timeout: 10000 })

    const newNotes = `E2E notes ${Date.now()}\nLigne 2`
    await ta.fill(newNotes)
    // Blur pour déclencher l'autosave
    await page.locator('h1').click()

    // Attend la fin du save (spinner disparaît) + persistance API
    await page.waitForFunction(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures/' + id, {
        headers: { Authorization: 'Bearer ' + token },
      })
      const j = await r.json()
      return j.notes && j.notes.startsWith('E2E notes ')
    }, factureId, { timeout: 10000 })

    // Reload — la valeur doit être là
    await page.reload({ waitUntil: 'domcontentloaded' })
    const ta2 = page.locator('[data-testid="facture-notes-input"]')
    await ta2.waitFor({ state: 'visible', timeout: 10000 })
    const persisted = await ta2.inputValue()
    assert.equal(persisted, newNotes, 'la note persiste après reload')
  })

  test('Le champ notes est exposé dans la route list factures (DataTable peut donc l\'afficher)', async () => {
    // Récupère via API la liste — la valeur posée au test précédent doit y
    // figurer. C'est le contrat qui permet à la colonne Notes (déclarée dans
    // TABLE_COLUMN_META.factures) de rendre la donnée pour les users qui
    // l'activent dans leur vue.
    const list = await apiFetch(page, 'GET', '/projets/factures?limit=all')
    const row = (list.body.data || []).find(f => String(f.id) === factureId)
    assert.ok(row, 'facture trouvée dans la liste')
    assert.ok(row.notes && row.notes.startsWith('E2E notes '),
      'la liste expose bien le champ notes avec la valeur attendue')
  })
})
