const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Couvre deux nouveautés des codes d'activité :
//   1. Un code marqué « pré-coché RSDE » (rsde_default) coche automatiquement la
//      case RSDE de l'entrée de feuille de temps qui l'utilise.
//   2. Création d'un code d'activité à la volée depuis le menu déroulant du picker
//      dans la feuille de temps (bouton « Créer le code … »).
describe('FeuilleDeTemps — code RSDE par défaut + création inline', () => {
  let browser, ctx, page
  const createdCodeIds = []   // codes à supprimer en fin de test
  let dayId = null            // journée du jour à supprimer (créée par le test)

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => {
    await page.evaluate(async ({ codes, day }) => {
      const token = localStorage.getItem('erp_token')
      if (day) {
        await fetch(`/erp/api/timesheets/day/${day}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
      }
      for (const id of codes) {
        await fetch(`/erp/api/activity-codes/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
      }
    }, { codes: createdCodeIds, day: dayId })
    await browser?.close()
  })

  test('POST/PATCH activity-codes accepte et persiste rsde_default', async () => {
    const result = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      // Crée avec rsde_default:true
      const created = await fetch('/erp/api/activity-codes', {
        method: 'POST', headers: h,
        body: JSON.stringify({ name: `E2E RSDE-default ${Date.now()}`, rsde_default: true }),
      }).then(r => r.json())
      // Toggle off via PATCH puis on
      const off = await fetch(`/erp/api/activity-codes/${created.id}`, {
        method: 'PATCH', headers: h, body: JSON.stringify({ rsde_default: false }),
      }).then(r => r.json())
      const on = await fetch(`/erp/api/activity-codes/${created.id}`, {
        method: 'PATCH', headers: h, body: JSON.stringify({ rsde_default: true }),
      }).then(r => r.json())
      return { id: created.id, createdFlag: created.rsde_default, offFlag: off.rsde_default, onFlag: on.rsde_default }
    })
    createdCodeIds.push(result.id)
    assert.equal(result.createdFlag, 1, 'POST avec rsde_default:true → 1')
    assert.equal(result.offFlag, 0, 'PATCH rsde_default:false → 0')
    assert.equal(result.onFlag, 1, 'PATCH rsde_default:true → 1')
  })

  test('sélectionner un code rsde_default coche automatiquement la case RSDE', async () => {
    // Prépare : un code rsde_default + une journée détaillée du jour avec une entrée vide.
    const setup = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const codeName = `E2E AutoRSDE ${Date.now()}`
      const code = await fetch('/erp/api/activity-codes', {
        method: 'POST', headers: h,
        body: JSON.stringify({ name: codeName, rsde_default: true }),
      }).then(r => r.json())
      const today = new Date().toISOString().slice(0, 10)
      const existing = await fetch(`/erp/api/timesheets/day?date=${today}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      if (existing?.id) {
        await fetch(`/erp/api/timesheets/day/${existing.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      }
      const day = await fetch('/erp/api/timesheets/day', {
        method: 'POST', headers: h, body: JSON.stringify({ date: today, mode: 'detailed' }),
      }).then(r => r.json())
      const withEntry = await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST', headers: h, body: JSON.stringify({ duration_minutes: 0 }),
      }).then(r => r.json())
      const entryId = withEntry.entries[withEntry.entries.length - 1].id
      return { codeId: code.id, codeName, dayId: day.id, entryId }
    })
    createdCodeIds.push(setup.codeId)
    dayId = setup.dayId

    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/Total payable du jour/', { timeout: 10000 })

    // La case RSDE de l'entrée est décochée au départ.
    const rsdeBox = page.locator(`[data-testid="entry-rsde-${setup.entryId}"]`)
    await rsdeBox.waitFor({ timeout: 5000 })
    assert.equal(await rsdeBox.isChecked(), false, 'case RSDE décochée avant sélection du code')

    // Ouvre le picker de code d'activité de la ligne, recherche et sélectionne le code.
    const codeCell = page.locator('tbody tr', { has: rsdeBox }).locator('button:has-text("Code…")')
    await codeCell.click()
    const search = page.locator('input[placeholder="Rechercher…"]')
    await search.waitFor({ timeout: 3000 })
    await search.fill(setup.codeName)
    await page.locator(`button:has-text("${setup.codeName}")`).first().click()

    // Après sélection : la case RSDE doit s'être cochée automatiquement.
    await page.waitForFunction(
      (id) => document.querySelector(`[data-testid="entry-rsde-${id}"]`)?.checked === true,
      setup.entryId,
      { timeout: 5000 },
    )
    assert.equal(await rsdeBox.isChecked(), true, 'case RSDE cochée automatiquement après sélection du code rsde_default')

    // Confirmé côté serveur.
    const persisted = await page.evaluate(async ({ dayId, entryId }) => {
      const token = localStorage.getItem('erp_token')
      const today = new Date().toISOString().slice(0, 10)
      const d = await fetch(`/erp/api/timesheets/day?date=${today}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      void dayId
      const e = (d.entries || []).find(x => x.id === entryId)
      return { rsde: e?.rsde, code: e?.activity_code_id }
    }, { dayId: setup.dayId, entryId: setup.entryId })
    assert.equal(persisted.rsde, 1, 'rsde=1 persisté en DB')
    assert.equal(persisted.code, setup.codeId, 'code d\'activité persisté en DB')
  })

  test('création d\'un code d\'activité à la volée depuis le picker', async () => {
    // S'assure d'une journée détaillée avec une entrée (réutilise / recrée au besoin).
    const setup = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const today = new Date().toISOString().slice(0, 10)
      let day = await fetch(`/erp/api/timesheets/day?date=${today}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      if (!day?.id) {
        day = await fetch('/erp/api/timesheets/day', {
          method: 'POST', headers: h, body: JSON.stringify({ date: today, mode: 'detailed' }),
        }).then(r => r.json())
      }
      const withEntry = await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST', headers: h, body: JSON.stringify({ duration_minutes: 0 }),
      }).then(r => r.json())
      const entryId = withEntry.entries[withEntry.entries.length - 1].id
      return { dayId: day.id, entryId, newName: `E2E Inline ${Date.now()}` }
    })
    dayId = setup.dayId

    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/Total payable du jour/', { timeout: 10000 })

    const rsdeBox = page.locator(`[data-testid="entry-rsde-${setup.entryId}"]`)
    await rsdeBox.waitFor({ timeout: 5000 })

    // Ouvre le picker de la nouvelle entrée et tape un nom inexistant.
    const row = page.locator('tbody tr', { has: rsdeBox })
    await row.locator('button:has-text("Code…")').click()
    const search = page.locator('input[placeholder="Rechercher…"]')
    await search.waitFor({ timeout: 3000 })
    await search.fill(setup.newName)

    // Le bouton « Créer le code … » apparaît ; on clique.
    const createBtn = page.locator('[data-testid="refpicker-create"]')
    await createBtn.waitFor({ timeout: 3000 })
    assert.match(await createBtn.textContent(), new RegExp(setup.newName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'le bouton affiche le nom saisi')
    await createBtn.click()

    // Le code créé est sélectionné dans le picker de la ligne.
    await page.waitForFunction(
      (name) => !!document.querySelector('tbody tr button')?.textContent && Array.from(document.querySelectorAll('tbody tr button')).some(b => b.textContent.includes(name)),
      setup.newName,
      { timeout: 5000 },
    )

    // Le code existe désormais côté serveur + a bien été affecté à l'entrée.
    const result = await page.evaluate(async ({ entryId, newName }) => {
      const token = localStorage.getItem('erp_token')
      const today = new Date().toISOString().slice(0, 10)
      const codes = await fetch('/erp/api/activity-codes?all=1', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      const list = codes.data || codes
      const found = list.find(c => c.name === newName)
      const d = await fetch(`/erp/api/timesheets/day?date=${today}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      const e = (d.entries || []).find(x => x.id === entryId)
      return { foundId: found?.id, foundRsdeDefault: found?.rsde_default, entryCode: e?.activity_code_id }
    }, { entryId: setup.entryId, newName: setup.newName })
    assert.ok(result.foundId, 'le code créé inline existe en DB')
    createdCodeIds.push(result.foundId)
    assert.equal(result.foundRsdeDefault, 0, 'un code créé inline n\'est pas pré-coché RSDE par défaut')
    assert.equal(result.entryCode, result.foundId, 'le code créé est affecté à l\'entrée')
  })
})
