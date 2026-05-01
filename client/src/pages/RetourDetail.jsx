import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { fmtDate } from '../lib/formatDate.js'


const STATUS_COLORS = {
  'Reçu': 'green',
  'En attente': 'yellow',
  'En traitement': 'blue',
  'Refusé': 'red',
}

function Field({ label, children, mono = false, full = false }) {
  return (
    <div className={full ? 'col-span-2 md:col-span-3' : ''}>
      <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">{label}</dt>
      <dd className={`${mono ? 'font-mono' : ''} text-slate-700 whitespace-pre-wrap break-words`}>
        {children ?? <span className="text-slate-400">—</span>}
      </dd>
    </div>
  )
}

function ItemDetailModal({ item, onClose }) {
  if (!item) return null
  const title = item.serial_number ? `${item.serial_number} — ${item.product_name || 'Article'}` : (item.product_name || 'Article')
  return (
    <Modal isOpen={!!item} onClose={onClose} title={title} size="xl">
      <div className="space-y-5">

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Identification</h3>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <Field label="N° de série" mono>
              {item.serial_id
                ? <Link to={`/serials/${item.serial_id}`} className="text-brand-600 hover:underline" onClick={onClose}>{item.serial_number || '—'}</Link>
                : item.serial_number}
            </Field>
            <Field label="N° de ligne" mono>{item.at_id}</Field>
            <Field label="Statut du n° de série">{item.statut_du_de_serie}</Field>
          </dl>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Produit</h3>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <Field label="Produit reçu">
              {item.product_id
                ? <Link to={`/products/${item.product_id}`} className="text-brand-600 hover:underline" onClick={onClose}>{item.product_name || '—'}</Link>
                : item.product_name}
            </Field>
            <Field label="SKU" mono>{item.sku}</Field>
            <Field label="Quantité">{item.qty}</Field>
            <Field label="Produit à envoyer">
              {item.product_send_id
                ? <Link to={`/products/${item.product_send_id}`} className="text-brand-600 hover:underline" onClick={onClose}>{item.product_to_send || '—'}</Link>
                : item.product_to_send}
            </Field>
            <Field label="Produit à recevoir">{item.product_to_receive || item.poduit_a_recevoir_fr_for_email_display}</Field>
            <Field label="Prix de l'item">{item.prix_de_l_item ? `${Number(item.prix_de_l_item).toLocaleString('fr-CA', { style: 'currency', currency: 'CAD' })}` : null}</Field>
          </dl>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Motif de retour</h3>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <Field label="Raison" full>{item.return_reason || item.reason}</Field>
            {item.return_reason_notes && <Field label="Précisions" full>{item.return_reason_notes}</Field>}
            <Field label="Action">{item.action}</Field>
            <Field label="Catégorie de problème">{item.problem_category}</Field>
            <Field label="Problème récurrent">{item.probleme_recurrent}</Field>
          </dl>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Réception &amp; analyse</h3>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <Field label="Reçu le">{fmtDate(item.received_at)}</Field>
            <Field label="Reçu par">{item.received_by}</Field>
            <Field label="Analysé par">{item.analyzed_by}</Field>
            <Field label="Date d'analyse">{fmtDate(item.date_d_analyse)}</Field>
            {item.analysis_notes && <Field label="Notes d'analyse" full>{item.analysis_notes}</Field>}
            {item.notes_de_retour && <Field label="Notes du retour" full>{item.notes_de_retour}</Field>}
            {item.instructions_pour_le_receptionniste && <Field label="Instructions pour le réceptionniste" full>{item.instructions_pour_le_receptionniste}</Field>}
          </dl>
        </section>

        {item.lien_issue_github && (
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Liens</h3>
            <a
              href={item.lien_issue_github}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:underline"
            >
              Issue GitHub #{item.issue_github ? Math.trunc(Number(item.issue_github)) : ''} <ExternalLink size={13} />
            </a>
          </section>
        )}

        {item.image_from_numero_de_serie && (
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Photos</h3>
            <div className="flex gap-3 flex-wrap">
              {String(item.image_from_numero_de_serie).split(',').map((url, i) => {
                const u = url.trim()
                if (!u) return null
                return (
                  <a key={i} href={u} target="_blank" rel="noopener noreferrer" className="block">
                    <img src={u} alt="" className="h-32 w-32 object-cover rounded-lg border border-slate-200 hover:border-brand-400 transition-colors" />
                  </a>
                )
              })}
            </div>
          </section>
        )}

      </div>
    </Modal>
  )
}

