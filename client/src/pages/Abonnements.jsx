import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, RefreshCw, CreditCard, X, FileText, ChevronRight } from 'lucide-react'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { month: 'short', day: 'numeric', year: 'numeric' })
}

const STATUS_COLORS = {
  // Stripe (anglais)
  'active': 'green',
  'trialing': 'blue',
  'past_due': 'yellow',
  'canceled': 'red',
  // Airtable (français)
  'Actif': 'green',
  'Inactif': 'gray',
  'Suspendu': 'yellow',
  'Annulé': 'red',
  'Expiré': 'orange',
}

const RACHAT_COLORS = {
  'rachat complet':  'bg-green-100 text-green-700',
  'rachat partiel':  'bg-yellow-100 text-yellow-700',
  'fusion':          'bg-purple-100 text-purple-700',
}

function RachatCell({ row, onChange }) {
  const [saving, setSaving] = useState(false)

  async function handleChange(e) {
    e.stopPropagation()
    const val = e.target.value || null
    setSaving(true)
    try {
      await api.abonnements.patch(row.id, { rachat: val })
      onChange(row.id, val)
    } catch (err) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="relative inline-block" onClick={e => e.stopPropagation()}>
      <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full pointer-events-none select-none ${
        row.rachat ? RACHAT_COLORS[row.rachat] : 'text-slate-300'
      } ${saving ? 'opacity-50' : ''}`}>
        {row.rachat || '+ ajouter'}
      </span>
      <select
        value={row.rachat || ''}
        onChange={handleChange}
        disabled={saving}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
      >
        <option value="">— aucun</option>
        <option value="rachat complet">Rachat complet</option>
        <option value="rachat partiel">Rachat partiel</option>
        <option value="fusion">Fusion</option>
      </select>
    </div>
  )
}

const RENDERS = {
  company_name: row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-indigo-600 hover:underline">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  status:     row => row.status
    ? <Badge color={STATUS_COLORS[row.status] || 'gray'}>{row.status}</Badge>
    : <span className="text-slate-400">—</span>,
  amount_cad: row => <span className="font-medium text-slate-700">{fmtCad(row.amount_cad)}</span>,
  start_date: row => <span className="text-slate-500">{fmtDate(row.start_date)}</span>,
  end_date:   row => <span className="text-slate-500">{fmtDate(row.end_date)}</span>,
  stripe_url: row => row.stripe_url
    ? <a href={row.stripe_url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="inline-flex items-center gap-1 text-purple-600 hover:underline text-xs"><ExternalLink size={12} /> Stripe</a>
    : <span className="text-slate-400">—</span>,
}

function AbonnementDetailModal({ abonnement, onClose }) {
  const [details, setDetails] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!abonnement) return
    setLoading(true)
    api.abonnements.stripeDetails(abonnement.id)
      .then(setDetails)
      .catch(() => setDetails(null))
      .finally(() => setLoading(false))
  }, [abonnement?.id])

  if (!abonnement) return null

  return (
    <Modal isOpen onClose={onClose} title="Détails de l'abonnement" size="xl">
      <div className="space-y-5">
        {/* En-tête */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div>
            <div className="text-sm text-slate-500">Entreprise</div>
            <Link to={`/companies/${abonnement.company_id}`} className="font-semibold text-indigo-600 hover:underline">{abonnement.company_name || '—'}</Link>
          </div>
          <div className="flex items-center gap-3">
            <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium ${abonnement.status === 'active' ? 'bg-green-100 text-green-700' : abonnement.status === 'canceled' ? 'bg-red-100 text-red-700' : abonnement.status === 'past_due' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
              {abonnement.status === 'active' ? 'Actif' : abonnement.status === 'canceled' ? 'Annulé' : abonnement.status === 'past_due' ? 'En retard' : abonnement.status === 'trialing' ? 'Essai' : abonnement.status}
            </span>
            <span className="text-lg font-bold text-slate-800">{fmtCad(abonnement.amount_cad)}<span className="text-xs font-normal text-slate-400">/{abonnement.interval_type === 'year' ? 'an' : 'mois'}</span></span>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div><div className="text-xs text-slate-400 mb-0.5">Début</div><div className="text-slate-700">{fmtDate(abonnement.start_date)}</div></div>
          <div><div className="text-xs text-slate-400 mb-0.5">Fin</div><div className="text-slate-700">{fmtDate(abonnement.end_date)}</div></div>
          <div><div className="text-xs text-slate-400 mb-0.5">Client Stripe</div><div className="text-slate-700 font-mono text-xs">{abonnement.customer_email || '—'}</div></div>
          <div>
            <div className="text-xs text-slate-400 mb-0.5">Stripe</div>
            {abonnement.stripe_url
              ? <a href={abonnement.stripe_url} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline text-xs inline-flex items-center gap-1"><ExternalLink size={11} /> Voir</a>
              : <span className="text-slate-400">—</span>}
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" /></div>
        ) : !details ? (
          <p className="text-center py-8 text-slate-400 text-sm">Impossible de charger les détails Stripe</p>
        ) : (
          <>
            {/* Produits */}
            <div>
              <h4 className="text-sm font-semibold text-slate-700 mb-2">Produits</h4>
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500">Produit</th>
                      <th className="text-right px-4 py-2 text-xs font-semibold text-slate-500">Prix unitaire</th>
                      <th className="text-right px-4 py-2 text-xs font-semibold text-slate-500">Qté</th>
                      <th className="text-right px-4 py-2 text-xs font-semibold text-slate-500">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {details.items.map(item => (
                      <tr key={item.id} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-slate-800">{item.product_name}</div>
                          {item.description && <div className="text-xs text-slate-400 mt-0.5">{item.description}</div>}
                          {item.interval && <div className="text-xs text-slate-400">/ {item.interval_count > 1 ? `${item.interval_count} ` : ''}{item.interval === 'month' ? 'mois' : item.interval === 'year' ? 'an' : item.interval}</div>}
                        </td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{item.unit_amount != null ? `${item.unit_amount.toFixed(2)} ${item.currency}` : '—'}</td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{item.quantity}</td>
                        <td className="px-4 py-2.5 text-right font-medium text-slate-800">{item.total != null ? `${item.total.toFixed(2)} ${item.currency}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {details.discount && (
                <div className="mt-2 text-xs text-indigo-600">
                  Rabais: {details.discount.name}
                  {details.discount.percent_off && ` (${details.discount.percent_off}%)`}
                  {details.discount.amount_off && ` (${details.discount.amount_off} $)`}
                </div>
              )}
            </div>

            {/* Historique des changements */}
            {details.history.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-slate-700 mb-2">Historique des changements</h4>
                <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                  {details.history.map((h, i) => (
                    <div key={i} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                      <div className="flex-shrink-0 pt-0.5 w-28">
                        <div className="text-xs text-slate-400">{fmtDate(h.date)}</div>
                        <div className={`text-[10px] font-medium mt-0.5 ${h.type === 'creation' ? 'text-green-600' : 'text-amber-600'}`}>
                          {h.type === 'creation' ? 'Création' : 'Modification'}
                        </div>
                      </div>
                      <div className="flex-1 space-y-0.5">
                        {h.changes.map((c, j) => (
                          <div key={j} className="text-slate-600 text-sm">{typeof c === 'string' ? c : `${c.field}: ${c.from || ''} → ${c.to || ''}`}</div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Factures récentes */}
            {details.invoices.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-slate-700 mb-2">Factures ({details.invoices.length})</h4>
                <div className="border border-slate-200 rounded-lg overflow-hidden divide-y divide-slate-100">
                  {details.invoices.map((inv, i) => (
                    <div key={i} className="px-4 py-2.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-slate-700 font-mono">{inv.number || '—'}</span>
                          <span className="text-xs text-slate-400">{fmtDate(inv.date)}</span>
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium ${inv.status === 'paid' ? 'bg-green-100 text-green-700' : inv.status === 'open' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                            {inv.status === 'paid' ? 'Payée' : inv.status === 'open' ? 'Ouverte' : inv.status === 'draft' ? 'Brouillon' : inv.status}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-medium text-slate-700 text-sm">{inv.amount.toFixed(2)} {inv.currency}</span>
                          {inv.pdf && <a href={inv.pdf} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline text-xs inline-flex items-center gap-1"><FileText size={11} /></a>}
                        </div>
                      </div>
                      {inv.lines && inv.lines.length > 0 && (
                        <div className="mt-1.5 space-y-0.5">
                          {inv.lines.map((li, j) => (
                            <div key={j} className={`flex items-center justify-between text-xs ${li.proration ? 'text-amber-600' : 'text-slate-400'}`}>
                              <span className="truncate mr-4">{li.proration ? '↕ ' : ''}{li.description}</span>
                              <span className="flex-shrink-0 font-mono">{li.amount >= 0 ? '' : '-'}{Math.abs(li.amount).toFixed(2)} $</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

export default function Abonnements() {
  const [abonnements, setAbonnements] = useState([])
  const [loading, setLoading] = useState(true)
  const [stripeConfigured, setStripeConfigured] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [selected, setSelected] = useState(null)

  function handleRachatChange(id, val) {
    setAbonnements(prev => prev.map(a => a.id === id ? { ...a, rachat: val } : a))
  }

  const COLUMNS = TABLE_COLUMN_META.abonnements.map(meta => ({
    ...meta,
    render: meta.id === 'rachat'
      ? row => <RachatCell row={row} onChange={handleRachatChange} />
      : RENDERS[meta.id],
  }))

  const load = useCallback(async () => {
    api.stripe.info().catch(() => ({ configured: false })).then(info => setStripeConfigured(!!info.configured))
    await loadProgressive(
      (page, limit) => api.abonnements.list({ limit, page }),
      setAbonnements, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])

  const syncStripe = async () => {
    setSyncing(true)
    try {
      await api.stripe.sync()
      // Poll until sync finishes, then reload
      const poll = setInterval(async () => {
        try {
          const status = await api.connectors.syncStatus()
          if (!status?.stripe?.running) {
            clearInterval(poll)
            await load()
            setSyncing(false)
          }
        } catch { clearInterval(poll); setSyncing(false) }
      }, 1500)
    } catch (e) {
      alert(e.message)
      setSyncing(false)
    }
  }

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Abonnements</h1>
          </div>
          <div className="flex items-center gap-2">
            {stripeConfigured && (
              <button onClick={syncStripe} disabled={syncing} className="btn-secondary btn-sm text-xs">
                <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
                {syncing ? 'Synchronisation…' : 'Sync Stripe'}
              </button>
            )}
            <TableConfigModal table="abonnements" />
          </div>
        </div>

        {!loading && !stripeConfigured && (
          <div className="mb-4 flex items-center gap-3 px-4 py-3 bg-purple-50 border border-purple-200 rounded-xl text-sm text-purple-800">
            <CreditCard size={16} className="text-purple-500 flex-shrink-0" />
            <span>Configurez le connecteur Stripe pour synchroniser les abonnements en temps réel.</span>
            <Link to="/connectors" className="ml-auto text-xs font-semibold text-purple-700 hover:underline whitespace-nowrap">
              Configurer →
            </Link>
          </div>
        )}

        <DataTable
          table="abonnements"
          columns={COLUMNS}
          data={abonnements}
          loading={loading}
          searchFields={['company_name']}
          onRowClick={setSelected}
        />
      </div>

      <AbonnementDetailModal abonnement={selected} onClose={() => setSelected(null)} />
    </Layout>
  )
}
