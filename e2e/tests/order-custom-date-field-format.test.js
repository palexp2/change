// Format d'affichage configurable pour un champ custom de type date (ex:
// "Date du dernier envoi" sur /orders — colonne repérée par l'utilisateur).
// La config est stockée dans `options.format` du champ custom, au même titre
// que le format d'un champ duration. On bascule le champ RÉEL "Date du
// dernier envoi" (colonne Airtable adoptée en champ custom) sur le format
// "Locale — date seule" et on vérifie que le rendu change dans le tableau,
// SANS modifier la moindre donnée de commande — seule la config d'affichage
// du champ est temporairement changée, puis restaurée en DB dans after().

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

// Reproduit le format "Locale — date seule" pour une valeur date-only
// (YYYY-MM-DD ou minuit UTC encodé Airtable), sans dépendre du fuseau du
// navigateur qui exécute le test.
function expectedLocalDate(isoValue) {
  const m = isoValue.match(/^(\d{4})-(\d{2})-(\d{2})/)
  const [, y, mo, d] = m
  return `${parseInt(d, 10)} ${MONTHS_FR[parseInt(mo, 10) - 1]} ${y}`
}

describe('Orders — format d\'affichage du champ custom "Date du dernier envoi"', () => {
  let browser, ctx, page, db
  let fieldId, originalOptions
  let orderId, orderNumber, rawDate

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    const field = db.prepare(`
      SELECT id, options FROM custom_fields
      WHERE erp_table='orders' AND column_name='date_du_dernier_envoi' AND deleted_at IS NULL
    `).get()
    assert.ok(field, 'le champ custom "Date du dernier envoi" doit exister sur orders')
    fieldId = field.id
    originalOptions = field.options

    const order = db.prepare(`
      SELECT id, order_number, date_du_dernier_envoi FROM orders
      WHERE date_du_dernier_envoi IS NOT NULL AND deleted_at IS NULL
      ORDER BY order_number DESC LIMIT 1
    `).get()
    assert.ok(order, 'au moins une commande avec une date de dernier envoi doit exister')
    orderId = order.id
    orderNumber = order.order_number
    rawDate = order.date_du_dernier_envoi

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    // Restaure la config d'affichage d'origine du champ (aucune donnée de
    // commande n'a été touchée — seul `options` du champ custom est restauré).
    try {
      db.prepare('UPDATE custom_fields SET options=? WHERE id=?').run(originalOptions, fieldId)
    } catch {}
    db?.close()
    await browser?.close()
  })

  test('changer le format en "Locale — date seule" met à jour le rendu du tableau, sans toucher aux données', async () => {
    await page.goto(`${URL}/orders`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    // La vue par défaut ("À envoyer") est filtrée sur un sous-ensemble de
    // commandes actives — bascule sur "Toutes les commandes" pour retrouver
    // la commande ciblée quel que soit son statut.
    await page.getByText('Toutes les commandes', { exact: true }).click()
    await page.waitForTimeout(500)

    // Filtre sur la commande connue pour ne garder qu'une ligne à inspecter.
    await page.fill('input[placeholder="Rechercher..."]', String(orderNumber))
    const row = page.locator(`[data-row-id="${orderId}"]`)
    await row.waitFor({ state: 'visible', timeout: 8000 })

    // Avant tout changement : rendu ISO par défaut (format non configuré = 'iso_date').
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.textContent?.includes('2026'),
      `[data-row-id="${orderId}"]`,
      { timeout: 8000 },
    )

    // Ouvre la modale d'édition du champ via le menu clic-droit de l'en-tête.
    const header = page.getByText('Date du dernier envoi', { exact: true }).first()
    await header.waitFor({ state: 'visible', timeout: 8000 })
    await header.click({ button: 'right' })
    await page.getByRole('button', { name: 'Modifier le champ' }).click()
    await page.waitForSelector('text=Modifier le champ', { timeout: 5000 })

    // Le réglage par défaut (champ jamais configuré) doit être "ISO — date seule".
    const isoRadio = page.locator('[data-testid="cf-date-format-iso_date"] input')
    await assert.doesNotReject(() => isoRadio.waitFor({ state: 'attached', timeout: 5000 }))
    assert.equal(await isoRadio.isChecked(), true, 'le format par défaut doit être ISO — date seule')

    // Bascule sur "Locale — date seule" — autosave immédiat (pas de bouton Enregistrer).
    await page.locator('[data-testid="cf-date-format-local_date"]').click()
    await page.waitForSelector('text=Enregistré', { timeout: 5000 })

    // Vérifie la persistance en DB.
    await page.waitForTimeout(300)
    const savedRow = db.prepare('SELECT options FROM custom_fields WHERE id=?').get(fieldId)
    const savedOpts = JSON.parse(savedRow.options)
    assert.equal(savedOpts.format, 'local_date', 'le format doit être persisté en DB')

    await page.locator('button.btn-secondary', { hasText: 'Fermer' }).click()

    // Le tableau doit maintenant afficher la date au format local (ex: "26 août 2026")
    // au lieu du format ISO (ex: "2026-08-26") — la donnée sous-jacente n'a pas changé.
    const expected = expectedLocalDate(rawDate)
    await page.waitForFunction(
      ({ sel, text }) => document.querySelector(sel)?.textContent?.includes(text),
      { sel: `[data-row-id="${orderId}"]`, text: expected },
      { timeout: 8000 },
    )
    const rowText = await row.textContent()
    assert.ok(rowText.includes(expected), `la ligne doit afficher "${expected}" (format local), reçu: ${rowText}`)

    // La donnée brute en DB n'a pas bougé — seule sa présentation a changé.
    const untouched = db.prepare('SELECT date_du_dernier_envoi FROM orders WHERE id=?').get(orderId)
    assert.equal(untouched.date_du_dernier_envoi, rawDate, 'la donnée de la commande ne doit pas avoir été modifiée')
  })
})
