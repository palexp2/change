import { useState, useEffect, useRef } from 'react'
import { Trash2, GripVertical, Plus, X, Clock, Table2, CreditCard } from 'lucide-react'
import { api } from '../lib/api.js'
import { fmtDateTime } from '../lib/formatDate.js'
import { SearchableSelect } from './SearchableSelect.jsx'
import {
  BLOCKS, DEFAULT_CONFIG, OPS, FREQS, WEEKDAYS, READABLE_TABLES, WATCHED_TABLES,
  tableLabel, stepSummary, triggerSummary, triggerKindOf, TRIGGER_TITLES,
} from '../lib/automationBlocks.js'

// Briques de la page Automatisations (façon Airtable) : canevas déclencheur →
// actions au centre, réglages du bloc choisi dans le panneau de droite.

const Section = ({ title, children }) => (
  <div className="p-4 border-b border-slate-100">
    <h4 className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase mb-3">{title}</h4>
    {children}
  </div>
)
const Row = ({ label, children }) => (
  <label className="block mb-3">
    <span className="block text-xs text-slate-500 mb-1">{label}</span>
    {children}
  </label>
)

/** Colonnes d'une table (libellé lisible), mises en cache. */
const colCache = new Map()
export function useColumns(table) {
  const [cols, setCols] = useState(() => colCache.get(table) || [])
  useEffect(() => {
    if (!table) { setCols([]); return }
    if (colCache.has(table)) { setCols(colCache.get(table)); return }
    let off = false
    api.automations.ruleFieldDefs(table).then(r => {
      const list = (r.columns || []).map(c => ({ value: c.column_name, label: c.airtable_field_name || c.column_name }))
        .sort((a, b) => a.label.localeCompare(b.label, 'fr'))
      colCache.set(table, list)
      if (!off) setCols(list)
    }).catch(() => {})
    return () => { off = true }
  }, [table])
  return cols
}

// ── Canevas ──────────────────────────────────────────────────────────────────

function Block({ icon, bg, title, sub, selected, onClick, drag }) {
  return (
    <div onClick={onClick} {...drag}
      className={`flex items-center gap-3 bg-white rounded-xl px-3.5 py-3 cursor-pointer transition ${selected ? 'border-2 border-brand-600 -m-px' : 'border border-slate-200 hover:border-slate-300'} ${drag?.className || ''}`}>
      {drag && <GripVertical size={14} className="text-slate-300 shrink-0 cursor-grab" />}
      <div className="w-9 h-9 rounded-lg grid place-items-center shrink-0 text-slate-700" style={{ background: bg }}>{icon}</div>
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-800">{title}</div>
        <div className="text-xs text-slate-500 truncate">{sub || '—'}</div>
      </div>
    </div>
  )
}
const Wire = () => <div className="w-0.5 h-5 bg-slate-300 ml-8" />
const Label = ({ children }) => <div className="text-[11px] font-semibold tracking-wider text-slate-500 mb-2">{children}</div>

