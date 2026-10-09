import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Search, ChevronDown, ChevronRight, History, FlaskConical, Trash2, Zap, Code2, Settings2, Table2, Clock, Webhook, Hand, CheckSquare, MessageSquare, Mail, Pencil, FilePlus, Users, BookOpen, Sheet, CreditCard, Database, HardDrive, RefreshCw, Lock } from 'lucide-react'
import { Layout } from '../components/Layout.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { api } from '../lib/api.js'
import AutomationDetail from './AutomationDetail.jsx'
import { FlowCanvas, TriggerPanel, StepPanel, HistoryPanel, TestPanel, newStep, useColumns } from '../components/AutomationBuilder.jsx'
import { SUB_TOKENS } from '../lib/automationBlocks.js'

// Page Automatisations façon Airtable (demande de Charles, 2026-10-09) : liste
// groupée à gauche, déclencheur → actions au centre, réglages à droite. Les
// automatisations en blocs (action_type « steps ») s'éditent ici ; les autres
// (système, scripts, webhooks) gardent leur fiche dans le panneau de droite.

const parse = s => { try { return JSON.parse(s || '{}') } catch { return {} } }
// Condition en cours de saisie (sans champ) : gardée à l'écran, pas envoyée.
const complete = tc => (tc.conditions ? { ...tc, conditions: { ...tc.conditions, rules: (tc.conditions.rules || []).filter(r => r.column) } } : tc)
const isBuilder = a => a?.action_type === 'steps' && !a.system

function readWidth(k, d) { try { return Number(localStorage.getItem(`autoW_${k}`)) || d } catch { return d } }
function saveWidth(k, v) { try { localStorage.setItem(`autoW_${k}`, String(v)) } catch { /* stockage indisponible */ } }

function Resizer({ onDrag }) {
  function down(e) {
    e.preventDefault()
    const x0 = e.clientX
    onDrag(0, true)
    const mv = ev => onDrag(ev.clientX - x0)
    const up = () => { onDrag(null); removeEventListener('mousemove', mv); removeEventListener('mouseup', up); document.body.style.cursor = '' }
    document.body.style.cursor = 'col-resize'
    addEventListener('mousemove', mv); addEventListener('mouseup', up)
  }
  return <div onMouseDown={down} className="w-1.5 -mx-[3px] z-10 shrink-0 cursor-col-resize hover:bg-brand-400 transition-colors" />
}

function useResizable(key, def) {
  const [w, setW] = useState(() => readWidth(key, def))
  const base = useRef(w)
  const drag = useCallback((dx, start, sign = 1) => {
    if (start) { base.current = w; return }
    if (dx === null) { setW(cur => { saveWidth(key, cur); return cur }); return }
    setW(Math.min(720, Math.max(220, base.current + sign * dx)))
  }, [key, w])
  return [w, drag]
}

