import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Archive, ArchiveRestore, ExternalLink, Plus, Tags } from 'lucide-react'
import api from '../lib/api.js'
import { DataTable } from '../components/DataTable.jsx'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { useAutosave } from '../lib/useAutosave.js'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { priceLabel } from './StripeCatalog.jsx'

// Fiche d'un produit Stripe : nom, description, prix. Un prix Stripe ne se
// modifie pas : on en crée un nouveau et on archive l'ancien (les abonnés
// actuels gardent le leur).

const FREQ = { month: 'Mensuel', year: 'Annuel', week: 'Hebdo', day: 'Quotidien' }

export default function StripeProductDetail({ recordId: id, onClose }) {
  const navigate = useNavigate()
  const [error, setError] = useState(null)
  const [draft, setDraft] = useState({ amount: '', currency: 'cad', interval: 'month' })
  const [busy, setBusy] = useState(false)

  const { record: p, setRecord: setP, loading, loadError, reload } = useDetailRecord(
    () => api.stripeCatalog.get(id), [id], { clearOnError: true })

  const { save } = useAutosave(p, (patch) => api.stripeCatalog.update(id, patch), {
    onSaved: updated => { setError(null); setP(updated) },
    onError: (key, prev, e) => { setError(e.message); setP(cur => ({ ...cur, [key]: prev })) },
  })

  const pending = detailPending({ loading, loadError, onRetry: reload, record: p, notFound: 'Produit introuvable.' })
  if (pending) return pending

  async function run(fn) {
    setBusy(true)
    setError(null)
    try { setP(await fn()) }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const addPrice = () => run(async () => {
    const r = await api.stripeCatalog.addPrice(id, { ...draft, interval: draft.interval || null })
    setDraft(d => ({ ...d, amount: '' }))
    return r
  })

  const columns = TABLE_COLUMN_META.stripe_prices.filter(meta => meta.id !== 'lang').map(meta => ({ ...meta, render: {
    unit_amount: row => <span className={`tabular-nums ${row.active ? 'text-slate-800' : 'text-slate-400 line-through'}`}>{priceLabel(row)}</span>,
    currency: row => <span className="text-slate-600">{row.currency?.toUpperCase()}</span>,
    interval: row => <span className="text-slate-600">{FREQ[row.interval] || 'Unique'}</span>,
    active: row => row.active ? <span className="text-green-600">●</span> : <span className="text-slate-300">●</span>,
    created: row => <span className="text-slate-600">{fmtDate(row.created_iso)}</span>,
    actions: row => (
      <button className="btn-secondary !px-2 !py-1" disabled={busy} title={row.active ? 'Archiver' : 'Réactiver'}
        data-testid={`stripe-price-toggle-${row.id}`}
        onClick={e => { e.stopPropagation(); run(() => api.stripeCatalog.setPriceActive(row.id, !row.active)) }}>
        {row.active ? <Archive size={13} /> : <ArchiveRestore size={13} />}
      </button>
    ),
  }[meta.id] }))
  const prices = p.prices.map(r => ({ ...r, created_iso: r.created ? new Date(r.created * 1000).toISOString() : null }))

  return (
    <DetailShell
      header={{
        actions: (<>
          <a href={`https://dashboard.stripe.com/products/${p.id}`} target="_blank" rel="noreferrer" className="btn-secondary" title="Stripe">
            <ExternalLink size={14} />
          </a>
          <button className="btn-secondary" title="Ajouter au catalogue" data-testid="stripe-product-adopt" disabled={busy}
            onClick={() => run(async () => { await api.stripeCatalog.adopt(id); onClose ? onClose() : navigate('/catalogue-vente'); return p })}>
            <Tags size={14} />
          </button>
          <button onClick={() => save('active', !p.active)} className="btn-secondary" title={p.active ? 'Archiver' : 'Réactiver'} data-testid="stripe-product-active">
            {p.active ? <Archive size={14} /> : <ArchiveRestore size={14} />}
          </button>
        </>),
      }}
    >
      {error && <div className="mb-3 text-sm text-red-600">{error}</div>}

      <div className="card p-5 space-y-4">
        <div>
          <label className="label">Nom</label>
          <input className="input" key={p.name} defaultValue={p.name || ''} data-testid="stripe-product-name"
            onBlur={e => e.target.value.trim() && e.target.value !== p.name && save('name', e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
        </div>
        <div>
          <label className="label">Description</label>
          <textarea className="input text-sm" rows={3} key={p.description} defaultValue={p.description || ''}
            data-testid="stripe-product-description"
            onBlur={e => e.target.value !== (p.description || '') && save('description', e.target.value)} />
        </div>
      </div>

      <div className="mt-5" data-testid="stripe-product-prices">
        <div className="text-sm font-semibold text-slate-900 mb-2">Prix</div>
        <DataTable table="stripe_prices" columns={columns} data={prices} />
        <div className="mt-3 flex items-center gap-2">
          <input className="input w-32" type="number" min="0" step="0.01" value={draft.amount}
            data-testid="stripe-price-amount" onChange={e => setDraft(d => ({ ...d, amount: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter' && draft.amount !== '') addPrice() }} />
          <select className="input w-24" value={draft.currency} data-testid="stripe-price-currency"
            onChange={e => setDraft(d => ({ ...d, currency: e.target.value }))}>
            <option value="cad">CAD</option>
            <option value="usd">USD</option>
          </select>
          <select className="input w-32" value={draft.interval} data-testid="stripe-price-interval"
            onChange={e => setDraft(d => ({ ...d, interval: e.target.value }))}>
            <option value="month">Mensuel</option>
            <option value="year">Annuel</option>
            <option value="">Unique</option>
          </select>
          <button className="btn-primary" disabled={busy || draft.amount === ''} onClick={addPrice} title="Ajouter le prix" data-testid="stripe-price-add">
            <Plus size={14} />
          </button>
        </div>
      </div>
    </DetailShell>
  )
}
