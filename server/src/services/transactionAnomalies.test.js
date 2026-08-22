// Détection d'anomalies transactionnelles : cas de référence = facture Axxess
// 1180634591-01 (103,48 $ CAD) comptabilisée deux fois — une fois uploadée
// manuellement, une fois re-reçue via factures@orisha.io. Le dédoublonnage par
// Message-ID ne couvre pas ce cas inter-canaux ; la détection par numéro/montant si.

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

const tmpDbPath = join(tmpdir(), `erp-test-anomalies-${process.pid}.db`)
process.env.DATABASE_PATH = tmpDbPath

const bootDb = new Database(tmpDbPath)
bootDb.exec(`
  CREATE TABLE sale_receipts (
    id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'done',
    company TEXT,
    receipt_number TEXT,
    receipt_date TEXT,
    total REAL,
    currency TEXT DEFAULT 'CAD',
    quickbooks_id TEXT,
    quickbooks_type TEXT,
    source TEXT DEFAULT 'upload',
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    deleted_at TEXT,
    archived_at TEXT,
    tps REAL,
    tvq REAL,
    service_period TEXT,
    items TEXT DEFAULT '[]'
  );
  CREATE TABLE transaction_anomalies (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    details TEXT,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    dismissed_by TEXT,
    dismissed_reason TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE UNIQUE INDEX idx_txn_anomalies_fp ON transaction_anomalies(fingerprint);
  CREATE TABLE sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    module TEXT, trigger_ TEXT, status TEXT,
    records_modified INTEGER, records_destroyed INTEGER,
    error_message TEXT, duration_ms INTEGER,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`)
bootDb.close()

const { detectReceiptAnomalies, syncReceiptAnomalies, openBlockingAnomalies, receiptObsolescence, verifyPublishedQbLinks } = await import('./transactionAnomalies.js')
const db = (await import('../db/database.js')).default

let seq = 0
function insertReceipt(fields) {
  const id = fields.id || `r-${++seq}`
  db.prepare(`
    INSERT INTO sale_receipts (id, status, company, receipt_number, receipt_date, total, currency, quickbooks_id, quickbooks_type, source, deleted_at, archived_at, tps, tvq, service_period, items)
    VALUES (@id, @status, @company, @receipt_number, @receipt_date, @total, @currency, @quickbooks_id, @quickbooks_type, @source, @deleted_at, @archived_at, @tps, @tvq, @service_period, @items)
  `).run({
    status: 'done', company: null, receipt_number: null, receipt_date: null,
    total: null, currency: 'CAD', quickbooks_id: null, quickbooks_type: null, source: 'upload', deleted_at: null,
    archived_at: null, tps: null, tvq: null, service_period: null, items: '[]',
    ...fields, id,
  })
  return db.prepare('SELECT * FROM sale_receipts WHERE id=?').get(id)
}

function reset() {
  db.prepare('DELETE FROM sale_receipts').run()
  db.prepare('DELETE FROM transaction_anomalies').run()
}

test('cas Axxess : même numéro + même total, noms fournisseur différents → duplicate_number high', () => {
  reset()
  insertReceipt({ id: 'axxess-upload', company: 'Axxess', receipt_number: '1180634591-01', receipt_date: '2026-07-14', total: 103.48, quickbooks_id: '17697' })
  const emailed = insertReceipt({ id: 'axxess-email', company: 'Axxess International Inc.', receipt_number: '1180634591-01', receipt_date: '2026-07-14', total: 103.48, source: 'email' })

  const anomalies = detectReceiptAnomalies(emailed)
  const dup = anomalies.find(a => a.kind === 'duplicate_number')
  assert.ok(dup, 'doublon détecté')
  assert.equal(dup.severity, 'high')
  assert.match(dup.message, /17697/)
})

test('numéro court identique (BTTH « 14 ») à un an d\'écart, même total → pas duplicate_number sans proximité, pas duplicate_amount hors fenêtre', () => {
  reset()
  insertReceipt({ company: 'BTTH SERVICES MUTIPLES', receipt_number: '14', receipt_date: '2025-07-19', total: 103.48 })
  const recent = insertReceipt({ company: 'BTTH SERVICES MUTIPLES', receipt_number: '15', receipt_date: '2026-07-18', total: 103.48 })
  // Numéros différents + dates éloignées : aucune anomalie de doublon.
  const kinds = detectReceiptAnomalies(recent).map(a => a.kind)
  assert.ok(!kinds.includes('duplicate_number'))
  assert.ok(!kinds.includes('duplicate_amount'))
})

