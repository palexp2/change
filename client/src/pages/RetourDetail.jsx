import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, Package, PackageCheck } from 'lucide-react'
import api from '../lib/api.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { useAutosave } from '../lib/useAutosave.js'
import RetourActionsSection from '../components/RetourActionsSection.jsx'
import RetourReceptionSection from '../components/RetourReceptionSection.jsx'
import { useAuth } from '../lib/auth.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate, localISODate } from '../lib/formatDate.js'
import { fmtMoney } from '../utils/formatters.js'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { DetailFieldGrid, DetailField } from '../components/DetailFieldGrid.jsx'
import { CustomFieldEditor, isEditableCustomField } from '../components/CustomDetailFields.jsx'
import { useCustomFields } from '../lib/useCustomFields.js'
import { LinkedRecordsValue } from '../lib/customFieldDisplay.jsx'



// Champ d'un ARTICLE de retour (return_items) : bloc d'affichage du side-peek
// de l'article, pas un champ gardé — la configuration des champs de la table
// (libellés, suppressions) s'applique au TABLEAU, via /champs/return_items.
// Les champs de la table `retours` passent, eux, par la carte de champs
// commune (<DetailFieldGrid>), qui applique le portier et règle leur ordre.
//
// `col` : colonne de l'article. Si le serveur la dit éditable (champ sans
// import Airtable ou bidirectionnel — même règle que le tableau), le bloc
// devient un éditeur en place (autosave) ; sinon il reste en lecture.
function ItemField({ label, children, mono = false, full = false, col, edit }) {
  const f = col && edit?.fields.get(col)
  const editor = f && isEditableCustomField(f) && (
    <CustomFieldEditor
      field={{ key: col, type: f.type, field: f, writable: f.writable }}
      value={edit.item[col]}
      saving={!!edit.saving[col]}
      onSave={edit.save}
      recordId={edit.item.id}
    />
  )
  return (
    <div className={full ? 'col-span-2 md:col-span-3' : ''}>
      <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">{label}</dt>
      <dd className={`${mono ? 'font-mono' : ''} text-slate-700 whitespace-pre-wrap break-words`}>
        {editor || (children ?? <span className="text-slate-400">—</span>)}
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
// dans son propre drawer. `onSave(itemId, colonne, valeur)` écrit un champ.
function RetourItemPanel({ item, onClose, onSave }) {
  const { fields: cf } = useCustomFields('return_items')
  const fields = useMemo(() => new Map(cf.map(f => [f.column_name, f])), [cf])
  const [saving, setSaving] = useState({})
  const itemId = item?.id
  const save = useCallback(async (col, value) => {
    setSaving(s => ({ ...s, [col]: true }))
    try { await onSave(itemId, col, value) } finally { setSaving(s => ({ ...s, [col]: false })) }
  }, [itemId, onSave])
  if (!item) return null
  const edit = { item, fields, saving, save }
  // Bloc facultatif : montré s'il a une valeur, ou s'il peut en recevoir une.
  const shown = col => !!item[col] || (fields.get(col) && isEditableCustomField(fields.get(col)))
  return (
    <div className="p-6 space-y-5">

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Identification</h3>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <ItemField label="N° de série" mono>
              {item.serial_id
                ? <Link to={`/serials/${item.serial_id}`} className="link-record" onClick={onClose}>{item.serial_number || '—'}</Link>
                : item.serial_number}
            </ItemField>
            <ItemField label="N° de ligne" mono col="at_id" edit={edit}>{item.at_id}</ItemField>
            <ItemField label="Statut du n° de série" col="statut_du_de_serie" edit={edit}>{item.statut_du_de_serie}</ItemField>
          </dl>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Produit</h3>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <ItemField label="Produit reçu">
              {item.product_id
                ? <Link to={`/products/${item.product_id}`} className="link-record" onClick={onClose}>{item.product_name || '—'}</Link>
                : item.product_name}
            </ItemField>
            <ItemField label="SKU" mono>{item.sku}</ItemField>
            <ItemField label="Produit à recevoir">{item.product_to_receive || item.poduit_a_recevoir_fr_for_email_display}</ItemField>
            <ItemField label="Prix de l'item" col="prix_de_l_item" edit={edit}>{item.prix_de_l_item ? fmtMoney(item.prix_de_l_item) : null}</ItemField>
          </dl>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Motif de retour</h3>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <ItemField label="Raison" full col="return_reason" edit={edit}>{item.return_reason || item.reason}</ItemField>
            {shown('return_reason_notes') && <ItemField label="Précisions" full col="return_reason_notes" edit={edit}>{item.return_reason_notes}</ItemField>}
            <ItemField label="Action" col="action" edit={edit}>{item.action}</ItemField>
            <ItemField label="Catégorie de problème" col="problem_category" edit={edit}>{item.problem_category}</ItemField>
            <ItemField label="Problème récurrent" col="probleme_recurrent" edit={edit}>{item.probleme_recurrent}</ItemField>
          </dl>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Réception &amp; analyse</h3>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <ItemField label="Reçu le" col="received_at" edit={edit}>{fmtDate(item.received_at)}</ItemField>
            <ItemField label="Reçu par" col="received_by" edit={edit}>
              {item.received_by_employee_id
                ? <Link to={`/employees/${item.received_by_employee_id}`} className="link-record" onClick={onClose}>{item.received_by}</Link>
                : item.received_by}
            </ItemField>
            <ItemField label="Analysé par" col="analyzed_by" edit={edit}>
              {item.analyzed_by_employee_id
                ? <Link to={`/employees/${item.analyzed_by_employee_id}`} className="link-record" onClick={onClose}>{item.analyzed_by}</Link>
                : item.analyzed_by}
            </ItemField>
            <ItemField label="Date d'analyse" col="date_d_analyse" edit={edit}>{fmtDate(item.date_d_analyse)}</ItemField>
            {shown('analysis_notes') && <ItemField label="Notes d'analyse" full col="analysis_notes" edit={edit}>{item.analysis_notes}</ItemField>}
            {shown('notes_de_retour') && <ItemField label="Notes du retour" full col="notes_de_retour" edit={edit}>{item.notes_de_retour}</ItemField>}
            {shown('instructions_pour_le_receptionniste') && <ItemField label="Instructions pour le réceptionniste" full col="instructions_pour_le_receptionniste" edit={edit}>{item.instructions_pour_le_receptionniste}</ItemField>}
          </dl>
        </section>

        {(item.billets || item.commande) && (
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Liés</h3>
            <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              {item.billets && <ItemField label="Billet"><LinkedRecordsValue field={{ record_link_target: 'tickets' }} value={item.billets} /></ItemField>}
              {item.commande && <ItemField label="Commande de remplacement"><LinkedRecordsValue field={{ record_link_target: 'orders' }} value={item.commande} /></ItemField>}
            </dl>
          </section>
        )}

        {item.lien_issue_github && (
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Liens</h3>
            <a
              href={item.lien_issue_github}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm link-record"
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
    ? <Link to={`/serials/${item.serial_id}`} onClick={e => e.stopPropagation()} className="font-mono text-xs font-medium link-record">{item.serial_number || '—'}</Link>
    : <span className="font-mono text-xs font-medium text-slate-900">{item.serial_number || '—'}</span>),
  product_name: item => (item.product_id
    ? <Link to={`/products/${item.product_id}`} onClick={e => e.stopPropagation()} className="font-medium link-record">{item.product_name || 'Produit'}</Link>
    : <span className="font-medium text-slate-900">{item.product_name || '—'}</span>),
  sku: item => (item.sku
    ? <span className="font-mono text-xs text-slate-500">{item.sku}</span>
    : <span className="text-slate-300">—</span>),
  received_at: item => (item.received_at ? fmtDate(item.received_at) : <span className="text-slate-300">—</span>),
  created_at: item => (item.created_at ? fmtDate(item.created_at) : <span className="text-slate-300">—</span>),
  product_to_receive: item => (item.product_to_receive && item.product_id
    ? <Link to={`/products/${item.product_id}`} onClick={e => e.stopPropagation()} className="link-record">{item.product_to_receive}</Link>
    : (item.product_to_receive || <span className="text-slate-300">—</span>)),
  received_by: item => (item.received_by_employee_id
    ? <Link to={`/employees/${item.received_by_employee_id}`} onClick={e => e.stopPropagation()} className="link-record">{item.received_by}</Link>
    : (item.received_by || <span className="text-slate-300">—</span>)),
  analyzed_by: item => (item.analyzed_by_employee_id
    ? <Link to={`/employees/${item.analyzed_by_employee_id}`} onClick={e => e.stopPropagation()} className="link-record">{item.analyzed_by}</Link>
    : (item.analyzed_by || <span className="text-slate-300">—</span>)),
}
const ITEM_COLUMNS = TABLE_COLUMN_META.return_items.map(meta => ({ ...meta, render: ITEM_RENDERS[meta.id] }))

export default function RetourDetail({ recordId: id }) {
  const { record: retour, setRecord: setRetour, loading, loadError, reload: load } =
    useDetailRecord(() => api.retours.get(id), [id], { clearOnError: true })

  // Modifié ailleurs (Airtable, un collègue) → la fiche suit sans rechargement.
  useRealtimeChannel(id ? `return:${id}` : null, (msg) => {
    if (msg.type === 'return:updated') setRetour(r => (r ? { ...r, ...msg.payload } : r))
  })

  const { addToast } = useToast()
  const { user } = useAuth()

  // Autosave des champs du retour. Seuls les champs bidirectionnels (ou sans
  // import Airtable) sont éditables — le serveur refuse les autres, dont la
  // saisie serait de toute façon écrasée au prochain sync.
  const { save: saveField, savingKeys } = useAutosave(
    retour,
    patch => api.retours.update(id, patch),
    {
      enabled: !!retour,
      onSaved: updated => setRetour(r => (r ? { ...r, ...updated } : r)),
      onError: (key, prev) => setRetour(r => (r ? { ...r, [key]: prev } : r)),
    }
  )

  // Patch ciblé d'un article déjà affiché (réception au pistolet, édition en
  // ligne) : la ligne porte des colonnes jointes que les réponses ne
  // connaissent pas — fusionner en bloc les effacerait.
  const patchItem = useCallback((patch) => {
    setRetour(r => (r
      ? { ...r, items: (r.items || []).map(it => (it.id === patch.id ? { ...it, ...patch } : it)) }
      : r))
  }, [setRetour])

  // Écriture d'un champ d'article : tableau (mode tableur) et side-peek.
  const saveItemValue = useCallback(async (itemId, column, value) => {
    try {
      const updated = await api.retours.updateItem(itemId, { [column]: value })
      patchItem({ id: itemId, [column]: updated?.[column] ?? value })
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }, [addToast, patchItem])
  const saveItemField = useCallback((row, col, value) => saveItemValue(row.id, col.field, value), [saveItemValue])

  // Réceptionniste et date : partagés par le pistolet et par le bouton
  // « Réceptionner » des articles cochés.
  const [receptionPerson, setReceptionPerson] = useState(() => user?.name || '')
  const [receptionDate, setReceptionDate] = useState(() => localISODate())
  // Consigne d'étagère du dernier geste (scan ou « Réceptionner »).
  const [receptionResults, setReceptionResults] = useState([])

  const receiveItems = useCallback(async (itemIds) => {
    const r = await api.retours.receiveItems(id, {
      item_ids: itemIds, received_by: receptionPerson, received_at: receptionDate,
    })
    for (const itemId of r.received || []) {
      patchItem({ id: itemId, received_at: r.received_at, received_by: r.received_by })
    }
    setReceptionResults((r.instructions || []).map(x => ({ action: 'received', ...x })))
  }, [id, receptionPerson, receptionDate, patchItem])

  const pending = detailPending({ loading, loadError, onRetry: load, record: retour, notFound: 'Retour introuvable.' })
  if (pending) return pending

  return (
    <DetailShell>
        {/* Info section */}
        {/* Carte de champs commune : ordre, retrait et ajout d'un champ de la
            table se règlent depuis la fiche (bouton « Personnaliser les
            champs »). Les champs personnalisés de /champs/retours s'y posent
            seuls, et restent modifiables — d'où `onSaveCustom`.
            « Statut » retiré : colonne droppée (migration serveur 041). */}
        <DetailFieldGrid
          entityType="retours"
          record={retour}
          onSaveCustom={saveField}
          savingKeys={savingKeys}
          className="card p-5 mb-4"
          testId="retour-fields"
        >
          <DetailField id="created_at" label="Date de création">
            <span className="text-sm text-slate-700">{fmtDate(retour.created_at)}</span>
          </DetailField>
          <DetailField id="received_at" label="Date de réception">
            <span className="text-sm text-slate-700">{retour.received_at ? fmtDate(retour.received_at) : '—'}</span>
          </DetailField>
        </DetailFieldGrid>

        {/* Actions : étiquette de retour, aide-mémoire, instructions au client */}
        <div className="card p-5 mb-4">
          <RetourActionsSection retour={retour} onDone={load} />
        </div>

        {/* Réception : qui reçoit, quand, et le pistolet. Juste au-dessus des
            articles — c'est sur eux que le scan pose la date et la personne. */}
        <RetourReceptionSection
          retour={retour}
          person={receptionPerson}
          setPerson={setReceptionPerson}
          date={receptionDate}
          setDate={setReceptionDate}
          onItemReceived={patchItem}
          results={receptionResults}
          setResults={setReceptionResults}
        />

        {/* Articles — DataTable (vues, tri, filtres, groupement, side-peek sur
            la fiche de l'article). Les articles NAISSENT du miroir Airtable
            (pas de création en ligne ici), mais leurs champs bidirectionnels
            s'éditent en mode tableur et repartent vers Airtable. */}
        <div className="mb-4">
          <h2 className="font-semibold text-slate-900 mb-2">Articles ({retour.items?.length || 0})</h2>
          <DataTable
            table="retour_items"
            columns={ITEM_COLUMNS}
            data={retour.items || []}
            searchFields={['serial_number', 'product_name', 'sku', 'return_reason', 'action']}
            onCellEdit={saveItemField}
            // Cases à cocher → « Réceptionner » : date et réceptionniste de
            // la section Réception posés sur chaque article choisi.
            bulkDeleteAlways
            bulkActions={[{
              key: 'receive',
              label: 'Réceptionner',
              icon: PackageCheck,
              busyLabel: 'Réception…',
              className: 'inline-flex items-center gap-1.5 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 px-3 py-1.5 rounded transition-colors',
              onClick: receiveItems,
            }]}
            // Tous les articles s'affichent : pas d'ascenseur dans la table,
            // c'est le panneau de la fiche qui défile.
            height="auto"
            peek={{
              title: itemTitle,
              subtitle: () => 'Retour',
              width: 520,
              key: 'retour_items',
              // Ligne courante (et non l'instantané de l'ouverture) : une valeur
              // enregistrée depuis le panneau s'y reflète aussitôt.
              render: (item, { close }) => (
                <RetourItemPanel
                  item={(retour.items || []).find(it => it.id === item.id) || item}
                  onClose={close}
                  onSave={saveItemValue}
                />
              ),
            }}
            emptyState={{
              icon: Package,
              title: 'Aucun article',
              description: "Ce retour n'a aucun article.",
            }}
          />
        </div>
    </DetailShell>
  )
}
