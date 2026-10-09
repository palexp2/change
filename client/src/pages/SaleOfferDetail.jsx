import { useState } from 'react'
import { Archive, ArchiveRestore, ExternalLink, Plus, Unlink } from 'lucide-react'
import api from '../lib/api.js'
import { DataTable } from '../components/DataTable.jsx'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { fmtMoney } from '../utils/formatters.js'
import { priceLabel } from './StripeCatalog.jsx'

// Fiche d'un produit de soumission : nom, SKU, 4 prix, et son produit Stripe.
// Les prix de la fiche sont la source : chaque prix modifié est créé dans
// Stripe s'il n'y existe pas ; l'ancien reste actif (abonnés existants)
// jusqu'à ce qu'on l'archive ici.

const FREQ = { month: 'Mensuel', year: 'Annuel', week: 'Hebdo', day: 'Quotidien' }
// SKU : attribué par l'app (SVC-###), lu par le System builder — pas modifiable.
const TEXT_FIELDS = [['name_fr', 'Nom'], ['name_en', 'Nom EN']]
const PRICE_FIELDS = [['price_cad', 'Achat CAD'], ['price_usd', 'Achat USD'], ['monthly_price_cad', 'Mensuel CAD'], ['monthly_price_usd', 'Mensuel USD']]