test('numéro court identique + même fournisseur + même total → duplicate_number', () => {
  reset()
  insertReceipt({ company: 'BTTH SERVICES MUTIPLES', receipt_number: '14', receipt_date: '2026-07-04', total: 103.48 })
  const dup = insertReceipt({ company: 'BTTH SERVICES MUTIPLES', receipt_number: '14', receipt_date: '2026-07-05', total: 103.48 })
  assert.ok(detectReceiptAnomalies(dup).some(a => a.kind === 'duplicate_number'))
})

test('numéro court identique un an plus tard (numérotation qui recommence) → pas de doublon', () => {
  reset()
  insertReceipt({ company: 'BTTH SERVICES MUTIPLES', receipt_number: '14', receipt_date: '2025-07-19', total: 103.48 })
  const later = insertReceipt({ company: 'BTTH SERVICES MUTIPLES', receipt_number: '14', receipt_date: '2026-07-04', total: 103.48 })
  assert.ok(!detectReceiptAnomalies(later).some(a => a.kind === 'duplicate_number'))
})

test('même fournisseur, même total, 3 jours d\'écart, sans numéros → duplicate_amount medium', () => {
  reset()
  insertReceipt({ company: 'Uline', receipt_date: '2026-06-01', total: 250 })
  const b = insertReceipt({ company: 'Uline', receipt_date: '2026-06-04', total: 250 })
  const a = detectReceiptAnomalies(b).find(x => x.kind === 'duplicate_amount')
  assert.ok(a)
  assert.equal(a.severity, 'medium')
})

test('récurrence légitime : numéros distincts sur les deux documents → pas de duplicate_amount', () => {
  reset()
  insertReceipt({ company: 'Ménage', receipt_number: '7', receipt_date: '2026-06-01', total: 103.48 })
  const b = insertReceipt({ company: 'Ménage', receipt_number: '8', receipt_date: '2026-06-03', total: 103.48 })
  assert.ok(!detectReceiptAnomalies(b).some(x => x.kind === 'duplicate_amount'))
})

// ── Vérification approfondie (réduction des faux positifs) ───────────────────

test('copie archivée jamais publiée (doublon déjà classé) → aucune anomalie, ni comme reçu ni comme pair', () => {
  reset()
  const published = insertReceipt({ id: 'pub', company: 'Uline', receipt_number: '18348475', receipt_date: '2026-06-25', total: 738.35, quickbooks_id: '17588' })
  const archived = insertReceipt({ id: 'arc', company: 'Uline', receipt_number: '18348475', receipt_date: '2026-06-25', total: 738.35, archived_at: '2026-07-01T00:00:00.000Z' })
  assert.equal(detectReceiptAnomalies(published).length, 0, 'le pair inerte ne déclenche rien')
  assert.equal(detectReceiptAnomalies(archived).length, 0, 'le reçu inerte ne se scanne pas')
})

test('copie archivée MAIS publiée sur QB → la double écriture reste signalée', () => {
  reset()
  insertReceipt({ company: 'Entretien ménager', receipt_number: '000014', receipt_date: '2026-07-11', total: 103.48, quickbooks_id: '17695', archived_at: '2026-07-20T00:00:00.000Z' })
  const second = insertReceipt({ company: 'Entretien ménager', receipt_number: '000014', receipt_date: '2026-07-11', total: 103.48, quickbooks_id: '17724' })
  assert.ok(detectReceiptAnomalies(second).some(a => a.kind === 'duplicate_number'))
})

