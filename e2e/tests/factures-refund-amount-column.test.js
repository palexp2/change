// Vérifie l'API et la colonne "Remboursé" dans la liste des factures :
//   - le endpoint /api/projets/factures renvoie refund_amount par facture
//   - la colonne TABLE_COLUMN_META.factures.refund_amount est exposée par DataTable
//   - quand on rend la colonne visible, un montant > 0 s'affiche pour les factures
//     ayant au moins un payment direction='out' avec stripe_refund_id.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Factures — colonne Remboursé', () => {
  let browser, ctx, page
  let viewSnapshot = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Snapshot the active "factures" view to restore after the test
    viewSnapshot = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/views/factures', { headers: { Authorization: `Bearer ${tok}` } })
      const data = await r.json()
      const lastId = localStorage.getItem('erp_lastView_factures')
      const pill = (data.pills || []).find(p => String(p.id) === String(lastId)) || (data.pills || [])[0]
      if (!pill) return null
      return {
        id: pill.id,
        sort: pill.sort || [],
        filters: pill.filters || [],
        visible_columns: pill.visible_columns || [],
        group_by: pill.group_by || null,
      }
    })
  })

  after(async () => {
    if (viewSnapshot && page) {
      try {
        await page.evaluate(async (snap) => {
          const tok = localStorage.getItem('erp_token')
          await fetch(`/erp/api/views/factures/pills/${snap.id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sort: snap.sort, filters: snap.filters,
              visible_columns: snap.visible_columns, group_by: snap.group_by,
            }),
          })
        }, viewSnapshot)
      } catch {}
    }
    await browser?.close()
  })

  test('le endpoint /api/projets/factures renvoie refund_amount sur chaque ligne', async () => {
    const sample = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=all', { headers: { Authorization: `Bearer ${tok}` } })
      const j = await r.json()
      const all = j.data || []
      const withRefund = all.filter(f => Number(f.refund_amount) > 0)
      return {
        total: all.length,
        allHaveField: all.every(f => 'refund_amount' in f),
        withRefundCount: withRefund.length,
        topRefund: withRefund.sort((a, b) => Number(b.refund_amount) - Number(a.refund_amount))[0] || null,
      }
    })
    assert.ok(sample.total > 0, 'au moins une facture requise pour le test')
    assert.ok(sample.allHaveField, 'refund_amount doit être présent sur toutes les lignes')
    assert.ok(sample.withRefundCount > 0, `au moins une facture avec refund_amount > 0 attendue (post-migration), got ${sample.withRefundCount}`)
    assert.ok(sample.topRefund, 'au moins une facture avec un remboursement attendue')
    assert.ok(Number(sample.topRefund.refund_amount) > 0, `refund_amount > 0 attendu, got ${sample.topRefund.refund_amount}`)
  })

  test('rendre la colonne Remboursé visible affiche l\'entête + les anciennes factures standalone "Remboursement" ont disparu', async () => {
    assert.ok(viewSnapshot, 'snapshot de la vue requis')

    // Force la colonne refund_amount visible dans la vue active
    await page.evaluate(async (snap) => {
      const tok = localStorage.getItem('erp_token')
      const visible = Array.isArray(snap.visible_columns) ? [...snap.visible_columns] : []
      if (!visible.includes('refund_amount')) visible.push('refund_amount')
      await fetch(`/erp/api/views/factures/pills/${snap.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sort: snap.sort, filters: snap.filters,
          visible_columns: visible, group_by: snap.group_by,
        }),
      })
    }, viewSnapshot)

    await page.goto(URL + '/factures', { waitUntil: 'networkidle' })
    await page.waitForSelector('div[style*="display: grid"][style*="position: absolute"]', { timeout: 15000 })

    // L'entête "Remboursé" doit être présent
    const header = page.locator('div.cursor-grab', { hasText: /^Remboursé$/ }).first()
    await header.waitFor({ state: 'visible', timeout: 10000 })

    // Post-migration : les 20 factures standalone migrées ne doivent plus exister
    // mais leurs document_number doivent toujours apparaître (sur la facture
    // d'origine) avec un refund_amount > 0. On vérifie au moins une via API.
    const apiCheck = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=all', { headers: { Authorization: `Bearer ${tok}` } })
      const j = await r.json()
      const all = j.data || []
      const standaloneRefund = all.filter(f => f.status === 'Remboursement' && f.sync_source === 'Remboursements Stripe')
      const withRefundAmount = all.filter(f => Number(f.refund_amount) > 0)
      return {
        standaloneRefundCount: standaloneRefund.length,
        withRefundAmount: withRefundAmount.length,
      }
    })
    assert.ok(
      apiCheck.standaloneRefundCount <= 8,
      `factures standalone "Remboursement" devraient être ≤ 8 (les 5 payout-reversal + 2 zero-amount + 1 no-match), got ${apiCheck.standaloneRefundCount}`,
    )
    assert.ok(
      apiCheck.withRefundAmount >= 20,
      `≥ 20 factures avec refund_amount > 0 attendues post-migration, got ${apiCheck.withRefundAmount}`,
    )
  })
})
