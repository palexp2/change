// Vérifie la fonctionnalité "rachat" sur les events de churn d'abonnement :
// - Détection automatique via insert direct DB d'un churn + d'une commande
//   significative postérieure du même client → rachat_status='probable'.
// - Endpoint PATCH /rachat permet de confirmer / dénier manuellement.
// - L'endpoint /rachat-candidates renvoie la commande candidate.
//
// Backend pur (pas d'UI) — la validation UI est dans
// abonnement-rachat-ui.test.js.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = '/home/ec2-user/erp/server/data/erp.db'

let token = null
async function login() {
  const r = await fetch(`${URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  })
  const j = await r.json()
  token = j.token
}

async function apiGet(path) {
  const r = await fetch(`${URL}/api${path}`, { headers: { Authorization: `Bearer ${token}` } })
  return r.json()
}
async function apiPost(path, body) {
  const r = await fetch(`${URL}/api${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return r.json()
}
async function apiPatch(path, body) {
  const r = await fetch(`${URL}/api${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json()
}

describe("Rachat post-churn — détection auto + édition manuelle", () => {
  let db
  let companyId = null
  let subId = null
  let churnEventId = null
  let orderId = null
  const insertedEventIds = []
  const insertedSubIds = []
  const insertedOrderIds = []

  before(async () => {
    await login()
    db = new Database(DB_PATH, { readonly: false })

    const company = db.prepare("SELECT id FROM companies WHERE name IS NOT NULL ORDER BY created_at DESC LIMIT 1").get()
    if (!company) throw new Error('Aucune entreprise en base')
    companyId = company.id

    // Sub annulé + churn event 6 mois dans le passé (donc fenêtre +12 mois
    // englobe today). previous_amount_cad = 100 → seuil = 1200 CAD.
    subId = `__rachat_sub_${Date.now()}`
    db.prepare(`INSERT INTO subscriptions (id, company_id, status, amount_monthly, currency) VALUES (?,?,?,?,?)`)
      .run(subId, companyId, 'canceled', 100, 'CAD')
    insertedSubIds.push(subId)

    const churnDate = new Date(Date.now() - 180 * 86400_000).toISOString()
    churnEventId = `__rachat_evt_${Date.now()}`
    db.prepare(`
      INSERT INTO subscription_events (id, subscription_id, company_id, event_date, event_type, category, amount_cad_delta, previous_amount_cad, currency)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(churnEventId, subId, companyId, churnDate, 'churn', 'churn', -100, 100, 'CAD')
    insertedEventIds.push(churnEventId)

    // Commande significative postérieure : 2 mois après le churn, total ≥ seuil
    // (12 × 100 = 1200 CAD). On insère un order_item à 1500 CAD pour dépasser.
    const orderDate = new Date(Date.now() - 120 * 86400_000).toISOString()
    orderId = `__rachat_order_${Date.now()}`
    const maxN = db.prepare('SELECT MAX(order_number) AS m FROM orders').get()
    const orderNumber = (maxN?.m || 0) + 1
    db.prepare(`
      INSERT INTO orders (id, order_number, company_id, status, date_commande, is_subscription, created_at)
      VALUES (?,?,?,?,?,0,?)
    `).run(orderId, orderNumber, companyId, 'Envoyé', orderDate.slice(0, 10), orderDate)
    insertedOrderIds.push(orderId)

    // 1 line à qty=1, unit_cost=1500 → total_value = 1500
    db.prepare(`
      INSERT INTO order_items (id, order_id, qty, unit_cost, item_type)
      VALUES (?,?,1,1500,'Facturable')
    `).run(`__rachat_oi_${Date.now()}`, orderId)
  })

  after(() => {
    if (db) {
      try {
        for (const id of insertedEventIds) db.prepare('DELETE FROM subscription_events WHERE id=?').run(id)
        for (const id of insertedSubIds) db.prepare('DELETE FROM subscriptions WHERE id=?').run(id)
        for (const id of insertedOrderIds) {
          db.prepare('DELETE FROM order_items WHERE order_id=?').run(id)
          db.prepare('DELETE FROM orders WHERE id=?').run(id)
        }
      } catch (e) { console.error('cleanup:', e.message) }
      db.close()
    }
  })

  test('détection auto via POST /detect-rachat → rachat_status=probable', async () => {
    const r = await apiPost(`/projets/abonnement-events/${churnEventId}/detect-rachat`)
    assert.equal(r.ok, true, `detect-rachat ok attendu: ${JSON.stringify(r)}`)

    // Vérifie en DB
    const ev = db.prepare('SELECT rachat_status, rachat_order_id, rachat_checked_at FROM subscription_events WHERE id=?').get(churnEventId)
    assert.equal(ev.rachat_status, 'probable', `attendu probable, observé ${ev.rachat_status}`)
    assert.equal(ev.rachat_order_id, orderId, `rachat_order_id devrait pointer sur la commande synthétique`)
    assert.ok(ev.rachat_checked_at, 'rachat_checked_at doit être renseigné')
  })

  test('GET /rachat-candidates retourne la commande candidate', async () => {
    const r = await apiGet(`/projets/abonnement-events/${churnEventId}/rachat-candidates`)
    assert.ok(Array.isArray(r.data), 'data array attendu')
    const found = r.data.find(o => o.id === orderId)
    assert.ok(found, `commande synthétique ${orderId} non trouvée parmi candidats`)
    assert.ok(found.total_value >= 1200, `total_value attendu >= 1200, observé ${found.total_value}`)
  })

  test("GET /abonnement-events?category=churn inclut rachat_status, _order_id, _order_number", async () => {
    const r = await apiGet(`/projets/abonnement-events?category=churn&limit=all`)
    const ev = r.data.find(e => e.id === churnEventId)
    assert.ok(ev, 'event de test introuvable dans la liste')
    assert.equal(ev.rachat_status, 'probable')
    assert.equal(ev.rachat_order_id, orderId)
    assert.ok(ev.rachat_order_number, `rachat_order_number attendu`)
  })

  test("PATCH /rachat status=confirmed persiste", async () => {
    const r = await apiPatch(`/projets/abonnement-events/${churnEventId}/rachat`, { status: 'confirmed' })
    assert.equal(r.ok, true)
    const ev = db.prepare('SELECT rachat_status FROM subscription_events WHERE id=?').get(churnEventId)
    assert.equal(ev.rachat_status, 'confirmed')
  })

  test("PATCH /rachat status=none persiste", async () => {
    const r = await apiPatch(`/projets/abonnement-events/${churnEventId}/rachat`, { status: 'none' })
    assert.equal(r.ok, true)
    const ev = db.prepare('SELECT rachat_status FROM subscription_events WHERE id=?').get(churnEventId)
    assert.equal(ev.rachat_status, 'none')
  })

  test("detection ne réécrase pas un statut 'confirmed'", async () => {
    // Repasse à confirmed, puis re-déclenche detect → doit rester confirmed.
    await apiPatch(`/projets/abonnement-events/${churnEventId}/rachat`, { status: 'confirmed' })
    await apiPost(`/projets/abonnement-events/${churnEventId}/detect-rachat`)
    const ev = db.prepare('SELECT rachat_status FROM subscription_events WHERE id=?').get(churnEventId)
    assert.equal(ev.rachat_status, 'confirmed', "detect-rachat ne doit pas écraser un 'confirmed'")
  })

  test("backfill admin renvoie un compteur cohérent", async () => {
    const r = await apiPost(`/projets/abonnement-events/backfill-rachat`)
    assert.equal(typeof r.processed, 'number', 'processed numérique attendu')
    assert.equal(typeof r.withCandidate, 'number', 'withCandidate numérique attendu')
  })

  test("PATCH /rachat sur un event non-churn renvoie 400", async () => {
    // Crée un event upgrade synthétique
    const evtId = `__rachat_invalid_${Date.now()}`
    db.prepare(`
      INSERT INTO subscription_events (id, subscription_id, event_date, event_type, category, currency)
      VALUES (?,?,?,?,?,?)
    `).run(evtId, subId, new Date().toISOString(), 'upgrade', 'upgrade', 'CAD')
    insertedEventIds.push(evtId)

    const r = await fetch(`${URL}/api/projets/abonnement-events/${evtId}/rachat`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'confirmed' }),
    })
    assert.equal(r.status, 400, `attendu 400, reçu ${r.status}`)
  })
})