test('numéro réutilisé avec des totaux différents (numéro de compte Bell) → pas de doublon d\'un mois à l\'autre, doublon à quelques jours', () => {
  reset()
  // Le même « numéro » apparaît avec deux totaux différents → numéro de compte.
  insertReceipt({ company: 'Bell', receipt_number: '543955959', receipt_date: '2026-05-22', total: 206.84 })
  insertReceipt({ company: 'Bell Canada', receipt_number: '543955959', receipt_date: '2026-06-22', total: 118.91 })
  const monthLater = insertReceipt({ company: 'Bell Canada', receipt_number: '543955959', receipt_date: '2026-06-22', total: 206.84 })
  assert.ok(!detectReceiptAnomalies(monthLater).some(a => a.kind === 'duplicate_number'), 'facturation mensuelle courante, pas un doublon')
  // …mais deux pièces au même total à 2 jours d'écart restent suspectes.
  const closeDup = insertReceipt({ company: 'Bell', receipt_number: '543955959', receipt_date: '2026-05-24', total: 206.84 })
  assert.ok(detectReceiptAnomalies(closeDup).some(a => a.kind === 'duplicate_number'))
})

test('même montant à 3 jours mais périodes de service distinctes → pas de duplicate_amount', () => {
  reset()
  insertReceipt({ company: 'Make', receipt_date: '2026-07-30', total: 10.59, service_period: 'juillet 2026' })
  const b = insertReceipt({ company: 'Make', receipt_date: '2026-08-02', total: 10.59, service_period: 'août 2026' })
  assert.ok(!detectReceiptAnomalies(b).some(a => a.kind === 'duplicate_amount'))
})

test('même total mais ventilation de taxes différente → pas de duplicate_amount (documents distincts)', () => {
  reset()
  insertReceipt({ company: 'Uline', receipt_date: '2026-06-01', total: 250, tps: 10.87, tvq: 21.69 })
  const b = insertReceipt({ company: 'Uline', receipt_date: '2026-06-03', total: 250, tps: 0, tvq: 0 })
  assert.ok(!detectReceiptAnomalies(b).some(a => a.kind === 'duplicate_amount'))
})

test('même total, même nombre de lignes mais montants de lignes différents → pas de duplicate_amount', () => {
  reset()
  insertReceipt({ company: 'DigiKey', receipt_date: '2026-06-01', total: 250, items: JSON.stringify([{ description: 'A', total: 100 }, { description: 'B', total: 150 }]) })
  const b = insertReceipt({ company: 'DigiKey', receipt_date: '2026-06-03', total: 250, items: JSON.stringify([{ description: 'C', total: 200 }, { description: 'D', total: 50 }]) })
  assert.ok(!detectReceiptAnomalies(b).some(a => a.kind === 'duplicate_amount'))
})

test('montant récurrent (recharges automatiques) → pas de duplicate_amount à quelques jours, mais signalé le jour même', () => {
  reset()
  insertReceipt({ company: 'Twilio', receipt_date: '2026-03-10', total: 50 })
  insertReceipt({ company: 'Twilio', receipt_date: '2026-04-22', total: 50 })
  insertReceipt({ company: 'Twilio', receipt_date: '2026-06-05', total: 50 })
  const closeButNormal = insertReceipt({ company: 'Twilio', receipt_date: '2026-06-08', total: 50 })
  assert.ok(!detectReceiptAnomalies(closeButNormal).some(a => a.kind === 'duplicate_amount'), 'récurrence établie → 3 jours d\'écart = normal')
  const sameDay = insertReceipt({ company: 'Twilio', receipt_date: '2026-06-05', total: 50 })
  assert.ok(detectReceiptAnomalies(sameDay).some(a => a.kind === 'duplicate_amount'), 'deux fois le même jour reste suspect')
})

test('duplicate_amount survivant : les signaux corroborants apparaissent dans le message', () => {
  reset()
  insertReceipt({ company: 'Uline', receipt_date: '2026-06-01', total: 250, tps: 10.87, tvq: 21.69 })
  const b = insertReceipt({ company: 'Uline', receipt_date: '2026-06-01', total: 250, tps: 10.87, tvq: 21.69 })
  const a = detectReceiptAnomalies(b).find(x => x.kind === 'duplicate_amount')
  assert.ok(a)
  assert.match(a.message, /même date/)
  assert.match(a.message, /même ventilation de taxes/)
})