export default function RetourDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [retour, setRetour] = useState(null)
  const [loading, setLoading] = useState(true)
  const [selectedItem, setSelectedItem] = useState(null)

  useEffect(() => {
    setLoading(true)
    api.retours.get(id)
      .then(data => setRetour(data))
      .catch(() => setRetour(null))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600" />
        </div>
      </Layout>
    )
  }
  if (!retour) return <Layout><div className="p-6 text-slate-500">Retour introuvable.</div></Layout>

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <button onClick={() => navigate('/retours')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900">{retour.return_number || `Retour #${id}`}</h1>
              {retour.processing_status && (
                <Badge color={STATUS_COLORS[retour.processing_status] || 'gray'} size="md">
                  {retour.processing_status}
                </Badge>
              )}
            </div>
            <div className="text-sm text-slate-500 mt-1">
              {retour.company_name && retour.company_id && (
                <Link to={`/companies/${retour.company_id}`} className="text-brand-600 hover:underline mr-2">
                  {retour.company_name}
                </Link>
              )}
            </div>
          </div>
        </div>

        {/* Info section */}
        <div className="card p-5 mb-4">
          <h2 className="font-semibold text-slate-900 mb-4">Informations</h2>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">N° de retour</dt>
              <dd className="font-mono font-medium text-slate-900">{retour.return_number || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">N° de suivi</dt>
              <dd className="font-mono text-slate-700">{retour.tracking_number || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Date de création</dt>
              <dd className="text-slate-700">{fmtDate(retour.created_at)}</dd>
            </div>
            {retour.received_at && (
              <div>
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Date de réception</dt>
                <dd className="text-slate-700">{fmtDate(retour.received_at)}</dd>
              </div>
            )}
            {retour.notes && (
              <div className="col-span-2 md:col-span-3">
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Notes</dt>
                <dd className="text-slate-700 whitespace-pre-wrap">{retour.notes}</dd>
              </div>
            )}
          </dl>
        </div>

        {/* Items section */}
        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200">
            <h2 className="font-semibold text-slate-900">Articles ({retour.items?.length || 0})</h2>
          </div>
          {!retour.items?.length ? (
            <p className="text-center py-10 text-slate-400">Aucun article</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">N° de série</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Produit / SKU</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell">Raison</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Action</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Reçu le</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden lg:table-cell">Produit à recevoir</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden lg:table-cell">Produit à envoyer</th>
                </tr>
              </thead>
              <tbody>
                {retour.items.map((item, i) => (
                  <tr
                    key={item.id || i}
                    onClick={() => setSelectedItem(item)}
                    className="border-b border-slate-100 last:border-0 hover:bg-brand-50/40 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-xs font-medium text-slate-900">{item.serial_number || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{item.product_name || '—'}</div>
                      {item.sku && <div className="text-xs text-slate-400 font-mono">{item.sku}</div>}
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell text-slate-600">{item.return_reason || '—'}</td>
                    <td className="px-4 py-3 hidden md:table-cell text-slate-600">{item.action || '—'}</td>
                    <td className="px-4 py-3 hidden md:table-cell text-slate-500">{fmtDate(item.received_at)}</td>
                    <td className="px-4 py-3 hidden lg:table-cell text-slate-600">{item.product_to_receive || '—'}</td>
                    <td className="px-4 py-3 hidden lg:table-cell text-slate-600">{item.product_to_send || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <ItemDetailModal item={selectedItem} onClose={() => setSelectedItem(null)} />
    </Layout>
  )
}
