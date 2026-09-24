// Mémoire des contrôles comptables.
//
// Même modèle que les anomalies de reçus (services/transactionAnomalies.js),
// qui a fait ses preuves : une constatation est identifiée par son EMPREINTE,
// pas par sa ligne. Conséquences voulues :
//   • un contrôle qui repasse ne crée pas de doublon ;
//   • « ce n'en est pas un » est définitif — une écartée n'est jamais recréée ;
//   • une constatation qui n'est plus détectée passe à « réglée », elle ne
//     disparaît pas de l'historique.
import db from '../../db/database.js'
import { newRecordId } from '../../utils/recordId.js'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

const upsertStmt = () => db.prepare(`
  INSERT INTO audit_findings
    (id, check_id, domain, severity, entity_type, entity_id, fingerprint, title, explanation, data)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(fingerprint) DO UPDATE SET
    check_id=excluded.check_id, domain=excluded.domain, severity=excluded.severity,
    entity_type=excluded.entity_type, entity_id=excluded.entity_id,
    title=excluded.title, explanation=excluded.explanation, data=excluded.data,
    status=CASE WHEN audit_findings.status='dismissed' THEN 'dismissed' ELSE 'open' END,
    resolved_at=NULL, last_seen_at=${NOW}, updated_at=${NOW}
`)

/** Enregistre une constatation produite par un contrôle. */
export function upsertFinding(checkId, f) {
  upsertStmt().run(
    newRecordId(), checkId, f.domain || 'banque', f.severity || 'medium',
    f.entity_type || null, f.entity_id || null, f.fingerprint,
    f.title, f.explanation || null, JSON.stringify(f.data || {}),
  )
}

/**
 * Écrit le résultat COMPLET d'un contrôle : ce qui est produit est enregistré,
 * ce qui ne l'est plus est réglé. Le périmètre est borné pour qu'un passage sur
 * un seul compte ne règle pas les constatations des autres.
 */
export function syncCheck(checkId, findings, { scope = null } = {}) {
  const produced = new Set(findings.map((f) => f.fingerprint))
  const tx = db.transaction(() => {
    for (const f of findings) upsertFinding(checkId, f)
    const open = db.prepare(`
      SELECT id, fingerprint FROM audit_findings
      WHERE check_id=? AND status='open'
    `).all(checkId).filter((r) => !produced.has(r.fingerprint)
      && (!scope || r.fingerprint.startsWith(scope)))
    for (const row of open) {
      db.prepare(`UPDATE audit_findings SET status='resolved', resolved_at=${NOW}, updated_at=${NOW} WHERE id=?`).run(row.id)
    }
    return { open: findings.length, resolved: open.length }
  })
  return tx()
}

export function listFindings({ status = 'open', domain = null, checkId = null, limit = 200 } = {}) {
  const where = ['1=1']
  const args = []
  if (status && status !== 'all') { where.push('status=?'); args.push(status) }
  if (domain) { where.push('domain=?'); args.push(domain) }
  if (checkId) { where.push('check_id=?'); args.push(checkId) }
  return db.prepare(`
    SELECT * FROM audit_findings WHERE ${where.join(' AND ')}
    ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
             last_seen_at DESC
    LIMIT ?
  `).all(...args, limit).map(serialize)
}

export function findingsSummary() {
  const rows = db.prepare(`
    SELECT severity, COUNT(*) AS n FROM audit_findings WHERE status='open' GROUP BY severity
  `).all()
  const out = { high: 0, medium: 0, low: 0, total: 0 }
  for (const r of rows) { out[r.severity] = r.n; out.total += r.n }
  out.last_run_at = db.prepare(`SELECT MAX(last_seen_at) AS d FROM audit_findings`).get()?.d || null
  return out
}

export function dismissFinding(id, userId, reason = null) {
  const info = db.prepare(`
    UPDATE audit_findings SET status='dismissed', dismissed_by=?, dismissed_reason=?,
      dismissed_at=${NOW}, updated_at=${NOW}
    WHERE id=? AND status!='dismissed'
  `).run(userId || null, reason, id)
  if (!info.changes) throw new Error('Constatation introuvable')
  return getFinding(id)
}

export function reopenFinding(id) {
  const info = db.prepare(`
    UPDATE audit_findings SET status='open', dismissed_by=NULL, dismissed_reason=NULL,
      dismissed_at=NULL, resolved_at=NULL, updated_at=${NOW}
    WHERE id=?
  `).run(id)
  if (!info.changes) throw new Error('Constatation introuvable')
  return getFinding(id)
}

export function getFinding(id) {
  const row = db.prepare(`SELECT * FROM audit_findings WHERE id=?`).get(id)
  return row ? serialize(row) : null
}

function serialize(row) {
  let data = {}
  try { data = JSON.parse(row.data || '{}') } catch {}
  return { ...row, data }
}
