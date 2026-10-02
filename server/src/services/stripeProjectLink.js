import db from '../db/database.js'

// Projet d'un paiement Stripe lancé depuis le PDF d'une soumission : les
// boutons « S'abonner » / « Acheter » posent erp_project_id (et
// erp_soumission_id) dans les métadonnées de la session, de l'abonnement et
// de la facture. Demande de Pierre-Alexandre Papillon (2026-09-30).

// Métadonnées d'une facture Stripe : les siennes (paiement unique), puis
// celles de l'abonnement recopiées par Stripe (API ≥ 2024-09 sous parent,
// avant sous subscription_details).
export function invoiceMetadatas(invoice) {
  return [invoice?.metadata, invoice?.parent?.subscription_details?.metadata, invoice?.subscription_details?.metadata]
}

/** Premier projet existant nommé par ces métadonnées, sinon celui de la soumission. */
export function projectIdFromStripeMetadata(...metas) {
  for (const m of metas) {
    const pid = m?.erp_project_id
    if (pid && db.prepare('SELECT 1 FROM projects WHERE id=?').get(pid)) return pid
  }
  for (const m of metas) {
    const sid = m?.erp_soumission_id
    const pid = sid ? db.prepare('SELECT project_id FROM soumissions WHERE id=?').get(sid)?.project_id : null
    if (pid) return pid
  }
  return null
}

/** Rattache la facture ERP au projet de sa soumission — jamais d'écrasement d'un lien posé. */
export function linkFactureToProject(factureId, invoice) {
  const pid = projectIdFromStripeMetadata(...invoiceMetadatas(invoice))
  if (!pid || !factureId) return null
  const { changes } = db.prepare(`
    UPDATE factures SET project_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND (project_id IS NULL OR project_id='')
  `).run(pid, factureId)
  return changes ? pid : null
}

// ── Rattachement automatique d'une facture Stripe à son entreprise et à son
// projet. Demande de Pierre-Alexandre Papillon (2026-10-01). Ne remplit que
// les liens vides et ne tranche que sur un candidat unique : un doute laisse
// le champ vide plutôt que de rattacher au mauvais client.

const norm = s => String(s || '').trim().toLowerCase()

function uniqueId(rows) {
  const ids = [...new Set(rows.map(r => r.id).filter(Boolean))]
  return ids.length === 1 ? ids[0] : null
}

/** Entreprise d'une facture sans client Stripe reconnu : { id, how } ou null. */
export function companyForStripeFacture({ projectId, subscriptionId, email, name }) {
  const fromProject = projectId ? db.prepare('SELECT company_id AS id FROM projects WHERE id=?').get(projectId)?.id : null
  if (fromProject) return { id: fromProject, how: 'projet de la soumission' }
  const fromSub = subscriptionId ? db.prepare('SELECT company_id AS id FROM subscriptions WHERE id=?').get(subscriptionId)?.id : null
  if (fromSub) return { id: fromSub, how: 'abonnement' }
  const e = norm(email)
  if (e) {
    const byContact = uniqueId(db.prepare(`
      SELECT DISTINCT company_id AS id FROM contacts
      WHERE lower(trim(email))=? AND company_id IS NOT NULL AND company_id<>''
    `).all(e))
    if (byContact) return { id: byContact, how: 'courriel du contact' }
    const byCompany = uniqueId(db.prepare('SELECT id FROM companies WHERE lower(trim(email))=?').all(e))
    if (byCompany) return { id: byCompany, how: "courriel de l'entreprise" }
  }
  const n = norm(name)
  if (n) {
    const byName = uniqueId(db.prepare('SELECT id FROM companies WHERE lower(trim(name))=?').all(n))
    if (byName) return { id: byName, how: 'nom du client' }
  }
  return null
}

/** Projet d'une facture dont l'entreprise est connue : { id, how } ou null. */
export function projectForStripeFacture({ factureId, companyId, subscriptionId }) {
  if (subscriptionId) {
    const bySub = uniqueId(db.prepare(`
      SELECT DISTINCT project_id AS id FROM factures
      WHERE subscription_id=? AND id<>? AND project_id IS NOT NULL AND project_id<>''
    `).all(subscriptionId, factureId))
    if (bySub) return { id: bySub, how: "autres factures de l'abonnement" }
  }
  if (companyId) {
    const only = db.prepare('SELECT id FROM projects WHERE company_id=? LIMIT 2').all(companyId)
    if (only.length === 1) return { id: only[0].id, how: "seul projet de l'entreprise" }
  }
  return null
}

/**
 * Rattache la facture ERP d'une facture Stripe à son entreprise puis à son
 * projet, sans jamais écraser un lien posé. Renvoie ce qui a été rattaché
 * (pour le journal de l'automatisation).
 */
export function autoLinkStripeFacture(factureId, invoice) {
  if (!factureId) return {}
  const linked = {}
  const metaProject = linkFactureToProject(factureId, invoice)
  if (metaProject) linked.project = { id: metaProject, how: 'soumission payée' }

  const f = db.prepare('SELECT company_id, project_id, subscription_id, customer_email FROM factures WHERE id=?').get(factureId)
  if (!f) return linked
  let companyId = f.company_id || null
  if (!companyId) {
    const co = companyForStripeFacture({
      projectId: f.project_id,
      subscriptionId: f.subscription_id,
      email: f.customer_email || invoice?.customer_email,
      name: invoice?.customer_name,
    })
    if (co) {
      db.prepare(`
        UPDATE factures SET company_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND (company_id IS NULL OR company_id='')
      `).run(co.id, factureId)
      companyId = co.id
      linked.company = co
    }
  }
  if (!f.project_id && !linked.project) {
    const p = projectForStripeFacture({ factureId, companyId, subscriptionId: f.subscription_id })
    if (p) {
      const { changes } = db.prepare(`
        UPDATE factures SET project_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND (project_id IS NULL OR project_id='')
      `).run(p.id, factureId)
      if (changes) linked.project = p
    }
  }
  return linked
}
