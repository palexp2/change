const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Ce test est purement en lecture : il navigue entre fiches existantes au
// clavier (j/k + ↑/↓). Aucun record créé ni configuration modifiée → pas de
// cleanup nécessaire (cf. CLAUDE.md).
describe('Navigation clavier entre enregistrements (j/k + ↑/↓)', () => {
  let browser, ctx, page

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

  after(async () => { await browser?.close() })

  test('FactureDetail — j/↓ va à la suivante, k/↑ à la précédente', async () => {
    // Cherche une facture qui a À LA FOIS un voisin précédent et suivant.
    // On s'appuie sur l'endpoint /neighbors — la même source que la fiche — pour
    // ne pas présumer que l'ordre de la liste correspond à l'ordre de nav (ce
    // qui n'est pas garanti).
    const found = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=all', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const j = await r.json()
      const ids = (j.data || []).map(f => String(f.id))
      for (const id of ids) {
        const nr = await fetch(`/erp/api/projets/factures/${id}/neighbors`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const n = await nr.json()
        if (n.prev && n.next) {
          return { startId: id, prevId: String(n.prev), nextId: String(n.next) }
        }
      }
      return null
    })
    assert.ok(found, 'une facture avec voisin précédent ET suivant est requise')
    const { startId, prevId: expectedPrevId, nextId: expectedNextId } = found

    await page.goto(URL + '/factures/' + startId, { waitUntil: 'domcontentloaded' })
    // Attendre que la liste voisine soit chargée (chevrons activés)
    await page.waitForFunction(() => {
      const p = document.querySelector('button[aria-label="Facture précédente"]')
      const n = document.querySelector('button[aria-label="Facture suivante"]')
      return p && n && !p.disabled && !n.disabled
    }, { timeout: 10000 })

    // S'assurer qu'aucun champ n'a le focus (sinon la garde ignore la frappe)
    await page.evaluate(() => document.activeElement?.blur?.())

    // « j » → facture suivante
    await page.keyboard.press('j')
    await page.waitForURL(u => u.toString().includes('/factures/' + expectedNextId), { timeout: 10000 })

    await page.waitForFunction(() => {
      const p = document.querySelector('button[aria-label="Facture précédente"]')
      return p && !p.disabled
    }, { timeout: 10000 })
    await page.evaluate(() => document.activeElement?.blur?.())

    // « ArrowUp » → précédente (retour à startId)
    await page.keyboard.press('ArrowUp')
    await page.waitForURL(u => u.toString().includes('/factures/' + startId), { timeout: 10000 })

    await page.waitForFunction(() => {
      const p = document.querySelector('button[aria-label="Facture précédente"]')
      return p && !p.disabled
    }, { timeout: 10000 })
    await page.evaluate(() => document.activeElement?.blur?.())

    // « k » → précédente (vers le voisin précédent de startId)
    await page.keyboard.press('k')
    await page.waitForURL(u => u.toString().includes('/factures/' + expectedPrevId), { timeout: 10000 })
  })

  test('La frappe est ignorée quand le focus est dans un champ', async () => {
    const ids = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=all', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const j = await r.json()
      return (j.data || []).map(f => String(f.id))
    })
    const startId = ids[1]
    await page.goto(URL + '/factures/' + startId, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => {
      const n = document.querySelector('button[aria-label="Facture suivante"]')
      return n && !n.disabled
    }, { timeout: 10000 })

    // Focus un champ texte, taper « j » : l'URL ne doit PAS changer.
    const input = page.locator('input[type="text"], textarea').first()
    await input.waitFor({ state: 'visible', timeout: 10000 })
    await input.focus()
    await page.keyboard.press('j')
    await page.waitForTimeout(400)
    assert.ok(
      page.url().includes('/factures/' + startId),
      'la frappe dans un champ ne doit pas déclencher la navigation',
    )
  })

  test('TicketDetail — j/k naviguent entre billets', async () => {
    const ids = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/tickets/ids', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const j = await r.json()
      return Array.isArray(j) ? j.map(String) : []
    })
    assert.ok(ids.length >= 3, 'au moins 3 billets requis')

    const startId = ids[1]
    const expectedNextId = ids[2]
    const expectedPrevId = ids[0]

    await page.goto(URL + '/tickets/' + startId, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => {
      const p = document.querySelector('button[title^="Billet précédent"]')
      const n = document.querySelector('button[title^="Billet suivant"]')
      return p && n && !p.disabled && !n.disabled
    }, { timeout: 10000 })
    await page.evaluate(() => document.activeElement?.blur?.())

    await page.keyboard.press('j')
    await page.waitForURL(u => u.toString().includes('/tickets/' + expectedNextId), { timeout: 10000 })

    await page.waitForFunction(() => {
      const p = document.querySelector('button[title^="Billet précédent"]')
      return p && !p.disabled
    }, { timeout: 10000 })
    await page.evaluate(() => document.activeElement?.blur?.())

    await page.keyboard.press('k')
    await page.waitForURL(u => u.toString().includes('/tickets/' + startId), { timeout: 10000 })

    await page.waitForFunction(() => {
      const p = document.querySelector('button[title^="Billet précédent"]')
      return p && !p.disabled
    }, { timeout: 10000 })
    await page.evaluate(() => document.activeElement?.blur?.())

    await page.keyboard.press('k')
    await page.waitForURL(u => u.toString().includes('/tickets/' + expectedPrevId), { timeout: 10000 })
  })
})
