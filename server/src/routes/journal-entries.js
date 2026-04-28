import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { qbGet, qbPost, getAccessToken } from '../connectors/quickbooks.js'
import db from '../db/database.js'

const router = Router()

function qbBaseUrl(_realmId) {
  const host = process.env.QB_SANDBOX === 'true'
    ? 'https://app.sandbox.qbo.intuit.com'
    : 'https://app.qbo.intuit.com'
  return `${host}/app/journal?txnId=`
}

function serializeEntry(entry) {
  const lines = Array.isArray(entry.Line) ? entry.Line : []
  return {
    id: entry.Id,
    doc_number: entry.DocNumber || null,
    txn_date: entry.TxnDate || null,
    memo: entry.PrivateNote || null,
    total: entry.TotalAmt ?? null,
    currency: entry.CurrencyRef?.value || null,
    created_at: entry.MetaData?.CreateTime || null,
    updated_at: entry.MetaData?.LastUpdatedTime || null,
    adjustment: !!entry.Adjustment,
    lines: lines.map(l => {
      const d = l.JournalEntryLineDetail || {}
      return {
        line_num: l.LineNum ?? null,
        description: l.Description || null,
        amount: l.Amount ?? 0,
        posting_type: d.PostingType || null,
        account_id: d.AccountRef?.value || null,
        account_name: d.AccountRef?.name || null,
        entity_type: d.Entity?.Type || null,
        entity_id: d.Entity?.EntityRef?.value || null,
        entity_name: d.Entity?.EntityRef?.name || null,
        class_id: d.ClassRef?.value || null,
        class_name: d.ClassRef?.name || null,
      }
    }),
  }
}

