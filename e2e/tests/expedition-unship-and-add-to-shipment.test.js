// OrderDetail / Mode expédition :
//   - cliquer un article dans « Déjà expédié » ouvre une modale qui détaille
//     le retrait (envoi + remise à « À prélever »), puis applique le PATCH.
//   - sur un article « Sur la table » (Prélevé), le bouton "Ajouter à un envoi
//     existant" ouvre une modale (picker si plusieurs envois) qui rattache
//     l'article à l'envoi choisi avec statut « Dans l'envoi ».
//
// Le test prépare l'état d'une commande existante via l'API (article A
// rattaché à un shipment + statut « Dans l'envoi », article B en « Prélevé »
// sans shipment), exerce les deux flows à la souris, puis restaure les
// fulfillment_status / shipment_id d'origine.

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

async function apiFetch(page, path, init = {}) {
  return await page.evaluate(async ({ path, init }) => {
    const tok = localStorage.getItem('erp_token')
    const headers = Object.assign({}, init.headers || {}, { Authorization: `Bearer ${tok}` })
    if (init.body) headers['Content-Type'] = 'application/json'
    const r = await fetch('/erp' + path, { ...init, headers })
    const text = await r.text()
    try { return { status: r.status, body: JSON.parse(text) } } catch { return { status: r.status, body: text } }
  }, { path, init })
}

