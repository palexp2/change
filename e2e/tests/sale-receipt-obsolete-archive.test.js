const { test, before, after, describe } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Documents obsolètes (transactionAnomalies.receiptObsolescence) : un reçu à 0 $
// est signalé « sans objet comptable » (anomalie zero_total, non bloquante) et la
// fiche propose l'archivage en un clic. On choisit un reçu réel done+non publié,
// on met son total à 0 (PATCH → re-scan des anomalies), on vérifie le bandeau et
// l'archivage, puis on RESTAURE tout : désarchivage + total d'origine (l'anomalie
// zero_total se résout au re-scan déclenché par le PATCH).

let browser, ctx, page, token, receiptId, originalTotal

function authFetch(path, opts = {}) {
  return fetch(`${URL}/api${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
}

// describe() obligatoire : des hooks before/after top-level ne s'exécutent pas
// proprement (after jamais lancé, runner qui pend) — cf. gotcha E2E du repo.
describe('document obsolète (0 $) — bandeau + archivage en un clic', () => {
  before(async () => {
    const login = await fetch(`${URL}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    }).then(r => r.json())
    token = login.token
    assert.ok(token, 'login a échoué')

    // Reçu extrait, non publié, non archivé, total > 0 et sans statut obsolète
    // préexistant : on le rend temporairement « à 0 $ » puis on restaure.
    const list = await authFetch('/sale-receipts?limit=all').then(r => r.json())
    const candidate = (list.data || []).find(r =>
      r.status === 'done' && !r.quickbooks_id && !r.archived_at && Number(r.total) > 0 && !r.obsolete)
    assert.ok(candidate, 'aucun reçu done+non-publié+total>0 disponible pour le test')
    receiptId = candidate.id
    originalTotal = candidate.total

    const patched = await authFetch(`/sale-receipts/${receiptId}`, {
      method: 'PATCH', body: JSON.stringify({ total: 0 }),
    })
    assert.equal(patched.status, 200, 'PATCH total=0 a échoué')

    browser = await chromium.launch()
    ctx = await browser.newContext()
    page = await ctx.newPage()
    await page.addInitScript(t => localStorage.setItem('erp_token', t), token)
  })

  after(async () => {
    // Restaure l'état d'origine : désarchive puis remet le total (le PATCH re-scanne
    // les anomalies → zero_total passe à resolved).
    if (token && receiptId) {
      await authFetch(`/sale-receipts/${receiptId}/unarchive`, { method: 'POST' }).catch(() => {})
      await authFetch(`/sale-receipts/${receiptId}`, {
        method: 'PATCH', body: JSON.stringify({ total: originalTotal }),
      }).catch(() => {})
    }
    await browser?.close()
  })

  test('l’API expose obsolete.reason=zero_total et l’anomalie n’est pas bloquante', async () => {
    const rec = await authFetch(`/sale-receipts/${receiptId}`).then(r => r.json())
    assert.ok(rec.obsolete, 'le reçu à 0 $ doit être marqué obsolète')
    assert.equal(rec.obsolete.reason, 'zero_total')
    assert.ok(rec.obsolete.anomaly_id, 'l’anomalie source est référencée')

    const anomalies = await authFetch(`/anomalies?status=open&entity_id=${receiptId}`).then(r => r.json())
    const zero = (anomalies.data || []).find(a => a.kind === 'zero_total')
    assert.ok(zero, 'anomalie zero_total ouverte')
    assert.equal(zero.severity, 'low', 'non bloquante (severity low)')
  })

  test('la fiche affiche le bandeau obsolète et l’archivage en un clic fonctionne', async () => {
    await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'domcontentloaded' })

    const banner = page.getByTestId('receipt-obsolete-banner')
    await banner.waitFor({ state: 'visible', timeout: 30000 })
    await assert.doesNotReject(
      banner.getByText('rien à payer ni à comptabiliser', { exact: false }).first().waitFor({ timeout: 5000 }),
      'le bandeau explique qu’il n’y a rien à comptabiliser')

    // Archivage en un clic depuis le bandeau → retour à la liste.
    await page.getByTestId('receipt-obsolete-archive').click()
    await page.waitForURL(u => /\/sale-receipts\/?$/.test(new globalThis.URL(u).pathname), { timeout: 15000 })

    // Poll l'API (pas le DOM) : archived_at posé par le serveur.
    let rec
    for (let i = 0; i < 20; i++) {
      rec = await authFetch(`/sale-receipts/${receiptId}`).then(r => r.json())
      if (rec.archived_at) break
      await new Promise(r => setTimeout(r, 500))
    }
    assert.ok(rec.archived_at, 'le reçu est archivé')
    assert.equal(rec.obsolete, null, 'un reçu archivé n’est plus signalé obsolète')

    // L'archivage résout l'anomalie zero_total immédiatement (re-scan dans la route).
    const anomalies = await authFetch(`/anomalies?status=all&entity_id=${receiptId}`).then(r => r.json())
    const zero = (anomalies.data || []).find(a => a.kind === 'zero_total')
    assert.ok(zero, 'l’anomalie existe toujours (historique)')
    assert.equal(zero.status, 'resolved', 'résolue par l’archivage')
  })
})