// GET /api/journal-entries/pending-operations?from=ISO&to=ISO
// Renvoie les opérations candidates à inclure dans une écriture de journal,
// sur une période donnée:
//   - serials: transitions de statut (avec règle comptable et montant calculé)
//   - shipped_items: order_items liés à un envoi sans numéro de série
//   - stock_movements: mouvements d'inventaire hors 'Fabrication'
router.get('/pending-operations', requireAuth, (req, res) => {
  try {
    const { from, to } = req.query
    if (!from || !to) {
      return res.status(400).json({ error: 'Paramètres `from` et `to` requis (ISO date)' })
    }

    // --- 1. Transitions de numéros de série ---
    const rules = db.prepare(`SELECT * FROM serial_accounting_rules WHERE active = 1`).all()
    const ruleByTransition = new Map()
    for (const r of rules) {
      const key = `${r.previous_status || ''}|${r.new_status || ''}`
      ruleByTransition.set(key, r)
    }
    const fallbackByNew = new Map()
    for (const r of rules) {
      if (r.previous_status === null || r.previous_status === '') {
        fallbackByNew.set(r.new_status, r)
      }
    }

    const changes = db.prepare(`
      SELECT
        sc.id, sc.serial_id, sc.previous_status, sc.new_status, sc.changed_at,
        sn.manufacture_value, sn.product_id, sn.serial,
        p.unit_cost AS product_unit_cost, p.name_fr AS product_name
      FROM serial_state_changes sc
      LEFT JOIN serial_numbers sn ON sn.id = sc.serial_id
      LEFT JOIN products p ON p.id = sn.product_id
      WHERE sc.changed_at >= ? AND sc.changed_at <= ?
      ORDER BY sc.changed_at ASC
    `).all(from, to)

    const transitionsMap = new Map()
    for (const c of changes) {
      const key = `${c.previous_status || ''}|${c.new_status || ''}`
      if (!transitionsMap.has(key)) {
        const rule = ruleByTransition.get(key) || fallbackByNew.get(c.new_status) || null
        transitionsMap.set(key, {
          previous_status: c.previous_status,
          new_status: c.new_status,
          count: 0,
          total_amount: 0,
          missing_valuation_count: 0,
          has_rule: !!rule,
          rule: rule ? {
            id: rule.id,
            skip_accounting: !!rule.skip_accounting,
            debit_account_id: rule.debit_account_id,
            debit_account_name: rule.debit_account_name,
            credit_account_id: rule.credit_account_id,
            credit_account_name: rule.credit_account_name,
            valuation_source: rule.valuation_source,
            fixed_amount: rule.fixed_amount,
            memo_template: rule.memo_template,
          } : null,
          samples: [],
        })
      }
      const bucket = transitionsMap.get(key)
      bucket.count++

      let amount = 0
      const rule = bucket.rule
      if (rule && !rule.skip_accounting) {
        if (rule.valuation_source === 'fixed_amount') {
          amount = Number(rule.fixed_amount) || 0
        } else if (rule.valuation_source === 'product_cost') {
          amount = Number(c.product_unit_cost) || 0
        } else {
          amount = Number(c.manufacture_value) || 0
        }
        if (!(amount > 0)) bucket.missing_valuation_count++
      }
      bucket.total_amount += amount
      if (bucket.samples.length < 3) {
        bucket.samples.push({ serial: c.serial, product: c.product_name, amount })
      }
    }
    const serials_transitions = Array.from(transitionsMap.values())
      .sort((a, b) => b.count - a.count)

    // --- 2. Pièces envoyées sans numéro de série ---
    // Lien via shipments.items_expedies (JSON array d'airtable_ids d'order_items)
    // Un order_item "non sérialisé" = produit lié dont besoin_d_un_numero_de_serie n'est pas vrai
    const shipped = db.prepare(`
      SELECT DISTINCT
        oi.id, oi.product_id, oi.qty, oi.shipped_unit_cost, oi.unit_cost,
        oi.item_type,
        sh.id AS shipment_id, sh.shipped_at,
        p.name_fr AS product_name, p.sku
      FROM shipments sh, json_each(sh.items_expedies) je
      INNER JOIN order_items oi ON oi.airtable_id = je.value
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE sh.items_expedies IS NOT NULL AND sh.items_expedies != ''
        AND sh.shipped_at IS NOT NULL
        AND sh.shipped_at >= ? AND sh.shipped_at <= ?
        AND (p.besoin_d_un_numero_de_serie IS NULL OR p.besoin_d_un_numero_de_serie != '1.0')
      ORDER BY sh.shipped_at ASC
    `).all(from, to)

    let shippedTotal = 0
    let shippedReplacementTotal = 0
    let shippedSaleTotal = 0
    let shippedReplacementCount = 0
    let shippedSaleCount = 0
    const shippedItems = shipped.map(r => {
      const unitCost = Number(r.shipped_unit_cost ?? r.unit_cost) || 0
      const qty = Number(r.qty) || 0
      const value = unitCost * qty
      const isReplacement = r.item_type === 'Remplacement'
      shippedTotal += value
      if (isReplacement) {
        shippedReplacementTotal += value
        shippedReplacementCount++
      } else {
        shippedSaleTotal += value
        shippedSaleCount++
      }
      return {
        id: r.id,
        product_id: r.product_id,
        product_name: r.product_name,
        sku: r.sku,
        qty,
        unit_cost: unitCost,
        total: value,
        item_type: r.item_type,
        is_replacement: isReplacement,
        shipment_id: r.shipment_id,
        shipped_at: r.shipped_at,
      }
    })

    // --- 3. Mouvements d'inventaire (hors Fabrication) ---
    const movements = db.prepare(`
      SELECT
        sm.id, sm.product_id, sm.type, sm.qty, sm.reason,
        sm.unit_cost, sm.movement_value, sm.created_at,
        p.name_fr AS product_name, p.sku
      FROM stock_movements sm
      LEFT JOIN products p ON p.id = sm.product_id
      WHERE sm.created_at >= ? AND sm.created_at <= ?
        AND (sm.reason IS NULL OR sm.reason != 'Fabrication')
      ORDER BY sm.created_at ASC
    `).all(from, to)

    const byReasonMap = new Map()
    for (const m of movements) {
      const unit = Number(m.unit_cost) || 0
      const qty = Number(m.qty) || 0
      const value = m.movement_value != null ? Number(m.movement_value) : unit * qty
      const key = `${m.type}|${m.reason || ''}`
      if (!byReasonMap.has(key)) {
        byReasonMap.set(key, {
          type: m.type,
          reason: m.reason,
          count: 0,
          total_qty: 0,
          total_amount: 0,
          samples: [],
        })
      }
      const bucket = byReasonMap.get(key)
      bucket.count++
      bucket.total_qty += qty
      bucket.total_amount += value
      if (bucket.samples.length < 3) {
        bucket.samples.push({
          product: m.product_name,
          sku: m.sku,
          qty,
          amount: value,
          created_at: m.created_at,
        })
      }
    }
    const stock_movements_groups = Array.from(byReasonMap.values())
      .sort((a, b) => Math.abs(b.total_amount) - Math.abs(a.total_amount))

    // --- 4. Solde ERP des pièces (hors produits sérialisés et hors obsolètes) ---
    // Sert à rapprocher le solde comptable « Stock de Pièces » avec la réalité
    // de l'inventaire ERP et à générer une écriture d'ajustement si besoin.
    const erpParts = db.prepare(`
      SELECT
        COUNT(*) AS product_count,
        SUM(COALESCE(stock_qty, 0) * COALESCE(unit_cost, 0)) AS total_value
      FROM products
      WHERE (besoin_d_un_numero_de_serie IS NULL OR besoin_d_un_numero_de_serie != '1.0')
        AND (type IS NULL OR type NOT LIKE '%OBSOL%')
        AND deleted_at IS NULL
    `).get()

    // --- 5. Solde ERP des produits finis (sérials disponibles pour vente) ---
    // Somme des manufacture_value des numéros de série en statut
    // « Disponible - Vente ». Sert à rapprocher le compte comptable
    // « Stock de Produits finis ».
    const erpFinished = db.prepare(`
      SELECT
        COUNT(*) AS serial_count,
        SUM(COALESCE(manufacture_value, 0)) AS total_value
      FROM serial_numbers
      WHERE status = 'Disponible - Vente'
        AND deleted_at IS NULL
    `).get()

    // --- 6. Solde ERP des produits finis reconditionnés (sérials dispo location) ---
    // Somme des manufacture_value des numéros de série en statut
    // « Disponible - Location ». Sert à rapprocher le compte comptable
    // « Stock de Produits finis reconditionnés ».
    const erpRefurbished = db.prepare(`
      SELECT
        COUNT(*) AS serial_count,
        SUM(COALESCE(manufacture_value, 0)) AS total_value
      FROM serial_numbers
      WHERE status = 'Disponible - Location'
        AND deleted_at IS NULL
    `).get()

    // --- 7. Solde ERP des équipements en transit ---
    // Somme des manufacture_value des numéros de série en statut
    // « En retour », « À analyser » ou « À reconditionner ». Sert à rapprocher
    // le compte comptable « Stock d'équip. en transit ».
    const erpInTransit = db.prepare(`
      SELECT
        COUNT(*) AS serial_count,
        SUM(COALESCE(manufacture_value, 0)) AS total_value
      FROM serial_numbers
      WHERE status IN ('En retour', 'À analyser', 'À reconditionner')
        AND deleted_at IS NULL
    `).get()

    // --- 8. Solde ERP des équipements prêtés aux abonnés ---
    // Somme des manufacture_value des numéros de série en statut
    // « Opérationnel - Loué ». Sert à rapprocher le compte comptable
    // « Équipements prêtés aux abonnés ».
    const erpLeased = db.prepare(`
      SELECT
        COUNT(*) AS serial_count,
        SUM(COALESCE(manufacture_value, 0)) AS total_value
      FROM serial_numbers
      WHERE status = 'Opérationnel - Loué'
        AND deleted_at IS NULL
    `).get()

    res.json({
      from, to,
      serials: {
        total_changes: changes.length,
        transitions: serials_transitions,
      },
      shipped_items: {
        count: shippedItems.length,
        total_amount: shippedTotal,
        replacement: { count: shippedReplacementCount, total_amount: shippedReplacementTotal },
        sale: { count: shippedSaleCount, total_amount: shippedSaleTotal },
        items: shippedItems,
      },
      stock_movements: {
        count: movements.length,
        groups: stock_movements_groups,
      },
      erp_parts_balance: {
        product_count: erpParts?.product_count || 0,
        total_value: Number(erpParts?.total_value) || 0,
      },
      erp_finished_goods_balance: {
        serial_count: erpFinished?.serial_count || 0,
        total_value: Number(erpFinished?.total_value) || 0,
      },
      erp_refurbished_goods_balance: {
        serial_count: erpRefurbished?.serial_count || 0,
        total_value: Number(erpRefurbished?.total_value) || 0,
      },
      erp_in_transit_balance: {
        serial_count: erpInTransit?.serial_count || 0,
        total_value: Number(erpInTransit?.total_value) || 0,
      },
      erp_leased_equipment_balance: {
        serial_count: erpLeased?.serial_count || 0,
        total_value: Number(erpLeased?.total_value) || 0,
      },
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/journal-entries
router.get('/', requireAuth, async (req, res) => {
  try {
    const { realmId } = await getAccessToken()
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000)
    const q = new URLSearchParams({
      query: `SELECT * FROM JournalEntry ORDERBY TxnDate DESC MAXRESULTS ${limit}`,
    })
    const data = await qbGet(`/query?${q}`)
    const entries = (data.QueryResponse?.JournalEntry || []).map(serializeEntry)
    const base = qbBaseUrl(realmId)
    for (const e of entries) e.qb_url = `${base}${e.id}`
    res.json({ data: entries, realm_id: realmId })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// GET /api/journal-entries/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { realmId } = await getAccessToken()
    const data = await qbGet(`/journalentry/${req.params.id}`)
    const entry = data.JournalEntry
    if (!entry) return res.status(404).json({ error: 'Écriture introuvable' })
    const serialized = serializeEntry(entry)
    serialized.qb_url = `${qbBaseUrl(realmId)}${serialized.id}`
    res.json(serialized)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// POST /api/journal-entries
// body: { txn_date, doc_number?, memo?, currency?, lines: [{posting_type, amount, account_id, description?, entity_type?, entity_id?, class_id?}] }
router.post('/', requireAuth, async (req, res) => {
  try {
    const { txn_date, doc_number, memo, currency, lines } = req.body || {}
    if (!Array.isArray(lines) || lines.length < 2) {
      return res.status(400).json({ error: 'Au moins deux lignes requises (débit et crédit)' })
    }

    let totalDebit = 0
    let totalCredit = 0
    const qbLines = lines.map((line, idx) => {
      const amount = Number(line.amount)
      if (!(amount > 0)) throw new Error(`Ligne ${idx + 1}: montant invalide`)
      if (!line.account_id) throw new Error(`Ligne ${idx + 1}: compte requis`)
      const posting = line.posting_type === 'Credit' ? 'Credit' : 'Debit'
      if (posting === 'Debit') totalDebit += amount
      else totalCredit += amount

      const detail = {
        PostingType: posting,
        AccountRef: { value: String(line.account_id) },
      }
      if (line.entity_id && line.entity_type) {
        detail.Entity = {
          Type: line.entity_type,
          EntityRef: { value: String(line.entity_id) },
        }
      }
      if (line.class_id) detail.ClassRef = { value: String(line.class_id) }

      return {
        Amount: Math.round(amount * 100) / 100,
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: detail,
        Description: line.description || undefined,
      }
    })

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return res.status(400).json({ error: `Débits (${totalDebit.toFixed(2)}) et crédits (${totalCredit.toFixed(2)}) doivent être égaux` })
    }

    const payload = { Line: qbLines }
    if (txn_date) payload.TxnDate = txn_date
    if (doc_number) payload.DocNumber = doc_number
    if (memo) payload.PrivateNote = memo
    if (currency) payload.CurrencyRef = { value: currency }

    const result = await qbPost('/journalentry', payload)
    const { realmId } = await getAccessToken()
    const serialized = serializeEntry(result.JournalEntry)
    serialized.qb_url = `${qbBaseUrl(realmId)}${serialized.id}`
    res.status(201).json(serialized)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

export default router