describe('ExpeditionView — décocher déjà expédié + ajouter à un envoi', () => {
  let browser, ctx, page
  let orderId, shipmentId
  let itemA, itemB // items to mutate
  const restore = []

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    // Trouve une commande avec >=2 items ET au moins 1 shipment existant.
    const found = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const list = await fetch('/erp/api/orders?limit=200', {
        headers: { Authorization: `Bearer ${tok}` },
      }).then(r => r.json())
      for (const o of (list.data || [])) {
        const detail = await fetch(`/erp/api/orders/${o.id}`, {
          headers: { Authorization: `Bearer ${tok}` },
        }).then(r => r.json())
        if ((detail.items || []).length >= 2 && (detail.shipments || []).length >= 1) {
          return {
            id: o.id,
            items: detail.items.map(i => ({ id: i.id, name: i.product_name, status: i.fulfillment_status, shipment_id: i.shipment_id, fulfilled_qty: i.fulfilled_qty })),
            shipments: detail.shipments.map(s => ({ id: s.id, status: s.status, carrier: s.carrier })),
          }
        }
      }
      return null
    })
    assert.ok(found, 'aucune commande avec ≥2 items + ≥1 shipment')
    orderId = found.id
    shipmentId = found.shipments[0].id
    itemA = found.items[0]
    itemB = found.items[1]

    // Snapshot pour restauration.
    for (const it of [itemA, itemB]) {
      restore.push({ id: it.id, fulfillment_status: it.status, shipment_id: it.shipment_id, fulfilled_qty: it.fulfilled_qty || 0 })
    }

    // Met item A en "Dans l'envoi" rattaché à shipment, item B en "Prélevé" sans shipment.
    await apiFetch(page, `/api/orders/${orderId}/items/${itemA.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ shipment_id: shipmentId, fulfillment_status: "Dans l'envoi" }),
    })
    await apiFetch(page, `/api/orders/${orderId}/items/${itemB.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ shipment_id: null, fulfillment_status: 'Prélevé', fulfilled_qty: 1 }),
    })
  })

  after(async () => {
    // Restaure l'état initial des deux items (par ordre inverse pour casser
    // toute dépendance shipment_id ↔ status éventuelle).
    for (const r of restore.reverse()) {
      try {
        await apiFetch(page, `/api/orders/${orderId}/items/${r.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            shipment_id: r.shipment_id,
            fulfillment_status: r.fulfillment_status,
            fulfilled_qty: r.fulfilled_qty,
          }),
        })
      } catch {}
    }
    await browser?.close()
  })

  test('décocher un article déjà expédié le retire de l\'envoi et le remet à « À prélever »', async () => {
    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'networkidle' })

    // Passer en mode expédition.
    await page.getByRole('button', { name: /Mode expédition/ }).click()
    // Attendre que le mode expédition soit rendu — son bouton "Vue commerciale" est unique à ce mode.
    await page.getByRole('button', { name: /Vue commerciale/ }).waitFor({ state: 'visible', timeout: 5000 })

    // Ouvrir la section « Déjà expédié » (le toggle est replié par défaut).
    const doneToggle = page.locator('button', { hasText: /Déjà expédié/ })
    await doneToggle.waitFor({ state: 'visible' })
    await doneToggle.click()

    // Localiser la ligne A par son texte exact (font-semibold leading-tight),
    // remonter jusqu'à la div cliquable parente.
    const itemNameLoc = page.locator(`.font-semibold.text-lg.leading-tight >> text="${itemA.name}"`).first()
    await itemNameLoc.waitFor({ state: 'visible', timeout: 5000 })
    await itemNameLoc.click()

    // La modale s'ouvre et indique les side effects.
    await page.locator('text=Retirer l\'article de l\'envoi').first().waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('text=« À prélever »').first().waitFor({ state: 'visible' })

    // Confirmer.
    await page.getByRole('button', { name: /^Retirer de l['']envoi$/ }).click()
    // La modale se ferme.
    await page.locator('text=Retirer l\'article de l\'envoi').first().waitFor({ state: 'hidden', timeout: 5000 })

    // Vérifier via API que item A est bien remis à "À prélever" sans shipment.
    await page.waitForTimeout(300)
    const detailAfter = await apiFetch(page, `/api/orders/${orderId}`)
    const aAfter = detailAfter.body.items.find(i => i.id === itemA.id)
    assert.equal(aAfter.shipment_id, null, 'item A devrait être détaché du shipment')
    assert.equal(aAfter.fulfillment_status, 'À prélever', 'item A devrait être à « À prélever »')
    assert.equal(aAfter.fulfilled_qty, 0, 'fulfilled_qty devrait être remis à 0')
  })

  test('le bouton « Ajouter à un envoi » sur un article Prélevé l\'ajoute à l\'envoi choisi', async () => {
    // On reste sur la page (déjà en mode expédition après le test précédent).
    // Item B est Prélevé sans shipment ; au moins 1 shipment existe.
    await page.waitForTimeout(300)

    // Le bouton "Ajouter à un envoi" (icône camion) est dans la section "Sur la table".
    // On le repère via le title accessible.
    const addBtn = page.locator('button[title="Ajouter à un envoi existant"]').first()
    await addBtn.waitFor({ state: 'visible', timeout: 5000 })
    await addBtn.click()

    // La modale s'ouvre.
    await page.locator('text=Ajouter à un envoi existant').first().waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('text=« Dans l\'envoi »').first().waitFor({ state: 'visible' })

    // Confirmer (s'il y a plusieurs shipments, le premier est pré-sélectionné si 1 seul ;
    // sinon il faut cocher un radio. On gère les deux cas.)
    const radios = page.locator('input[type="radio"][name="ship-target"]')
    const nRadios = await radios.count()
    if (nRadios > 0) await radios.first().check()
    await page.getByRole('button', { name: /^Ajouter à l['']envoi$/ }).click()
    await page.locator('text=Ajouter à un envoi existant').first().waitFor({ state: 'hidden', timeout: 5000 })

    // Vérifier via API : item B est maintenant rattaché à un shipment avec statut "Dans l'envoi".
    await page.waitForTimeout(300)
    const detailAfter = await apiFetch(page, `/api/orders/${orderId}`)
    const bAfter = detailAfter.body.items.find(i => i.id === itemB.id)
    assert.ok(bAfter.shipment_id, 'item B devrait être rattaché à un shipment')
    assert.equal(bAfter.fulfillment_status, "Dans l'envoi", 'item B devrait être « Dans l\'envoi »')
  })
})
