// Colonne « Rachat » des abonnements annulés (/abonnements, vue « Annulés »).
// Pose automatiquement la valeur — non / rachat complet / rachat partiel /
// fusion — pour dire si l'annulation est un vrai churn. Demande de
// Pierre-Alexandre Papillon (2026-10-14).
//
// Indices, dans l'ordre (calibrés sur les 69 abonnements classés à la main) :
//   1. Facture hors abonnement du même client, de 90 j avant à 30 j après
//      l'annulation, qui dit « rachat / buy back » sur une ligne, ou dont le
//      montant ≥ max(1 500 $, 12 mois d'abonnement) → rachat. Un abonnement
//      annulé moins de 14 j après son début ne compte pas comme racheté par le
//      montant seul (achat d'équipement en même temps qu'un essai avorté).
//      → partiel si le client garde un autre abonnement actif payant.
//   2. Autre abonnement payant du même client démarré de 15 j avant à 45 j
//      après l'annulation → fusion.
//   3. Sinon → non (vrai churn).
//
// Ne touche jamais une valeur posée à la main (rachat_auto = 0) : seules les
// lignes vides ou déjà posées par cette détection sont (ré)évaluées, ce qui
// permet à une facture de rachat arrivée après coup de corriger un « non ».
import db from '../db/database.js'
import { emitSubscription } from './realtimeEmitters.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'

export const SUBSCRIPTION_RACHAT_AUTOMATION_ID = 'sys_subscription_rachat'

const INVOICE_DAYS_BEFORE = 90
const INVOICE_DAYS_AFTER = 30
const MIN_BUYOUT_CAD = 1500
const MIN_LIFESPAN_DAYS = 14
const FUSION_DAYS_BEFORE = 15
const FUSION_DAYS_AFTER = 45
const BUYOUT_RE = /rachat|buy[\s-]?back|buy[\s-]?out/i

const DAY_MS = 86_400_000
const dayDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / DAY_MS)
const fmt = n => Math.round(n).toLocaleString('fr-CA')

function usdRate() {
  return db.prepare("SELECT rate FROM fx_rates WHERE pair='USDCAD' ORDER BY date DESC LIMIT 1").get()?.rate || 1.38
}

function buyoutInvoice(sub, cancel, rate) {
  const rows = db.prepare(`
    SELECT f.id, f.document_number, f.document_date, f.currency, f.invoice_id,
           f.amount_before_tax_cad AS amount_native,
           (SELECT GROUP_CONCAT(i.description, ' | ') FROM stripe_invoice_items i
             WHERE i.facture_id = f.id OR (f.invoice_id IS NOT NULL AND i.stripe_invoice_id = f.invoice_id)) AS lines
    FROM factures f
    WHERE f.company_id = ?
      AND f.subscription_id IS NULL
      AND f.status IN ('Payé', 'À payer', 'En retard')
      AND f.document_date BETWEEN date(?, '-${INVOICE_DAYS_BEFORE} days') AND date(?, '+${INVOICE_DAYS_AFTER} days')
  `).all(sub.company_id, cancel, cancel)

  const monthlyCad = (sub.currency === 'USD' ? rate : 1) * (Number(sub.amount_monthly) || 0)
  const threshold = Math.max(MIN_BUYOUT_CAD, 12 * monthlyCad)
  const shortLived = sub.start_date && dayDiff(cancel, sub.start_date) < MIN_LIFESPAN_DAYS

  let best = null
  for (const f of rows) {
    const cad = (f.currency === 'USD' ? rate : 1) * (Number(f.amount_native) || 0)
    const keyword = BUYOUT_RE.test(f.lines || '')
    if (!keyword && (shortLived || cad < threshold)) continue
    const c = { ...f, cad, keyword, days: dayDiff(f.document_date, cancel) }
    // Une ligne « rachat » l'emporte ; sinon la facture la plus proche.
    if (!best || (c.keyword && !best.keyword) ||
        (c.keyword === best.keyword && Math.abs(c.days) < Math.abs(best.days))) best = c
  }
  return best
}

function siblings(sub) {
  return db.prepare(`
    SELECT id, status, start_date, amount_monthly FROM subscriptions
    WHERE company_id = ? AND id != ? AND COALESCE(is_test, 0) = 0 AND COALESCE(amount_monthly, 0) > 0
  `).all(sub.company_id, sub.id)
}

