// Régression : une commande soft-deletée ne doit JAMAIS apparaître comme une
// commande « vide » dans l'app. Symptôme rapporté : #976 (et 977-991) sortaient
// vides parce que :
//   1. la recherche globale (/api/search) ne filtrait pas deleted_at → renvoyait
//      le fantôme soft-deleté en plus de la vraie commande ;
//   2. GET /api/orders/:id ne filtrait pas deleted_at → ouvrir le fantôme rendait
//      une fiche « Commande vide » au lieu d'un 404.
// Ce test crée une commande, la soft-delete, puis vérifie que le fantôme :
//   - ne ressort pas dans la recherche globale,
//   - renvoie 404 sur GET /api/orders/:id,
//   - affiche « Commande introuvable. » dans l'UI (pas la fiche remplie).
// La vraie commande (non supprimée) reste, elle, visible.

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

// Appel API authentifié depuis le contexte de la page (réutilise erp_token).
async function apiCall(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const res = await fetch('/erp/api' + path, {
      method,
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    let json = null
    try { json = await res.json() } catch { /* 204 / pas de corps */ }
    return { status: res.status, json }
  }, { method, path, body })
}

describe('Commande soft-deletée — invisible (recherche + détail)', () => {
  let browser, ctx, page
  let ghostId, ghostNumber

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    // Crée une commande puis la soft-delete → elle devient un « fantôme ».
    const created = await apiCall(page, 'POST', '/orders', {
      status: 'Commande vide',
      notes: `E2E ghost ${Date.now()}`,
    })
    assert.ok(created.status === 200 || created.status === 201, 'création commande')
    ghostId = created.json.id
    ghostNumber = created.json.order_number
    const del = await apiCall(page, 'DELETE', `/orders/${ghostId}`)
    assert.ok(del.status >= 200 && del.status < 300, 'soft-delete commande')
  })

  after(async () => {
    // La commande est déjà soft-deletée (état terminal voulu, comme les autres
    // fantômes). Rien de plus à nettoyer.
    await browser?.close()
  })

  test('le fantôme renvoie 404 sur GET /api/orders/:id', async () => {
    const r = await apiCall(page, 'GET', `/orders/${ghostId}`)
    assert.equal(r.status, 404, 'un order soft-deleté ne doit pas être récupérable')
  })

  test('le fantôme n\'apparaît pas dans la recherche globale', async () => {
    const r = await apiCall(page, 'GET', `/search?q=${ghostNumber}`)
    assert.equal(r.status, 200)
    const orders = (r.json.results || []).filter(x => x.type === 'order')
    const hit = orders.find(o => o.url && o.url.includes(ghostId))
    assert.equal(hit, undefined, 'le fantôme ne doit pas figurer dans les résultats de recherche')
  })

  test('ouvrir le fantôme affiche « Commande introuvable. », pas une fiche vide', async () => {
    await page.goto(`${URL}/orders/${ghostId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    const body = await page.evaluate(() => document.body.innerText)
    assert.ok(body.includes('Commande introuvable'), 'doit afficher l\'état introuvable')
    assert.ok(!/Articles\s*\(/.test(body), 'ne doit pas rendre la section Articles d\'une fiche commande')
  })

  test('le fantôme est absent de la source de données de la vue Commandes (bootstrap)', async () => {
    // La page Commandes (Orders.jsx) ne fait pas de fetch direct : elle rend
    // depuis le cache client hydraté par GET /api/bootstrap. On vérifie donc,
    // dans un contexte frais (bootstrap APRÈS la soft-suppression), que le
    // snapshot reçu par le navigateur ne contient pas le fantôme — ni aucune
    // commande supprimée.
    const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const p2 = await ctx2.newPage()
    try {
      await login(p2)
      const snap = await p2.evaluate(async () => {
        const tok = localStorage.getItem('erp_token')
        const j = await fetch('/erp/api/bootstrap', {
          headers: { Authorization: `Bearer ${tok}` },
        }).then(r => r.json())
        const t = j.tables.orders
        const idIdx = t.columns.indexOf('id')
        const delIdx = t.columns.indexOf('deleted_at')
        return {
          ids: t.rows.map(r => r[idIdx]),
          deletedCount: t.rows.filter(r => r[delIdx] != null).length,
        }
      })
      assert.ok(!snap.ids.includes(ghostId), 'le fantôme ne doit pas être dans le snapshot bootstrap')
      assert.equal(snap.deletedCount, 0, 'aucune commande supprimée ne doit être dans le cache')
    } finally {
      await ctx2.close()
    }
  })
})
