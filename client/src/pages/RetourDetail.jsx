import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, ExternalLink, PanelRight, Package } from 'lucide-react'
import api from '../lib/api.js'
import { PageTitle } from '../components/PageTitle.jsx'
import Spinner from '../components/Spinner.jsx'
import RetourActionsSection from '../components/RetourActionsSection.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { fmtMoney } from '../utils/formatters.js'
import { DetailLoadError } from '../components/DetailLoadError.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { Field } from '../components/Field.jsx'
import { CustomDetailFields } from '../components/CustomDetailFields.jsx'



// Champ d'un ARTICLE de retour (return_items) : bloc d'affichage du side-peek
// de l'article, pas un champ gardé — la configuration des champs de la table
// (libellés, suppressions) s'applique au TABLEAU, via /champs/return_items.
// Les champs de la table `retours` passent, eux, par <Field> (portier).
function ItemField({ label, children, mono = false, full = false }) {
  return (
    <div className={full ? 'col-span-2 md:col-span-3' : ''}>
      <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">{label}</dt>
      <dd className={`${mono ? 'font-mono' : ''} text-slate-700 whitespace-pre-wrap break-words`}>
        {children ?? <span className="text-slate-400">—</span>}
      </dd>
    </div>
  )
}

// Titre du side-peek de l'article, aussi utilisé par le DataTable.
function itemTitle(item) {
  return item?.serial_number
    ? `${item.serial_number} — ${item.product_name || 'Article'}`
    : (item?.product_name || 'Article')
}

// Fiche d'un article : rendue DANS le side-peek du DataTable (peek.render), pas
// dans son propre drawer.
function RetourItemPanel({ item, onClose }) {
  if (!item) return null
  return (
    <div className="p-6 space-y-5">

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Identification</h3>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <ItemField label="N° de série" mono>
              {item.serial_id
                ? <Link to={`/serials/${item.serial_id}`} className="text-brand-600 hover:underline" onClick={onClose}>{item.serial_number || '—'}</Link>
                : item.serial_number}
            </ItemField>
            <ItemField label="N° de ligne" mono>{item.at_id}</ItemField>
            <ItemField label="Statut du n° de série">{item.statut_du_de_serie}</ItemField>
          </dl>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Produit</h3>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <ItemField label="Produit reçu">
              {item.product_id
                ? <Link to={`/products/${item.product_id}`} className="text-brand-600 hover:underline" onClick={onClose}>{item.product_name || '—'}</Link>
                : item.product_name}
            </ItemField>
            <ItemField label="SKU" mono>{item.sku}</ItemField>
            <ItemField label="Quantité">{item.qty}</ItemField>
            <ItemField label="Produit à envoyer">
              {item.product_send_id
                ? <Link to={`/products/${item.product_send_id}`} className="text-brand-600 hover:underline" onClick={onClose}>{item.product_to_send || '—'}</Link>
                : item.product_to_send}
            </ItemField>
            <ItemField label="Produit à recevoir">{item.product_to_receive || item.poduit_a_recevoir_fr_for_email_display}</ItemField>
            <ItemField label="Prix de l'item">{item.prix_de_l_item ? fmtMoney(item.prix_de_l_item) : null}</ItemField>
          </dl>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Motif de retour</h3>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <ItemField label="Raison" full>{item.return_reason || item.reason}</ItemField>
            {item.return_reason_notes && <ItemField label="Précisions" full>{item.return_reason_notes}</ItemField>}
            <ItemField label="Action">{item.action}</ItemField>
            <ItemField label="Catégorie de problème">{item.problem_category}</ItemField>
            <ItemField label="Problème récurrent">{item.probleme_recurrent}</ItemField>
          </dl>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Réception &amp; analyse</h3>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <ItemField label="Reçu le">{fmtDate(item.received_at)}</ItemField>
            <ItemField label="Reçu par">
              {item.received_by_employee_id
                ? <Link to={`/employees/${item.received_by_employee_id}`} className="text-brand-600 hover:underline" onClick={onClose}>{item.received_by}</Link>
                : item.received_by}
            </ItemField>
            <ItemField label="Analysé par">
              {item.analyzed_by_employee_id
                ? <Link to={`/employees/${item.analyzed_by_employee_id}`} className="text-brand-600 hover:underline" onClick={onClose}>{item.analyzed_by}</Link>
                : item.analyzed_by}
            </ItemField>
            <ItemField label="Date d'analyse">{fmtDate(item.date_d_analyse)}</ItemField>
            {item.analysis_notes && <ItemField label="Notes d'analyse" full>{item.analysis_notes}</ItemField>}
            {item.notes_de_retour && <ItemField label="Notes du retour" full>{item.notes_de_retour}</ItemField>}
            {item.instructions_pour_le_receptionniste && <ItemField label="Instructions pour le réceptionniste" full>{item.instructions_pour_le_receptionniste}</ItemField>}
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
  )
}

