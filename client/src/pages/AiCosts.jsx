import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { MiniColumns } from '../components/DashboardOverview.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'
import Spinner from '../components/Spinner.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { fmtMoney, fmtNumber } from '../utils/formatters.js'

// Paramètres → Coûts IA : coût réel par jour et par fonctionnalité des API d'IA
// payées à l'usage. OpenAI = facture lue avec une clé admin ; Gemini = jetons ×
// prix Google. Serveur : services/aiCostMeter.js.

const usd = (n, digits = 2) => fmtMoney(n, 'USD', { maximumFractionDigits: digits, minimumFractionDigits: digits })

function Tile({ label, value }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className="text-2xl font-semibold tabular-nums leading-none text-slate-900">{value}</div>
      <div className="text-xs mt-1.5 text-slate-500">{label}</div>
    </div>
  )
}

function AdminKeyForm({ onSaved }) {
  const { addToast } = useToast()
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  async function save() {
    setSaving(true)
    try { await api.aiCosts.setOpenAiAdminKey(key.trim()); setKey(''); onSaved() } catch (e) { addToast({ message: e.message, type: 'error' }) } finally { setSaving(false) }
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-slate-500">Clé admin OpenAI</span>
      <input type="password" value={key} onChange={e => setKey(e.target.value)} data-testid="ai-costs-admin-key"
        className="w-64 px-2 py-1 rounded border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
      <button type="button" onClick={save} disabled={saving || !key.trim()}
        className="px-3 py-1 rounded-md bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 disabled:opacity-50">OK</button>
    </div>
  )
}

const th = 'px-3 py-2 text-left text-xs font-medium text-slate-500'
const td = 'px-3 py-2 text-sm text-slate-700'
const num = 'px-3 py-2 text-sm text-slate-700 text-right tabular-nums'

export function AiCostsContent() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    api.aiCosts.get().then(r => { setData(r); setError(null) }).catch(e => setError(e.message))
  }, [])
  useEffect(load, [load])

  const points = useMemo(() => (data?.days || []).map(d => (
    { key: d.date, label: d.date, short: String(d.date).slice(5), value: d.cost || 0 }
  )), [data])

  if (error) return <ErrorBanner>{error}</ErrorBanner>
  if (!data) return <div className="text-sm text-slate-400 py-6"><Spinner size="xs" label="Chargement…" /></div>

  const sum = (n) => points.slice(-n).reduce((s, p) => s + p.value, 0)
  const total = sum(365)

  return (
    <div data-testid="ai-costs">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-lg font-semibold text-slate-900">Coûts IA <span className="text-sm font-normal text-slate-400">USD</span></h2>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Tile label="365 jours" value={usd(total)} />
        <Tile label="30 jours" value={usd(sum(30))} />
        <Tile label="7 jours" value={usd(sum(7))} />
        <Tile label="Moyenne / jour" value={usd(total / 365)} />
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-3 mb-6" data-testid="ai-costs-chart">
        <MiniColumns points={points} vw={900} labelEvery={30} format={v => usd(v, v >= 10 ? 0 : 2)} chartId="ai-costs" />
      </div>

      {data.billing.error && <ErrorBanner className="mb-4">OpenAI : {data.billing.error}</ErrorBanner>}
      {!data.billing.configured && <div className="mb-6"><AdminKeyForm onSaved={load} /></div>}

      <table className="w-full max-w-md rounded-lg border border-slate-200 bg-white overflow-hidden" data-testid="ai-costs-features">
        <thead className="bg-slate-50"><tr><th className={th}>Usage</th><th className={`${th} text-right`}>Appels</th><th className={`${th} text-right`}>Coût</th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {data.features.map(f => (
            <tr key={f.label}><td className={td}>{f.label}</td><td className={num}>{fmtNumber(f.calls)}</td><td className={num}>{usd(f.cost)}{f.unpriced > 0 && <span className="text-amber-600"> ?</span>}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
