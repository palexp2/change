import { useState, useEffect, useCallback } from 'react'
import { Plus, ExternalLink, Trash2, RefreshCw, BookOpen, AlertCircle, Wand2, ChevronDown, ChevronRight } from 'lucide-react'
import { api } from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'

function fmtCad(n, currency = 'CAD') {
  if (n == null) return '—'
  try {
    return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: currency || 'CAD' }).format(n)
  } catch {
    return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
  }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function emptyLine(posting = 'Debit') {
  return { posting_type: posting, amount: '', account_id: '', description: '' }
}

function firstOfMonthISO() {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10)
}

function CreateJournalEntryForm({ accounts, onSaved, onCancel }) {
  const [txnDate, setTxnDate] = useState(todayISO())
  const [docNumber, setDocNumber] = useState('')
  const [memo, setMemo] = useState('')
  const [lines, setLines] = useState([emptyLine('Debit'), emptyLine('Credit')])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Prépopulation
  const [prepOpen, setPrepOpen] = useState(false)
  const [prepFrom, setPrepFrom] = useState(firstOfMonthISO())
  const [prepTo, setPrepTo] = useState(todayISO())
  const [prepLoading, setPrepLoading] = useState(false)
  const [prepError, setPrepError] = useState('')
  const [prepData, setPrepData] = useState(null)
  const [includeSerials, setIncludeSerials] = useState(true)
  const [includeShipped, setIncludeShipped] = useState(true)
  const [includeMovements, setIncludeMovements] = useState(true)
  const [includeAdjustmentParts, setIncludeAdjustmentParts] = useState(true)
  const [includeAdjustmentFinished, setIncludeAdjustmentFinished] = useState(true)
  const [includeAdjustmentRefurbished, setIncludeAdjustmentRefurbished] = useState(true)
  const [includeAdjustmentInTransit, setIncludeAdjustmentInTransit] = useState(true)
  const [includeAdjustmentLeased, setIncludeAdjustmentLeased] = useState(true)
  // Comptes hardcodés par nom (résolus via accounts list)
  const SHIPPED_REPL_DEBIT = 'Envoi de pièces de remplacement'
  const SHIPPED_SALE_DEBIT = 'Coût des produits vendus'
  const STOCK_ACCOUNT = 'Stock de Pièces'
  const FINISHED_GOODS_ACCOUNT = 'Stock de Produits finis'
  const REFURBISHED_GOODS_ACCOUNT = 'Stock de Produits finis reconditionnés'
  const IN_TRANSIT_ACCOUNT = 'Stock d\'équip. en transit'
  const LEASED_EQUIPMENT_ACCOUNT = 'Équipements prêtés aux abonnés'
  const ADJUSTMENT_OFFSET_ACCOUNT = 'Ajustements (Coûts des produits vendus)'
  // Mapping reason → { account, direction } pour les mouvements d'inventaire
  // direction 'out' (stock diminue) → Débit compte, Crédit Stock
  // direction 'in'  (stock augmente) → Débit Stock, Crédit compte
  const MOVEMENT_MAP = {
    'Ajustement (augmentation)': { account: 'Ajustements (Coûts des produits vendus)', direction: 'in' },
    'Ajustement (diminution)':   { account: 'Ajustements (Coûts des produits vendus)', direction: 'out' },
    'Utilisation de pièces usagés': { account: 'Récupération de pièces', direction: 'out' },
    'Utilisation pour le reconditionnement': { account: 'Utilisation de pièces pour le reconditionnement', direction: 'out' },
    'Prélèvement pour R&D': { account: 'Fournitures R&D', direction: 'out' },
  }
  const findAccountId = (name) => accounts.find(a => a.Name === name)?.Id || ''
  const findAccount = (name) => accounts.find(a => a.Name === name) || null

  // Impact net des opérations sélectionnées sur un compte de stock donné.
  // Convention : positif = augmente le solde QB (débit - crédit).
  // On compare par id de compte QB — les règles de sérials stockent le nom
  // pleinement qualifié (ex. « Stocks:Stock de Pièces ») qui ne matche pas
  // le `Name` court du compte.
  function computeAccountImpact(accountName) {
    if (!prepData) return 0
    const accId = findAccountId(accountName)
    if (!accId) return 0
    let impact = 0
    if (includeSerials && prepData.serials?.transitions) {
      for (const t of prepData.serials.transitions) {
        if (!t.has_rule || !t.rule || t.rule.skip_accounting) continue
        if (!(t.total_amount > 0)) continue
        if (t.rule.debit_account_id === accId) impact += t.total_amount
        if (t.rule.credit_account_id === accId) impact -= t.total_amount
      }
    }
    // Les envois et mouvements ne touchent que Stock de Pièces (par construction
    // côté mapping). On ne compte donc leur effet que pour ce compte.
    if (accountName === STOCK_ACCOUNT) {
      if (includeShipped && prepData.shipped_items) {
        impact -= (prepData.shipped_items.replacement?.total_amount || 0)
        impact -= (prepData.shipped_items.sale?.total_amount || 0)
      }
      if (includeMovements && prepData.stock_movements?.groups) {
        for (const g of prepData.stock_movements.groups) {
          const m = MOVEMENT_MAP[g.reason]
          if (!m || !(g.total_amount > 0)) continue
          impact += (m.direction === 'in' ? g.total_amount : -g.total_amount)
        }
      }
    }
    return impact
  }

  const totalDebit = lines.reduce((s, l) => s + (l.posting_type === 'Debit' ? (parseFloat(l.amount) || 0) : 0), 0)
  const totalCredit = lines.reduce((s, l) => s + (l.posting_type === 'Credit' ? (parseFloat(l.amount) || 0) : 0), 0)
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01 && totalDebit > 0

  function updateLine(idx, patch) {
    setLines(ls => ls.map((l, i) => i === idx ? { ...l, ...patch } : l))
  }
  function addLine(posting = 'Debit') {
    setLines(ls => [...ls, emptyLine(posting)])
  }
  function removeLine(idx) {
    setLines(ls => ls.length > 2 ? ls.filter((_, i) => i !== idx) : ls)
  }

  async function loadPrep() {
    setPrepLoading(true)
    setPrepError('')
    setPrepData(null)
    try {
      const from = prepFrom + 'T00:00:00.000Z'
      const to = prepTo + 'T23:59:59.999Z'
      const data = await api.journalEntries.pendingOperations({ from, to })
      setPrepData(data)
    } catch (e) {
      setPrepError(e.message)
    } finally {
      setPrepLoading(false)
    }
  }

  function applyPrepopulation() {
    if (!prepData) return
    const generated = []

    if (includeSerials && prepData.serials?.transitions) {
      for (const t of prepData.serials.transitions) {
        if (!t.has_rule || !t.rule || t.rule.skip_accounting) continue
        if (!(t.total_amount > 0)) continue
        const label = `Sérials ${t.previous_status || '∅'} → ${t.new_status} (${t.count})`
        generated.push({
          posting_type: 'Debit',
          amount: String(t.total_amount.toFixed(2)),
          account_id: t.rule.debit_account_id || '',
          description: label,
        })
        generated.push({
          posting_type: 'Credit',
          amount: String(t.total_amount.toFixed(2)),
          account_id: t.rule.credit_account_id || '',
          description: label,
        })
      }
    }

    if (includeShipped && prepData.shipped_items) {
      const stockId = findAccountId(STOCK_ACCOUNT)
      const repl = prepData.shipped_items.replacement
      const sale = prepData.shipped_items.sale
      const missing = []
      if ((repl?.total_amount > 0 || sale?.total_amount > 0) && !stockId) missing.push(STOCK_ACCOUNT)
      if (repl?.total_amount > 0 && !findAccountId(SHIPPED_REPL_DEBIT)) missing.push(SHIPPED_REPL_DEBIT)
      if (sale?.total_amount > 0 && !findAccountId(SHIPPED_SALE_DEBIT)) missing.push(SHIPPED_SALE_DEBIT)
      if (missing.length) {
        setPrepError(`Comptes QB introuvables: ${missing.join(', ')}`)
        return
      }
      if (repl?.total_amount > 0) {
        const amt = repl.total_amount.toFixed(2)
        const label = `Envoi pièces de remplacement (${repl.count})`
        generated.push({ posting_type: 'Debit', amount: amt, account_id: findAccountId(SHIPPED_REPL_DEBIT), description: label })
        generated.push({ posting_type: 'Credit', amount: amt, account_id: stockId, description: label })
      }
      if (sale?.total_amount > 0) {
        const amt = sale.total_amount.toFixed(2)
        const label = `Pièces vendues sans série (${sale.count})`
        generated.push({ posting_type: 'Debit', amount: amt, account_id: findAccountId(SHIPPED_SALE_DEBIT), description: label })
        generated.push({ posting_type: 'Credit', amount: amt, account_id: stockId, description: label })
      }
    }

    if (includeMovements && prepData.stock_movements?.groups) {
      const stockId = findAccountId(STOCK_ACCOUNT)
      const missingMov = []
      const unmapped = []
      for (const g of prepData.stock_movements.groups) {
        if (!(g.total_amount > 0)) continue
        const mapping = MOVEMENT_MAP[g.reason]
        if (!mapping) { unmapped.push(g.reason || '(sans raison)'); continue }
        if (!findAccountId(mapping.account)) missingMov.push(mapping.account)
      }
      const hasAny = prepData.stock_movements.groups.some(g => g.total_amount > 0 && MOVEMENT_MAP[g.reason])
      if (hasAny && !stockId) missingMov.push(STOCK_ACCOUNT)
      if (missingMov.length || unmapped.length) {
        const parts = []
        if (missingMov.length) parts.push(`Comptes QB introuvables: ${[...new Set(missingMov)].join(', ')}`)
        if (unmapped.length) parts.push(`Raisons non mappées: ${[...new Set(unmapped)].join(', ')}`)
        setPrepError(parts.join(' · '))
        return
      }
      for (const g of prepData.stock_movements.groups) {
        const amt = g.total_amount
        if (!(amt > 0)) continue
        const mapping = MOVEMENT_MAP[g.reason]
        if (!mapping) continue
        const label = `${g.reason} (${g.count})`
        const accId = findAccountId(mapping.account)
        if (mapping.direction === 'out') {
          generated.push({ posting_type: 'Debit', amount: amt.toFixed(2), account_id: accId, description: label })
          generated.push({ posting_type: 'Credit', amount: amt.toFixed(2), account_id: stockId, description: label })
        } else {
          generated.push({ posting_type: 'Debit', amount: amt.toFixed(2), account_id: stockId, description: label })
          generated.push({ posting_type: 'Credit', amount: amt.toFixed(2), account_id: accId, description: label })
        }
      }
    }

    // Écritures d'ajustement pour réconcilier les soldes ERP ↔ QB.
    const adjustmentJobs = [
      {
        enabled: includeAdjustmentParts,
        accountName: STOCK_ACCOUNT,
        erpBalance: Number(prepData.erp_parts_balance?.total_value) || 0,
        label: `Ajustement réconciliation ${STOCK_ACCOUNT} (ERP ↔ QB)`,
      },
      {
        enabled: includeAdjustmentFinished,
        accountName: FINISHED_GOODS_ACCOUNT,
        erpBalance: Number(prepData.erp_finished_goods_balance?.total_value) || 0,
        label: `Ajustement réconciliation ${FINISHED_GOODS_ACCOUNT} (ERP ↔ QB)`,
      },
      {
        enabled: includeAdjustmentRefurbished,
        accountName: REFURBISHED_GOODS_ACCOUNT,
        erpBalance: Number(prepData.erp_refurbished_goods_balance?.total_value) || 0,
        label: `Ajustement réconciliation ${REFURBISHED_GOODS_ACCOUNT} (ERP ↔ QB)`,
      },
      {
        enabled: includeAdjustmentInTransit,
        accountName: IN_TRANSIT_ACCOUNT,
        erpBalance: Number(prepData.erp_in_transit_balance?.total_value) || 0,
        label: `Ajustement réconciliation ${IN_TRANSIT_ACCOUNT} (ERP ↔ QB)`,
      },
      {
        enabled: includeAdjustmentLeased,
        accountName: LEASED_EQUIPMENT_ACCOUNT,
        erpBalance: Number(prepData.erp_leased_equipment_balance?.total_value) || 0,
        label: `Ajustement réconciliation ${LEASED_EQUIPMENT_ACCOUNT} (ERP ↔ QB)`,
      },
    ]
    for (const job of adjustmentJobs) {
      if (!job.enabled) continue
      const stockId = findAccountId(job.accountName)
      const offsetId = findAccountId(ADJUSTMENT_OFFSET_ACCOUNT)
      const qbAcc = findAccount(job.accountName)
      const qbBalance = Number(qbAcc?.CurrentBalance ?? NaN)
      if (!Number.isFinite(qbBalance)) {
        setPrepError(`Solde QB du compte "${job.accountName}" indisponible — impossible de calculer l'ajustement`)
        return
      }
      if (!stockId || !offsetId) {
        setPrepError(`Comptes QB introuvables pour l'ajustement: ${[!stockId && job.accountName, !offsetId && ADJUSTMENT_OFFSET_ACCOUNT].filter(Boolean).join(', ')}`)
        return
      }
      const expectedAfter = qbBalance + computeAccountImpact(job.accountName)
      const delta = job.erpBalance - expectedAfter
      if (Math.abs(delta) < 0.01) continue
      const amt = Math.abs(delta).toFixed(2)
      if (delta > 0) {
        generated.push({ posting_type: 'Debit', amount: amt, account_id: stockId, description: job.label })
        generated.push({ posting_type: 'Credit', amount: amt, account_id: offsetId, description: job.label })
      } else {
        generated.push({ posting_type: 'Debit', amount: amt, account_id: offsetId, description: job.label })
        generated.push({ posting_type: 'Credit', amount: amt, account_id: stockId, description: job.label })
      }
    }

    if (generated.length === 0) {
      setPrepError('Aucune ligne à ajouter avec les sélections actuelles')
      return
    }

    setLines(ls => {
      const hasEmpty = ls.length === 2 && ls.every(l => !l.amount && !l.account_id)
      return hasEmpty ? generated : [...ls, ...generated]
    })
    if (!memo) setMemo(`Écriture périodique ${prepFrom} → ${prepTo}`)
    setPrepOpen(false)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (!balanced) { setError('Les débits et les crédits doivent être égaux et non nuls'); return }
    setSaving(true)
    try {
      const payload = {
        txn_date: txnDate,
        doc_number: docNumber || undefined,
        memo: memo || undefined,
        lines: lines.map(l => ({
          posting_type: l.posting_type,
          amount: parseFloat(l.amount) || 0,
          account_id: l.account_id,
          description: l.description || undefined,
        })),
      }
      const created = await api.journalEntries.create(payload)
      onSaved(created)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="label">Date *</label>
          <input type="date" className="input" value={txnDate} onChange={e => setTxnDate(e.target.value)} required />
        </div>
        <div>
          <label className="label">N° de document</label>
          <input type="text" className="input" value={docNumber} onChange={e => setDocNumber(e.target.value)} placeholder="Optionnel" />
        </div>
        <div>
          <label className="label">Mémo</label>
          <input type="text" className="input" value={memo} onChange={e => setMemo(e.target.value)} placeholder="Note privée" />
        </div>
      </div>

      <div className="border border-brand-200 bg-brand-50/50 rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => setPrepOpen(v => !v)}
          className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-semibold text-brand-900 hover:bg-brand-100/60"
        >
          <span className="flex items-center gap-2">
            {prepOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Wand2 size={14} /> Prépopuler depuis les opérations ERP
          </span>
          <span className="text-xs font-normal text-brand-600">
            Numéros de série · Envois · Mouvements
          </span>
        </button>

        {prepOpen && (
          <div className="px-4 py-3 border-t border-brand-200 space-y-3">
            <div className="grid grid-cols-3 gap-3 items-end">
              <div>
                <label className="label">Du</label>
                <input type="date" className="input" value={prepFrom} onChange={e => setPrepFrom(e.target.value)} />
              </div>
              <div>
                <label className="label">Au</label>
                <input type="date" className="input" value={prepTo} onChange={e => setPrepTo(e.target.value)} />
              </div>
              <button
                type="button"
                onClick={loadPrep}
                disabled={prepLoading}
                className="btn-secondary"
              >
                {prepLoading ? <><RefreshCw size={14} className="animate-spin" /> Analyse…</> : <><RefreshCw size={14} /> Analyser la période</>}
              </button>
            </div>

            {prepError && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded px-3 py-1.5 text-xs">
                <AlertCircle size={12} /> {prepError}
              </div>
            )}

            {prepData && (
              <div className="space-y-3 text-sm">
                {/* Serials */}
                <div className="bg-white border border-slate-200 rounded-lg p-3">
                  <label className="flex items-center gap-2 font-medium text-slate-800 mb-2">
                    <input type="checkbox" checked={includeSerials} onChange={e => setIncludeSerials(e.target.checked)} />
                    Changements d'état des numéros de série
                    <span className="text-xs font-normal text-slate-500">
                      ({prepData.serials?.total_changes || 0} changements, {prepData.serials?.transitions?.length || 0} transitions)
                    </span>
                  </label>
                  {prepData.serials?.transitions?.length > 0 ? (
                    <div className="border border-slate-100 rounded">
                      <table className="w-full text-xs table-fixed">
                        <thead className="bg-slate-50 text-slate-500">
                          <tr>
                            <th className="text-left px-2 py-1 w-40">Transition</th>
                            <th className="text-right px-2 py-1 w-14">Nb</th>
                            <th className="text-left px-2 py-1">Débit</th>
                            <th className="text-left px-2 py-1">Crédit</th>
                            <th className="text-right px-2 py-1 w-24">Montant</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {prepData.serials.transitions.map((t, i) => {
                            const mapped = t.has_rule && !t.rule?.skip_accounting
                            return (
                              <tr key={i}>
                                <td className="px-2 py-1 text-slate-700">
                                  {t.previous_status || '∅'} → <strong>{t.new_status}</strong>
                                  {t.missing_valuation_count > 0 && (
                                    <span className="ml-1 text-amber-600">· {t.missing_valuation_count} sans montant</span>
                                  )}
                                </td>
                                <td className="px-2 py-1 text-right tabular-nums">{t.count}</td>
                                {mapped ? (
                                  <>
                                    <td className="px-2 py-1 text-slate-600">{t.rule?.debit_account_name}</td>
                                    <td className="px-2 py-1 text-slate-600">{t.rule?.credit_account_name}</td>
                                  </>
                                ) : (
                                  <td className="px-2 py-1 text-slate-500" colSpan={2}>
                                    {!t.has_rule && <span className="text-amber-600">Aucune règle</span>}
                                    {t.has_rule && t.rule?.skip_accounting && <span className="text-slate-400">Ignoré</span>}
                                  </td>
                                )}
                                <td className="px-2 py-1 text-right tabular-nums">
                                  {mapped ? fmtCad(t.total_amount) : '—'}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400">Aucun changement d'état sur la période</p>
                  )}
                </div>

                {/* Shipped items */}
                <div className="bg-white border border-slate-200 rounded-lg p-3">
                  <label className="flex items-center gap-2 font-medium text-slate-800 mb-2">
                    <input type="checkbox" checked={includeShipped} onChange={e => setIncludeShipped(e.target.checked)} />
                    Pièces envoyées sans numéro de série
                    <span className="text-xs font-normal text-slate-500">
                      ({prepData.shipped_items?.count || 0} items, total {fmtCad(prepData.shipped_items?.total_amount || 0)})
                    </span>
                  </label>
                  {(prepData.shipped_items?.count || 0) > 0 && (
                    <div className="border border-slate-100 rounded">
                      <table className="w-full text-xs table-fixed">
                        <thead className="bg-slate-50 text-slate-500">
                          <tr>
                            <th className="text-left px-2 py-1 w-40">Type</th>
                            <th className="text-right px-2 py-1 w-14">Nb</th>
                            <th className="text-left px-2 py-1">Débit</th>
                            <th className="text-left px-2 py-1">Crédit</th>
                            <th className="text-right px-2 py-1 w-24">Montant</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {(prepData.shipped_items.replacement?.count || 0) > 0 && (
                            <tr>
                              <td className="px-2 py-1 text-slate-700">Remplacement</td>
                              <td className="px-2 py-1 text-right tabular-nums">{prepData.shipped_items.replacement.count}</td>
                              <td className="px-2 py-1 text-slate-600">{SHIPPED_REPL_DEBIT}</td>
                              <td className="px-2 py-1 text-slate-600">{STOCK_ACCOUNT}</td>
                              <td className="px-2 py-1 text-right tabular-nums">{fmtCad(prepData.shipped_items.replacement.total_amount)}</td>
                            </tr>
                          )}
                          {(prepData.shipped_items.sale?.count || 0) > 0 && (
                            <tr>
                              <td className="px-2 py-1 text-slate-700">Vente</td>
                              <td className="px-2 py-1 text-right tabular-nums">{prepData.shipped_items.sale.count}</td>
                              <td className="px-2 py-1 text-slate-600">{SHIPPED_SALE_DEBIT}</td>
                              <td className="px-2 py-1 text-slate-600">{STOCK_ACCOUNT}</td>
                              <td className="px-2 py-1 text-right tabular-nums">{fmtCad(prepData.shipped_items.sale.total_amount)}</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Stock movements */}
                <div className="bg-white border border-slate-200 rounded-lg p-3">
                  <label className="flex items-center gap-2 font-medium text-slate-800 mb-2">
                    <input type="checkbox" checked={includeMovements} onChange={e => setIncludeMovements(e.target.checked)} />
                    Mouvements d'inventaire (hors Fabrication)
                    <span className="text-xs font-normal text-slate-500">
                      ({prepData.stock_movements?.count || 0} mouvements, {prepData.stock_movements?.groups?.length || 0} groupes)
                    </span>
                  </label>
                  {prepData.stock_movements?.groups?.length > 0 ? (
                    <div className="border border-slate-100 rounded">
                      <table className="w-full text-xs table-fixed">
                        <thead className="bg-slate-50 text-slate-500">
                          <tr>
                            <th className="text-left px-2 py-1 w-40">Raison</th>
                            <th className="text-right px-2 py-1 w-14">Nb</th>
                            <th className="text-left px-2 py-1">Débit</th>
                            <th className="text-left px-2 py-1">Crédit</th>
                            <th className="text-right px-2 py-1 w-24">Montant</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {prepData.stock_movements.groups.map((g, i) => {
                            const m = MOVEMENT_MAP[g.reason]
                            const debit = m ? (m.direction === 'out' ? m.account : STOCK_ACCOUNT) : null
                            const credit = m ? (m.direction === 'out' ? STOCK_ACCOUNT : m.account) : null
                            return (
                              <tr key={i}>
                                <td className="px-2 py-1 text-slate-700">{g.reason || <em className="text-slate-400">sans raison</em>}</td>
                                <td className="px-2 py-1 text-right tabular-nums">{g.count}</td>
                                {m ? (
                                  <>
                                    <td className="px-2 py-1 text-slate-600">{debit}</td>
                                    <td className="px-2 py-1 text-slate-600">{credit}</td>
                                  </>
                                ) : (
                                  <td className="px-2 py-1 text-amber-600" colSpan={2}>Non mappé</td>
                                )}
                                <td className="px-2 py-1 text-right tabular-nums">{fmtCad(g.total_amount)}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400">Aucun mouvement sur la période</p>
                  )}
                </div>

                {/* Réconciliations ERP ↔ QB (Stock de Pièces + Stock de Produits finis) */}
                {[
                  prepData.erp_parts_balance && {
                    key: 'parts',
                    accountName: STOCK_ACCOUNT,
                    erpLabel: 'ERP — pièces non sérialisées (hors obsolètes)',
                    erpBalance: Number(prepData.erp_parts_balance.total_value) || 0,
                    erpCount: prepData.erp_parts_balance.product_count || 0,
                    include: includeAdjustmentParts,
                    setInclude: setIncludeAdjustmentParts,
                  },
                  prepData.erp_finished_goods_balance && {
                    key: 'finished',
                    accountName: FINISHED_GOODS_ACCOUNT,
                    erpLabel: 'ERP — sérials en statut « Disponible - Vente »',
                    erpBalance: Number(prepData.erp_finished_goods_balance.total_value) || 0,
                    erpCount: prepData.erp_finished_goods_balance.serial_count || 0,
                    include: includeAdjustmentFinished,
                    setInclude: setIncludeAdjustmentFinished,
                  },
                  prepData.erp_refurbished_goods_balance && {
                    key: 'refurbished',
                    accountName: REFURBISHED_GOODS_ACCOUNT,
                    erpLabel: 'ERP — sérials en statut « Disponible - Location »',
                    erpBalance: Number(prepData.erp_refurbished_goods_balance.total_value) || 0,
                    erpCount: prepData.erp_refurbished_goods_balance.serial_count || 0,
                    include: includeAdjustmentRefurbished,
                    setInclude: setIncludeAdjustmentRefurbished,
                  },
                  prepData.erp_in_transit_balance && {
                    key: 'inTransit',
                    accountName: IN_TRANSIT_ACCOUNT,
                    erpLabel: 'ERP — sérials en statut « En retour », « À analyser » ou « À reconditionner »',
                    erpBalance: Number(prepData.erp_in_transit_balance.total_value) || 0,
                    erpCount: prepData.erp_in_transit_balance.serial_count || 0,
                    include: includeAdjustmentInTransit,
                    setInclude: setIncludeAdjustmentInTransit,
                  },
                  prepData.erp_leased_equipment_balance && {
                    key: 'leased',
                    accountName: LEASED_EQUIPMENT_ACCOUNT,
                    erpLabel: 'ERP — sérials en statut « Opérationnel - Loué »',
                    erpBalance: Number(prepData.erp_leased_equipment_balance.total_value) || 0,
                    erpCount: prepData.erp_leased_equipment_balance.serial_count || 0,
                    include: includeAdjustmentLeased,
                    setInclude: setIncludeAdjustmentLeased,
                  },
                ].filter(Boolean).map(reco => {
                  const qbAcc = findAccount(reco.accountName)
                  const qbBalance = qbAcc ? Number(qbAcc.CurrentBalance) : null
                  const impact = computeAccountImpact(reco.accountName)
                  const expectedAfter = qbBalance != null ? qbBalance + impact : null
                  const delta = expectedAfter != null ? reco.erpBalance - expectedAfter : null
                  const balanced = delta != null && Math.abs(delta) < 0.01
                  return (
                    <div key={reco.key} className="bg-white border border-slate-200 rounded-lg p-3">
                      <label className="flex items-center gap-2 font-medium text-slate-800 mb-2">
                        <input
                          type="checkbox"
                          checked={(qbBalance == null || balanced) ? false : reco.include}
                          onChange={e => reco.setInclude(e.target.checked)}
                          disabled={qbBalance == null || balanced}
                        />
                        Écriture d'ajustement — Réconciliation {reco.accountName} (ERP ↔ QB)
                      </label>
                      <div className="border border-slate-100 rounded">
                        <table className="w-full text-xs table-fixed">
                          <thead className="bg-slate-50 text-slate-500">
                            <tr>
                              <th className="text-left px-2 py-1 w-40">Solde</th>
                              <th className="text-right px-2 py-1 w-14">Nb</th>
                              <th className="text-left px-2 py-1">Débit</th>
                              <th className="text-left px-2 py-1">Crédit</th>
                              <th className="text-right px-2 py-1 w-24">Montant</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            <tr>
                              <td className="px-2 py-1 text-slate-700">{reco.erpLabel}</td>
                              <td className="px-2 py-1 text-right tabular-nums">{reco.erpCount}</td>
                              <td className="px-2 py-1 text-slate-400" colSpan={2}>—</td>
                              <td className="px-2 py-1 text-right tabular-nums">{fmtCad(reco.erpBalance)}</td>
                            </tr>
                            <tr>
                              <td className="px-2 py-1 text-slate-700">QB — {reco.accountName} (actuel)</td>
                              <td className="px-2 py-1"></td>
                              <td className="px-2 py-1 text-slate-400" colSpan={2}>—</td>
                              <td className="px-2 py-1 text-right tabular-nums">
                                {qbBalance != null ? fmtCad(qbBalance) : <span className="text-amber-600">indisponible</span>}
                              </td>
                            </tr>
                            <tr>
                              <td className="px-2 py-1 text-slate-600">Impact des opérations sélectionnées</td>
                              <td className="px-2 py-1"></td>
                              <td className="px-2 py-1 text-slate-400" colSpan={2}>débit − crédit sur {reco.accountName}</td>
                              <td className="px-2 py-1 text-right tabular-nums">
                                {(impact >= 0 ? '+' : '−') + fmtCad(Math.abs(impact)).replace(/^-/, '')}
                              </td>
                            </tr>
                            <tr className="bg-slate-50">
                              <td className="px-2 py-1 text-slate-700 font-medium">QB — projeté après opérations</td>
                              <td className="px-2 py-1"></td>
                              <td className="px-2 py-1 text-slate-400" colSpan={2}>—</td>
                              <td className="px-2 py-1 text-right tabular-nums font-medium">
                                {expectedAfter != null ? fmtCad(expectedAfter) : '—'}
                              </td>
                            </tr>
                            {delta != null && (
                              <tr className={balanced ? 'bg-emerald-50' : 'bg-amber-50'}>
                                <td className="px-2 py-1 font-medium text-slate-800">
                                  {balanced ? 'Soldes balancés' : 'Ajustement requis (ERP − projeté)'}
                                </td>
                                <td className="px-2 py-1"></td>
                                {balanced ? (
                                  <td className="px-2 py-1 text-emerald-700" colSpan={2}>aucune écriture nécessaire</td>
                                ) : (
                                  <>
                                    <td className="px-2 py-1 text-slate-600">
                                      {delta > 0 ? reco.accountName : ADJUSTMENT_OFFSET_ACCOUNT}
                                    </td>
                                    <td className="px-2 py-1 text-slate-600">
                                      {delta > 0 ? ADJUSTMENT_OFFSET_ACCOUNT : reco.accountName}
                                    </td>
                                  </>
                                )}
                                <td className="px-2 py-1 text-right tabular-nums font-medium">
                                  {balanced ? fmtCad(0) : fmtCad(Math.abs(delta))}
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                      {qbBalance == null && (
                        <p className="text-xs text-amber-600 mt-1">
                          Compte QB « {reco.accountName} » introuvable — ajustement impossible.
                        </p>
                      )}
                    </div>
                  )
                })}

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={applyPrepopulation}
                    className="btn-primary text-sm"
                  >
                    <Plus size={14} /> Ajouter les lignes
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-slate-700">Lignes</h3>
          <div className="flex gap-2">
            <button type="button" onClick={() => addLine('Debit')} className="text-xs btn-secondary py-1 px-2">
              <Plus size={12} /> Débit
            </button>
            <button type="button" onClick={() => addLine('Credit')} className="text-xs btn-secondary py-1 px-2">
              <Plus size={12} /> Crédit
            </button>
          </div>
        </div>

        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left px-3 py-2 text-slate-600 font-medium w-24">Type</th>
                <th className="text-left px-3 py-2 text-slate-600 font-medium">Compte</th>
                <th className="text-left px-3 py-2 text-slate-600 font-medium">Description</th>
                <th className="text-right px-3 py-2 text-slate-600 font-medium w-32">Montant</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="px-2 py-1.5">
                    <select
                      value={l.posting_type}
                      onChange={e => updateLine(i, { posting_type: e.target.value })}
                      className="input text-xs py-1"
                    >
                      <option value="Debit">Débit</option>
                      <option value="Credit">Crédit</option>
                    </select>
                  </td>
                  <td className="px-2 py-1.5">
                    <LinkedRecordField
                      name={`journal_account_${i}`}
                      value={l.account_id}
                      options={accounts.map(a => ({ id: a.Id, _name: a.Name, _type: a.AccountType }))}
                      labelFn={a => `${a._name}${a._type ? ` (${a._type})` : ''}`}
                      placeholder="Compte"
                      onChange={v => updateLine(i, { account_id: v })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="text"
                      value={l.description}
                      onChange={e => updateLine(i, { description: e.target.value })}
                      className="input text-xs py-1"
                      placeholder="Description"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={l.amount}
                      onChange={e => updateLine(i, { amount: e.target.value })}
                      className="input text-xs py-1 text-right tabular-nums"
                      required
                    />
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    {lines.length > 2 && (
                      <button type="button" onClick={() => removeLine(i)} className="text-slate-400 hover:text-red-600 p-1">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50 border-t border-slate-200">
              <tr>
                <td colSpan={3} className="px-3 py-2 text-right text-slate-600 font-medium">Total débit</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900">{fmtCad(totalDebit)}</td>
                <td></td>
              </tr>
              <tr>
                <td colSpan={3} className="px-3 py-2 text-right text-slate-600 font-medium">Total crédit</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900">{fmtCad(totalCredit)}</td>
                <td></td>
              </tr>
              <tr className={balanced ? 'bg-green-50' : 'bg-amber-50'}>
                <td colSpan={3} className="px-3 py-2 text-right font-semibold">{balanced ? 'Équilibré' : 'Écart'}</td>
                <td className={`px-3 py-2 text-right font-bold tabular-nums ${balanced ? 'text-green-700' : 'text-amber-700'}`}>
                  {fmtCad(totalDebit - totalCredit)}
                </td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving || !balanced} className="btn-primary">
          {saving ? <><RefreshCw size={14} className="animate-spin" /> Publication…</> : <><BookOpen size={14} /> Publier sur QuickBooks</>}
        </button>
      </div>
    </form>
  )
}

function EntryDetailModal({ entryId, onClose }) {
  const [entry, setEntry] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!entryId) return
    setLoading(true)
    api.journalEntries.get(entryId)
      .then(setEntry)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [entryId])

  return (
    <Modal isOpen={!!entryId} onClose={onClose} title="Écriture de journal" size="xl">
      {loading && (
        <div className="flex items-center gap-2 text-slate-500 py-6">
          <RefreshCw size={16} className="animate-spin" /> Chargement…
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm">
          <AlertCircle size={14} /> {error}
        </div>
      )}
      {entry && (
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xl font-bold text-slate-900">
                  {entry.doc_number ? `#${entry.doc_number}` : `JE-${entry.id}`}
                </span>
                {entry.adjustment && (
                  <span className="text-xs bg-amber-100 text-amber-800 rounded-full px-2 py-0.5">Ajustement</span>
                )}
              </div>
              <p className="text-sm text-slate-500 mt-0.5">
                {entry.txn_date ? fmtDate(entry.txn_date) : '—'}
                {entry.currency && ` · ${entry.currency}`}
              </p>
            </div>
            {entry.qb_url && (
              <a
                href={entry.qb_url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary text-sm"
              >
                <ExternalLink size={14} /> Ouvrir dans QuickBooks
              </a>
            )}
          </div>

          {entry.memo && (
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wide font-medium mb-1">Mémo</p>
              <p className="text-sm text-slate-700">{entry.memo}</p>
            </div>
          )}

          <div>
            <h3 className="text-sm font-semibold text-slate-700 mb-2">Lignes</h3>
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="text-left px-3 py-2 text-slate-600 font-medium">Compte</th>
                    <th className="text-left px-3 py-2 text-slate-600 font-medium">Description</th>
                    <th className="text-left px-3 py-2 text-slate-600 font-medium">Entité</th>
                    <th className="text-right px-3 py-2 text-slate-600 font-medium w-28">Débit</th>
                    <th className="text-right px-3 py-2 text-slate-600 font-medium w-28">Crédit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {entry.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2 text-slate-700">{l.account_name || l.account_id || '—'}</td>
                      <td className="px-3 py-2 text-slate-600">{l.description || '—'}</td>
                      <td className="px-3 py-2 text-slate-600">
                        {l.entity_name ? `${l.entity_name}${l.entity_type ? ` (${l.entity_type})` : ''}` : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        {l.posting_type === 'Debit' ? fmtCad(l.amount, entry.currency) : ''}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        {l.posting_type === 'Credit' ? fmtCad(l.amount, entry.currency) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50 border-t border-slate-200">
                  <tr>
                    <td colSpan={3} className="px-3 py-2 text-right font-semibold">Total</td>
                    <td className="px-3 py-2 text-right font-bold tabular-nums text-slate-900">
                      {fmtCad(entry.lines.filter(l => l.posting_type === 'Debit').reduce((s, l) => s + (l.amount || 0), 0), entry.currency)}
                    </td>
                    <td className="px-3 py-2 text-right font-bold tabular-nums text-slate-900">
                      {fmtCad(entry.lines.filter(l => l.posting_type === 'Credit').reduce((s, l) => s + (l.amount || 0), 0), entry.currency)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

function totalForRow(row) {
  if (row.total) return row.total
  return (row.lines || []).filter(l => l.posting_type === 'Debit').reduce((s, l) => s + (l.amount || 0), 0)
}

const RENDERS = {
  txn_date:    row => <span className="text-slate-500">{fmtDate(row.txn_date)}</span>,
  doc_number:  row => row.doc_number ? <span className="font-mono text-slate-700">{row.doc_number}</span> : <span className="text-slate-300">—</span>,
  memo:        row => row.memo ? <span className="text-slate-700">{row.memo}</span> : <span className="text-slate-300">—</span>,
  lines_count: row => <span className="tabular-nums text-slate-500">{row.lines_count ?? '—'}</span>,
  total:       row => <span className="font-medium tabular-nums text-slate-800">{fmtCad(row.total, row.currency)}</span>,
  qb:          row => row.qb_url
    ? <a href={row.qb_url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} title="Ouvrir dans QuickBooks" className="inline-flex items-center text-brand-600 hover:text-brand-800"><ExternalLink size={14} /></a>
    : <span className="text-slate-300">—</span>,
}

const COLUMNS = TABLE_COLUMN_META.journal_entries.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function JournalEntries() {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [creating, setCreating] = useState(false)
  const [accounts, setAccounts] = useState([])

  const decorate = (rows) => (rows || []).map(r => ({
    ...r,
    lines_count: r.lines?.length ?? null,
    total: totalForRow(r),
  }))

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.journalEntries.list({ limit, page }).then(r => ({ data: decorate(r.data) })),
      setEntries, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])

  async function openCreate() {
    setCreating(true)
    if (accounts.length === 0) {
      try {
        const list = await api.quickbooks.accounts({ all: '1' })
        setAccounts(list.filter(a => a.Active).sort((a, b) => a.Name.localeCompare(b.Name)))
      } catch (e) {
        setError(e.message)
      }
    }
  }

  function handleCreated(entry) {
    setCreating(false)
    setEntries(es => [...decorate([entry]), ...es])
    setSelectedId(entry.id)
  }

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Écritures de journal</h1>
            <p className="text-sm text-slate-500 mt-1">Écritures synchronisées avec QuickBooks</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={load} disabled={loading} className="btn-secondary">
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Actualiser
            </button>
            <button onClick={openCreate} className="btn-primary">
              <Plus size={14} /> Nouvelle écriture
            </button>
            <TableConfigModal table="journal_entries" />
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm mb-4">
            <AlertCircle size={14} /> {error}
          </div>
        )}

        <DataTable
          table="journal_entries"
          columns={COLUMNS}
          data={entries}
          loading={loading}
          searchFields={['doc_number', 'memo']}
          onRowClick={row => setSelectedId(row.id)}
        />
      </div>

      <EntryDetailModal entryId={selectedId} onClose={() => setSelectedId(null)} />

      <Modal isOpen={creating} onClose={() => setCreating(false)} title="Nouvelle écriture de journal" size="xl">
        <CreateJournalEntryForm
          accounts={accounts}
          onSaved={handleCreated}
          onCancel={() => setCreating(false)}
        />
      </Modal>
    </Layout>
  )
}