test('fournisseur aux montants très dispersés (Amazon) → pas d\'amount_outlier', () => {
  reset()
  const totals = [3.77, 11.19, 27.95, 41.79, 54.92, 86.43, 111.0]
  totals.forEach((t, i) => insertReceipt({ company: 'Amazon.com.ca ULC', receipt_number: `CA-${i}`, receipt_date: `2026-0${(i % 6) + 1}-1${i}`, total: t }))
  const big = insertReceipt({ company: 'Amazon.com.ca ULC', receipt_number: 'CA-BIG', receipt_date: '2026-07-15', total: 220.86 })
  assert.ok(!detectReceiptAnomalies(big).some(x => x.kind === 'amount_outlier'))
})

test('montant ≥ 3× la médiane 12 mois → amount_outlier', () => {
  reset()
  for (let i = 1; i <= 5; i++) {
    insertReceipt({ company: 'AWS', receipt_number: `INV-${i}`, receipt_date: `2026-0${i}-15`, total: 70, currency: 'USD' })
  }
  const big = insertReceipt({ company: 'AWS', receipt_number: 'INV-9', receipt_date: '2026-07-15', total: 500, currency: 'USD' })
  const a = detectReceiptAnomalies(big).find(x => x.kind === 'amount_outlier')
  assert.ok(a)
  assert.match(a.message, /médiane/)
})

test('devise différente de la devise dominante du fournisseur → currency_mismatch (cas AWS USD→CAD)', () => {
  reset()
  for (let i = 1; i <= 5; i++) {
    insertReceipt({ company: 'AWS', receipt_number: `INV-${i}`, receipt_date: `2026-0${i}-15`, total: 70, currency: 'USD' })
  }
  const wrong = insertReceipt({ company: 'AWS', receipt_number: 'INV-9', receipt_date: '2026-07-15', total: 69.68, currency: 'CAD' })
  assert.ok(detectReceiptAnomalies(wrong).some(x => x.kind === 'currency_mismatch'))
})