// Valeur proposée pour un abonnement annulé : { rachat, reason }.
export function classifySubscriptionRachat(sub, rate = usdRate(), depth = 0) {
  const cancel = String(sub.cancel_date || '').slice(0, 10)
  if (!cancel || !sub.company_id) return { rachat: 'non', reason: 'Aucun indice' }
  const others = siblings(sub)

  const inv = buyoutInvoice(sub, cancel, rate)
  if (inv) {
    const keepsOther = others.some(o => o.status === 'active' && o.start_date && dayDiff(o.start_date, cancel) <= FUSION_DAYS_AFTER)
    const when = inv.days === 0 ? 'le jour même' : inv.days < 0 ? `${-inv.days} j avant` : `${inv.days} j après`
    return {
      rachat: keepsOther ? 'rachat partiel' : 'rachat complet',
      reason: `Facture ${inv.document_number || ''} · ${fmt(inv.cad)} $${inv.keyword ? ' · « rachat »' : ''} · ${when}`
        + (keepsOther ? ' · autre abonnement actif' : ''),
    }
  }

  const start = String(sub.start_date || '').slice(0, 10)
  const next = others
    .filter(o => o.start_date && (!start || o.start_date.slice(0, 10) >= start))
    .map(o => ({ ...o, days: dayDiff(o.start_date, cancel) }))
    .filter(o => o.days >= -FUSION_DAYS_BEFORE && o.days <= FUSION_DAYS_AFTER)
    .sort((a, b) => Math.abs(a.days) - Math.abs(b.days))[0]
  if (next) {
    // Chaîne fusionnée puis rachetée : l'abonnement remplaçant, annulé à son
    // tour pour un rachat, emporte toute la chaîne (classement manuel).
    if (depth < 5 && (next.status === 'canceled' || next.status === 'Annulé')) {
      const full = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(next.id)
      const down = full && full.cancel_date && full.cancel_date.slice(0, 10) >= cancel
        ? classifySubscriptionRachat(full, rate, depth + 1) : null
      if (down?.rachat.startsWith('rachat')) {
        return { rachat: down.rachat, reason: `Abonnement suivant racheté · ${down.reason}` }
      }
    }
    const when = next.days === 0 ? 'le jour même' : next.days < 0 ? `${-next.days} j avant` : `${next.days} j après`
    return { rachat: 'fusion', reason: `Autre abonnement démarré ${when}` }
  }

  // Petit abonnement d'appoint annulé alors que le client garde son
  // abonnement principal actif : regroupé dans celui-ci.
  const kept = others.find(o => o.status === 'active' && o.start_date && o.start_date.slice(0, 10) <= cancel)
  if (kept) return { rachat: 'fusion', reason: `Autre abonnement toujours actif (${fmt(kept.amount_monthly)} $/mois)` }

  return { rachat: 'non', reason: 'Ni facture de rachat ni autre abonnement' }
}

// Passe sur les abonnements annulés non classés à la main. dryRun = rien
// n'est écrit. Renvoie le détail des changements (pour le journal).
export function runSubscriptionRachatDetection({ dryRun = false } = {}) {
  const rate = usdRate()
  const subs = db.prepare(`
    SELECT id, company_id, status, start_date, cancel_date, amount_monthly, currency, rachat, rachat_reason
    FROM subscriptions
    WHERE status IN ('canceled', 'Annulé') AND COALESCE(is_test, 0) = 0
      AND (rachat IS NULL OR COALESCE(rachat_auto, 0) = 1)
  `).all()
  const update = db.prepare('UPDATE subscriptions SET rachat = ?, rachat_auto = 1, rachat_reason = ? WHERE id = ?')
  const changes = []
  for (const s of subs) {
    const { rachat, reason } = classifySubscriptionRachat(s, rate)
    if (rachat === s.rachat && reason === s.rachat_reason) continue
    changes.push({ id: s.id, avant: s.rachat, apres: rachat, raison: reason })
    if (!dryRun) {
      update.run(rachat, reason, s.id)
      emitSubscription('updated', s.id, null)
    }
  }
  const counts = changes.reduce((m, c) => ({ ...m, [c.apres]: (m[c.apres] || 0) + 1 }), {})
  return {
    summary: `${subs.length} examiné(s) · ${changes.length} ${dryRun ? 'à changer' : 'changé(s)'}`
      + (changes.length ? ' — ' + Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') : ''),
    changes,
  }
}

// Passe planifiée : honore l'interrupteur de l'automation, ne journalise que
// les passages qui changent quelque chose (ou échouent).
export function scheduledSubscriptionRachat() {
  if (!isSystemAutomationActive(SUBSCRIPTION_RACHAT_AUTOMATION_ID)) return
  const t0 = Date.now()
  try {
    const out = runSubscriptionRachatDetection()
    if (out.changes.length) {
      logSystemRun(SUBSCRIPTION_RACHAT_AUTOMATION_ID, { status: 'success', result: out, duration_ms: Date.now() - t0 })
    }
  } catch (e) {
    logSystemRun(SUBSCRIPTION_RACHAT_AUTOMATION_ID, { status: 'error', error: e, duration_ms: Date.now() - t0 })
    console.error('Détection rachat abonnements :', e.message)
  }
}
