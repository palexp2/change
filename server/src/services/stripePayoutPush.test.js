// Comptabilisation automatique des Stripe payouts → Deposits QuickBooks :
// verrouille le périmètre du job quotidien (syncAndPushStripePayouts).
//   1. getStripePayoutPushConfig — merge action_config ↔ défauts (vide = défaut).
//   2. selectPayoutPushCandidates — la borne push_since exclut l'historique
//      (payouts d'avant l'ERP, déjà comptabilisés autrement : les pousser
//      doublerait des mois de revenus dans QB), et seuls les payouts réglés,
//      non poussés et avec balance_transactions synchronisées sont candidats.
//   3. selectStalePayouts — filet « jamais silencieux » : tout payout du
//      périmètre encore sans Deposit après stale_alert_days jours remonte,
//      y compris ceux sans BT (jamais candidats au push).

import { tmpdir } from 'os'
import { join } from 'path'
import { unlinkSync } from 'fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

const tmpDbPath = join(tmpdir(), `erp-test-payout-push-${process.pid}.db`)
process.env.DATABASE_PATH = tmpDbPath

// Schéma minimal — uniquement les colonnes que les fonctions sous test lisent.
// Synchroniser à la main avec schema.js si les fonctions évoluent.
const bootDb = new Database(tmpDbPath)
bootDb.exec(`
  CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    action_config TEXT
  );
  CREATE TABLE stripe_payouts (
    id TEXT PRIMARY KEY,
    stripe_id TEXT UNIQUE,
    amount REAL,
    currency TEXT,
    status TEXT,
    arrival_date TEXT,
    created_date TEXT,
    qb_deposit_id TEXT
  );
  CREATE TABLE stripe_balance_transactions (
    id TEXT PRIMARY KEY,
    payout_stripe_id TEXT
  );
`)
bootDb.close()

// Import APRÈS DATABASE_PATH posé : la singleton ouvre le fichier tmp.
const {
  getStripePayoutPushConfig,
  selectPayoutPushCandidates,
  selectStalePayouts,
  STRIPE_PAYOUT_PUSH_DEFAULTS,
} = await import('./quickbooks.js')
const dbModule = await import('../db/database.js')
const db = dbModule.default

test.after(() => {
  try { db.close() } catch {}
  try { unlinkSync(tmpDbPath) } catch {}
})

function reset() {
  db.exec('DELETE FROM stripe_balance_transactions; DELETE FROM stripe_payouts; DELETE FROM automations;')
}

let seq = 0
function addPayout({ stripeId, arrival, created, status = 'paid', qbDepositId = null, withBt = true, amount = 100, currency = 'CAD' }) {
  const id = stripeId || `po_${++seq}`
  db.prepare(`
    INSERT INTO stripe_payouts (id, stripe_id, amount, currency, status, arrival_date, created_date, qb_deposit_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, id, amount, currency, status, arrival, created || `${arrival || '2026-06-01'}T12:00:00.000Z`, qbDepositId)
  if (withBt) {
    db.prepare('INSERT INTO stripe_balance_transactions (id, payout_stripe_id) VALUES (?, ?)').run(`bt_${id}`, id)
  }
  return id
}

test('config — sans row automation → défauts', () => {
  reset()
  assert.deepEqual(getStripePayoutPushConfig(), STRIPE_PAYOUT_PUSH_DEFAULTS)
})

test('config — action_config partiel : clés posées priment, vides retombent au défaut', () => {
  reset()
  db.prepare('INSERT INTO automations (id, action_config) VALUES (?, ?)').run(
    'sys_stripe_weekly_payout_push',
    JSON.stringify({ push_since: '2026-06-01', max_batch: '', autre_cle: 'x' })
  )
  const cfg = getStripePayoutPushConfig()
  assert.equal(cfg.push_since, '2026-06-01')
  assert.equal(cfg.max_batch, STRIPE_PAYOUT_PUSH_DEFAULTS.max_batch)
  assert.equal(cfg.slack_webhook_env, STRIPE_PAYOUT_PUSH_DEFAULTS.slack_webhook_env)
})

test('candidats — la borne push_since exclut les payouts historiques', () => {
  reset()
  addPayout({ stripeId: 'po_historique', arrival: '2026-04-20' }) // dernier payout pré-ERP
  addPayout({ stripeId: 'po_recent', arrival: '2026-07-27' })
  const out = selectPayoutPushCandidates({ push_since: '2026-04-21' })
  assert.deepEqual(out.map(p => p.stripe_id), ['po_recent'])
})

test('candidats — exclut non réglés, déjà poussés, et sans balance_transactions', () => {
  reset()
  addPayout({ stripeId: 'po_ok', arrival: '2026-07-01' })
  addPayout({ stripeId: 'po_in_transit', arrival: '2026-07-02', status: 'in_transit' })
  addPayout({ stripeId: 'po_deja_pousse', arrival: '2026-07-03', qbDepositId: '17750' })
  addPayout({ stripeId: 'po_sans_bt', arrival: '2026-07-04', withBt: false })
  const out = selectPayoutPushCandidates({ push_since: '2026-04-21' })
  assert.deepEqual(out.map(p => p.stripe_id), ['po_ok'])
})

test('candidats — tri du plus ancien au plus récent (le cap max_batch reporte les récents)', () => {
  reset()
  addPayout({ stripeId: 'po_b', arrival: '2026-07-20' })
  addPayout({ stripeId: 'po_a', arrival: '2026-07-06' })
  addPayout({ stripeId: 'po_c', arrival: '2026-07-27' })
  const out = selectPayoutPushCandidates({ push_since: '2026-04-21' })
  assert.deepEqual(out.map(p => p.stripe_id), ['po_a', 'po_b', 'po_c'])
})

test('candidats — arrival_date NULL retombe sur la date de created_date', () => {
  reset()
  addPayout({ stripeId: 'po_sans_arrivee', arrival: null, created: '2026-07-30T09:00:00.000Z' })
  addPayout({ stripeId: 'po_null_historique', arrival: null, created: '2026-03-01T09:00:00.000Z' })
  const out = selectPayoutPushCandidates({ push_since: '2026-04-21' })
  assert.deepEqual(out.map(p => p.stripe_id), ['po_sans_arrivee'])
  assert.equal(out[0].arrival_date, '2026-07-30')
})

test('en souffrance — payout réglé depuis ≥ N jours sans Deposit, avec ou sans BT', () => {
  reset()
  const today = new Date('2026-08-04T12:00:00Z')
  addPayout({ stripeId: 'po_vieux_sans_bt', arrival: '2026-07-27', withBt: false })
  addPayout({ stripeId: 'po_vieux_avec_bt', arrival: '2026-07-20' })
  addPayout({ stripeId: 'po_frais', arrival: '2026-08-03' })            // < 3 jours → pas encore alarmant
  addPayout({ stripeId: 'po_pousse', arrival: '2026-07-01', qbDepositId: '17600' })
  addPayout({ stripeId: 'po_historique', arrival: '2026-03-01', withBt: false }) // hors périmètre
  const out = selectStalePayouts({ push_since: '2026-04-21', staleDays: 3, today })
  assert.deepEqual(out.map(p => p.stripe_id), ['po_vieux_avec_bt', 'po_vieux_sans_bt'])
  assert.equal(out.find(p => p.stripe_id === 'po_vieux_sans_bt').has_bt, 0)
  assert.equal(out.find(p => p.stripe_id === 'po_vieux_avec_bt').has_bt, 1)
})