export default function Automations() {
  const [list, setList] = useState([])
  const [params, setParams] = useSearchParams()
  const selId = params.get('id')
  const [q, setQ] = useState('')
  const [closed, setClosed] = useState({})
  const [step, setStep] = useState(0)
  const [panel, setPanel] = useState('edit') // edit | history | test
  const [users, setUsers] = useState([])
  const [tables, setTables] = useState([])
  const [products, setProducts] = useState([])
  const [leftW, dragLeft] = useResizable('left', 320)
  const [rightW, dragRight] = useResizable('right', 380)
  const { addToast } = useToast()
  const confirm = useConfirm()

  const load = useCallback(() => api.automations.list().then(setList).catch(() => addToast({ message: 'Erreur de chargement', type: 'error' })), [addToast])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.auth.users().then(u => setUsers((u || []).filter(x => x.active !== 0))).catch(() => {})
    api.automations.fieldRuleTables().then(setTables).catch(() => {})
    api.stripeCatalog.list().then(d => setProducts((d.offers || []).flatMap(o => (o.stripe_products || []).map(p => ({
      value: p.id, label: `${p.name}${o.sku ? ` · ${o.sku}` : ''}${p.lang && p.lang !== 'fr' ? ` (${p.lang.toUpperCase()})` : ''}`,
    }))))).catch(() => {})
  }, [])

  const sel = list.find(a => a.id === selId) || null
  useEffect(() => { if (!selId && list.length) setParams({ id: list.find(isBuilder)?.id || list[0].id }, { replace: true }) }, [selId, list, setParams])
  useEffect(() => { setStep(0); setPanel('edit') }, [selId])

  // Brouillon de l'automatisation en blocs choisie, sauvegardé tout seul.
  const [draft, setDraft] = useState(null)
  useEffect(() => {
    if (!isBuilder(sel)) { setDraft(null); return }
    setDraft(d => (d?.id === sel.id ? d : { id: sel.id, kind: sel.kind, tc: parse(sel.trigger_config), steps: parse(sel.action_config).steps || [] }))
  }, [sel])
  const timer = useRef(null)
  function change(next, extra = {}) {
    setDraft(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      try {
        // Changement de type : le serveur pose le déclencheur par défaut du nouveau type.
        const updated = await api.automations.update(next.id, {
          kind: next.kind, ...(extra.kind ? {} : { trigger_config: complete(next.tc) }), action_config: { steps: next.steps }, ...extra,
        })
        setList(l => l.map(a => (a.id === updated.id ? { ...a, ...updated } : a)))
        if (extra.kind) setDraft(d => ({ ...d, tc: parse(updated.trigger_config) }))
      } catch (e) { addToast({ message: e.message || 'Échec de la sauvegarde', type: 'error' }) }
    }, extra.kind ? 0 : 500)
  }

  async function toggle(a) {
    try {
      const updated = await api.automations.update(a.id, { active: a.active ? 0 : 1 })
      setList(l => l.map(x => (x.id === a.id ? { ...x, active: updated.active } : x)))
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
  }
  async function rename(name) {
    if (!name.trim() || name === sel.name) return
    const updated = await api.automations.update(sel.id, { name }).catch(e => addToast({ message: e.message, type: 'error' }))
    if (updated) setList(l => l.map(x => (x.id === sel.id ? { ...x, name: updated.name } : x)))
  }
  async function create() {
    try {
      const a = await api.automations.create({
        name: 'Nouvelle automatisation', kind: 'field_rule', active: 0, action_type: 'steps',
        trigger_config: { erp_table: 'shipments', conditions: { conjunction: 'AND', rules: [] }, fire_on: 'per_record_once' },
        action_config: { steps: [] },
      })
      await load()
      setParams({ id: a.id })
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
  }
  async function remove() {
    if (!(await confirm(`Supprimer « ${sel.name} » ?`))) return
    await api.automations.delete(sel.id)
    setParams({})
    load()
  }

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const m = new Map()
    for (const a of list) {
      if (needle && !`${a.name} ${a.description || ''}`.toLowerCase().includes(needle)) continue
      const g = a.group || 'Autres'
      if (!m.has(g)) m.set(g, [])
      m.get(g).push(a)
    }
    const order = ['Mes automatisations', 'Ventes', 'Banque', 'Comptabilité', 'Expédition & retours', 'Instagram', 'Système']
    return [...m.entries()].sort((x, y) => (order.indexOf(x[0]) + 99) % 99 - (order.indexOf(y[0]) + 99) % 99)
  }, [list, q])

  const triggerTable = draft?.kind === 'flow' ? null : draft?.tc?.erp_table
  const triggerTokens = draft?.tc?.type === 'subscription_product' ? SUB_TOKENS : null
  const productLabel = id => products.find(p => p.value === id)?.label || id
  const cols = useColumns(triggerTable)
  const colLabel = c => cols.find(x => x.value === c)?.label || c

  function setSteps(steps, nextStep) {
    change({ ...draft, steps })
    if (nextStep !== undefined) setStep(nextStep)
  }
  function move(from, to) {
    const s = [...draft.steps]
    s.splice(to, 0, s.splice(from, 1)[0])
    setSteps(s, step === from + 1 ? to + 1 : step)
  }

  const builder = isBuilder(sel) && draft
  const cur = builder && step > 0 ? draft.steps[step - 1] : null

  return (
    <Layout>
      <div className="h-full flex flex-col bg-slate-50">
        {/* Barre du haut */}
        <div className="h-12 shrink-0 flex items-center gap-3 px-4 bg-white border-b border-slate-200">
          {sel && (
            <button onClick={() => toggle(sel)} title={sel.active ? 'Active' : 'Inactive'}
              className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${sel.active ? 'bg-brand-500' : 'bg-slate-300'}`}>
              <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${sel.active ? 'left-[18px]' : 'left-0.5'}`} />
            </button>
          )}
          {sel && (
            <label className="group flex items-center gap-1 min-w-0 flex-1 max-w-md" title="Renommer">
              <input key={`${sel.id}-${sel.name}`} defaultValue={sel.name} onBlur={e => { if (!e.target.value.trim()) e.target.value = sel.name; else rename(e.target.value) }} onKeyDown={e => e.key === 'Enter' && e.target.blur()}
                className="font-semibold text-sm bg-transparent border border-transparent hover:border-slate-200 focus:border-brand-400 rounded px-1.5 py-0.5 min-w-0 flex-1 outline-none" />
              <Pencil size={13} className="shrink-0 text-slate-300 group-hover:text-slate-500" />
            </label>
          )}
          <span className="flex-1" />
          {sel && !builder && (
            <>
              <button onClick={() => setPanel(p => (p === 'history' ? 'edit' : 'history'))}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-lg ${panel === 'history' ? 'bg-slate-100' : 'bg-white'}`}><History size={14} /> Historique</button>
              <button onClick={() => setPanel(p => (p === 'all' ? 'edit' : 'all'))} title="Tous les réglages"
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-lg ${panel === 'all' ? 'bg-slate-100' : 'bg-white'}`}><Settings2 size={14} /> Détails</button>
            </>
          )}
          {builder && (
            <>
              <button onClick={() => setPanel(p => (p === 'history' ? 'edit' : 'history'))}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-lg ${panel === 'history' ? 'bg-slate-100' : 'bg-white'}`}><History size={14} /> Historique</button>
              <button onClick={() => setPanel(p => (p === 'test' ? 'edit' : 'test'))}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-lg ${panel === 'test' ? 'bg-slate-100' : 'bg-white'}`}><FlaskConical size={14} /> Tester</button>
              <button onClick={remove} title="Supprimer" className="p-1.5 text-slate-400 hover:text-red-600"><Trash2 size={15} /></button>
            </>
          )}
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Liste */}
          <div style={{ width: leftW }} className="shrink-0 bg-white border-r border-slate-200 overflow-y-auto hidden md:block">
            <div className="m-3 flex items-center gap-2">
              <div className="relative flex-1 min-w-0">
                <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
                <input value={q} onChange={e => setQ(e.target.value)} className="input input-sm pl-8" />
              </div>
              <button onClick={create} className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700">
                <Plus size={14} /> Nouvelle
              </button>
            </div>
            {groups.map(([g, items]) => (
              <div key={g} className="mb-1">
                <button onClick={() => setClosed(c => ({ ...c, [g]: !c[g] }))} className="w-full flex items-center justify-between px-4 py-2 text-sm font-semibold">
                  <span className="flex items-center gap-1">{closed[g] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}{g}</span>
                  <span className="text-xs font-normal text-slate-400">{items.filter(a => a.active).length} actives</span>
                </button>
                {!closed[g] && items.map(a => (
                  <button key={a.id} onClick={() => setParams({ id: a.id })}
                    className={`w-[calc(100%-12px)] mx-1.5 flex items-start gap-2 px-3 py-2 rounded-lg text-left ${a.id === selId ? 'bg-brand-50' : 'hover:bg-slate-50'}`}>
                    <span className="min-w-0 flex-1 block text-[13px] font-medium truncate">{a.name}</span>
                    <span className={`mt-0.5 shrink-0 text-[10px] font-bold rounded px-1.5 ${a.active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-400'}`}>{a.active ? 'ON' : 'OFF'}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <Resizer onDrag={(dx, start) => dragLeft(dx, start, 1)} />

          {/* Canevas */}
          <div className="flex-1 min-w-0 overflow-auto py-10 px-6"
            style={{ backgroundImage: 'radial-gradient(rgb(var(--c-slate-200)) 1px, transparent 1px)', backgroundSize: '18px 18px' }}>
            {builder && (
              <FlowCanvas automation={{ ...sel, kind: draft.kind }} tc={draft.tc} steps={draft.steps} step={step} users={users} colLabel={colLabel} productLabel={productLabel}
                onSelect={i => { setStep(i); setPanel('edit') }}
                onAdd={type => { setSteps([...draft.steps, newStep(type)], draft.steps.length + 1); setPanel('edit') }}
                onMove={move} />
            )}
            {sel && !builder && <SystemCanvas a={sel} step={step} onSelect={i => { setStep(i); setPanel('edit') }} />}
          </div>
          <Resizer onDrag={(dx, start) => dragRight(dx, start, -1)} />

          {/* Réglages */}
          <div style={{ width: rightW }} className="shrink-0 bg-white border-l border-slate-200 overflow-y-auto hidden lg:block">
            {sel && !builder && panel === 'edit' && <SystemBlockPanel a={sel} step={step} />}
            {sel && !builder && panel === 'history' && <HistoryPanel automationId={sel.id} />}
            {sel && !builder && panel === 'all' && <AutomationDetail key={`${sel.id}-${sel.active}`} recordId={sel.id} embedded />}
            {builder && panel === 'history' && <HistoryPanel automationId={sel.id} />}
            {builder && panel === 'test' && <TestPanel automation={{ ...sel, kind: draft.kind }} onDone={load} />}
            {builder && panel === 'edit' && step === 0 && (
              <TriggerPanel automation={{ ...sel, kind: draft.kind }} tc={draft.tc} tables={tables} products={products}
                onKind={k => {
                  const tc = k === 'subscription_product' ? { type: 'subscription_product', products: [] } : k === 'schedule' ? { freq: 'day', time: '08:00' } : null
                  const kind = k === 'field_rule' ? 'field_rule' : 'flow'
                  change({ ...draft, kind, ...(tc ? { tc } : {}) }, { kind, ...(tc ? { trigger_config: tc } : {}) })
                }}
                onTc={tc => change({ ...draft, tc })} />
            )}
            {builder && panel === 'edit' && cur && (
              <StepPanel key={`${sel.id}-${step}`} step={cur} index={step - 1} users={users}
                triggerTable={triggerTable} triggerTokens={triggerTokens} prevSteps={draft.steps.slice(0, step - 1)}
                onChange={s => setSteps(draft.steps.map((x, i) => (i === step - 1 ? s : x)))}
                onType={t => setSteps(draft.steps.map((x, i) => (i === step - 1 ? { ...newStep(t), id: x.id } : x)))}
                onDelete={() => setSteps(draft.steps.filter((_, i) => i !== step - 1), 0)} />
            )}
          </div>
        </div>
      </div>
    </Layout>
  )
}

const TRIGGER_LABELS = { schedule: 'Planifié', webhook: 'Webhook', field_rule: 'Enregistrement', manual: 'Manuel', system: 'Code Boréal' }

// Automatisations codées : schéma en blocs décrit côté serveur (flow) ; les
// réglages déjà modifiables s'éditent dans le bloc auquel ils appartiennent.
const TYPE_ICONS = {
  record: Table2, schedule: Clock, event: Zap, webhook: Webhook, manual: Hand,
  task: CheckSquare, slack: MessageSquare, email: Mail, update: Pencil, create: FilePlus, find: Search,
  hubspot: Users, qb: BookOpen, script: Code2, sheet: Sheet, stripe: CreditCard, airtable: Database,
  drive: HardDrive, sync: RefreshCw, other: Zap,
}
function systemFlow(a) {
  if (a.flow) return a.flow
  return {
    trigger: { type: 'event', title: TRIGGER_LABELS[a.trigger_type] || 'Déclencheur', sub: '', config: [] },
    actions: [{ type: 'script', title: 'Code Boréal', sub: a.description || '', config: [] }],
  }
}

function SystemCanvas({ a, step, onSelect }) {
  const f = systemFlow(a)
  const blocks = [f.trigger, ...f.actions]
  return (
    <div className="max-w-md mx-auto">
      {blocks.map((b, i) => {
        const Icon = TYPE_ICONS[b.type] || Zap
        const editable = (b.config || []).length > 0
        return (
          <div key={i}>
            {i === 0 && <div className="text-[11px] font-semibold tracking-wider text-slate-500 mb-2">DÉCLENCHEUR</div>}
            {i === 1 && <><div className="w-0.5 h-5 bg-slate-300 ml-8" /><div className="text-[11px] font-semibold tracking-wider text-slate-500 mb-2">ACTIONS</div></>}
            {i > 1 && <div className="w-0.5 h-5 bg-slate-300 ml-8" />}
            <div onClick={() => onSelect(i)}
              className={`flex items-center gap-3 bg-white rounded-xl px-3.5 py-3 cursor-pointer ${step === i ? 'border-2 border-brand-600 -m-px' : 'border border-slate-200 hover:border-slate-300'}`}>
              <div className={`w-9 h-9 rounded-lg grid place-items-center shrink-0 text-slate-700 ${i === 0 ? 'bg-[#e0f2e7]' : 'bg-slate-100'}`}><Icon size={17} /></div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{b.title}</div>
                <div className="text-xs text-slate-500 truncate">{b.sub || '—'}</div>
              </div>
              {editable ? <Pencil size={13} className="text-brand-600 shrink-0" /> : <Lock size={13} className="text-slate-300 shrink-0" />}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SystemBlockPanel({ a, step }) {
  const f = systemFlow(a)
  const b = step === 0 ? f.trigger : f.actions[step - 1]
  if (!b) return null
  return (
    <div className="p-4">
      <h4 className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase mb-3">{step === 0 ? 'Déclencheur' : `Action ${step}`}</h4>
      <div className="text-sm font-medium">{b.title}</div>
      {b.sub && <div className="text-xs text-slate-500 mb-4">{b.sub}</div>}
      <AutomationDetail key={`${a.id}-${a.active}-${step}`} recordId={a.id} embedded
        block={{ trigger: (b.config || []).includes('__trigger'), keys: (b.config || []).filter(k => k !== '__trigger') }} />
    </div>
  )
}
