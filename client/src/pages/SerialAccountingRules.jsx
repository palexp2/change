import { useState, useEffect, useMemo } from 'react'
import { Plus, Trash2, AlertCircle, CheckCircle2, Ban } from 'lucide-react'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

const VALUATION_LABELS = {
  manufacture_value: 'Valeur de fabrication',
  product_cost: 'Coût du produit',
  fixed_amount: 'Montant fixe',
}

function statusLabel(s) {
  return s == null || s === '' ? '∅ (création)' : s
}

function RuleForm({ initial, transition, accounts, onSave, onCancel }) {
  const [form, setForm] = useState(() => ({
    previous_status: initial?.previous_status ?? transition?.previous_status ?? '',
    new_status: initial?.new_status ?? transition?.new_status ?? '',
    skip_accounting: initial?.skip_accounting ?? 0,
    debit_account_id: initial?.debit_account_id ?? '',
    credit_account_id: initial?.credit_account_id ?? '',
    valuation_source: initial?.valuation_source ?? 'manufacture_value',
    fixed_amount: initial?.fixed_amount ?? '',
    memo_template: initial?.memo_template ?? '',
    notes: initial?.notes ?? '',
    active: initial?.active ?? 1,
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const isEdit = !!initial?.id

  const findAcct = (id) => accounts.find(a => a.Id === id)

  async function submit(e) {
    e.preventDefault()
    if (!form.skip_accounting && (!form.debit_account_id || !form.credit_account_id)) {
      setError('Comptes débit et crédit requis.')
      return
    }
    setSaving(true); setError('')
    try {
      const debit = findAcct(form.debit_account_id)
      const credit = findAcct(form.credit_account_id)
      const payload = {
        previous_status: form.previous_status === '' ? null : form.previous_status,
        new_status: form.new_status,
        skip_accounting: form.skip_accounting ? 1 : 0,
        debit_account_id: form.skip_accounting ? null : form.debit_account_id,
        debit_account_name: form.skip_accounting ? null : (debit?.FullyQualifiedName || debit?.Name || null),
        credit_account_id: form.skip_accounting ? null : form.credit_account_id,
        credit_account_name: form.skip_accounting ? null : (credit?.FullyQualifiedName || credit?.Name || null),
        valuation_source: form.valuation_source,
        fixed_amount: form.valuation_source === 'fixed_amount' ? Number(form.fixed_amount) : null,
        memo_template: form.memo_template || null,
        notes: form.notes || null,
        active: form.active ? 1 : 0,
      }
      if (isEdit) {
        await api.serials.accounting.updateRule(initial.id, payload)
      } else {
        await api.serials.accounting.createRule(payload)
      }
      onSave()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">État précédent</label>
          <input
            className="input"
            value={form.previous_status ?? ''}
            onChange={e => setField('previous_status', e.target.value)}
            placeholder="(laisser vide = wildcard / création)"
            disabled={isEdit}
          />
        </div>
        <div>
          <label className="label">Nouvel état *</label>
          <input
            className="input"
            value={form.new_status}
            onChange={e => setField('new_status', e.target.value)}
            required
            disabled={isEdit}
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm bg-amber-50 border border-amber-200 rounded p-2">
        <input
          type="checkbox"
          checked={!!form.skip_accounting}
          onChange={e => setField('skip_accounting', e.target.checked ? 1 : 0)}
        />
        <span className="text-amber-900">Aucune écriture comptable pour cette transition</span>
      </label>

      {!form.skip_accounting && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Compte débit *</label>
            <SearchableSelect
              className="input"
              size="sm"
              value={form.debit_account_id}
              onChange={v => setField('debit_account_id', v)}
              options={accounts}
              getOptionValue={a => a.Id}
              getOptionLabel={a => `${a.FullyQualifiedName || a.Name} (${a.AccountType})`}
              getOptionKey={a => a.Id}
              placeholder="— Choisir —"
              testId="debit-account-select"
            />
          </div>
          <div>
            <label className="label">Compte crédit *</label>
            <SearchableSelect
              className="input"
              size="sm"
              value={form.credit_account_id}
              onChange={v => setField('credit_account_id', v)}
              options={accounts}
              getOptionValue={a => a.Id}
              getOptionLabel={a => `${a.FullyQualifiedName || a.Name} (${a.AccountType})`}
              getOptionKey={a => a.Id}
              placeholder="— Choisir —"
              testId="credit-account-select"
            />
          </div>
        </div>
      )}

      <div className={`grid grid-cols-2 gap-3 ${form.skip_accounting ? 'opacity-50 pointer-events-none' : ''}`}>
        <div>
          <label className="label">Source de la valeur</label>
          <select
            className="input"
            value={form.valuation_source}
            onChange={e => setField('valuation_source', e.target.value)}
          >
            {Object.entries(VALUATION_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        {form.valuation_source === 'fixed_amount' && (
          <div>
            <label className="label">Montant fixe (CAD) *</label>
            <input
              type="number"
              step="0.01"
              className="input"
              value={form.fixed_amount}
              onChange={e => setField('fixed_amount', e.target.value)}
              required
            />
          </div>
        )}
      </div>

      <div>
        <label className="label">Mémo (template)</label>
        <input
          className="input"
          value={form.memo_template}
          onChange={e => setField('memo_template', e.target.value)}
          placeholder="ex: {count}× {prev}→{new} — semaine {week}"
        />
        <p className="text-xs text-slate-500 mt-1">
          Variables disponibles: {`{count}`}, {`{prev}`}, {`{new}`}, {`{week}`}, {`{total}`}
        </p>
      </div>

      <div>
        <label className="label">Notes internes</label>
        <textarea
          className="input"
          rows={2}
          value={form.notes}
          onChange={e => setField('notes', e.target.value)}
          placeholder="Précisions sur les conditions, exceptions, etc."
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={!!form.active}
          onChange={e => setField('active', e.target.checked ? 1 : 0)}
        />
        Règle active (incluse dans l'agrégation hebdomadaire)
      </label>

      {error && <p className="text-red-600 text-sm">{error}</p>}

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">
          {saving ? 'Enregistrement...' : (isEdit ? 'Mettre à jour' : 'Créer la règle')}
        </button>
      </div>
    </form>
  )
}

export default function SerialAccountingRules() {
  const [transitions, setTransitions] = useState([])
  const [rules, setRules] = useState([])
  const [missingVals, setMissingVals] = useState({ data: [], total: 0 })
  const [showMissing, setShowMissing] = useState(false)
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [accountsError, setAccountsError] = useState('')
  const [modal, setModal] = useState(null) // { rule, transition }
  const [windowDays, setWindowDays] = useState(90)
  const confirm = useConfirm()

  const reload = async () => {
    setLoading(true)
    try {
      const since = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10)
      const [tRes, rRes, mRes] = await Promise.allSettled([
        api.serials.accounting.transitions({ since }),
        api.serials.accounting.listRules(),
        api.serials.accounting.missingValuations({ since, limit: 500 }),
      ])
      setTransitions(tRes.status === 'fulfilled' ? (tRes.value.data || []) : [])
      setRules(rRes.status === 'fulfilled' ? (rRes.value.data || []) : [])
      setMissingVals(mRes.status === 'fulfilled' ? mRes.value : { data: [], total: 0 })
      if (tRes.status === 'rejected') console.error('transitions error', tRes.reason)
      if (rRes.status === 'rejected') console.error('rules error', rRes.reason)
      if (mRes.status === 'rejected') console.error('missing error', mRes.reason)
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload() }, [windowDays])

  useEffect(() => {
    api.quickbooks.accounts({ all: '1' })
      .then(setAccounts)
      .catch(e => setAccountsError(e.message))
  }, [])

  const ruleByKey = useMemo(() => {
    const m = new Map()
    for (const r of rules) {
      m.set(`${r.previous_status ?? ''}→${r.new_status}`, r)
    }
    return m
  }, [rules])

  // Vue unifiée: transitions observées + règles définies sans observation récente
  const mergedRows = useMemo(() => {
    const seen = new Set()
    const rows = transitions.map(t => {
      const key = `${t.previous_status ?? ''}→${t.new_status}`
      seen.add(key)
      return { ...t, key, source: 'observed' }
    })
    for (const r of rules) {
      const key = `${r.previous_status ?? ''}→${r.new_status}`
      if (!seen.has(key)) {
        rows.push({
          key,
          previous_status: r.previous_status,
          new_status: r.new_status,
          count: 0,
          last_seen: null,
          source: 'rule_only',
        })
      }
    }
    return rows
  }, [transitions, rules])

  async function deleteRule(id) {
    if (!(await confirm('Supprimer cette règle ?'))) return
    await api.serials.accounting.deleteRule(id)
    reload()
  }

  // ── Données décorées pour les DataTable ─────────────────────────────────
  // Chaque ligne reçoit un `id` stable + des champs dérivés (mapping_status,
  // active_label, transition…) qui rendent le tri/filtre/groupage possibles.
  const transitionRows = useMemo(() => mergedRows.map(t => {
    const rule = ruleByKey.get(t.key)
    return {
      ...t,
      id: t.key,
      rule,
      mapping_status: rule ? (rule.skip_accounting ? 'skip' : 'mapped') : 'unmapped',
    }
  }), [mergedRows, ruleByKey])

  const ruleRows = useMemo(() => rules.map(r => ({
    ...r,
    active_label: r.active ? 'Oui' : 'Non',
  })), [rules])

  const missingRows = useMemo(() => (missingVals.data || []).map(m => ({
    ...m,
    id: m.change_id,
    changed_at: m.changed_at || m.created_at,
    product: m.product_name || m.product_sku || '—',
    transition: `${statusLabel(m.previous_status)} → ${statusLabel(m.new_status)}`,
    value_label: m.manufacture_value == null ? 'NULL' : '0 $',
  })), [missingVals])

  // ── Colonnes (meta centralisée + render attachés ici pour capter le scope) ─
  const transitionColumns = useMemo(() => {
    const RENDERS = {
      previous_status: t => <span className="text-slate-700">{statusLabel(t.previous_status)}</span>,
      new_status:      t => <span className="text-slate-900 font-medium">{statusLabel(t.new_status)}</span>,
      count:           t => t.count > 0 ? <span className="tabular-nums">{t.count}</span> : <span className="text-slate-300">0</span>,
      missing_value_count: t => t.missing_value_count > 0
        ? <span className="inline-flex items-center gap-1 text-red-600 font-medium" title="Numéros de série sans valeur de fabrication"><AlertCircle size={11} /> {t.missing_value_count}</span>
        : <span className="text-slate-300">—</span>,
      last_seen:       t => t.last_seen ? <span className="text-slate-500 text-xs">{fmtDate(t.last_seen)}</span> : <span className="text-slate-300">—</span>,
      mapping_status:  t => {
        const rule = t.rule
        if (!rule) return <span className="inline-flex items-center gap-1 text-xs text-red-600"><AlertCircle size={12} /> Non mappé</span>
        if (rule.skip_accounting) return <span className="inline-flex items-center gap-1 text-xs text-slate-500"><Ban size={12} /> Aucune écriture</span>
        return <span className="inline-flex items-center gap-1 text-xs text-green-700"><CheckCircle2 size={12} /> {rule.debit_account_name?.split(':').pop() || rule.debit_account_id} / {rule.credit_account_name?.split(':').pop() || rule.credit_account_id}</span>
      },
      action: t => t.rule
        ? <button onClick={() => setModal({ rule: t.rule })} className="text-xs text-brand-600 hover:text-brand-800">Modifier</button>
        : <button onClick={() => setModal({ transition: t })} className="inline-flex items-center gap-1 text-xs text-brand-600 hover:text-brand-800"><Plus size={12} /> Mapper</button>,
    }
    const labelFor = { mapped: 'Mappé', skip: 'Aucune écriture', unmapped: 'Non mappé' }
    return TABLE_COLUMN_META.serial_transitions.map(meta => ({
      ...meta,
      render: RENDERS[meta.id],
      ...(meta.id === 'previous_status' || meta.id === 'new_status' ? { formatGroupKey: statusLabel } : {}),
      ...(meta.id === 'mapping_status' ? { formatGroupKey: k => labelFor[k] || k } : {}),
    }))
  }, [])

  const ruleColumns = useMemo(() => {
    const RENDERS = {
      previous_status: r => <span className="text-slate-500">{statusLabel(r.previous_status)}</span>,
      new_status:      r => <span className="text-slate-900 font-medium">{statusLabel(r.new_status)}</span>,
      debit:  r => r.skip_accounting ? <span className="text-slate-400 italic">— skip —</span> : <span className="text-slate-700 text-xs">{r.debit_account_name || r.debit_account_id}</span>,
      credit: r => r.skip_accounting ? <span className="text-slate-400 italic">— skip —</span> : <span className="text-slate-700 text-xs">{r.credit_account_name || r.credit_account_id}</span>,
      valuation: r => r.skip_accounting
        ? <span className="text-xs text-slate-400">Aucune écriture</span>
        : <span className="text-xs text-slate-600">{VALUATION_LABELS[r.valuation_source]}{r.valuation_source === 'fixed_amount' && r.fixed_amount != null && ` (${r.fixed_amount} $)`}</span>,
      active: r => r.active ? <span className="text-xs text-green-700">Oui</span> : <span className="text-xs text-slate-400">Non</span>,
      action: r => (
        <div className="text-right">
          <button onClick={() => setModal({ rule: r })} className="text-xs text-brand-600 hover:text-brand-800 mr-3">Modifier</button>
          <button onClick={() => deleteRule(r.id)} className="text-xs text-red-600 hover:text-red-800 inline-flex items-center gap-1"><Trash2 size={11} /></button>
        </div>
      ),
    }
    return TABLE_COLUMN_META.serial_accounting_rules.map(meta => ({
      ...meta,
      render: RENDERS[meta.id],
      ...(meta.id === 'previous_status' || meta.id === 'new_status' ? { formatGroupKey: statusLabel } : {}),
      ...(meta.id === 'valuation' ? { formatGroupKey: k => VALUATION_LABELS[k] || k } : {}),
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const missingColumns = useMemo(() => {
    const RENDERS = {
      date:   m => <span className="text-slate-500 text-xs">{fmtDate(m.changed_at)}</span>,
      serial: m => (
        <span>
          <a href={`/erp/serials/${m.serial_id}`} className="text-brand-600 hover:underline">{m.serial}</a>
          {m.serial_airtable_id && (
            <a
              href={`https://airtable.com/appB4Fehk9jYd4s4B/tblJKSmWxtwBQjdmB/viw6ZdCpuYAQ6KWT2/${m.serial_airtable_id}?blocks=hide`}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-2 text-xs text-amber-600 hover:text-amber-800 underline"
              title="Éditer dans Airtable"
            >Airtable ↗</a>
          )}
        </span>
      ),
      company: m => <span className="text-slate-500 text-xs">{m.company_name || '—'}</span>,
      value:   m => <span className="text-red-600 text-xs">{m.value_label}</span>,
    }
    return TABLE_COLUMN_META.serial_missing_valuations.map(meta => ({ ...meta, render: RENDERS[meta.id] }))
  }, [])

  return (
    <Layout>
      <div className="p-6 max-w-6xl mx-auto">
        <h1 className="text-xl font-bold text-slate-900 mb-1">Mouvements numéros de série</h1>
        <p className="text-sm text-slate-500 mb-4">
          Chaque transition d'état produit une ligne débit/crédit. L'agrégation hebdomadaire poussera une écriture de journal QuickBooks combinant toutes les transitions de la semaine.
        </p>

        {accountsError && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800 flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
            <div>QuickBooks non connecté ou inaccessible — les comptes ne peuvent pas être chargés. ({accountsError})</div>
          </div>
        )}

        <div className="flex items-center gap-3 mb-3 text-sm">
          <span className="text-slate-600">Fenêtre d'analyse:</span>
          {[30, 90, 180, 365].map(d => (
            <button
              key={d}
              onClick={() => setWindowDays(d)}
              className={`px-2 py-1 rounded ${windowDays === d ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
            >{d}j</button>
          ))}
        </div>

        {missingVals.total > 0 && (
          <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded text-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-red-800">
                <AlertCircle size={14} />
                <strong>{missingVals.total}</strong> changement(s) d'état avec valeur de fabrication manquante ou nulle dans la fenêtre.
                Ces transitions ne pourront pas générer d'écriture comptable.
              </div>
              <button
                onClick={() => setShowMissing(s => !s)}
                className="text-xs text-red-700 hover:text-red-900 underline"
              >
                {showMissing ? 'Masquer' : 'Voir le détail'}
              </button>
            </div>
            {showMissing && (
              <div className="mt-3">
                <DataTable
                  table="serial_missing_valuations"
                  columns={missingColumns}
                  data={missingRows}
                  loading={loading}
                  searchFields={['serial', 'product', 'company_name', 'transition']}
                  height="320px"
                />
                {missingVals.data.length < missingVals.total && (
                  <p className="text-xs text-slate-400 px-2 py-1">… {missingVals.total - missingVals.data.length} autres lignes non affichées.</p>
                )}
              </div>
            )}
          </div>
        )}

        <DataTable
          table="serial_transitions"
          columns={transitionColumns}
          data={transitionRows}
          loading={loading}
          searchFields={['previous_status', 'new_status']}
          height="calc(100vh - 460px)"
          emptyState={{ icon: AlertCircle, title: 'Aucune transition ni règle', description: "Aucune transition d'état observée dans la fenêtre et aucune règle définie." }}
        />

        <div className="mt-8">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-base font-semibold text-slate-900">Toutes les règles ({rules.length})</h2>
            <button
              onClick={() => setModal({})}
              className="btn-primary text-xs flex items-center gap-1"
              disabled={!accounts.length}
            >
              <Plus size={12} /> Nouvelle règle
            </button>
          </div>
          <DataTable
            table="serial_accounting_rules"
            columns={ruleColumns}
            data={ruleRows}
            loading={loading}
            searchFields={['previous_status', 'new_status', 'debit_account_name', 'credit_account_name']}
            height="calc(100vh - 460px)"
            emptyState={{ icon: AlertCircle, title: 'Aucune règle définie', description: 'Crée une règle de mapping pour générer les écritures comptables.' }}
          />
        </div>
      </div>

      <Modal
        isOpen={!!modal}
        onClose={() => setModal(null)}
        title={modal?.rule ? 'Modifier la règle' : 'Nouvelle règle de mapping'}
        size="md"
      >
        {modal && (
          <RuleForm
            initial={modal.rule}
            transition={modal.transition}
            accounts={accounts}
            onSave={() => { setModal(null); reload() }}
            onCancel={() => setModal(null)}
          />
        )}
      </Modal>
    </Layout>
  )
}
