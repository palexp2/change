import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Plus, Trash2, ChevronDown, Check } from 'lucide-react'
import api from '../lib/api.js'
import { Modal } from './Modal.jsx'
import { useConfirm } from './ConfirmProvider.jsx'

export function TaxMappingModal({ isOpen, onClose }) {
  const [mappings, setMappings] = useState([])
  const [qbTaxCodes, setQbTaxCodes] = useState([])
  const [qbTaxError, setQbTaxError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ stripe_tax_ids: [], stripe_tax_description: '', qb_tax_code: '' })
  const [manualTaxId, setManualTaxId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const confirm = useConfirm()

  const qbTaxCodeMap = useMemo(() => {
    const map = new Map()
    qbTaxCodes.forEach(tc => map.set(tc.Id, tc))
    return map
  }, [qbTaxCodes])

  const reload = useCallback(async () => {
    setLoading(true)
    setQbTaxError(null)
    try {
      const [m, tc] = await Promise.all([
        api.stripeQueue.taxMappings(),
        api.quickbooks.taxCodes().catch(e => { setQbTaxError(e.message || 'QuickBooks non connecté'); return [] }),
      ])
      setMappings(m || [])
      setQbTaxCodes(tc || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (isOpen) reload() }, [isOpen, reload])

  async function handleSave(e) {
    e.preventDefault()
    setError(null)
    if (form.stripe_tax_ids.length === 0 || !form.qb_tax_code.trim()) {
      setError('Au moins un Stripe Tax ID et un QB Tax Code sont requis')
      return
    }
    const combinedKey = [...new Set(form.stripe_tax_ids)].sort().join('+')
    setSaving(true)
    try {
      await api.stripeQueue.saveTaxMapping({
        stripe_tax_id: combinedKey,
        stripe_tax_description: form.stripe_tax_description,
        qb_tax_code: form.qb_tax_code,
      })
      setForm({ stripe_tax_ids: [], stripe_tax_description: '', qb_tax_code: '' })
      setManualTaxId('')
      await reload()
    } catch (err) {
      setError(err.message || 'Erreur lors de l\'enregistrement')
    } finally {
      setSaving(false)
    }
  }

  const knownStripeTaxIds = useMemo(() => {
    const map = new Map()
    mappings.forEach(m => {
      const ids = String(m.stripe_tax_id).split('+')
      ids.forEach(id => {
        if (!map.has(id)) map.set(id, { id, percentage: null })
      })
    })
    return [...map.values()].sort((a, b) => a.id.localeCompare(b.id))
  }, [mappings])

  function toggleTaxId(id) {
    setForm(f => ({
      ...f,
      stripe_tax_ids: f.stripe_tax_ids.includes(id)
        ? f.stripe_tax_ids.filter(x => x !== id)
        : [...f.stripe_tax_ids, id],
    }))
  }

  function addManualTaxId() {
    const v = manualTaxId.trim()
    if (!v) return
    setForm(f => ({
      ...f,
      stripe_tax_ids: f.stripe_tax_ids.includes(v) ? f.stripe_tax_ids : [...f.stripe_tax_ids, v],
    }))
    setManualTaxId('')
  }

  async function handleDelete(id) {
    if (!(await confirm('Supprimer ce mapping ?'))) return
    await api.stripeQueue.deleteTaxMapping(id)
    await reload()
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Taxes Stripe → QuickBooks" size="lg">
      <div className="p-5 space-y-5 overflow-y-auto">
        <div>
          <p className="text-xs text-slate-500 mb-2">
            Associe chaque taux de taxe Stripe à un code de taxe QuickBooks. Utilisé lors du push des payouts Stripe vers QB.
          </p>
        </div>

        {/* Existing mappings */}
        <div>
          <h3 className="text-sm font-semibold text-slate-900 mb-2">Mappings actifs</h3>
          {loading ? (
            <div className="text-sm text-slate-500">Chargement…</div>
          ) : mappings.length === 0 ? (
            <div className="text-sm text-slate-400 italic">Aucun mapping configuré</div>
          ) : (
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-3 py-2">Stripe Tax ID</th>
                    <th className="text-left px-3 py-2">QB Tax Code</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {mappings.map(m => {
                    const tc = qbTaxCodeMap.get(String(m.qb_tax_code))
                    return (
                    <tr key={m.id}>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {String(m.stripe_tax_id).split('+').map(id => (
                            <span key={id} className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-mono text-[11px]">
                              {id}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {tc ? (
                          <span><span className="font-medium">{tc.Name}</span> <span className="text-xs font-mono text-slate-400">#{m.qb_tax_code}</span></span>
                        ) : (
                          <span className="font-mono text-xs">{m.qb_tax_code}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => handleDelete(m.id)}
                          className="text-slate-400 hover:text-red-600"
                          title="Supprimer"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  )})}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Add / edit form */}
        <form onSubmit={handleSave} className="border-t border-slate-200 pt-4 space-y-3">
          <h3 className="text-sm font-semibold text-slate-900">Ajouter / mettre à jour</h3>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">
              Stripe Tax IDs <span className="text-slate-400 font-normal">(cocher un ou plusieurs pour un taux combiné)</span>
            </label>
            {knownStripeTaxIds.length > 0 && (
              <div className="border border-slate-200 rounded-lg p-2 max-h-32 overflow-y-auto space-y-1 bg-white">
                {knownStripeTaxIds.map(r => {
                  const checked = form.stripe_tax_ids.includes(r.id)
                  return (
                    <label key={r.id} className={`flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-slate-50 ${checked ? 'bg-indigo-50' : ''}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleTaxId(r.id)}
                        className="rounded"
                      />
                      <span className="font-mono text-xs text-slate-700">{r.id}</span>
                      {r.percentage != null && (
                        <span className="text-xs text-slate-400">({r.percentage}%)</span>
                      )}
                    </label>
                  )
                })}
              </div>
            )}
            <div className="flex gap-2 mt-2">
              <input
                type="text"
                placeholder="txr_... (saisie manuelle)"
                value={manualTaxId}
                onChange={e => setManualTaxId(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addManualTaxId() } }}
                className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button
                type="button"
                onClick={addManualTaxId}
                className="px-3 py-1.5 text-sm bg-slate-100 hover:bg-slate-200 rounded-lg"
              >
                Ajouter
              </button>
            </div>
            {form.stripe_tax_ids.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {form.stripe_tax_ids.map(id => (
                  <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-mono text-xs">
                    {id}
                    <button type="button" onClick={() => toggleTaxId(id)} className="hover:text-indigo-900">
                      ×
                    </button>
                  </span>
                ))}
                {form.stripe_tax_ids.length > 1 && (
                  <span className="text-xs text-slate-400 self-center ml-1">
                    → clé combinée : <span className="font-mono">{[...form.stripe_tax_ids].sort().join('+')}</span>
                  </span>
                )}
              </div>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">QB Tax Code</label>
            <QbTaxCodeCombobox
              value={form.qb_tax_code}
              onChange={v => setForm({ ...form, qb_tax_code: v })}
              options={qbTaxCodes}
              error={qbTaxError}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Description (optionnel)</label>
            <input
              type="text"
              placeholder="Ex: TPS+TVQ Québec"
              value={form.stripe_tax_description}
              onChange={e => setForm({ ...form, stripe_tax_description: e.target.value })}
              className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50"
            >
              <Plus size={14} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  )
}

function QbTaxCodeCombobox({ value, onChange, options, error }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapRef = useRef(null)

  useEffect(() => {
    function handle(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  const selected = useMemo(() => options.find(o => String(o.Id) === String(value)), [options, value])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(o =>
      o.Name?.toLowerCase().includes(q) ||
      o.Description?.toLowerCase().includes(q) ||
      String(o.Id).includes(q)
    )
  }, [options, query])

  function select(tc) {
    onChange(String(tc.Id))
    setOpen(false)
    setQuery('')
  }

  if (error) {
    return (
      <div className="text-xs text-red-600 border border-red-200 bg-red-50 rounded-lg px-2 py-2">
        Impossible de charger les codes QB : {error}
      </div>
    )
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between border border-slate-200 rounded-lg px-2 py-1.5 text-sm bg-white hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        <span className={selected ? 'text-slate-900' : 'text-slate-400'}>
          {selected ? (
            <><span className="font-medium">{selected.Name}</span> <span className="text-xs font-mono text-slate-400">#{selected.Id}</span></>
          ) : (
            options.length === 0 ? 'Aucun code disponible' : 'Sélectionner un code…'
          )}
        </span>
        <ChevronDown size={14} className="text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-64 flex flex-col">
          <input
            type="text"
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Rechercher…"
            className="px-2 py-1.5 text-sm border-b border-slate-100 focus:outline-none"
          />
          <div className="overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-slate-400 italic">Aucun résultat</div>
            ) : (
              filtered.map(tc => {
                const isSel = String(tc.Id) === String(value)
                return (
                  <button
                    key={tc.Id}
                    type="button"
                    onClick={() => select(tc)}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-indigo-50 flex items-start gap-2 ${isSel ? 'bg-indigo-50' : ''}`}
                  >
                    <Check size={14} className={`mt-0.5 flex-shrink-0 ${isSel ? 'text-indigo-600' : 'text-transparent'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-slate-900 truncate">{tc.Name}</div>
                      {tc.Description && <div className="text-xs text-slate-500 truncate">{tc.Description}</div>}
                      <div className="text-xs font-mono text-slate-400">#{tc.Id}{tc.Taxable === false ? ' • non taxable' : ''}</div>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