test('syncReceiptAnomalies : persiste, bloque le push, dismiss survit au re-scan, suppression résout', () => {
  reset()
  insertReceipt({ id: 'a1', company: 'Axxess', receipt_number: '1180634591-01', receipt_date: '2026-07-14', total: 103.48 })
  insertReceipt({ id: 'a2', company: 'Axxess International Inc.', receipt_number: '1180634591-01', receipt_date: '2026-07-14', total: 103.48 })

  syncReceiptAnomalies('a2')
  const blocking = openBlockingAnomalies('a2')
  assert.equal(blocking.length, 1)
  assert.equal(blocking[0].kind, 'duplicate_number')

  // Re-scan : pas de doublon d'anomalie (même fingerprint).
  syncReceiptAnomalies('a2')
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM transaction_anomalies`).get().c, 1)

  // Dismiss → plus bloquant, et le re-scan ne la réouvre pas.
  db.prepare(`UPDATE transaction_anomalies SET status='dismissed' WHERE id=?`).run(blocking[0].id)
  syncReceiptAnomalies('a2')
  assert.equal(openBlockingAnomalies('a2').length, 0)
  assert.equal(db.prepare(`SELECT status FROM transaction_anomalies`).get().status, 'dismissed')

  // Réouverte puis l'un des reçus supprimé → resolved.
  db.prepare(`UPDATE transaction_anomalies SET status='open'`).run()
  db.prepare(`UPDATE sale_receipts SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='a1'`).run()
  syncReceiptAnomalies('a1')
  assert.equal(db.prepare(`SELECT status FROM transaction_anomalies`).get().status, 'resolved')
})

// ── Grand livre QuickBooks (achats_fournisseurs) ─────────────────────────────
// Cas visé : la facture a été saisie directement dans QB (ou via le module Achats)
// AVANT d'arriver dans l'extracteur. La comparaison reçu↔reçu ne la voyait pas →
// re-comptabilisation, donc seconde dette fournisseur et risque de double paiement.

const dbAchats = (await import('../db/database.js')).default
dbAchats.exec(`
  CREATE TABLE IF NOT EXISTS achats_fournisseurs (
    id TEXT PRIMARY KEY, type TEXT, vendor TEXT, vendor_invoice_number TEXT, reference TEXT,
    date_achat TEXT, total_cad REAL, amount_paid_cad REAL DEFAULT 0, currency TEXT DEFAULT 'CAD',
    status TEXT, quickbooks_id TEXT
  );
`)

let aSeq = 0
function insertAchat(fields) {
  const id = fields.id || `a-${++aSeq}`
  db.prepare(`
    INSERT INTO achats_fournisseurs (id, type, vendor, vendor_invoice_number, reference, date_achat,
      total_cad, amount_paid_cad, currency, status, quickbooks_id)
    VALUES (@id, @type, @vendor, @vendor_invoice_number, @reference, @date_achat,
      @total_cad, @amount_paid_cad, @currency, @status, @quickbooks_id)
  `).run({
    type: 'bill', vendor: null, vendor_invoice_number: null, reference: null, date_achat: null,
    total_cad: 0, amount_paid_cad: 0, currency: 'CAD', status: 'Approuvé', quickbooks_id: null,
    ...fields, id,
  })
}

function resetAll() {
  reset()
  db.prepare('DELETE FROM achats_fournisseurs').run()
}

test('facture déjà saisie dans QB (même nº, même total) → already_in_qb high + mention du paiement', () => {
  resetAll()
  insertAchat({ vendor: 'Axxess International Inc.', vendor_invoice_number: '1180634591-01', date_achat: '2026-07-14', total_cad: 103.48, amount_paid_cad: 103.48, quickbooks_id: '9001' })
  const rec = insertReceipt({ company: 'Axxess', receipt_number: '1180634591-01', receipt_date: '2026-07-15', total: 103.48 })
  const a = detectReceiptAnomalies(rec).find(x => x.kind === 'already_in_qb')
  assert.ok(a, 'doublon grand livre détecté')
  assert.equal(a.severity, 'high')
  assert.match(a.message, /déjà payée/)
  assert.equal(a.details.qb_id, '9001')
  assert.equal(openBlockingAnomalies(rec.id).length, 0) // pas encore persistée
  syncReceiptAnomalies(rec.id)
  assert.equal(openBlockingAnomalies(rec.id).length, 1, 'bloque la publication QB')
})

test('la publication du reçu lui-même (même quickbooks_id) ne se signale pas comme doublon', () => {
  resetAll()
  insertAchat({ vendor: 'Twilio', vendor_invoice_number: 'INV-777777', date_achat: '2026-07-01', total_cad: 250, quickbooks_id: '9100' })
  const rec = insertReceipt({ company: 'Twilio', receipt_number: 'INV-777777', receipt_date: '2026-07-01', total: 250, quickbooks_id: '9100' })
  assert.ok(!detectReceiptAnomalies(rec).some(x => x.kind === 'already_in_qb'))
})

test('achat QB du même fournisseur et du même montant à 2 jours, sans numéro → possible_duplicate_in_qb medium', () => {
  resetAll()
  insertAchat({ type: 'purchase', vendor: 'Uline', date_achat: '2026-06-02', total_cad: 250, quickbooks_id: '9200' })
  const rec = insertReceipt({ company: 'Uline', receipt_date: '2026-06-04', total: 250 })
  const a = detectReceiptAnomalies(rec).find(x => x.kind === 'possible_duplicate_in_qb')
  assert.ok(a)
  assert.equal(a.severity, 'medium')
})

test('achat QB avec un numéro DIFFÉRENT (récurrence légitime) → aucune anomalie grand livre', () => {
  resetAll()
  insertAchat({ vendor: 'Ménage', vendor_invoice_number: '7', date_achat: '2026-06-01', total_cad: 103.48, quickbooks_id: '9300' })
  const rec = insertReceipt({ company: 'Ménage', receipt_number: '8', receipt_date: '2026-06-03', total: 103.48 })
  const kinds = detectReceiptAnomalies(rec).map(x => x.kind)
  assert.ok(!kinds.includes('already_in_qb') && !kinds.includes('possible_duplicate_in_qb'))
})

test('achat QB hors fenêtre de 400 jours → ignoré', () => {
  resetAll()
  insertAchat({ vendor: 'Bell', vendor_invoice_number: 'FACT-123456', date_achat: '2024-01-10', total_cad: 90, quickbooks_id: '9400' })
  const rec = insertReceipt({ company: 'Bell', receipt_number: 'FACT-123456', receipt_date: '2026-07-10', total: 90 })
  assert.ok(!detectReceiptAnomalies(rec).some(x => x.kind === 'already_in_qb'))
})

// ── Documents à 0 $ et obsolescence ──────────────────────────────────────────
// Cas de référence : facture mensuelle Google Cloud à 0,00 $ (frais nuls) — rien à
// payer ni à comptabiliser, le document doit être signalé archivable sans bloquer.

test('document à 0 $ → zero_total low, non bloquant, résolu à l\'archivage', () => {
  resetAll()
  const rec = insertReceipt({ company: 'Google Cloud Canada Corporation', receipt_number: '5654662743', receipt_date: '2026-07-31', total: 0, service_period: 'juillet 2026' })
  const a = detectReceiptAnomalies(rec).find(x => x.kind === 'zero_total')
  assert.ok(a, 'zero_total détectée')
  assert.equal(a.severity, 'low')
  assert.match(a.message, /rien à payer ni à comptabiliser/)

  syncReceiptAnomalies(rec.id)
  assert.equal(openBlockingAnomalies(rec.id).length, 0, 'un 0 $ ne bloque pas la publication')
  assert.equal(receiptObsolescence(rec.id)?.reason, 'zero_total')

  // Archivé → l'anomalie se résout et le statut obsolète disparaît.
  db.prepare(`UPDATE sale_receipts SET archived_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(rec.id)
  syncReceiptAnomalies(rec.id)
  assert.equal(db.prepare(`SELECT status FROM transaction_anomalies WHERE kind='zero_total'`).get().status, 'resolved')
  assert.equal(receiptObsolescence(rec.id), null)
})

