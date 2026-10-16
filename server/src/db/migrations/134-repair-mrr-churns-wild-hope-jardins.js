/**
 * 134 — Répare deux abonnements annulés touchés par la 133.
 *
 * Demandé par Pierre-Alexandre Papillon, 2026-10-14. La 133 avait retiré
 * l'upgrade de Wild Hope Farm comme « sur abonnement déjà annulé » : lecture
 * faussée par le churn daté à minuit (cancel_date), avant le mouvement du même
 * jour. C'était une vraie hausse (fin de la gratuité, 1re facture payée 40 USD).
 * - Wild Hope Farm : upgrade réinséré (création → montant retiré au churn) ;
 * - Les Jardins du Coin : churn = −(montant de la création) ;
 * - les deux churns passent après leurs mouvements (même règle que recordEvent).
 */
export const id = '134-repair-mrr-churns-wild-hope-jardins'
export const description = 'Rétablit la hausse de Wild Hope Farm et rééquilibre deux annulations'

const WILD_HOPE = 'eaab504c-3bac-43d0-b3b6-78e7abbbfadf'
const JARDINS = '2f7702c3-3b84-4af1-bc7e-b26a14c265fc'
const UPGRADE_ID = 'borHgK4cqxxg9zWPr'
const UPGRADE_DATE = '2026-09-23T14:04:53.000Z'

function churnOf(db, subId, day) {
  const rows = db.prepare(`SELECT * FROM subscription_events
    WHERE subscription_id = ? AND category = 'churn' AND substr(event_date, 1, 10) = ?`).all(subId, day)
  if (rows.length !== 1) throw new Error(`134 : ${rows.length} churn(s) pour ${subId} le ${day}, 1 attendu`)
  return rows[0]
}

function creationOf(db, subId) {
  const row = db.prepare(`SELECT * FROM subscription_events
    WHERE subscription_id = ? AND category = 'creation' ORDER BY event_date LIMIT 1`).get(subId)
  if (!row || row.new_amount_cad == null) throw new Error(`134 : création introuvable pour ${subId}`)
  return row
}

// Churn = −(dernier MRR suivi), daté au plus tôt 1 s après le mouvement précédent.
function rebalanceChurn(db, churn) {
  const tracked = db.prepare(`SELECT new_amount_cad FROM subscription_events
    WHERE subscription_id = ? AND id != ? AND category IN ('creation','upgrade','downgrade','reactivation')
      AND new_amount_cad IS NOT NULL
    ORDER BY event_date DESC, created_at DESC LIMIT 1`).pluck().get(churn.subscription_id, churn.id)
  const last = db.prepare('SELECT MAX(event_date) FROM subscription_events WHERE subscription_id = ? AND id != ?')
    .pluck().get(churn.subscription_id, churn.id)
  let date = churn.event_date
  if (last && !(Date.parse(date) > Date.parse(last))) date = new Date(Date.parse(last) + 1000).toISOString()
  db.prepare('UPDATE subscription_events SET previous_amount_cad = ?, amount_cad_delta = ?, event_date = ? WHERE id = ?')
    .run(tracked, -tracked, date, churn.id)
}

export function up(db) {
  const wildChurn = churnOf(db, WILD_HOPE, '2026-09-23')
  const jardinsChurn = churnOf(db, JARDINS, '2026-08-11')

  const hasUpgrade = db.prepare(`SELECT 1 FROM subscription_events
    WHERE subscription_id = ? AND category = 'upgrade' AND substr(event_date, 1, 10) = '2026-09-23'`).get(WILD_HOPE)
  if (!hasUpgrade) {
    const prev = creationOf(db, WILD_HOPE).new_amount_cad
    const next = wildChurn.previous_amount_cad
    if (next == null) throw new Error('134 : montant du churn de Wild Hope Farm absent')
    db.prepare(`INSERT INTO subscription_events (
        id, subscription_id, company_id, event_date, event_type, category,
        amount_cad_delta, previous_amount_cad, new_amount_cad, currency, created_at
      ) VALUES (?,?,?,?,'upgrade','upgrade',?,?,?,'USD',?)`)
      .run(UPGRADE_ID, WILD_HOPE, wildChurn.company_id, UPGRADE_DATE,
        Math.round((next - prev) * 100) / 100, prev, next, UPGRADE_DATE)
  }

  creationOf(db, JARDINS)
  rebalanceChurn(db, wildChurn)
  rebalanceChurn(db, jardinsChurn)
}