export function FlowCanvas({ automation, tc, steps, step, onSelect, onAdd, onMove, users, colLabel, productLabel }) {
  const [menu, setMenu] = useState(false)
  const [dragI, setDragI] = useState(null)
  const [overI, setOverI] = useState(null)
  const menuRef = useRef(null)
  useEffect(() => {
    if (!menu) return
    const close = e => { if (!menuRef.current?.contains(e.target)) setMenu(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])
  const tk = triggerKindOf(automation, tc)
  const TIcon = { field_rule: Table2, schedule: Clock, subscription_product: CreditCard }[tk]
  return (
    <div className="max-w-md mx-auto">
      <Label>DÉCLENCHEUR</Label>
      <Block icon={<TIcon size={17} />} bg="#e0f2e7" title={tk === 'subscription_product' && tc?.event === 'lost' ? 'Quand un abonnement perd un produit' : TRIGGER_TITLES[tk]}
        sub={triggerSummary(automation, tc, colLabel, productLabel)} selected={step === 0} onClick={() => onSelect(0)} />
      <Wire />
      <Label>ACTIONS</Label>
      {steps.map((s, i) => {
        const b = BLOCKS[s.type] || BLOCKS.script
        return (
          <div key={s.id || i}>
            {i > 0 && <Wire />}
            <Block icon={<b.Icon size={17} />} bg={b.bg} title={b.label} sub={stepSummary(s, users)} selected={step === i + 1}
              onClick={() => onSelect(i + 1)}
              drag={{
                draggable: true,
                onDragStart: () => setDragI(i),
                onDragEnd: () => { setDragI(null); setOverI(null) },
                onDragOver: e => { e.preventDefault(); setOverI(i) },
                onDrop: e => { e.preventDefault(); if (dragI !== null && dragI !== i) onMove(dragI, i); setDragI(null); setOverI(null) },
                className: `${dragI === i ? 'opacity-40' : ''} ${overI === i && dragI !== i ? 'ring-2 ring-brand-400' : ''}`,
              }} />
          </div>
        )
      })}
      {steps.length > 0 && <Wire />}
      <div className="relative inline-block ml-4" ref={menuRef}>
        <button onClick={() => setMenu(m => !m)}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-600 bg-white border border-dashed border-slate-400 rounded-lg hover:border-brand-500 hover:text-brand-700">
          <Plus size={12} /> Action
        </button>
        {menu && (
          <div className="absolute z-20 top-9 left-0 w-64 bg-white border border-slate-200 rounded-xl shadow-lg p-1.5">
            {Object.entries(BLOCKS).map(([k, b]) => (
              <button key={k} onClick={() => { setMenu(false); onAdd(k) }}
                className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-sm text-left hover:bg-slate-50">
                <span className="w-7 h-7 rounded-md grid place-items-center text-slate-700" style={{ background: b.bg }}><b.Icon size={14} /></span>
                {b.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Déclencheur ──────────────────────────────────────────────────────────────

function ConditionsEditor({ table, rules, onChange, withConj, conj, onConj }) {
  const cols = useColumns(table)
  const set = (i, patch) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div>
      {withConj && rules.length > 1 && (
        <div className="flex gap-1 mb-2">
          {[['AND', 'Toutes (et)'], ['OR', 'Au moins une (ou)']].map(([v, l]) => (
            <button key={v} onClick={() => onConj(v)}
              className={`px-2 py-0.5 rounded text-xs border ${conj === v ? 'bg-brand-50 border-brand-300 text-brand-700' : 'border-slate-200 text-slate-500'}`}>{l}</button>
          ))}
        </div>
      )}
      {rules.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_96px_1fr_20px] gap-1.5 mb-1.5 items-center">
          <SearchableSelect value={r.column} options={cols} className="input input-sm text-xs" onChange={v => set(i, { column: v })} />
          <select className="input input-sm text-xs" value={r.op || 'eq'} onChange={e => set(i, { op: e.target.value })}>
            {OPS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {r.op === 'not_null' ? <span /> : (
            <input className="input input-sm text-xs" value={r.value ?? ''} onChange={e => set(i, { value: e.target.value })} />
          )}
          <button onClick={() => onChange(rules.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-600"><X size={14} /></button>
        </div>
      ))}
      <button onClick={() => onChange([...rules, { column: '', op: 'eq', value: '' }])}
        className="text-sm text-brand-700 hover:underline">+ Condition</button>
    </div>
  )
}

function ProductsEditor({ value, onChange, products }) {
  const label = id => products.find(p => p.value === id)?.label || id
  return (
    <div>
      {value.map(id => (
        <div key={id} className="flex items-center justify-between gap-2 mb-1.5 px-2.5 py-1.5 rounded-lg bg-slate-50 text-sm">
          <span className="truncate">{label(id)}</span>
          <button onClick={() => onChange(value.filter(x => x !== id))} className="text-slate-400 hover:text-red-600"><X size={14} /></button>
        </div>
      ))}
      <SearchableSelect value="" className="input input-sm text-xs" options={products.filter(p => !value.includes(p.value))}
        placeholder="+ Produit" onChange={v => v && onChange([...value, v])} />
    </div>
  )
}

export function TriggerPanel({ automation, tc, onKind, onTc, tables, products = [] }) {
  const tk = triggerKindOf(automation, tc)
  const flow = tk === 'schedule'
  const rules = tc.conditions?.rules || []
  const tableOptions = [...new Set([...WATCHED_TABLES, ...(tables || [])])]
    .map(t => ({ value: t, label: tableLabel(t) })).sort((a, b) => a.label.localeCompare(b.label, 'fr'))
  return (
    <>
      <Section title="Déclencheur">
        <Row label="Type">
          <select className="input" value={tk} onChange={e => onKind(e.target.value)}>
            {Object.entries(TRIGGER_TITLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Row>
        {tk === 'subscription_product' ? (
          <>
            <Row label="Quand">
              <select className="input" value={tc.event === 'lost' ? 'lost' : 'contains'}
                onChange={e => onTc({ ...tc, event: e.target.value === 'lost' ? 'lost' : undefined })}>
                <option value="contains">Contient le produit</option>
                <option value="lost">Le perd (annulé ou retiré)</option>
              </select>
            </Row>
            <Row label="Produits">
              <ProductsEditor value={tc.products || []} products={products} onChange={p => onTc({ ...tc, products: p })} />
            </Row>
          </>
        ) : flow ? (
          <>
            <Row label="Fréquence">
              <select className="input" value={tc.freq || 'day'} onChange={e => onTc({ ...tc, freq: e.target.value })}>
                {FREQS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </Row>
            {tc.freq === 'week' && (
              <Row label="Jour">
                <select className="input" value={tc.weekday ?? 1} onChange={e => onTc({ ...tc, weekday: Number(e.target.value) })}>
                  {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select>
              </Row>
            )}
            {tc.freq === 'month' && (
              <Row label="Jour du mois">
                <input type="number" min="1" max="28" className="input" value={tc.monthday ?? 1}
                  onChange={e => onTc({ ...tc, monthday: Number(e.target.value) })} />
              </Row>
            )}
            {['day', 'week', 'month'].includes(tc.freq || 'day') && (
              <Row label="Heure">
                <input type="time" className="input" value={tc.time || '08:00'} onChange={e => onTc({ ...tc, time: e.target.value })} />
              </Row>
            )}
          </>
        ) : (
          <Row label="Table">
            <SearchableSelect value={tc.erp_table} options={tableOptions} className="input"
              onChange={v => onTc({ ...tc, erp_table: v, conditions: { conjunction: 'AND', rules: [] } })} />
          </Row>
        )}
      </Section>
      {tk === 'field_rule' && (
        <Section title="Conditions">
          <ConditionsEditor table={tc.erp_table} rules={rules} withConj conj={tc.conditions?.conjunction || 'AND'}
            onConj={c => onTc({ ...tc, conditions: { ...tc.conditions, conjunction: c, rules } })}
            onChange={r => onTc({ ...tc, conditions: { conjunction: tc.conditions?.conjunction || 'AND', rules: r } })} />
        </Section>
      )}
    </>
  )
}

// ── Action ───────────────────────────────────────────────────────────────────

export function StepPanel({ step, index, onChange, onType, onDelete, users, triggerTable, triggerTokens, prevSteps }) {
  const b = BLOCKS[step.type] || BLOCKS.script
  const c = step.config || {}
  const set = patch => onChange({ ...step, config: { ...c, ...patch } })
  const lastField = useRef(null)
  const triggerCols = useColumns(triggerTable)

  function insert(token) {
    const el = lastField.current
    if (!el || !el.dataset.key) return
    const s = el.selectionStart ?? el.value.length
    const e = el.selectionEnd ?? s
    const v = el.value.slice(0, s) + token + el.value.slice(e)
    set({ [el.dataset.key]: v })
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + token.length, s + token.length) })
  }
  const textProps = key => ({ 'data-key': key, value: c[key] ?? '', onFocus: e => { lastField.current = e.target }, onChange: e => set({ [key]: e.target.value }) })

  const tokens = [
    ...(triggerTokens || triggerCols).map(col => ({ token: `{{${col.value}}}`, label: col.label })),
    ...prevSteps.flatMap((s, i) => (s.type === 'find'
      ? [{ token: `{{etape${i + 1}.nombre}}`, label: `Action ${i + 1} · nombre` }, { token: `{{etape${i + 1}.liste}}`, label: `Action ${i + 1} · liste` }]
      : [])),
  ]

  return (
    <>
      <Section title={`Action ${index + 1}`}>
        <Row label="Type">
          <select className="input" value={step.type} onChange={e => onType(e.target.value)}>
            {Object.entries(BLOCKS).map(([k, x]) => <option key={k} value={k}>{x.label}</option>)}
          </select>
        </Row>
        {b.fields.map(([key, label, type]) => (
          <Row key={key} label={label}>
            {type === 'text' && <input className="input" {...textProps(key)} />}
            {type === 'slack_channel' && <SlackChannelSelect value={c[key] || ''} onChange={v => set({ [key]: v })} />}
            {type === 'number' &&<input type="number" className="input" value={c[key] ?? ''} onChange={e => set({ [key]: e.target.value === '' ? '' : Number(e.target.value) })} />}
            {type === 'area' && <textarea rows={4} className="input" {...textProps(key)} />}
            {type === 'code' && <textarea rows={14} spellCheck={false} className="input input-sm text-xs font-mono" {...textProps(key)} />}
            {type === 'user' && (
              <SearchableSelect value={c[key] || ''} emptyOption="Personne" className="input"
                options={users.map(u => ({ value: u.id, label: u.name || u.email }))} onChange={v => set({ [key]: v || null })} />
            )}
            {type === 'priority' && (
              <select className="input" value={c[key] || 'Normal'} onChange={e => set({ [key]: e.target.value })}>
                {['Basse', 'Normal', 'Haute', 'Urgent'].map(p => <option key={p}>{p}</option>)}
              </select>
            )}
            {type === 'object' && (
              <select className="input" value={c[key] || 'contacts'} onChange={e => set({ [key]: e.target.value })}>
                <option value="contacts">Contact</option><option value="companies">Entreprise</option>
              </select>
            )}
            {type === 'readable' && (
              <SearchableSelect value={c[key]} className="input"
                options={READABLE_TABLES.map(t => ({ value: t, label: tableLabel(t) }))} onChange={v => set({ [key]: v, conditions: [] })} />
            )}
            {type === 'conditions' && <ConditionsEditor table={c.table} rules={c.conditions || []} onChange={r => set({ conditions: r })} />}
            {type === 'fields' && <FieldsEditor table={triggerTable} fields={c.fields || []} onChange={f => set({ fields: f })} />}
          </Row>
        ))}
        {step.type !== 'script' && tokens.length > 0 && (
          <div className="mt-1">
            <span className="block text-xs text-slate-500 mb-1">Insérer un champ</span>
            <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
              {tokens.map(t => (
                <button key={t.token} onMouseDown={e => { e.preventDefault(); insert(t.token) }}
                  className="px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 text-xs hover:bg-brand-100">{t.label}</button>
              ))}
            </div>
          </div>
        )}
      </Section>
      <div className="p-4 flex gap-2 justify-end">
        <button onClick={onDelete} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50">
          <Trash2 size={13} /> Supprimer
        </button>
      </div>
    </>
  )
}

// Canaux et personnes Slack, chargés une fois par session. Valeur gardée
// « #nom » ou « U… » (résolue côté serveur) ; une ancienne valeur hors liste
// reste affichée — un message privé « D… » connu prend le nom de la personne.
let slackChannelsP = null
function SlackChannelSelect({ value, onChange }) {
  const [list, setList] = useState([])
  useEffect(() => {
    slackChannelsP ||= api.automations.slackChannels().catch(e => { slackChannelsP = null; throw e })
    let off = false
    slackChannelsP.then(r => { if (!off) setList(r) }).catch(() => {})
    return () => { off = true }
  }, [])
  const options = list.map(ch => (ch.user
    ? { value: ch.id, label: `@ ${ch.name}` }
    : { value: `#${ch.name}`, label: `${ch.private ? '🔒' : '#'} ${ch.name}` }))
  if (value && !options.some(o => o.value === value)) {
    const dm = list.find(u => u.user && u.dm === value)
    options.unshift({ value, label: dm ? `@ ${dm.name}` : value })
  }
  return <SearchableSelect value={value} options={options} className="input" onChange={v => onChange(v || '')} />
}

function FieldsEditor({ table, fields, onChange }) {
  const cols = useColumns(table)
  const set = (i, patch) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  return (
    <div>
      {fields.map((f, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_20px] gap-1.5 mb-1.5 items-center">
          <SearchableSelect value={f.column} options={cols} className="input input-sm text-xs" onChange={v => set(i, { column: v })} />
          <input className="input input-sm text-xs" value={f.value ?? ''} onChange={e => set(i, { value: e.target.value })} />
          <button onClick={() => onChange(fields.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-600"><X size={14} /></button>
        </div>
      ))}
      <button onClick={() => onChange([...fields, { column: '', value: '' }])} className="text-sm text-brand-700 hover:underline">+ Champ</button>
    </div>
  )
}

export const newStep = type => ({ id: Math.random().toString(36).slice(2, 10), type, config: structuredClone(DEFAULT_CONFIG[type] || {}) })

// ── Historique et test ───────────────────────────────────────────────────────

export function HistoryPanel({ automationId }) {
  const [logs, setLogs] = useState(null)
  useEffect(() => { api.automations.logs(automationId).then(setLogs).catch(() => setLogs([])) }, [automationId])
  const [open, setOpen] = useState(null)
  return (
    <Section title="Historique">
      {!logs ? <div className="text-xs text-slate-400">…</div> : !logs.length ? <div className="text-xs text-slate-400">Aucune exécution</div> : logs.map(l => (
        <div key={l.id} className="border-b border-slate-100 py-1.5 text-xs">
          <button className="w-full flex justify-between" onClick={() => setOpen(open === l.id ? null : l.id)}>
            <span className="text-slate-600">{fmtDateTime(l.created_at)}</span>
            <span className={l.status === 'error' ? 'text-red-600' : 'text-green-700'}>{l.status === 'error' ? 'Échec' : 'Réussi'}</span>
          </button>
          {open === l.id && <pre className="mt-1 whitespace-pre-wrap text-[11px] text-slate-600 bg-slate-50 rounded p-2">{l.error || l.result || '—'}</pre>}
        </div>
      ))}
    </Section>
  )
}

export function TestPanel({ automation, onDone }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)
  const flow = automation.trigger_type === 'schedule'
  useEffect(() => {
    if (flow) return
    api.automations.test(automation.id).then(setData).catch(e => setMsg({ err: true, text: e.message }))
  }, [automation.id, flow])
  async function run(recordId) {
    setBusy(recordId || 'flow'); setMsg(null)
    try {
      await api.automations.runNow(automation.id, recordId ? { record_id: recordId } : {})
      setMsg({ text: 'Exécutée' }); onDone?.()
    } catch (e) { setMsg({ err: true, text: e.message }) } finally { setBusy(null) }
  }
  return (
    <Section title="Tester">
      {msg && <div className={`text-xs mb-2 ${msg.err ? 'text-red-600' : 'text-green-700'}`}>{msg.text}</div>}
      {flow ? (
        <button onClick={() => run(null)} disabled={!!busy} className="px-3 py-1.5 text-sm bg-brand-600 text-white rounded-lg disabled:opacity-50">
          {busy ? '…' : 'Exécuter maintenant'}
        </button>
      ) : !data ? <div className="text-xs text-slate-400">…</div> : !data.previews?.length ? (
        <div className="text-xs text-slate-400">Aucun enregistrement ne correspond</div>
      ) : (
        <>
          <div className="text-xs text-slate-500 mb-2">{data.candidates_total} correspondent</div>
          {data.previews.map(p => (
            <div key={p.id} className="flex items-center justify-between gap-2 py-1 border-b border-slate-100 text-xs">
              <span className={`truncate ${p.already_fired ? 'text-slate-400' : ''}`}>{p.label}</span>
              <button onClick={() => run(p.id)} disabled={!!busy} className="shrink-0 px-2 py-0.5 border rounded text-brand-700 hover:bg-brand-50 disabled:opacity-50">
                {busy === p.id ? '…' : 'Exécuter'}
              </button>
            </div>
          ))}
        </>
      )}
    </Section>
  )
}