test('total NULL (extraction incomplète) ou reçu déjà publié → pas de zero_total', () => {
  resetAll()
  const noTotal = insertReceipt({ company: 'Mystère', total: null })
  assert.ok(!detectReceiptAnomalies(noTotal).some(x => x.kind === 'zero_total'))
  const published = insertReceipt({ company: 'Google', total: 0, quickbooks_id: '9500' })
  assert.ok(!detectReceiptAnomalies(published).some(x => x.kind === 'zero_total'))
})

test('doublon dont le pair est publié sur QB → obsolète avec pointeur vers la transaction QB existante', () => {
  resetAll()
  insertReceipt({ id: 'orig', company: 'Axxess', receipt_number: '1180634591-01', receipt_date: '2026-07-14', total: 103.48, quickbooks_id: '17697', quickbooks_type: 'bill' })
  const copy = insertReceipt({ id: 'copy', company: 'Axxess International Inc.', receipt_number: '1180634591-01', receipt_date: '2026-07-14', total: 103.48, source: 'email' })
  syncReceiptAnomalies(copy.id)

  const ob = receiptObsolescence(copy.id)
  assert.ok(ob, 'la copie est obsolète')
  assert.equal(ob.reason, 'duplicate_published')
  assert.equal(ob.qb_id, '17697')
  assert.equal(ob.qb_entity, 'bill')
  assert.equal(ob.other_receipt_id, 'orig')
  // L'original publié, lui, n'est jamais obsolète (fingerprint de paire partagé).
  assert.equal(receiptObsolescence('orig'), null)
})

test('doublon entre deux reçus NON publiés → pas d\'obsolescence (juste l\'anomalie bloquante)', () => {
  resetAll()
  insertReceipt({ id: 'x1', company: 'Uline', receipt_number: '18348475', receipt_date: '2026-06-25', total: 738.35 })
  const b = insertReceipt({ id: 'x2', company: 'Uline', receipt_number: '18348475', receipt_date: '2026-06-25', total: 738.35 })
  syncReceiptAnomalies(b.id)
  assert.equal(receiptObsolescence('x1'), null)
  assert.equal(receiptObsolescence('x2'), null)
  assert.ok(openBlockingAnomalies('x2').length >= 1, 'le doublon reste bloquant')
})

