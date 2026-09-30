// Les suggestions très sûres qui n'écrivent rien dans QuickBooks s'appliquent
// seules (décision de Charles, 2026-09-26) : un paiement émis retrouvé au
// relevé, le débit de la paie, un versement de dette. Chacune garde sa trace
// (`auto_accepted`) et s'annule d'un clic. Ce qui publie dans QuickBooks
// attend toujours le geste humain — la liste ci-dessous n'en contient aucune.
import db from '../../db/database.js'
import { acceptProposal } from './apply.js'
import { PUBLISHES_TO_QB } from './model.js'

export const AUTO_ACCEPT_DEFAULTS = {
  auto_accept_kinds: 'payment_clear,paie_debit,debt_payment',
  auto_accept_min_confidence: '0.9',
}

function config() {
  const row = db.prepare("SELECT action_config FROM automations WHERE id='sys_bank_engine'").get()
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  // Vide = coupé : une chaîne vide est un choix.
  const kinds = cfg.auto_accept_kinds != null ? String(cfg.auto_accept_kinds) : AUTO_ACCEPT_DEFAULTS.auto_accept_kinds
  const min = Number(cfg.auto_accept_min_confidence || AUTO_ACCEPT_DEFAULTS.auto_accept_min_confidence)
  return {
    kinds: kinds.split(',').map((k) => k.trim()).filter((k) => k && !PUBLISHES_TO_QB.has(k)),
    min: Number.isFinite(min) ? Math.max(min, 0.5) : 0.9,
  }
}

export async function autoAcceptSafe({ dryRun = false } = {}) {
  const { kinds, min } = config()
  if (!kinds.length) return { accepted: 0, failed: 0 }
  const rows = db.prepare(`
    SELECT id FROM bank_proposals
    WHERE status='proposee' AND last_error IS NULL AND confidence >= ?
      AND kind IN (${kinds.map(() => '?').join(',')})
  `).all(min, ...kinds)
  if (dryRun) return { accepted: 0, would_accept: rows.length, failed: 0 }
  let accepted = 0, failed = 0
  for (const { id } of rows) {
    try { await acceptProposal(id, null, { auto: true }); accepted++ }
    catch (e) { failed++; console.warn('autoAcceptSafe:', id, e.message) }
  }
  if (accepted) console.log(`bankProposals: ${accepted} suggestion(s) sûre(s) appliquée(s) automatiquement`)
  return { accepted, failed }
}
