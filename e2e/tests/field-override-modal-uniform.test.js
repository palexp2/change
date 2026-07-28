// La modale « Modifier le champ » d'un champ NATIF (signalement utilisateur :
// « Avant taxes (CAD) » sur /factures) doit avoir la même présentation et le
// même comportement que celle des champs custom (CustomFieldModal) : labels
// uppercase, cartes de type (pas de <select>), autosave sans bouton
// « Enregistrer », footer « Fermer ».
//
// NB : la vue globale de /factures peut masquer « Avant taxes (CAD) » (pill
// partagée — on ne la mute pas depuis un test, voir CLAUDE.md/mémoire). La
// modale étant le même composant pour toutes les colonnes natives, le test
// s'exécute sur la première colonne native VISIBLE parmi des candidates.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const TABLE = 'factures'
// Colonnes natives candidates (tableDefs.factures), essayées dans l'ordre.
const CANDIDATES = [
  { id: 'amount_before_tax_cad', label: 'Avant taxes (CAD)' },
  { id: 'document_number',       label: 'N° document' },
  { id: 'document_date',         label: 'Date document' },
  { id: 'status',                label: 'Statut' },
]

describe('FieldOverrideModal — même modale d\'édition que les champs custom', () => {
  let browser, ctx, page
  let originalOverrides = [] // overrides préexistants de la table (pour restauration)
  let usedFieldId = null     // colonne effectivement utilisée par le test

  async function apiListOverrides() {
    return page.evaluate(async (table) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/field-overrides/${table}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await r.json()
      return body.data || []
    }, TABLE)
  }

  async function apiGetOverride(fieldId) {
    const list = await apiListOverrides()
    return list.find(o => o.field_id === fieldId) || null
  }

  async function apiRestoreOverride(fieldId, ov) {
    return page.evaluate(async ({ table, fieldId, ov }) => {
      const token = localStorage.getItem('erp_token')
      if (ov && (ov.label != null || ov.type != null)) {
        await fetch(`/erp/api/field-overrides/${table}/${fieldId}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: ov.label, type: ov.type, decimals: ov.decimals }),
        })
      } else {
        await fetch(`/erp/api/field-overrides/${table}/${fieldId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        })
      }
    }, { table: TABLE, fieldId, ov })
  }

  async function pollOverride(fieldId, predicate, timeoutMs = 8000) {
    const start = Date.now()
    let last = null
    while (Date.now() - start < timeoutMs) {
      last = await apiGetOverride(fieldId)
      if (predicate(last)) return last
      await page.waitForTimeout(300)
    }
    throw new assert.AssertionError({ message: `Override attendu non observé après ${timeoutMs}ms — dernier état : ${JSON.stringify(last)}` })
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    originalOverrides = await apiListOverrides()
  })

  after(async () => {
    // Restaure l'état d'origine de l'override de la colonne utilisée, quoi qu'il arrive.
    try {
      if (usedFieldId) {
        const original = originalOverrides.find(o => o.field_id === usedFieldId) || null
        await apiRestoreOverride(usedFieldId, original)
      }
    } catch {}
    await browser?.close()
  })

  test('la modale du champ natif a la même structure que CustomFieldModal et autosave', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    await page.locator('div[draggable="true"]').first().waitFor({ timeout: 20000 })

    // Trouve une colonne native visible dont le clic droit expose l'entrée
    // « Modifier le champ » champ natif (colmenu-edit-native-field).
    const editEntry = page.locator('[data-testid="colmenu-edit-native-field"]')
    for (const cand of CANDIDATES) {
      const expectedLabel = originalOverrides.find(o => o.field_id === cand.id)?.label || cand.label
      const header = page.locator('div[draggable="true"]', { hasText: expectedLabel }).first()
      if (await header.count() === 0 || !(await header.isVisible().catch(() => false))) continue
      await header.click({ button: 'right' })
      try {
        await editEntry.waitFor({ timeout: 2000 })
        usedFieldId = cand.id
        break
      } catch {
        // Menu sans entrée champ natif (colonne adoptée en champ custom) → fermer et suivant.
        await page.keyboard.press('Escape')
        await page.mouse.click(5, 5)
      }
    }
    assert.ok(usedFieldId, 'Aucune colonne native visible avec l\'entrée « Modifier le champ » sur /factures')
    const originalOverride = originalOverrides.find(o => o.field_id === usedFieldId) || null
    await editEntry.click()

    // La modale s'ouvre avec le même titre que celle des champs custom.
    await page.locator('text=Modifier le champ').first().waitFor({ timeout: 5000 })

    // 1. Champ « Nom » avec le même style de label que CustomFieldModal
    //    (uppercase tracking-wide, pas le gros label "Nom du champ" d'avant).
    const nameInput = page.locator('[data-testid="field-override-name"]')
    await nameInput.waitFor({ timeout: 5000 })
    const nameLabelClass = await page.evaluate(() => {
      const input = document.querySelector('[data-testid="field-override-name"]')
      const label = input?.closest('div')?.querySelector('label')
      return label?.className || ''
    })
    assert.ok(nameLabelClass.includes('uppercase'), `Label « Nom » doit être uppercase comme CustomFieldModal (classe: ${nameLabelClass})`)

    // 2. Le type est un groupe de cartes radio (comme CustomFieldModal), pas un <select>.
    const typeTag = await page.evaluate(() =>
      document.querySelector('[data-testid="field-override-type"]')?.tagName || null
    )
    assert.notStrictEqual(typeTag, 'SELECT', 'Le sélecteur de type ne doit plus être un <select>')
    assert.strictEqual(typeTag, 'DIV', 'Le type doit être un groupe de cartes (div)')
    const currencyCard = page.locator('[data-testid="field-override-type-currency"]')
    assert.ok(await currencyCard.count() > 0, 'Carte de type « Devise » attendue')

    // 3. Footer identique à CustomFieldModal en édition : « Fermer », pas de
    //    bouton « Enregistrer » / « Annuler » (autosave partout).
    const dialogButtons = await page.evaluate(() => {
      const input = document.querySelector('[data-testid="field-override-name"]')
      const form = input?.closest('form')
      return Array.from(form?.querySelectorAll('button') || []).map(b => b.textContent.trim())
    })
    assert.ok(dialogButtons.includes('Fermer'), `Bouton « Fermer » attendu (boutons: ${dialogButtons.join(', ')})`)
    assert.ok(!dialogButtons.some(t => t === 'Enregistrer' || t === 'Annuler'),
      `Pas de bouton « Enregistrer »/« Annuler » — autosave (boutons: ${dialogButtons.join(', ')})`)

    // 4. Autosave du nom au blur (pas de bouton à cliquer).
    const testLabel = `Champ natif E2E ${Date.now()}`
    await nameInput.fill(testLabel)
    await nameInput.press('Tab')
    await pollOverride(usedFieldId, o => o && o.label === testLabel)

    // 5. Autosave du type au clic sur une carte + avertissement sync visible
    //    (factures est alimentée par des syncs).
    await currencyCard.click()
    await pollOverride(usedFieldId, o => o && o.type === 'currency')
    await page.locator('[data-testid="field-override-sync-warning"]').waitFor({ timeout: 5000 })

    // 6. « Réinitialiser le champ » retire l'override.
    await page.locator('[data-testid="field-override-reset"]').click()
    await pollOverride(usedFieldId, o => o === null)

    // 7. Fermeture via « Fermer » puis restauration de l'override d'origine (after).
    await page.locator('form button:has-text("Fermer")').click()
    await page.locator('[data-testid="field-override-name"]').waitFor({ state: 'detached', timeout: 5000 })
    // Si un override existait avant le test, le remettre tout de suite (l'after le refait par sécurité).
    if (originalOverride) await apiRestoreOverride(usedFieldId, originalOverride)
  })
})
