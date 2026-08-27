const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Une ligne d'article rattachée à un achat LIA doit porter le code LIA **suivi du nom
// de la pièce** (« LIA-1991⇥PCB Module d'activation V2 ») — pas le code seul. Le nom est
// recopié de la table Achats sur la ligne du reçu ; la fiche Achat / Airtable ne bouge pas.
//
// Deux volets :
//  1. écriture — sur un reçu JETABLE créé par le test : une ligne saisie avec le seul
//     code LIA se complète du nom de la pièce à l'enregistrement ;
//  2. affichage — sur un vrai reçu, en LECTURE SEULE (cf. CLAUDE.md : la DB de test est
//     celle de la prod) : la ligne montre bien code + nom, et la légende de la section
//     Articles annonce ce format.

// 1x1 PNG transparent : suffit à créer un reçu jetable (l'extraction IA échoue sur une
// image vide — sans importance ici, le test écrit les lignes lui-même par l'API).
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

describe('Extraction de données : ligne LIA = code + nom de la pièce', () => {
  let browser, ctx, page
  let token, createdId
  let liaCode, partName          // achat réel servant de référence (lecture seule)
  let displayReceipt, displayIndex // vrai reçu `done` avec une ligne LIA (lecture seule)

  const auth = () => ({ Authorization: 'Bearer ' + token })

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

    // Achat LIA de référence : code (purchases.at_id) + nom de la pièce liée. Le serveur
    // retient, pour un code donné, l'achat le plus récent — même règle ici.
    const purchases = (await (await page.request.get(URL + '/api/purchases?limit=all', { headers: auth() })).json()).data || []
    const withLia = purchases.filter(p => /^LIA-\d+$/i.test(String(p.at_id || '')) && (p.product_name || '').trim())
    const byCode = new Map()
    for (const p of withLia) {
      const code = String(p.at_id).toUpperCase()
      const seen = byCode.get(code)
      if (!seen || String(p.order_date || '') > String(seen.order_date || '')) byCode.set(code, p)
    }
    const ref = [...byCode.values()][0]
    assert.ok(ref, 'Préalable : au moins un achat avec un code LIA et une pièce liée')
    liaCode = String(ref.at_id).toUpperCase()
    partName = ref.product_name.trim()

    // Reçu jetable (support d'écriture).
    const upload = await page.request.post(URL + '/api/sale-receipts/upload', {
      headers: auth(),
      multipart: { file: { name: `e2e-lia-${Date.now()}.png`, mimeType: 'image/png', buffer: PNG_1x1 } },
    })
    assert.ok(upload.ok(), 'Upload du reçu jetable')
    createdId = (await upload.json()).id
    // L'extraction tourne en tâche de fond : attendre qu'elle rende la main pour qu'elle
    // n'écrase pas les lignes écrites par le test.
    for (let i = 0; i < 40; i++) {
      const r = await (await page.request.get(URL + '/api/sale-receipts/' + createdId, { headers: auth() })).json()
      if (r.status !== 'processing') break
      await page.waitForTimeout(3000)
    }

    // Vrai reçu `done` portant déjà une ligne LIA — utilisé en LECTURE SEULE. Déjà lu
    // (read_at renseigné) pour que l'ouverture de la fiche ne change rien.
    const all = (await (await page.request.get(URL + '/api/sale-receipts?limit=all', { headers: auth() })).json()).data || []
    for (const r of all) {
      if (r.status !== 'done' || !r.read_at) continue
      const idx = (r.items || []).findIndex(it => /^LIA-\d+/i.test(String(it.description || '')))
      if (idx >= 0) { displayReceipt = r; displayIndex = idx; break }
    }
  })

  after(async () => {
    // Ne supprime QUE le reçu créé par le test, par id explicite.
    if (createdId && token) {
      await page.request.delete(URL + '/api/sale-receipts/' + createdId, { headers: auth() })
    }
    await browser?.close()
  })

  test('une ligne saisie avec le seul code LIA se complète du nom de la pièce', async () => {
    const patch = await page.request.patch(URL + '/api/sale-receipts/' + createdId, {
      headers: { ...auth(), 'Content-Type': 'application/json' },
      data: { items: [{ description: liaCode, total: 12.34 }] },
    })
    assert.ok(patch.ok(), `PATCH items doit réussir (${patch.status()})`)

    const saved = (await (await page.request.get(URL + '/api/sale-receipts/' + createdId, { headers: auth() })).json()).items || []
    assert.equal(saved.length, 1)
    assert.equal(
      saved[0].description, `${liaCode}\t${partName}`,
      `La ligne doit porter « ${liaCode} + nom de la pièce », vu : ${JSON.stringify(saved[0].description)}`,
    )
  })

  test('un libellé LIA déjà complet n\'est pas altéré, une ligne sans code non plus', async () => {
    const complet = `${liaCode}\t${partName}`
    const patch = await page.request.patch(URL + '/api/sale-receipts/' + createdId, {
      headers: { ...auth(), 'Content-Type': 'application/json' },
      data: { items: [{ description: complet, total: 12.34 }, { description: 'Transport Purolator', total: 20 }] },
    })
    assert.ok(patch.ok(), `PATCH items doit réussir (${patch.status()})`)

    const saved = (await (await page.request.get(URL + '/api/sale-receipts/' + createdId, { headers: auth() })).json()).items || []
    assert.equal(saved[0].description, complet, 'libellé LIA complet inchangé')
    assert.equal(saved[1].description, 'Transport Purolator', 'ligne sans code LIA inchangée')
  })

  test('la fiche montre le code suivi du nom de la pièce, et l\'annonce', async () => {
    if (!displayReceipt) {
      console.log('Aucun reçu « done » avec une ligne LIA — volet affichage ignoré.')
      return
    }
    await page.goto(URL + '/sale-receipts/' + displayReceipt.id, { waitUntil: 'networkidle' })
    await page.getByTestId('receipt-item-add').waitFor({ state: 'visible', timeout: 15000 })

    const row = page.locator(`[data-testid="receipt-item-row-${displayIndex}"]`)
    await row.waitFor({ state: 'visible', timeout: 10000 })
    const value = await row.locator('input').nth(0).inputValue()
    assert.match(
      value, /^LIA-\d+\s+\S/,
      `La description affichée doit être « code + nom de la pièce », vue : ${JSON.stringify(value)}`,
    )
    assert.equal(value, displayReceipt.items[displayIndex].description, 'la fiche affiche la description enregistrée')

    // La légende de la section Articles décrit le format publié.
    const legend = page.locator('text=/rattachée à un achat LIA est publiée avec le/i').first()
    await legend.waitFor({ state: 'visible', timeout: 5000 })
    const legendText = await legend.innerText()
    assert.match(legendText, /code suivi du nom de la pièce/i, `Légende inattendue : ${legendText}`)
  })
})
