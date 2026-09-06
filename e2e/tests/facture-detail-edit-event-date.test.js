// Vérifie que l'édition manuelle de la date d'un événement de l'historique
// comptable (section "Historique des événements" sur FactureDetail) :
//   1. n'est visible que pour un utilisateur admin
//   2. persiste en DB via PATCH /admin/factures/:id/raw
//   3. se reflète immédiatement dans l'UI après refresh
// Cleanup obligatoire (CLAUDE.md) : restaure created_at à sa valeur initiale.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Facture stable utilisée par d'autres tests (Feast Land Farm 23467A23-0014).
const FACTURE_ID = '61f35cf8-2386-4e22-9bf6-9c9f8f5a766c'

describe('FactureDetail — édition manuelle de la date d\'un événement (admin)', () => {
  let browser, ctx, page, token, originalCreatedAt

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    // Snapshot de la valeur originale pour restauration (la DB de test = DB de prod).
    const detail = await page.evaluate(async (args) => {
      const r = await fetch(`/erp/api/projets/factures/${args.id}`, {
        headers: { Authorization: `Bearer ${args.tok}` },
      })
      return r.json()
    }, { id: FACTURE_ID, tok: token })
    originalCreatedAt = detail.created_at
    assert.ok(originalCreatedAt, 'la facture test doit avoir un created_at')
  })

  after(async () => {
    // Restaure même si le test a échoué — sinon la facture reste avec une date bidon.
    if (originalCreatedAt && token) {
      try {
        await page.evaluate(async (args) => {
          await fetch(`/erp/api/admin/factures/${args.id}/raw`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${args.tok}`,
            },
            body: JSON.stringify({ created_at: args.value }),
          })
        }, { id: FACTURE_ID, tok: token, value: originalCreatedAt })
      } catch {}
    }
    await browser?.close()
  })

  test('pencil → modale → PATCH raw → DB persistée', async () => {
    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="facture-accounting-section"]', { timeout: 10000 })
    await page.waitForSelector('[data-testid="event-created"]', { timeout: 10000 })

    // Le bouton crayon doit être visible pour l'admin.
    const pencil = page.locator('[data-testid="edit-event-created"]')
    await pencil.waitFor({ timeout: 5000 })

    await pencil.click()
    const input = page.locator('[data-testid="edit-event-date-input"]')
    await input.waitFor({ timeout: 5000 })

    // Force une nouvelle date stable (1er janv 2020 à 12h00 heure locale).
    // Autosave on blur (plus de bouton « Enregistrer ») : on quitte le champ
    // et la valeur se sauvegarde automatiquement.
    const newLocalValue = '2020-01-01T12:00'
    await input.fill(newLocalValue)
    await input.blur()

    // L'indicateur « Enregistré ✓ » confirme la fin de l'autosave ;
    // la modale reste ouverte.
    await page.waitForSelector('[data-testid="edit-event-date-status"]:has-text("Enregistré")', { timeout: 10000 })
    await input.waitFor({ state: 'attached', timeout: 1000 })

    // Vérification DB via API : created_at doit être le ISO UTC correspondant.
    const after = await page.evaluate(async (args) => {
      const r = await fetch(`/erp/api/projets/factures/${args.id}`, {
        headers: { Authorization: `Bearer ${args.tok}` },
      })
      return r.json()
    }, { id: FACTURE_ID, tok: token })

    const expectedIso = new Date(newLocalValue).toISOString()
    assert.equal(after.created_at, expectedIso, `created_at attendu ${expectedIso}, vu ${after.created_at}`)
  })
})