test('already_in_qb (écriture au grand livre) → obsolète avec qb_id/qb_entity de l\'achat', () => {
  resetAll()
  insertAchat({ id: 'ach-1', type: 'purchase', vendor: 'Axxess International Inc.', vendor_invoice_number: '1180634591-01', date_achat: '2026-07-14', total_cad: 103.48, quickbooks_id: '9001' })
  const rec = insertReceipt({ company: 'Axxess', receipt_number: '1180634591-01', receipt_date: '2026-07-15', total: 103.48 })
  syncReceiptAnomalies(rec.id)
  const ob = receiptObsolescence(rec.id)
  assert.ok(ob)
  assert.equal(ob.reason, 'duplicate_published')
  assert.equal(ob.qb_id, '9001')
  assert.equal(ob.qb_entity, 'expense')
  assert.equal(ob.achat_id, 'ach-1')
})

test('l\'obsolescence suit le dismiss de l\'anomalie', () => {
  resetAll()
  const rec = insertReceipt({ company: 'Google Cloud', receipt_number: 'Z-1', receipt_date: '2026-07-31', total: 0 })
  syncReceiptAnomalies(rec.id)
  const ob = receiptObsolescence(rec.id)
  assert.ok(ob)
  db.prepare(`UPDATE transaction_anomalies SET status='dismissed' WHERE id=?`).run(ob.anomaly_id)
  assert.equal(receiptObsolescence(rec.id), null, 'dismiss = « à comptabiliser quand même »')
})

// ── Capture ratée ≠ document à 0 $ ───────────────────────────────────────────
// Cas réel : le collecteur Amazon a enregistré la page « We're unable to load your
// order details ». Le document est vide (0 $, pas de date, pas de ligne) — le
// signaler comme « rien à payer, il peut être archivé » enterrait une facture non
// récupérée.

test('extraction vide → extraction_incomplete, jamais zero_total, et pas d\'archivage proposé', () => {
  resetAll()
  const rec = insertReceipt({ company: 'Amazon.ca', receipt_date: null, total: 0, source: 'scraper:amazon' })
  const kinds = detectReceiptAnomalies(rec).map(a => a.kind)
  assert.ok(kinds.includes('extraction_incomplete'))
  assert.ok(!kinds.includes('zero_total'))
  syncReceiptAnomalies(rec.id)
  assert.equal(receiptObsolescence(rec.id), null, 'une capture ratée ne s\'archive pas')
})

test('vrai 0,00 $ (date + numéro extraits) → zero_total, archivage proposé', () => {
  resetAll()
  const rec = insertReceipt({ company: 'Google Cloud', receipt_number: 'Z-9', receipt_date: '2026-07-31', total: 0 })
  const kinds = detectReceiptAnomalies(rec).map(a => a.kind)
  assert.ok(kinds.includes('zero_total'))
  assert.ok(!kinds.includes('extraction_incomplete'))
})

// ── Montant inhabituel : validé au push ──────────────────────────────────────
// Cas réel : cautionnement douanier annuel Axxess à 575 $ US chez un fournisseur
// facturé 40 $/mois. L'outlier sert à attraper une extraction fautive avant
// comptabilisation ; une fois publié, un humain a tranché.

function seedAxxessHistory() {
  for (const d of ['2026-04-16', '2026-05-04', '2026-06-02', '2026-07-02']) {
    insertReceipt({ company: 'Axxess', receipt_date: d, total: 40, currency: 'USD' })
  }
}

test('montant hors norme non publié → amount_outlier', () => {
  resetAll()
  seedAxxessHistory()
  const rec = insertReceipt({ company: 'Axxess', receipt_date: '2026-08-18', total: 575, currency: 'USD' })
  assert.ok(detectReceiptAnomalies(rec).some(a => a.kind === 'amount_outlier'))
})

test('le même montant une fois publié sur QB → plus d\'amount_outlier', () => {
  resetAll()
  seedAxxessHistory()
  const rec = insertReceipt({ company: 'Axxess', receipt_date: '2026-08-18', total: 575, currency: 'USD', quickbooks_id: '17884', quickbooks_type: 'bill' })
  assert.ok(!detectReceiptAnomalies(rec).some(a => a.kind === 'amount_outlier'))
})