export default function SaleOfferDetail({ recordId: id, onChanged }) {
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [candidates, setCandidates] = useState(null)

  const { record: o, setRecord: setO, loading, loadError, reload } = useDetailRecord(
    () => api.stripeCatalog.getOffer(id), [id], { clearOnError: true })

  const pending = detailPending({ loading, loadError, onRetry: reload, record: o, notFound: 'Produit introuvable.' })
  if (pending) return pending

  async function run(fn) {
    setBusy(true)
    setError(null)
    try { setO(await fn()); onChanged?.() }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const saveField = (key, raw, isPrice) => {
    const value = isPrice ? (raw === '' ? 0 : Number(raw)) : raw
    if ((o[key] ?? '') === value || (isPrice && Number(o[key] || 0) === value)) return
    run(async () => {
      await api.products.update(id, { [key]: value })
      return isPrice ? api.stripeCatalog.pushOffer(id) : api.stripeCatalog.getOffer(id)
    })
  }

  const loadCandidates = () => {
    if (candidates) return
    api.stripeCatalog.list().then(r => setCandidates(r.unlinked)).catch(e => setError(e.message))
  }

  const columns = TABLE_COLUMN_META.stripe_prices.map(meta => ({ ...meta, render: {
    lang: row => <span className="text-xs text-slate-500 uppercase">{row.lang}</span>,
    unit_amount: row => <span className={`tabular-nums ${row.active ? 'text-slate-800' : 'text-slate-400 line-through'}`}>{priceLabel(row)}</span>,
    currency: row => <span className="text-slate-600">{row.currency?.toUpperCase()}</span>,
    interval: row => <span className="text-slate-600">{FREQ[row.interval] || 'Unique'}</span>,
    active: row => row.active ? <span className="text-green-600">●</span> : <span className="text-slate-300">●</span>,
    created: row => <span className="text-slate-600">{fmtDate(row.created_iso)}</span>,
    actions: row => (
      <button className="btn-secondary !px-2 !py-1" disabled={busy} title={row.active ? 'Archiver' : 'Réactiver'}
        data-testid={`offer-price-toggle-${row.id}`}
        onClick={e => { e.stopPropagation(); run(async () => { await api.stripeCatalog.setPriceActive(row.id, !row.active); return api.stripeCatalog.getOffer(id) }) }}>
        {row.active ? <Archive size={13} /> : <ArchiveRestore size={13} />}
      </button>
    ),
  }[meta.id] }))
  const prices = o.stripe_prices.map(r => ({ ...r, created_iso: r.created ? new Date(r.created * 1000).toISOString() : null }))

  return (
    <DetailShell header={{
      actions: (
        <button className="btn-secondary" disabled={busy} title={o.active ? 'Archiver (ici et dans Stripe)' : 'Réactiver'}
          data-testid="offer-archive" onClick={() => run(() => api.stripeCatalog.setOfferActive(id, !o.active))}>
          {o.active ? <Archive size={14} /> : <ArchiveRestore size={14} />}
        </button>
      ),
    }}>
      {error && <div className="mb-3 text-sm text-red-600">{error}</div>}

      <div className="card p-5 grid grid-cols-2 gap-4">
        {TEXT_FIELDS.map(([key, label]) => (
          <div key={key} className={key === 'name_fr' ? 'col-span-2' : ''}>
            <label className="label">{label}</label>
            <input className="input" key={o[key]} defaultValue={o[key] || ''} data-testid={`offer-${key}`}
              onBlur={e => saveField(key, e.target.value.trim(), false)}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
          </div>
        ))}
        <div>
          <label className="label">SKU</label>
          <div className="input bg-slate-50 text-slate-500 font-mono text-sm" data-testid="offer-sku">{o.sku || '—'}</div>
        </div>
        {PRICE_FIELDS.map(([key, label]) => (
          <div key={key}>
            <label className="label">{label}</label>
            <input className="input tabular-nums" type="number" min="0" step="0.01" key={o[key]} defaultValue={o[key] || ''}
              data-testid={`offer-${key}`}
              onBlur={e => saveField(key, e.target.value, true)}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
          </div>
        ))}
      </div>

      {o.sales?.lines > 0 && (
        <div className="mt-4 text-sm text-slate-600" data-testid="offer-sales">
          <span className="font-semibold text-slate-900">Ventes</span>{' '}
          {o.sales.lines} · {o.sales.totals.map(t => fmtMoney(t.amount, t.currency)).join(' + ')} · {fmtDate(o.sales.first)} → {fmtDate(o.sales.last)}
        </div>
      )}

      <div className="mt-5" data-testid="offer-stripe">
        {/* Un produit Stripe par langue : le client lit le nom dans la sienne. */}
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          <div className="text-sm font-semibold text-slate-900">Stripe</div>
          {o.stripe_products.map(l => (
            <a key={l.id} href={`https://dashboard.stripe.com/products/${l.id}`} target="_blank" rel="noreferrer"
              className="link-record text-sm inline-flex items-center gap-1">
              <span className="text-xs text-slate-500 uppercase">{l.lang}</span> {l.name} <ExternalLink size={12} />
            </a>
          ))}
          {o.stripe_products.length > 0 && (
            <button className="btn-secondary !px-2 !py-1 ml-auto" disabled={busy} title="Délier" data-testid="offer-unlink"
              onClick={() => run(() => api.stripeCatalog.linkOffer(id, { stripe_product_id: null }))}>
              <Unlink size={13} />
            </button>
          )}
        </div>
        {o.stripe_aliases?.length > 0 && (
          <details className="mb-2 text-xs text-slate-500">
            <summary className="cursor-pointer">Anciens produits Stripe ({o.stripe_aliases.length})</summary>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {o.stripe_aliases.map(a => (
                <a key={a.id} href={`https://dashboard.stripe.com/products/${a.id}`} target="_blank" rel="noreferrer"
                  className={`link-record ${a.active ? '' : 'line-through'}`}>{a.name || a.id}</a>
              ))}
            </div>
          </details>
        )}
        {o.stripe_products.length ? (
          <DataTable table="stripe_prices" columns={columns} data={prices} />
        ) : (
          <div className="flex items-center gap-2" onFocusCapture={loadCandidates} onMouseEnter={loadCandidates}>
            <div className="flex-1">
              <SearchableSelect value="" testId="offer-link-select" className="input text-left"
                options={(candidates || []).map(p => ({ value: p.id, label: `${p.name}${p.prices.length ? ` · ${p.prices.map(priceLabel).join(', ')}` : ''}` }))}
                emptyOption="—" placeholder={candidates ? 'Relier à…' : '…'}
                onChange={v => v && run(() => api.stripeCatalog.linkOffer(id, { stripe_product_id: v }))} />
            </div>
            <button className="btn-primary" disabled={busy} title="Créer dans Stripe" data-testid="offer-create-stripe"
              onClick={() => run(() => api.stripeCatalog.linkOffer(id, { create: true }))}>
              <Plus size={14} /> Stripe
            </button>
          </div>
        )}
      </div>
    </DetailShell>
  )
}