// Colonnes du DataTable « Articles » de la fiche retour : méta partagée
// (tableDefs.return_items) + rendus de la page. Champs référence → liens vers
// la fiche visée (règle « champs référence » du CLAUDE.md).
const ITEM_RENDERS = {
  serial_number: item => (item.serial_id
    ? <Link to={`/serials/${item.serial_id}`} onClick={e => e.stopPropagation()} className="font-mono text-xs font-medium text-brand-600 hover:underline">{item.serial_number || '—'}</Link>
    : <span className="font-mono text-xs font-medium text-slate-900">{item.serial_number || '—'}</span>),
  product_name: item => (item.product_id
    ? <Link to={`/products/${item.product_id}`} onClick={e => e.stopPropagation()} className="font-medium text-brand-600 hover:underline">{item.product_name || 'Produit'}</Link>
    : <span className="font-medium text-slate-900">{item.product_name || '—'}</span>),
  sku: item => (item.sku
    ? <span className="font-mono text-xs text-slate-500">{item.sku}</span>
    : <span className="text-slate-300">—</span>),
  received_at: item => (item.received_at ? fmtDate(item.received_at) : <span className="text-slate-300">—</span>),
  created_at: item => (item.created_at ? fmtDate(item.created_at) : <span className="text-slate-300">—</span>),
  product_to_receive: item => (item.product_to_receive && item.product_id
    ? <Link to={`/products/${item.product_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{item.product_to_receive}</Link>
    : (item.product_to_receive || <span className="text-slate-300">—</span>)),
  product_to_send: item => (item.product_to_send && item.product_send_id
    ? <Link to={`/products/${item.product_send_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{item.product_to_send}</Link>
    : (item.product_to_send || <span className="text-slate-300">—</span>)),
  received_by: item => (item.received_by_employee_id
    ? <Link to={`/employees/${item.received_by_employee_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{item.received_by}</Link>
    : (item.received_by || <span className="text-slate-300">—</span>)),
  analyzed_by: item => (item.analyzed_by_employee_id
    ? <Link to={`/employees/${item.analyzed_by_employee_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{item.analyzed_by}</Link>
    : (item.analyzed_by || <span className="text-slate-300">—</span>)),
}
const ITEM_COLUMNS = TABLE_COLUMN_META.return_items.map(meta => ({ ...meta, render: ITEM_RENDERS[meta.id] }))

export default function RetourDetail({ recordId, embedded = true }) {
  const { id: paramId } = useParams()
  const id = recordId ?? paramId
  const navigate = useNavigate()
  // Le cadre vient toujours du panneau latéral : une fiche ne s'affiche jamais
  // en pleine page (voir components/RecordRoutePanel.jsx).
  const shell = (content) => content

  const { record: retour, setRecord: setRetour, loading, loadError, reload: load } =
    useDetailRecord(() => api.retours.get(id), [id], { clearOnError: true })

  // Modifié ailleurs (Airtable, un collègue) → la fiche suit sans rechargement.
  useRealtimeChannel(id ? `return:${id}` : null, (msg) => {
    if (msg.type === 'return:updated') setRetour(r => (r ? { ...r, ...msg.payload } : r))
  })

  if (loading) return shell(<Spinner center />)
  if (loadError && !retour) return shell(<DetailLoadError message={loadError} onRetry={load} />)
  if (!retour) return shell(<div className="p-6 text-slate-500">Retour introuvable.</div>)

  return shell(
    <>
    <div className={embedded ? 'p-6' : 'p-6 max-w-5xl mx-auto'}>
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          {!embedded && (
            <button onClick={() => navigate('/retours')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <PageTitle>{retour.n_de_retour || `Retour #${id}`}</PageTitle>
            </div>
            <div className="text-sm text-slate-500 mt-1">
              {retour.company_name && retour.company_id && (
                <LinkedRecordField
                  name="company_id"
                  value={retour.company_id}
                  options={[{ id: retour.company_id, name: retour.company_name }]}
                  getHref={c => `/companies/${c.id}`}
                  disabled
                  allowClear={false}
                />
              )}
            </div>
          </div>
          {!embedded && (
            <button
              onClick={() => navigate('/retours', { state: { peekId: id } })}
              title="Revenir au panneau"
              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg"
            >
              <PanelRight size={18} />
            </button>
          )}
        </div>

        {/* Info section */}
        <div className="card p-5 mb-4">
          <h2 className="font-semibold text-slate-900 mb-4">Informations</h2>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <Field table="retours" id="n_de_retour" label="N° de retour" labelClassName="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">
              <dd className="font-mono font-medium text-slate-900">{retour.n_de_retour || '—'}</dd>
            </Field>
            <Field table="retours" id="created_at" label="Date de création" labelClassName="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">
              <dd className="text-slate-700">{fmtDate(retour.created_at)}</dd>
            </Field>
            {retour.received_at && (
              <Field table="retours" id="received_at" label="Date de réception" labelClassName="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">
                <dd className="text-slate-700">{fmtDate(retour.received_at)}</dd>
              </Field>
            )}
            {retour.notes && (
              <Field table="retours" id="notes" label="Notes" className="col-span-2 md:col-span-3" labelClassName="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">
                <dd className="text-slate-700 whitespace-pre-wrap">{retour.notes}</dd>
              </Field>
            )}
            <CustomDetailFields table="retours" record={retour} labelClassName="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1" />
          </dl>
        </div>

        {/* Actions : étiquette de retour, aide-mémoire, instructions au client */}
        <div className="card p-5 mb-4">
          <RetourActionsSection retour={retour} onDone={load} />
        </div>

        {/* Articles — DataTable (vues, tri, filtres, groupement, side-peek sur
            la fiche de l'article). Table de LECTURE : les articles d'un retour
            naissent du miroir Airtable, pas d'une saisie en ligne ici. */}
        <div className="mb-4">
          <h2 className="font-semibold text-slate-900 mb-2">Articles ({retour.items?.length || 0})</h2>
          <DataTable
            table="retour_items"
            columns={ITEM_COLUMNS}
            data={retour.items || []}
            searchFields={['serial_number', 'product_name', 'sku', 'return_reason', 'action']}
            // Tous les articles s'affichent : pas d'ascenseur dans la table,
            // c'est le panneau de la fiche qui défile.
            height="auto"
            peek={{
              title: itemTitle,
              subtitle: () => retour.n_de_retour || 'Retour',
              width: 520,
              key: 'retour_items',
              render: (item, { close }) => <RetourItemPanel item={item} onClose={close} />,
            }}
            emptyState={{
              icon: Package,
              title: 'Aucun article',
              description: "Ce retour n'a aucun article.",
            }}
          />
        </div>
      </div>
    </>,
  )
}