// ── Un seul signalement par doublon ──────────────────────────────────────────
// L'achat du grand livre est le miroir QB du reçu pair : la paire reçu↔reçu est
// déjà jugée. Deux fingerprints pour un seul fait, c'était du bruit — et rejeter
// l'un laissait l'autre ouvert (cas Bell Mobilité du 19 août).

test('le miroir QB d\'un reçu pair ne produit pas une seconde anomalie', () => {
  resetAll()
  insertReceipt({ id: 'wix-upload', company: 'Wix.com', receipt_number: '1252097931', receipt_date: '2026-07-21', total: 43.1, currency: 'USD', quickbooks_id: '17746', quickbooks_type: 'purchase' })
  insertAchat({ type: 'purchase', vendor: 'Wix – USD', date_achat: '2026-07-21', total_cad: 43.1, currency: 'USD', quickbooks_id: '17746' })
  const scraped = insertReceipt({ company: 'Wix.com', receipt_number: '1252097931', receipt_date: '2026-07-22', total: 43.1, currency: 'USD', source: 'scraper:wix' })
  const kinds = detectReceiptAnomalies(scraped).map(a => a.kind)
  assert.deepEqual(kinds, ['duplicate_number'])
})

test('une écriture QB SANS reçu correspondant reste signalée', () => {
  resetAll()
  insertAchat({ type: 'bill', vendor: 'Axxess International Inc.', vendor_invoice_number: '1180634591-01', date_achat: '2026-07-14', total_cad: 103.48, quickbooks_id: '9100' })
  const rec = insertReceipt({ company: 'Axxess', receipt_number: '1180634591-01', receipt_date: '2026-07-15', total: 103.48 })
  assert.ok(detectReceiptAnomalies(rec).some(a => a.kind === 'already_in_qb'))
})

// ── Lien QuickBooks périmé ───────────────────────────────────────────────────
// Cas réel : 5 reçus se disaient publiés sous des Id supprimés depuis dans QB
// (nettoyage de doublons, push refait). Rien ne le signalait.

test('écriture supprimée dans QB → qb_entry_missing, avec le remplacement s\'il existe', async () => {
  resetAll()
  insertReceipt({ id: 'bell', company: 'Bell Mobilité', receipt_date: '2026-08-19', total: 196.83, quickbooks_id: '17887', quickbooks_type: 'vendor_credit' })
  insertAchat({ type: 'bill', vendor: 'Bell Mobilité', date_achat: '2026-08-19', total_cad: 196.83, quickbooks_id: '17888' })
  const out = await verifyPublishedQbLinks({ fetchEntity: async () => { throw new Error('objet introuvable') } })
  assert.equal(out.missing, 1)
  const row = db.prepare(`SELECT * FROM transaction_anomalies WHERE kind='qb_entry_missing'`).get()
  assert.equal(row.severity, 'medium')
  assert.match(row.message, /17888/)

  // L'écriture réapparaît (ou l'appel réussit) → anomalie résolue.
  await verifyPublishedQbLinks({ fetchEntity: async () => ({ Id: '17887' }) })
  assert.equal(db.prepare(`SELECT status FROM transaction_anomalies WHERE kind='qb_entry_missing'`).get().status, 'resolved')
})

test('sans écriture équivalente → severity high ; une panne réseau ne crée rien', async () => {
  resetAll()
  insertReceipt({ company: 'Sage Mentorat', receipt_date: '2026-05-01', total: 68.99, quickbooks_id: '17388', quickbooks_type: 'purchase' })
  await verifyPublishedQbLinks({ fetchEntity: async () => { throw new Error('objet introuvable') } })
  assert.equal(db.prepare(`SELECT severity FROM transaction_anomalies WHERE kind='qb_entry_missing'`).get().severity, 'high')

  resetAll()
  insertReceipt({ company: 'Sage Mentorat', receipt_date: '2026-05-01', total: 68.99, quickbooks_id: '17388', quickbooks_type: 'purchase' })
  const out = await verifyPublishedQbLinks({ fetchEntity: async () => { throw new Error('ECONNRESET') } })
  assert.equal(out.missing, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM transaction_anomalies`).get().c, 0)
})
