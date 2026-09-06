import { useState, useEffect, useRef, useCallback } from 'react'
import { Plus, Trash2, Copy, RotateCcw, Play, Check } from 'lucide-react'
import { api } from '../lib/api.js'
import { SearchableSelect } from './SearchableSelect.jsx'

// Tables que le moteur de webhooks peut lire/écrire. Doit rester aligné avec
// WEBHOOK_TABLES côté serveur (services/webhookEngine.js & routes/automations.js).
const WEBHOOK_TABLES = ['tickets', 'projects', 'serial_numbers']
const TABLE_LABELS = { tickets: 'Billets', projects: 'Projets', serial_numbers: 'Numéros de série' }
const STEP_TYPES = [
  { value: 'update', label: 'Mettre à jour (match → set)' },
  { value: 'upsert', label: 'Upsert (match → set, sinon créer)' },
  { value: 'create', label: 'Créer un enregistrement' },
]
const VALUE_SOURCES = [
  { value: 'param', label: 'Param entrant' },
  { value: 'literal', label: 'Valeur fixe' },
  { value: 'record', label: 'Champ du record matché' },
]
const RESP_OPS = [
  { value: 'eq', label: '= égal à' },
  { value: 'ne', label: '≠ différent de' },
  { value: 'exists', label: 'est présent' },
]

const card = 'bg-white rounded-lg border p-5'
const lbl = 'block text-xs font-medium text-gray-600 mb-1'
const inp = 'input'

// Hook : colonnes d'une table ERP (mémoïsées par table, partagées entre champs).
function useTableColumns() {
  const cacheRef = useRef({})
  const [, force] = useState(0)
  const load = useCallback((table) => {
    if (!table || cacheRef.current[table]) return
    cacheRef.current[table] = []
    api.automations.ruleFieldDefs(table)
      .then(d => { cacheRef.current[table] = d.columns || []; force(n => n + 1) })
      .catch(() => {})
  }, [])
  return { get: (t) => cacheRef.current[t] || [], load }
}

function ColumnSelect({ table, value, onChange, columns, onNeed, emptyLabel = '—', disabled }) {
  useEffect(() => { if (table) onNeed(table) }, [table, onNeed])
  return (
    <SearchableSelect
      value={value || ''}
      options={columns}
      getOptionValue={c => c.column_name}
      getOptionLabel={c => c.airtable_field_name ? `${c.airtable_field_name} (${c.column_name})` : c.column_name}
      getOptionKey={c => c.column_name}
      emptyOption={emptyLabel}
      onChange={onChange}
      disabled={disabled || !table}
      size="sm"
      className={inp + ' disabled:bg-gray-50'}
    />
  )
}

