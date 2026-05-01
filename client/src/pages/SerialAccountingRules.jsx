import { useState, useEffect, useMemo } from 'react'
import { Plus, Trash2, AlertCircle, CheckCircle2, ArrowRight, Ban } from 'lucide-react'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Modal } from '../components/Modal.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'

const VALUATION_LABELS = {
  manufacture_value: 'Valeur de fabrication',
  product_cost: 'Coût du produit',
  fixed_amount: 'Montant fixe',
}

function fmtDate(s) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('fr-CA')
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
            <select
              className="input"
              value={form.debit_account_id}
              onChange={e => setField('debit_account_id', e.target.value)}
              required
            >
              <option value="">— Choisir —</option>
              {accounts.map(a => (
                <option key={a.Id} value={a.Id}>
                  {a.FullyQualifiedName || a.Name} ({a.AccountType})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Compte crédit *</label>
            <select
              className="input"
              value={form.credit_account_id}
              onChange={e => setField('credit_account_id', e.target.value)}
              required
            >
              <option value="">— Choisir —</option>
              {accounts.map(a => (
                <option key={a.Id} value={a.Id}>
                  {a.FullyQualifiedName || a.Name} ({a.AccountType})
                </option>
              ))}
            </select>
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
              <div className="mt-3 max-h-72 overflow-auto bg-white rounded border border-red-100">
                <table className="w-full text-xs">
                  <thead className="bg-red-50 text-red-700">
                    <tr>
                      <th className="text-left px-2 py-1">Date</th>
                      <th className="text-left px-2 py-1">Serial</th>
                      <th className="text-left px-2 py-1">Produit</th>
                      <th className="text-left px-2 py-1">Client</th>
                      <th className="text-left px-2 py-1">Transition</th>
                      <th className="text-right px-2 py-1">Valeur</th>
                    </tr>
                  </thead>
                  <tbody>
                    {missingVals.data.map(m => (
                      <tr key={m.change_id} className="border-t border-red-50">
                        <td className="px-2 py-1 text-slate-500">{fmtDate(m.changed_at || m.created_at)}</td>
                        <td className="px-2 py-1">
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
                        </td>
                        <td className="px-2 py-1 text-slate-700">{m.product_name || m.product_sku || '—'}</td>
                        <td className="px-2 py-1 text-slate-500">{m.company_name || '—'}</td>
                        <td className="px-2 py-1 text-slate-600">
                          {statusLabel(m.previous_status)} → {statusLabel(m.new_status)}
                        </td>
                        <td className="px-2 py-1 text-right text-red-600">
                          {m.manufacture_value == null ? 'NULL' : '0 $'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {missingVals.data.length < missingVals.total && (
                  <p className="text-xs text-slate-400 px-2 py-1">… {missingVals.total - missingVals.data.length} autres lignes non affichées.</p>
                )}
              </div>
            )}
          </div>
        )}

        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">État précédent</th>
                <th className="text-left px-3 py-2"></th>
                <th className="text-left px-3 py-2">Nouvel état</th>
                <th className="text-right px-3 py-2">Occurrences</th>
                <th className="text-right px-3 py-2">Sans valeur</th>
                <th className="text-left px-3 py-2">Dernière</th>
                <th className="text-left px-3 py-2">Mapping</th>
                <th className="text-right px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">Chargement…</td></tr>
              )}
              {!loading && mergedRows.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">Aucune transition ni règle.</td></tr>
              )}
              {mergedRows.map((t) => {
                const rule = ruleByKey.get(t.key)
                return (
                  <tr key={t.key} className={`border-t border-slate-100 hover:bg-slate-50 ${t.source === 'rule_only' ? 'bg-slate-50/40' : ''}`}>
                    <td className="px-3 py-2 text-slate-700">{statusLabel(t.previous_status)}</td>
                    <td className="px-3 py-2 text-slate-300"><ArrowRight size={14} /></td>
                    <td className="px-3 py-2 text-slate-900 font-medium">{statusLabel(t.new_status)}</td>
                    <td className="px-3 py-2 text-right text-slate-700">
                      {t.count > 0 ? t.count : <span className="text-slate-300">0</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-xs">
                      {t.missing_value_count > 0
                        ? <span className="inline-flex items-center gap-1 text-red-600 font-medium" title="Numéros de série sans valeur de fabrication">
                            <AlertCircle size={11} /> {t.missing_value_count}
                          </span>
                        : <span className="text-slate-300">—</span>
                      }
                    </td>
                    <td className="px-3 py-2 text-slate-500 text-xs">{t.last_seen ? fmtDate(t.last_seen) : '—'}</td>
                    <td className="px-3 py-2">
                      {rule ? (
                        rule.skip_accounting
                          ? <span className="inline-flex items-center gap-1 text-xs text-slate-500"><Ban size={12} /> Aucune écriture</span>
                          : <span className="inline-flex items-center gap-1 text-xs text-green-700">
                              <CheckCircle2 size={12} />
                              {rule.debit_account_name?.split(':').pop() || rule.debit_account_id} / {rule.credit_account_name?.split(':').pop() || rule.credit_account_id}
                            </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-red-600">
                          <AlertCircle size={12} /> Non mappé
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {rule ? (
                        <button
                          onClick={() => setModal({ rule })}
                          className="text-xs text-brand-600 hover:text-brand-800"
                        >Modifier</button>
                      ) : (
                        <button
                          onClick={() => setModal({ transition: t })}
                          className="inline-flex items-center gap-1 text-xs text-brand-600 hover:text-brand-800"
                        >
                          <Plus size={12} /> Mapper
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

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
          <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">Transition</th>
                  <th className="text-left px-3 py-2">Débit</th>
                  <th className="text-left px-3 py-2">Crédit</th>
                  <th className="text-left px-3 py-2">Valeur</th>
                  <th className="text-left px-3 py-2">Actif</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rules.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Aucune règle définie.</td></tr>
                )}
                {rules.map(r => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">
                      <span className="text-slate-500">{statusLabel(r.previous_status)}</span>
                      <ArrowRight size={12} className="inline mx-1 text-slate-300" />
                      <span className="text-slate-900 font-medium">{statusLabel(r.new_status)}</span>
                    </td>
                    <td className="px-3 py-2 text-slate-700 text-xs">
                      {r.skip_accounting ? <span className="text-slate-400 italic">— skip —</span> : (r.debit_account_name || r.debit_account_id)}
                    </td>
                    <td className="px-3 py-2 text-slate-700 text-xs">
                      {r.skip_accounting ? <span className="text-slate-400 italic">— skip —</span> : (r.credit_account_name || r.credit_account_id)}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {r.skip_accounting
                        ? <span className="text-slate-400">Aucune écriture</span>
                        : (<>
                            {VALUATION_LABELS[r.valuation_source]}
                            {r.valuation_source === 'fixed_amount' && r.fixed_amount != null && ` (${r.fixed_amount} $)`}
                          </>)
                      }
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {r.active ? <span className="text-green-700">Oui</span> : <span className="text-slate-400">Non</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => setModal({ rule: r })} className="text-xs text-brand-600 hover:text-brand-800 mr-3">Modifier</button>
                      <button onClick={() => deleteRule(r.id)} className="text-xs text-red-600 hover:text-red-800 inline-flex items-center gap-1">
                        <Trash2 size={11} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
