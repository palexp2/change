// OrderDetail — le champ Notes est un textarea autosauvegardé (debounce ~500ms).
// On vérifie : (1) le textarea est rendu, (2) saisir met à jour la valeur sur
// le serveur sans cliquer de bouton, (3) la valeur persiste après reload.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('OrderDetail — Notes autosave', () => {
  let browser, ctx, page, orderId, original

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
    // Prend n'importe quelle commande récente — on remettra la valeur d'origine après.
    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const list = await fetch('/erp/api/orders?limit=1', {
        headers: { Authorization: `Bearer ${tok}` },
      }).then(r => r.json())
      const o = (list.data || [])[0]
      if (!o) return null
      const detail = await fetch(`/erp/api/orders/${o.id}`, {
        headers: { Authorization: `Bearer ${tok}` },
      }).then(r => r.json())
      return { id: o.id, notes: detail.notes || '' }
    })
    assert.ok(data, 'aucune commande disponible pour le test')
    orderId = data.id
    original = data.notes
  })

  after(async () => {
    // Restaure la valeur d'origine pour éviter de polluer la fixture.
    if (orderId !== undefined) {
      try {
        await page.evaluate(async ({ id, notes }) => {
          const tok = localStorage.getItem('erp_token')
          await fetch(`/erp/api/orders/${id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes }),
          })
        }, { id: orderId, notes: original })
      } catch {}
    }
    await browser?.close()
  })

  test('le textarea Notes est rendu, autosauvegarde la frappe, et persiste après reload', async () => {
    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'networkidle' })

    const textarea = page.locator('textarea[placeholder="Ajouter des notes…"]')
    await textarea.waitFor({ state: 'visible', timeout: 5000 })

    // Pas de bouton "Enregistrer" pour le champ notes.
    const saveBtn = await page.getByRole('button', { name: /^(Enregistrer|Sauvegarder|Save)$/i }).count()
    assert.equal(saveBtn, 0, `aucun bouton "Enregistrer" attendu, trouvé ${saveBtn}`)

    const probe = `autosave-${Date.now()}\nligne 2`
    await textarea.fill(probe)

    // Attente debounce + round-trip serveur.
    await page.waitForTimeout(900)

    // Vérification côté serveur via l'API.
    const persisted = await page.evaluate(async (id) => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/orders/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
      const d = await r.json()
      return d.notes || ''
    }, orderId)
    assert.equal(persisted, probe, 'la valeur autosauvegardée ne correspond pas à la saisie')

    // Reload et vérification que la valeur est bien rechargée dans le textarea.
    await page.reload({ waitUntil: 'networkidle' })
    await textarea.waitFor({ state: 'visible', timeout: 5000 })
    const reloaded = await textarea.inputValue()
    assert.equal(reloaded, probe, 'la valeur n\'est pas rechargée correctement dans le textarea')
  })
})
