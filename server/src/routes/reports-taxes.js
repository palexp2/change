import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { splitQcTax, TPS_RATE, TVQ_RATE } from '../services/taxes.js'

const router = Router()
router.use(requireAuth)

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100 }

// Devises traitées comme canadiennes (taxes récupérables / collectées au pays).
function isCad(currency) {
  const c = (currency || 'CAD').toUpperCase()
  return c === 'CAD'
}

// Statuts de facture exclus du rapport de taxes (brouillons, annulations) — ne
// représentent pas une fourniture réalisée.
const FACTURE_EXCLUDE = /annul|void|cancel|brouillon|draft|abandon/i

// GET /api/reports/tax-remittance?start=YYYY-MM-DD&end=YYYY-MM-DD
//
// Rapport de remise TPS/TVQ pour une période : taxes PERÇUES sur les ventes
// (factures) moins les CTI/RTI = taxes PAYÉES sur les achats (reçus de
// l'Extraction de données + achats fournisseurs). Donne le net à remettre.
//
// Tout est calculé à la volée (aucune écriture en DB). Les montants de taxe
// agrégés (factures, achats) sont ventilés TPS/TVQ via `splitQcTax`.
router.get('/tax-remittance', (req, res) => {
  const start = String(req.query.start || '').slice(0, 10)
  const end = String(req.query.end || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return res.status(400).json({ error: 'Paramètres start et end requis au format YYYY-MM-DD' })
  }
  if (start > end) {
    return res.status(400).json({ error: 'La date de début doit précéder la date de fin' })
  }

  try {
    // ── 1. Taxes perçues sur les ventes (factures) ─────────────────────────────
    const factures = db.prepare(`
      SELECT f.id, f.document_number, f.document_date, f.currency, f.status,
             f.amount_before_tax_cad AS base, f.total_amount,
             f.company_id, c.name AS company_name
      FROM factures f
      LEFT JOIN companies c ON c.id = f.company_id
      WHERE f.document_date >= ? AND f.document_date <= ?
      ORDER BY f.document_date ASC
    `).all(start, end)

    const collected = { tps: 0, tvq: 0, other: 0, taxableBase: 0, count: 0 }
    const collectedExcluded = { count: 0, total: 0 }
    const collectedForeign = { count: 0, base: 0 }
    const factureLines = []
    for (const f of factures) {
      if (f.status && FACTURE_EXCLUDE.test(f.status)) {
        collectedExcluded.count++
        collectedExcluded.total += round2((Number(f.total_amount) || 0) - (Number(f.base) || 0))
        continue
      }
      if (!isCad(f.currency)) {
        // Vente en devise étrangère = export détaxé : aucune taxe à percevoir.
        collectedForeign.count++
        collectedForeign.base += round2(Number(f.base) || 0)
        factureLines.push({
          id: f.id, document_number: f.document_number, document_date: f.document_date,
          company_id: f.company_id, company_name: f.company_name, currency: f.currency,
          base: round2(f.base), tps: 0, tvq: 0, other: 0, category: 'export', status: f.status,
        })
        continue
      }
      const taxTotal = round2((Number(f.total_amount) || 0) - (Number(f.base) || 0))
      const split = splitQcTax({ base: f.base, taxTotal })
      collected.tps += split.tps
      collected.tvq += split.tvq
      collected.other += split.other
      collected.taxableBase += round2(Number(f.base) || 0)
      collected.count++
      factureLines.push({
        id: f.id, document_number: f.document_number, document_date: f.document_date,
        company_id: f.company_id, company_name: f.company_name, currency: f.currency,
        base: round2(f.base), tps: split.tps, tvq: split.tvq, other: split.other,
        category: split.category, status: f.status,
      })
    }

    // ── 2. CTI/RTI — taxes payées sur les reçus (Extraction de données) ─────────
    const receipts = db.prepare(`
      SELECT id, receipt_date, company, currency, subtotal, tps, tvq, other_taxes, total
      FROM sale_receipts
      WHERE deleted_at IS NULL AND status = 'done'
        AND receipt_date >= ? AND receipt_date <= ?
      ORDER BY receipt_date ASC
    `).all(start, end)

    const itcReceipts = { tps: 0, tvq: 0, other: 0, base: 0, count: 0 }
    const receiptsForeign = { count: 0 }
    const receiptLines = []
    for (const r of receipts) {
      if (!isCad(r.currency)) { receiptsForeign.count++; continue }
      const tps = round2(r.tps)
      const tvq = round2(r.tvq)
      const other = round2(r.other_taxes)
      itcReceipts.tps += tps
      itcReceipts.tvq += tvq
      itcReceipts.other += other
      itcReceipts.base += round2(r.subtotal)
      itcReceipts.count++
      receiptLines.push({
        id: r.id, date: r.receipt_date, vendor: r.company, currency: r.currency,
        base: round2(r.subtotal), tps, tvq, other,
      })
    }

    // ── 3. CTI/RTI — taxes payées sur les achats fournisseurs ──────────────────
    const achats = db.prepare(`
      SELECT id, date_achat, vendor, currency, amount_cad, tax_cad, total_cad, type, status
      FROM achats_fournisseurs
      WHERE date_achat >= ? AND date_achat <= ?
      ORDER BY date_achat ASC
    `).all(start, end)

    const itcAchats = { tps: 0, tvq: 0, other: 0, base: 0, count: 0 }
    const achatLines = []
    for (const a of achats) {
      // amount_cad / tax_cad sont déjà normalisés en CAD (peu importe la devise source).
      const split = splitQcTax({ base: a.amount_cad, taxTotal: a.tax_cad })
      itcAchats.tps += split.tps
      itcAchats.tvq += split.tvq
      itcAchats.other += split.other
      itcAchats.base += round2(Number(a.amount_cad) || 0)
      itcAchats.count++
      achatLines.push({
        id: a.id, date: a.date_achat, vendor: a.vendor, currency: a.currency, type: a.type,
        base: round2(a.amount_cad), tps: split.tps, tvq: split.tvq, other: split.other,
        category: split.category,
      })
    }

    // ── 4. Totaux et net à remettre ────────────────────────────────────────────
    for (const o of [collected, itcReceipts, itcAchats]) {
      o.tps = round2(o.tps); o.tvq = round2(o.tvq)
      o.other = round2(o.other); o.base = round2(o.base ?? o.taxableBase)
    }
    collected.taxableBase = round2(collected.taxableBase)
    collected.total = round2(collected.tps + collected.tvq + collected.other)

    const itcTps = round2(itcReceipts.tps + itcAchats.tps)
    const itcTvq = round2(itcReceipts.tvq + itcAchats.tvq)
    const itcOther = round2(itcReceipts.other + itcAchats.other)
    const itcTotal = round2(itcTps + itcTvq + itcOther)

    const net = {
      tps: round2(collected.tps - itcTps),
      tvq: round2(collected.tvq - itcTvq),
      total: round2(collected.total - itcTotal),
    }

    res.json({
      period: { start, end },
      rates: { tps: TPS_RATE, tvq: TVQ_RATE },
      collected: {
        ...collected,
        excluded: collectedExcluded,
        foreign: { count: collectedForeign.count, base: round2(collectedForeign.base) },
      },
      inputTaxCredits: {
        tps: itcTps, tvq: itcTvq, other: itcOther, total: itcTotal,
        sources: {
          receipts: { ...itcReceipts, foreignCount: receiptsForeign.count },
          achats: itcAchats,
        },
      },
      net,
      // Indique au comptable que les deux sources de CTI/RTI ne sont pas dédupliquées :
      // un même achat saisi à la fois dans l'Extraction et en achat fournisseur serait
      // compté deux fois. À réconcilier avant de produire la déclaration officielle.
      warnings: {
        itcSourcesNotDeduplicated: itcReceipts.count > 0 && itcAchats.count > 0,
        collectedOtherTax: collected.other > 0,
      },
      details: {
        factures: factureLines,
        receipts: receiptLines,
        achats: achatLines,
      },
    })
  } catch (e) {
    console.error('[reports-taxes] tax-remittance a échoué:', e)
    res.status(500).json({ error: e?.message || 'Erreur interne' })
  }
})

export default router
