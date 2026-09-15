// Accès base des propositions. La décision, elle, vit dans model.js (pur) et
// l'action dans apply.js — ici on ne fait qu'écrire ce qui a été décidé.
import db from '../../db/database.js'
import { newRecordId } from '../../utils/recordId.js'
import { reconcilePropositions } from './model.js'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
const json = (v) => (v == null ? null : JSON.stringify(v))

// TOUS les statuts, périmées comprises : le modèle a besoin de les voir pour
// respecter un refus, ignorer une acceptée et RÉANIMER une périmée. Les
// exclure ferait échouer l'insertion en silence (l'empreinte est unique) et la
// proposition ne reviendrait jamais.
export function openProposals({ accountId = null, kinds = null } = {}) {
  const where = ['1=1']
  const args = []
  if (accountId) { where.push('account_id = ?'); args.push(accountId) }
  if (kinds?.length) { where.push(`kind IN (${kinds.map(() => '?').join(',')})`); args.push(...kinds) }
  return db.prepare(`SELECT * FROM bank_proposals WHERE ${where.join(' AND ')}`).all(...args)
}

export function proposalsForTxn(txnId) {
  return db.prepare(`
    SELECT * FROM bank_proposals WHERE bank_txn_id=? AND status IN ('proposee','acceptee')
    ORDER BY created_at
  `).all(txnId).map(decode)
}

export function decode(row) {
  if (!row) return row
  let evidence = []
  let payload = {}
  try { evidence = JSON.parse(row.evidence || '[]') } catch { evidence = [] }
  try { payload = JSON.parse(row.payload || '{}') } catch { payload = {} }
  return { ...row, evidence, payload }
}

// Applique le résultat de `reconcilePropositions` : insertions, mises à jour,
// péremptions, et le compteur de passages non revus.
export function persistReconcile(plan, { seenFingerprints = [], scope = {} } = {}) {
  const ins = db.prepare(`
    INSERT INTO bank_proposals
      (id, kind, bank_txn_id, account_id, target_type, target_id, period_key, amount, currency,
       confidence, evidence, payload, fingerprint, producer, run_id, last_seen_at, runs_unseen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,${NOW},0)
    -- Sans cible : couvre l'empreinte ET l'unicité « une vivante par ligne et
    -- par nature ». Une collision ne doit jamais faire tomber tout le passage.
    ON CONFLICT DO NOTHING
  `)
  const upd = db.prepare(`
    UPDATE bank_proposals
    SET amount=?, currency=?, confidence=?, evidence=?, payload=?, account_id=?,
        run_id=?, last_seen_at=${NOW}, runs_unseen=0, updated_at=${NOW}
    WHERE id=? AND status='proposee'
  `)
  // Réanimation d'une périmée : même mise à jour, et le statut repart à zéro.
  const revive = db.prepare(`
    UPDATE bank_proposals
    SET status='proposee', amount=?, currency=?, confidence=?, evidence=?, payload=?, account_id=?,
        run_id=?, last_seen_at=${NOW}, runs_unseen=0, updated_at=${NOW}
    WHERE id=? AND status='perimee'
  `)
  const touch = db.prepare(`UPDATE bank_proposals SET last_seen_at=${NOW}, runs_unseen=0 WHERE id=?`)
  const expire = db.prepare(`UPDATE bank_proposals SET status='perimee', updated_at=${NOW} WHERE id=? AND status='proposee'`)

  let inserted = 0
  const tx = db.transaction(() => {
    for (const p of plan.inserer) {
      inserted += ins.run(
        newRecordId(), p.kind, p.bank_txn_id, p.account_id || null, p.target_type || null,
        p.target_id || null, p.period_key || null, p.amount ?? null, p.currency || null,
        p.confidence ?? null, json(p.evidence), json(p.payload), p.fingerprint,
        p.producer || null, p.run_id || null
      ).changes
    }
    for (const p of plan.mettreAJour) {
      const stmt = p.revive ? revive : upd
      stmt.run(p.amount ?? null, p.currency || null, p.confidence ?? null, json(p.evidence),
        json(p.payload), p.account_id || null, p.run_id || null, p.id)
    }
    for (const p of plan.inchangees) touch.run(p.id)
    for (const id of plan.perimer) expire.run(id)
    // Les propositions vivantes DU MÊME PÉRIMÈTRE que ce passage n'a pas revues
    // vieillissent. Le périmètre compte : un passage sur le compte A ne doit
    // pas faire vieillir — donc périmer — les propositions du compte B, ni un
    // producteur faire vieillir les natures qu'il ne produit pas.
    const where = ["status='proposee'"]
    const args = []
    if (scope.accountId) { where.push('account_id = ?'); args.push(scope.accountId) }
    if (scope.kinds?.length) { where.push(`kind IN (${scope.kinds.map(() => '?').join(',')})`); args.push(...scope.kinds) }
    if (seenFingerprints.length) {
      where.push(`fingerprint NOT IN (${seenFingerprints.map(() => '?').join(',')})`)
      args.push(...seenFingerprints)
    }
    db.prepare(`UPDATE bank_proposals SET runs_unseen = COALESCE(runs_unseen,0) + 1 WHERE ${where.join(' AND ')}`).run(...args)
  })
  tx()
  return { inserted, updated: plan.mettreAJour.length, unchanged: plan.inchangees.length, expired: plan.perimer.length }
}

// Le passage complet pour un lot de propositions produites.
export function reconcileAndPersist(produced, { accountId = null, kinds = null, staleRuns = 6, runId = null } = {}) {
  const existing = openProposals({ accountId, kinds })
  const plan = reconcilePropositions(existing, produced, { staleRuns, runId })
  const seen = [...plan.inserer, ...plan.mettreAJour, ...plan.inchangees].map((p) => p.fingerprint)
  const res = persistReconcile(plan, { seenFingerprints: seen, scope: { accountId, kinds } })
  return { ...res, ignored: plan.ignorees, produced: produced.length }
}

// Compteurs pour le bandeau de la page.
export function proposalSummary(accountId = null) {
  const rows = accountId
    ? db.prepare("SELECT kind, COUNT(*) n FROM bank_proposals WHERE status='proposee' AND account_id=? GROUP BY kind").all(accountId)
    : db.prepare("SELECT kind, COUNT(*) n FROM bank_proposals WHERE status='proposee' GROUP BY kind").all()
  const by_kind = Object.fromEntries(rows.map((r) => [r.kind, r.n]))
  return { total: rows.reduce((s, r) => s + r.n, 0), by_kind }
}
