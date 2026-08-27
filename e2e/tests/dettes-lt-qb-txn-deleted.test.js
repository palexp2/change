// Dettes à long terme — un versement dont la dépense QB a été supprimée dans
// QuickBooks ne doit plus s'afficher comme « Publié » : rien n'est comptabilisé.
//
// Vérifie :
//   • GET /lt-debts/:id/qb-check signale les versements dont la transaction QB
//     n'existe plus (contrôle de lecture, rien n'est écrit) ;
//   • le badge du versement concerné n'écrit plus « Publié » et propose « Délier » ;
//   • les versements dont la dépense existe toujours restent « Publié » ;
//   • délier refuse (409) tant que la transaction existe encore dans QB ;
//   • délier refuse (400) un versement qui n'a aucune transaction QB liée.
//
// Aucun vrai record n'est modifié : l'état « supprimé dans QB » est forcé par
// interception de la réponse qb-check, et le seul versement créé appartient à
// une dette JETABLE supprimée en fin de test.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Dettes LT — dépense QB supprimée ≠ publié', () => {
  let browser, ctx, page
  let throwawayDebtId = null
  let forcedMissing = null   // ids de versements que qb-check doit rendre « manquants »

  const api = (path, options) => page.evaluate(async ([p, o]) => {
    const res = await fetch(`/erp/api${p}`, {
      ...o,
      headers: {
        Authorization: `Bearer ${localStorage.getItem('erp_token')}`,
        'Content-Type': 'application/json',
        ...(o?.headers || {}),
      },
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }, [path, options || null])

  // Première dette qui a au moins deux versements liés à une transaction QB :
  // un servira de « supprimé dans QB », l'autre doit rester « Publié ».
  const findDebtWithPublished = async () => {
    const { body: debts } = await api('/lt-debts')
    for (const d of debts) {
      const { body } = await api(`/lt-debts/${d.id}/payments`)
      const published = (body?.payments || []).filter(p => p.qb_txn_id)
      if (published.length >= 2) return { debt: d, published }
    }
    return null
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } })
    page = await ctx.newPage()
    await page.route('**/api/lt-debts/*/qb-check', async (route) => {
      if (!forcedMissing) return route.continue()
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ missing: forcedMissing, checked_at: new Date().toISOString() }),
      })
    })
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
    await page.goto(URL + '/dettes-lt', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('button:has-text("Nouvelle dette")', { timeout: 20000 })
  })

  after(async () => {
    if (throwawayDebtId) await api(`/lt-debts/${throwawayDebtId}`, { method: 'DELETE' }).catch(() => {})
    await browser?.close()
  })

  test('qb-check signale les versements dont la transaction QB n\'existe plus', async () => {
    const { body: debts } = await api('/lt-debts')
    let checkedOne = false
    for (const d of debts) {
      const { body: detail } = await api(`/lt-debts/${d.id}/payments`)
      const published = (detail?.payments || []).filter(p => p.qb_txn_id)
      const { status, body } = await api(`/lt-debts/${d.id}/qb-check`)
      assert.equal(status, 200, `qb-check ${d.label} : ${JSON.stringify(body)}`)
      assert.ok(Array.isArray(body.missing), 'missing doit être un tableau')
      // Un « manquant » est forcément un versement publié de cette dette.
      for (const id of body.missing) {
        assert.ok(published.some(p => p.id === id), 'un id manquant doit être un versement publié de la dette')
      }
      if (published.length) checkedOne = true
      // Le contrôle est en lecture seule : les versements restent liés.
      const { body: after } = await api(`/lt-debts/${d.id}/payments`)
      assert.deepEqual(
        (after?.payments || []).filter(p => p.qb_txn_id).map(p => p.qb_txn_id).sort(),
        published.map(p => p.qb_txn_id).sort(),
        'qb-check ne doit rien écrire')
    }
    assert.ok(checkedOne, 'au moins une dette avec des versements publiés est attendue')
  })

  test('le versement dont la dépense a été supprimée n\'affiche plus « Publié »', async () => {
    const found = await findDebtWithPublished()
    assert.ok(found, 'une dette avec au moins 2 versements publiés est attendue')
    const gone = found.published[found.published.length - 1]
    const alive = found.published[0]

    forcedMissing = [gone.id]
    await page.goto(URL + '/dettes-lt', { waitUntil: 'domcontentloaded' })
    await page.click(`button:has-text("${found.debt.label}")`)
    await page.waitForSelector(`[data-testid="payment-status-${gone.id}"]`, { timeout: 20000 })
    await page.waitForFunction(
      id => !document.querySelector(`[data-testid="payment-status-${id}"]`)?.innerText.includes('Publié'),
      gone.id, { timeout: 20000 })

    const label = await page.innerText(`[data-testid="payment-status-${gone.id}"]`)
    assert.ok(!label.includes('Publié'), `le badge ne doit pas dire « Publié » : ${label}`)
    assert.ok(/supprim/i.test(label) && /QB/.test(label), `le badge doit expliquer la suppression dans QB : ${label}`)

    // Et l'utilisateur peut délier pour recomptabiliser.
    assert.equal(await page.isVisible(`[data-testid="payment-unpublish-${gone.id}"]`), true,
      'le bouton Délier doit être offert')

    // Le versement dont la dépense existe toujours reste « Publié ».
    const ok = await page.innerText(`[data-testid="payment-status-${alive.id}"]`)
    assert.ok(ok.includes('Publié'), `le versement encore publié doit rester « Publié » : ${ok}`)

    forcedMissing = null
  })

  test('délier refuse tant que la transaction existe encore dans QuickBooks', async () => {
    const found = await findDebtWithPublished()
    assert.ok(found, 'une dette avec des versements publiés est attendue')
    const { body: check } = await api(`/lt-debts/${found.debt.id}/qb-check`)
    const alive = found.published.find(p => !(check.missing || []).includes(p.id))
    assert.ok(alive, 'un versement dont la dépense QB existe encore est attendu')

    const { status, body } = await api(`/lt-debts/payments/${alive.id}/unpublish`, { method: 'POST', body: '{}' })
    assert.equal(status, 409, `délier doit être refusé : ${JSON.stringify(body)}`)
    assert.ok(/existe encore/i.test(body.error || ''), body.error)

    // Rien n'a bougé.
    const { body: detail } = await api(`/lt-debts/${found.debt.id}/payments`)
    const still = detail.payments.find(p => p.id === alive.id)
    assert.equal(still.qb_txn_id, alive.qb_txn_id, 'le lien QB doit être intact')
    assert.ok(still.pushed_at, 'le versement doit rester comptabilisé')
  })

  test('délier est refusé sur un versement sans transaction QB liée', async () => {
    const { body: debt } = await api('/lt-debts', {
      method: 'POST',
      body: JSON.stringify({ label: `ZZ Test délier ${Date.now()}`, currency: 'CAD' }),
    })
    throwawayDebtId = debt.id
    const { body: payment } = await api(`/lt-debts/${debt.id}/payments`, {
      method: 'POST',
      body: JSON.stringify({ payment_date: '2030-01-15', principal: 100, interest: 5, balance_after: 900 }),
    })
    const { status, body } = await api(`/lt-debts/payments/${payment.id}/unpublish`, { method: 'POST', body: '{}' })
    assert.equal(status, 400, `attendu 400, reçu ${status} : ${JSON.stringify(body)}`)
    assert.ok(/Aucune transaction QB/i.test(body.error || ''), body.error)
  })
})