export function WebhookEditor({
  value, onChange, script, onScriptChange,
  token, isNew, automationId,
}) {
  const cfg = value || {}
  const mode = cfg.mode === 'script' ? 'script' : 'declarative'
  const steps = Array.isArray(cfg.steps) ? cfg.steps : []
  const responseRules = Array.isArray(cfg.response_rules) ? cfg.response_rules : []
  const cols = useTableColumns()
  const [addresses, setAddresses] = useState([])
  const [copied, setCopied] = useState(false)
  const [testParams, setTestParams] = useState('{\n  \n}')
  const [testResult, setTestResult] = useState(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    api.connectors.postmarkInfo().then(p => setAddresses(p?.addresses || [])).catch(() => setAddresses([]))
  }, [])

  const publicUrl = token ? `${window.location.origin}/erp/api/hooks/${token}` : null

  function patch(partial) { onChange({ ...cfg, ...partial }) }
  function setSteps(next) { patch({ steps: next }) }
  function setStep(i, partial) { setSteps(steps.map((s, j) => j === i ? { ...s, ...partial } : s)) }
  function setRules(next) { patch({ response_rules: next }) }

  function addStep() {
    setSteps([...steps, { type: 'update', table: 'tickets', match: { field: '', param: '' }, fields: [] }])
  }
  function addField(i) {
    const s = steps[i]
    setStep(i, { fields: [...(s.fields || []), { column: '', source: 'param', value: '' }] })
  }
  function setField(i, fi, partial) {
    const s = steps[i]
    setStep(i, { fields: (s.fields || []).map((f, k) => k === fi ? { ...f, ...partial } : f) })
  }

  async function copyUrl() {
    if (!publicUrl) return
    try { await navigator.clipboard.writeText(publicUrl); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* clipboard refusé */ }
  }

  async function runTest() {
    setTesting(true); setTestResult(null)
    let params
    try { params = JSON.parse(testParams || '{}') } catch { setTestResult({ error: 'JSON des params invalide' }); setTesting(false); return }
    try {
      const out = await api.automations.test(automationId, { params })
      setTestResult(out)
    } catch (e) {
      setTestResult({ error: e.message || 'Erreur' })
    }
    setTesting(false)
  }

  return (
    <>
      {/* URL publique + rotation */}
      <div className={card}>
        <h2 className="text-sm font-semibold mb-1">URL du webhook</h2>
        <p className="text-xs text-gray-500 mb-3">
          Le token compact <strong>est</strong> le secret. Tout appel <code className="bg-gray-100 px-1 rounded">GET</code> ou{' '}
          <code className="bg-gray-100 px-1 rounded">POST</code> sur cette URL déclenche le webhook. Les paramètres exposés à l'action sont la query string <em>et</em> le corps JSON.
        </p>
        {isNew ? (
          <div className="text-sm text-gray-500 italic">L'URL sera générée à la création du webhook.</div>
        ) : (
          <div className="flex items-center gap-2">
            <input readOnly value={publicUrl || ''} className={inp + ' font-mono text-xs bg-gray-50'} data-testid="webhook-url" />
            <button onClick={copyUrl} className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-50 flex items-center gap-1.5 shrink-0">
              {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />} {copied ? 'Copié' : 'Copier'}
            </button>
            <RotateTokenButton automationId={automationId} />
          </div>
        )}
      </div>

      {/* Mode */}
      <div className={card}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold">Action</h2>
          <div className="flex gap-1">
            {[['declarative', 'Déclaratif'], ['script', 'Script']].map(([v, l]) => (
              <button key={v} onClick={() => patch({ mode: v })}
                className={`px-3 py-1 text-xs rounded-lg border ${mode === v ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                {l}
              </button>
            ))}
          </div>
        </div>

        {mode === 'declarative' ? (
          <div className="space-y-4 mt-3">
            {steps.length === 0 && <p className="text-xs text-gray-400">Aucune étape. Ajoutez-en une pour décrire ce que fait le webhook.</p>}
            {steps.map((s, i) => {
              const tCols = cols.get(s.table)
              const isCreate = (s.type || 'update') === 'create'
              return (
                <div key={i} className="border rounded-lg p-4 space-y-3 bg-gray-50/50">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-500">Étape {i + 1}</span>
                    <button onClick={() => setSteps(steps.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500"><Trash2 size={14} /></button>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={lbl}>Type</label>
                      <select value={s.type || 'update'} onChange={e => setStep(i, { type: e.target.value })} className={inp}>
                        {STEP_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className={lbl}>Table</label>
                      <select value={s.table || ''} onChange={e => setStep(i, { table: e.target.value, match: { field: '', param: s.match?.param || '' }, fields: [] })} className={inp}>
                        {WEBHOOK_TABLES.map(t => <option key={t} value={t}>{TABLE_LABELS[t]}</option>)}
                      </select>
                    </div>
                  </div>

                  {!isCreate && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={lbl}>Chercher le record où…</label>
                        <ColumnSelect table={s.table} value={s.match?.field} columns={tCols} onNeed={cols.load}
                          onChange={v => setStep(i, { match: { ...s.match, field: v } })} />
                      </div>
                      <div>
                        <label className={lbl}>… = la valeur du param</label>
                        <input value={s.match?.param || ''} onChange={e => setStep(i, { match: { ...s.match, param: e.target.value } })}
                          className={inp + ' font-mono'} />
                      </div>
                    </div>
                  )}

                  <div>
                    <label className={lbl}>{isCreate ? 'Champs à définir' : 'Champs à mettre à jour'}</label>
                    <div className="space-y-2">
                      {(s.fields || []).map((f, fi) => (
                        <div key={fi} className="grid grid-cols-[1fr_130px_1fr_28px] gap-2 items-center">
                          <ColumnSelect table={s.table} value={f.column} columns={tCols} onNeed={cols.load}
                            onChange={v => setField(i, fi, { column: v })} />
                          <select value={f.source || 'param'} onChange={e => setField(i, fi, { source: e.target.value })} className={inp}>
                            {VALUE_SOURCES.filter(vs => vs.value !== 'record' || !isCreate).map(vs => <option key={vs.value} value={vs.value}>{vs.label}</option>)}
                          </select>
                          {f.source === 'record'
                            ? <ColumnSelect table={s.table} value={f.value} columns={tCols} onNeed={cols.load} onChange={v => setField(i, fi, { value: v })} />
                            : <input value={f.value ?? ''} onChange={e => setField(i, fi, { value: e.target.value })} className={inp + ' font-mono'} />}
                          <button onClick={() => setStep(i, { fields: s.fields.filter((_, k) => k !== fi) })} className="text-gray-400 hover:text-red-500"><Trash2 size={13} /></button>
                        </div>
                      ))}
                      <button onClick={() => addField(i)} className="text-xs text-brand-600 hover:text-brand-700 flex items-center gap-1"><Plus size={12} /> Ajouter un champ</button>
                    </div>
                  </div>
                </div>
              )
            })}
            <button onClick={addStep} className="text-sm text-brand-600 hover:text-brand-700 flex items-center gap-1.5"><Plus size={14} /> Ajouter une étape</button>
          </div>
        ) : (
          <div className="mt-3">
            <p className="text-xs text-gray-500 mb-2">
              Variables : <code className="bg-gray-100 px-1 rounded">params</code>, <code className="bg-gray-100 px-1 rounded">request</code>.{' '}
              Fonctions : <code className="bg-gray-100 px-1 rounded">query(sql, params)</code>, <code className="bg-gray-100 px-1 rounded">update(table, id, patch)</code>{' '}
              (tables : tickets, projects, serial_numbers), <code className="bg-gray-100 px-1 rounded">fetch</code>, <code className="bg-gray-100 px-1 rounded">log</code>,{' '}
              <code className="bg-gray-100 px-1 rounded">respond(status, body)</code>. Timeout : 10 s.
            </p>
            <textarea value={script || ''} onChange={e => onScriptChange(e.target.value)} rows={12}
              className="w-full border rounded-lg px-4 py-3 font-mono text-sm bg-gray-900 text-green-400 focus:outline-none focus:ring-2 focus:ring-brand-400" />
          </div>
        )}
      </div>

      {/* Règles de réponse (déclaratif) */}
      {mode === 'declarative' && (
        <div className={card}>
          <h2 className="text-sm font-semibold mb-1">Réponse renvoyée</h2>
          <p className="text-xs text-gray-500 mb-3">
            Première règle qui matche un param l'emporte, sinon la réponse par défaut. Le corps accepte des gabarits{' '}
            <code className="bg-gray-100 px-1 rounded">{'{{param.x}}'}</code> et <code className="bg-gray-100 px-1 rounded">{'{{steps.0.record.champ}}'}</code>.
          </p>
          <div className="space-y-2">
            {responseRules.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_120px_1fr_90px_1.5fr_28px] gap-2 items-center">
                <input value={r.param || ''} onChange={e => setRules(responseRules.map((x, j) => j === i ? { ...x, param: e.target.value } : x))} className={inp + ' font-mono'} />
                <select value={r.op || 'eq'} onChange={e => setRules(responseRules.map((x, j) => j === i ? { ...x, op: e.target.value } : x))} className={inp}>
                  {RESP_OPS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <input value={r.value ?? ''} disabled={r.op === 'exists'} onChange={e => setRules(responseRules.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} className={inp + ' disabled:bg-gray-50'} />
                <input type="number" value={r.status ?? 200} onChange={e => setRules(responseRules.map((x, j) => j === i ? { ...x, status: Number(e.target.value) } : x))} className={inp} />
                <input value={typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})} onChange={e => setRules(responseRules.map((x, j) => j === i ? { ...x, body: tryParse(e.target.value) } : x))} className={inp + ' font-mono'} />
                <button onClick={() => setRules(responseRules.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500"><Trash2 size={13} /></button>
              </div>
            ))}
            <button onClick={() => setRules([...responseRules, { param: '', op: 'eq', value: '', status: 200, body: { ok: true } }])} className="text-xs text-brand-600 hover:text-brand-700 flex items-center gap-1"><Plus size={12} /> Ajouter une règle</button>
          </div>
          <div className="mt-4 grid grid-cols-[90px_1fr] gap-2 items-center">
            <div>
              <label className={lbl}>Défaut — code</label>
              <input type="number" value={cfg.default_response?.status ?? 200} onChange={e => patch({ default_response: { ...cfg.default_response, status: Number(e.target.value) } })} className={inp} />
            </div>
            <div>
              <label className={lbl}>Défaut — corps</label>
              <input value={typeof cfg.default_response?.body === 'string' ? cfg.default_response.body : JSON.stringify(cfg.default_response?.body ?? { ok: true })} onChange={e => patch({ default_response: { ...cfg.default_response, body: tryParse(e.target.value) } })} className={inp + ' font-mono'} />
            </div>
          </div>
        </div>
      )}

      {/* Courriel d'échec */}
      <div className={card}>
        <h2 className="text-sm font-semibold mb-1">Notification d'échec</h2>
        <p className="text-xs text-gray-500 mb-3">
          En cas d'échec (0 résultat sur un <em>update</em>, erreur d'écriture, write-back Airtable, ou exception du script), un courriel est envoyé à cet employé — au plus un toutes les 15 minutes.
        </p>
        <div className="max-w-md">
          <SearchableSelect
            value={cfg.failure_recipient || ''}
            options={addresses}
            getOptionValue={a => a} getOptionLabel={a => a} getOptionKey={a => a}
            emptyOption="— aucun —"
            onChange={v => patch({ failure_recipient: v || undefined })}
            searchPlaceholder="Rechercher une adresse…"
            size="sm"
            className={inp}
          />
        </div>
      </div>

      {/* Test (dry-run) */}
      {!isNew && mode === 'declarative' && (
        <div className={card}>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold">Tester (simulation, aucune écriture)</h2>
            <button onClick={runTest} disabled={testing} className="px-3 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5">
              {testing ? <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> …</> : <><Play size={14} /> Simuler</>}
            </button>
          </div>
          <label className={lbl}>Params simulés (JSON)</label>
          <textarea value={testParams} onChange={e => setTestParams(e.target.value)} rows={4} className="w-full border rounded-lg px-3 py-2 font-mono text-xs" />
          {testResult && (
            <div className={`mt-3 p-3 rounded-lg text-xs font-mono ${testResult.error || testResult.status >= 400 ? 'bg-red-50 border border-red-200' : 'bg-green-50 border border-green-200'}`}>
              {testResult.error
                ? <span className="text-red-600">{testResult.error}</span>
                : <>
                    <div className="mb-1"><strong>Réponse {testResult.status}</strong> : {JSON.stringify(testResult.body)}</div>
                    {(testResult.actions || []).length > 0 && <pre className="whitespace-pre-wrap text-gray-600">{testResult.actions.join('\n')}</pre>}
                  </>}
            </div>
          )}
        </div>
      )}
    </>
  )
}

function tryParse(s) {
  try { return JSON.parse(s) } catch { return s }
}

function RotateTokenButton({ automationId }) {
  const [busy, setBusy] = useState(false)
  async function rotate() {
    if (busy) return
    if (!window.confirm('Régénérer le token ? L\'ancienne URL cessera immédiatement de fonctionner.')) return
    setBusy(true)
    try { await api.automations.rotateToken(automationId); window.location.reload() } catch { setBusy(false) }
  }
  return (
    <button onClick={rotate} disabled={busy} className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-50 flex items-center gap-1.5 shrink-0 text-gray-600">
      <RotateCcw size={14} /> Régénérer
    </button>
  )
}
