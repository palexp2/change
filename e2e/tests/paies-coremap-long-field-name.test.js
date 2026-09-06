const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Un nom de champ Airtable très long ne doit pas briser la mise en page du
// mapping des champs « cœur » (CoreMapPane, onglet de /champs/paies) : le nom est tronqué
// (ellipsis) et le nom complet est disponible en tooltip (attribut title).
//
// Le nom long est injecté en interceptant la réponse GET .../core-map côté
// navigateur (page.route) — aucune configuration serveur n'est modifiée,
// test 100 % lecture seule.
const LONG_NAME = 'Nom_de_champ_Airtable_extrêmement_long_sans_espaces_qui_brisait_la_mise_en_page_de_la_modale_avant_le_correctif_' + 'x'.repeat(80)

// Ouvre la modale « Configuration des champs » (bouton de la barre d'outils de
// la DataTable, présent sur toutes les pages) puis l'onglet Airtable demandé.
async function openFieldConfig(page, moduleKey) {
  await page.click('button:has-text("Configurer les champs")')
  await page.waitForSelector(`[data-testid="fieldcfg-tab-${moduleKey}"]`, { timeout: 15000 })
  await page.click(`[data-testid="fieldcfg-tab-${moduleKey}"]`)
}

describe('Paies — nom de champ Airtable long dans la modale de mapping', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Injecte un champ Airtable au nom démesuré : ajouté aux métadonnées,
    // mappé sur le premier champ ERP, et suggéré sur le premier champ non mappé.
    await page.route('**/connectors/airtable/module-fields/paies/core-map', async route => {
      const res = await route.fetch()
      const data = await res.json()
      data.airtable_fields = [...(data.airtable_fields || []), { name: LONG_NAME, type: 'singleLineText' }]
      const fields = data.fields || []
      if (fields[0]) data.field_map = { ...data.field_map, [fields[0].key]: LONG_NAME }
      const unmapped = fields.find(f => f.key !== fields[0]?.key)
      if (unmapped) {
        data.field_map = { ...data.field_map, [unmapped.key]: '' }
        data.suggested = { ...data.suggested, [unmapped.key]: LONG_NAME }
      }
      await route.fulfill({ response: res, json: data })
    })
  })

  after(async () => {
    await browser?.close()
  })

  test('le nom long est tronqué + tooltip, le panneau ne déborde pas', async () => {
    await page.goto(URL + '/paies', { waitUntil: 'domcontentloaded' })
    // Bouton « Configurer les champs » → onglet « Airtable · Paies »
    await openFieldConfig(page, 'paies')
    await page.waitForSelector('[data-testid="coremap-paies-headers"]', { timeout: 15000 })
    // Panneau du mapping cœur (ex-corps de la modale) : conteneur du tableau.
    const dialog = page.locator('[data-testid="coremap-paies-headers"]').locator('xpath=ancestor::div[contains(@class,"space-y-4")][1]')

    // 1. Le picker mappé sur le nom long l'affiche… tronqué, avec le nom
    //    complet en tooltip (title) sur le bouton déclencheur.
    const trigger = dialog.locator(`button[title="${LONG_NAME}"]`).first()
    await trigger.waitFor({ state: 'visible', timeout: 10000 })
    const span = trigger.locator('span').first()
    assert.match(await span.getAttribute('class'), /truncate/, 'le libellé sélectionné doit porter la classe truncate')
    const truncated = await span.evaluate(el => el.scrollWidth > el.clientWidth)
    assert.ok(truncated, 'le nom long doit être visuellement tronqué (scrollWidth > clientWidth)')

    // 2. Le bouton « Suggestion » (nom long suggéré) est tronqué + tooltip.
    const sugg = dialog.locator('button:has-text("Suggestion :")').first()
    if (await sugg.count()) {
      const title = await sugg.getAttribute('title')
      assert.ok(title && title.includes(LONG_NAME), 'le tooltip de la suggestion doit contenir le nom complet')
      const suggSpan = sugg.locator('span.truncate').first()
      assert.ok(await suggSpan.count(), 'le libellé de la suggestion doit être tronqué')
    }

    // 3. La mise en page tient : aucun débordement horizontal du panneau,
    //    et chaque rangée reste dans sa largeur.
    const overflow = await dialog.evaluate(el => el.scrollWidth - el.clientWidth)
    assert.ok(overflow <= 1, `le panneau ne doit pas défiler horizontalement (débordement: ${overflow}px)`)
    const dialogBox = await dialog.boundingBox()
    const triggerBox = await trigger.boundingBox()
    assert.ok(
      triggerBox.x + triggerBox.width <= dialogBox.x + dialogBox.width + 1,
      'le picker au nom long doit rester dans la largeur du panneau'
    )

    // 4. Sanity : les deux colonnes d'en-tête sont toujours visibles côte à côte.
    const headers = page.locator('[data-testid="coremap-paies-headers"]')
    assert.match(await headers.innerText(), /Champ ERP/i)
    assert.match(await headers.innerText(), /Champ Airtable/i)
  })
})
