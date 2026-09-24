import { roofInverterSupplyKey } from '../lib/discoveryRoofs.js'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { EQUIPMENT_LABELS as ROLE_LABELS, EQUIPMENT_OUTPUTS, SENSOR_PRODUCTS } from '../lib/discoveryEquipmentCatalog.js'
import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, Trash2, ShoppingCart, Pencil } from 'lucide-react'
import { Modal } from '../components/Modal.jsx'
import DiscoveryFormOptions from '../components/DiscoveryFormOptions.jsx'
import DiscoveryExtrasTable, { additionalEquipment } from '../components/DiscoveryExtrasTable.jsx'
import api from '../lib/api.js'
import { Badge } from '../components/Badge.jsx'
import TableThumb, { TABLE_THUMB_CLASS } from '../components/TableThumb.jsx'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { fmtDate } from '../lib/formatDate.js'
import { fmtAddress } from '../utils/formatters.js'
import { buildForm, controllerDistanceValue, CUSTOM_SECTIONS, sideVentsOnly, FANS_HP_RANGE_OPTIONS, fansHpRangeValue } from '../lib/discoveryFormSchema.js'
import { louverSummary } from '../components/LouverTypeChoice.jsx'

// Fiche d'un formulaire de découverte : lecture des réponses telles que
// remplies par le client (le formulaire lui-même vit sur /d/:token).
// Les codes stockés en base sont traduits ici avec les mêmes libellés que
// ceux affichés au client dans pages/CustomerPostPayment.jsx.

const SITE_LABELS = {
  new: 'Nouveau site',
  add_to_existing: 'Ajout à un site existant',
}
const NETWORK_LABELS = {
  ethernet: 'Ethernet (< 250 pi)',
  wifi_250: 'Wi-Fi (< 250 pi, ligne de vue)',
  wifi_350_coax: '350 pi — câble coaxial fourni',
  mobile_controller: 'Contrôleur internet mobile requis',
}
// Plage de puissance des deux ventilateurs ; une vieille réponse chiffrée s'y ramène.
const fansHpLabel = g => {
  const range = fansHpRangeValue(g)
  return FANS_HP_RANGE_OPTIONS.find(o => o.value === range)?.label || range || null
}
const PIPE_LABELS = {
  aluminum_C: 'Aluminium (profil C)',
  steel_O: 'Acier (profil rond)',
}
const GUIDE_LABELS = {
  present: 'Oui',
  needed: 'Non',
}
const PERMISSION_LABELS = {
  chief_grower: 'Chef de culture',
  helper: 'Helper',
}

// Les tables ci-dessus abrègent les choix livrés par le code pour la lecture
// interne. Un choix ajouté dans l'éditeur n'y figure pas : on le résout alors
// dans le calque, où vit son libellé.
function choiceLabel(schema, listId, value, labels = {}) {
  if (value == null || value === '') return null
  return labels[value] ?? schema.opts(listId).find(o => o.value === value)?.label ?? String(value)
}

function yesNo(v) {
  if (v == null || v === '') return null
  return v ? 'Oui' : 'Non'
}

function Row({ label, children, wide = false }) {
  const empty = children == null || children === '' || children === false
  return (
    <div className={`min-w-0 break-words${wide ? ' col-span-full' : ''}`}>
      <div className="text-xs font-medium text-slate-500 mb-1">{label}</div>
      <div className="text-sm text-slate-900">{empty ? <span className="text-slate-400">—</span> : children}</div>
    </div>
  )
}

function Section({ title, children, cols = 2 }) {
  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold text-slate-900 mb-3">{title}</h2>
      <div className={cols === 1 ? 'space-y-3' : 'system-response-grid'}>{children}</div>
    </div>
  )
}

// Réponses aux questions ajoutées via l'éditeur : leurs libellés vivent dans le
// calque, pas dans la base — on les résout avec le schéma chargé en parallèle.
function customRows(questions, answers) {
  const a = answers || {}
  return questions
    .filter(q => a[q.id] != null && a[q.id] !== '')
    .map(q => {
      const v = a[q.id]
      const text = typeof v === 'boolean'
        ? (v ? 'Oui' : 'Non')
        : (q.options?.find(o => o.value === v)?.label ?? String(v))
      return <Row key={q.id} label={q.label}>{text}</Row>
    })
}

function ResponseGroup({ title, children, checks = [], verification, onCheck, saving }) {
  const verified = checks.length > 0 && checks.every(([key]) => verification?.[key])
  return (
    <section aria-label={title} className={`min-w-0 rounded-lg border p-3 ${verified ? 'border-green-600 ring-1 ring-green-600' : 'border-slate-200'}`}>
      <h4 className="text-xs font-semibold text-slate-700 mb-3">{title}</h4>
      {children}
      {checks.length > 0 && <fieldset disabled={saving} aria-busy={saving} className="mt-3 border-t border-slate-100 pt-1 disabled:opacity-60">
        <legend className="sr-only">Vérification — {title}</legend>
        {checks.map(([key, label]) => <label key={key} className="flex min-h-11 items-center gap-3 text-sm text-slate-700 cursor-pointer">
          <input type="checkbox" className="h-4 w-4 shrink-0 rounded accent-green-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-600" checked={!!verification?.[key]} onChange={e => onCheck(key, e.target.checked)} />{label}
        </label>)}
      </fieldset>}
    </section>
  )
}

function GreenhouseCard({ g, idx, form, equipment, images, types, response, onCheck, saving }) {
  const perm = PERMISSION_LABELS[g.permission_level]
  // Serre Helper : côtés ouvrants seulement — les autres automatisations ne lui
  // sont pas demandées, inutile de montrer leurs lignes.
  const helperOnly = sideVentsOnly(g.permission_level || response.permission_level)
  const zones = Number(g.irrigation_zones) || 0
  const furnaces = Array.isArray(g.furnaces) ? g.furnaces : []
  // Garder les clés existantes pour retrouver les vérifications déjà enregistrées.
  // Seuls les équipements du client nécessitent une vérification.
  const checkProps = checks => ({
    checks: equipment ? checks.filter(Boolean).map(([key, label]) => [`g${idx + 1}:${key}`, label]) : [],
    verification: response.verification,
    onCheck,
    saving,
  })
  const extraRows = [
    ...customRows(form.custom('greenhouse'), g.custom),
    ...(g.permission_level === 'chief_grower' ? customRows(form.custom('greenhouse_chief'), g.custom) : []),
  ]
  return (
    <section className="card p-4 sm:p-5" aria-label={`Serre #${idx + 1}`}>
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-sm font-semibold text-slate-900">Serre #{idx + 1}</h2>
        {perm && <Badge color={g.permission_level === 'chief_grower' ? 'green' : 'slate'} size="sm">{perm}</Badge>}
      </div>
      <div className={equipment ? 'system-greenhouse-grid' : undefined}>
      <div className="min-w-0">
      <h3 className="text-xs font-semibold text-slate-500 mb-3">Réponses du client</h3>
      <div className="space-y-3">
        {g.has_side_vents === true && <Row label="Longueur (pi)">{g.length || null}</Row>}
        <ResponseGroup title="Côtés" {...checkProps([
          g.has_side_vents && g.has_existing_side_vent_motors && ['motors', 'Moteurs du client vérifiés'],
          g.has_side_vents && (g.side_pipe_diameter || g.guide_pipe_diameter) && ['pipes', 'Diamètre des tuyaux vérifié'],
        ])}>
        <div className="system-response-grid">
        <Row label="Côtés ouvrants">{g.has_side_vents === true ? (g.num_side_vent_motors || 'Oui') : yesNo(g.has_side_vents)}</Row>
        {g.has_side_vents === true && (
          <>
            <Row label="Hauteur côtés (pi)">{g.side_vent_height || (g.side_vent_height_range === 'up_to_6' ? '6 pi et moins' : null)}</Row>
            <Row label="Tuyau de côté">{choiceLabel(form, 'greenhouse.side_pipe_type_options', g.side_pipe_type, PIPE_LABELS)}</Row>
            <Row label="Diamètre côté">{g.side_pipe_diameter}</Row>
            <Row label="Tuyaux guides 1 à 1 5/16 po">{choiceLabel(form, 'greenhouse.guide_pipes_options', g.guide_pipes_state, GUIDE_LABELS)}</Row>
            <Row label="Diamètre guides">{g.guide_pipe_diameter}</Row>
            {g.wants_compatible_guide_pipes && <Row label="Guides compatibles">À fournir</Row>}
          </>
        )}
        {g.has_existing_side_vent_motors && <Row label="Moteurs déclarés">{[g.side_vent_motor_brand, g.side_vent_motor_model].filter(Boolean).join(' ') || null}</Row>}
        {g.has_existing_side_vent_motors && typeof g.side_has_inverters === 'boolean' && <Row label="Inverseurs">{g.side_has_inverters
          ? [g.side_inverter_model === 'other' ? [g.side_inverter_brand_other, g.side_inverter_model_other].filter(Boolean).join(' ') || 'Autre' : g.side_inverter_model, { per_motor: 'un par moteur', per_two: 'un pour deux moteurs' }[g.side_inverter_ratio]].filter(Boolean).join(', ')
          : 'Aucun'}</Row>}
        </div>
        </ResponseGroup>
        {(g.has_roof_vents != null || g.num_roof_vents != null || g.roof_motor_voltage) && <ResponseGroup title="Toits ouvrants">
            <Row label="Toit ouvrant">{yesNo(g.has_roof_vents)}</Row>
            <Row label="Nombre de toits ouvrants">{g.num_roof_vents}</Row>
            {(g.has_roof_vents || g.roof_motor_voltage) && <>
              <Row label="Tension du moteur">{choiceLabel(form, 'roofs.voltage_options', g.roof_motor_voltage)}</Row>
              <Row label="Inverseur déjà disponible">{yesNo(g.has_roof_inverter)}</Row>
              {g.has_roof_inverter === true && <>
                <Row label="Inverseur">{choiceLabel(form, 'roofs.inverter_options', g.roof_inverter_type)}</Row>
                {g.roof_inverter_type === 'other' && <><Row label="Marque">{g.roof_inverter_brand}</Row><Row label="Modèle">{g.roof_inverter_model}</Row></>}
              </>}
              {g.has_roof_inverter === false && <>
                {g.roof_motor_voltage === '240' && <Row label="Ridder RW240, 1 phase, 5 fils">{yesNo(g.roof_motor_ridder_rw240)}</Row>}
                <Row label="Fourniture de l’inverseur">{form.t(roofInverterSupplyKey(g))}</Row>
              </>}
            </>}
          </ResponseGroup>}
        {!helperOnly && <>
          {!g.has_louvers || !g.louvers?.length ? <ResponseGroup title="Louvres">
          <Row label="Louvres">{g.has_louvers === false ? 'Aucune' : g.louvers?.length || null}</Row>
          </ResponseGroup> : g.louvers.map((l, i) => <ResponseGroup key={i} title={`Louvre #${i + 1}`} {...checkProps([[`louver:${i}`, `Louvre #${i + 1} vérifiée`]])}>
            <div className="system-response-grid"><Row label="Louvre">{louverSummary(l) || null}</Row><Row label="Ventilateur associé">{yesNo(l.has_fan)}</Row>{l.has_fan && l.control_type === 'open_close' && <Row label="Commande">Contrôle séparé du ventilateur non proposé — à vérifier</Row>}</div>
          </ResponseGroup>)}
        </>}
        {!helperOnly && <ResponseGroup title="Ventilateurs">
          <div className="system-response-grid">
            <Row label="Ventilateurs">{g.num_fans || null}</Row>
            {Number(g.num_fans) === 2 && <Row label="Puissance ventilateurs">{fansHpLabel(g)}</Row>}
          </div>
        </ResponseGroup>}
        {(g.permission_level === 'chief_grower' || g.has_furnaces != null) && furnaces.length === 0 && <ResponseGroup title="Fournaises">
          <Row label="Fournaises">{yesNo(g.has_furnaces)}</Row>
        </ResponseGroup>}
          {furnaces.map((f, i) => (
            <ResponseGroup key={i} title={`Fournaise #${i + 1}`} {...checkProps([[`furnace:${i}`, `Fournaise #${i + 1} vérifiée`]])}>
            <div className="system-response-grid">
              <Row label="Thermostat mural">{form.opts('furnace.dry_contact_options').find(o => o.value === f.dry_contact_24v)?.label || null}</Row>
              {/* Les réponses d'avant la question du contact sec ne portent que la marque et le modèle. */}
              {(f.brand || f.model) && <Row label="Marque / modèle">{[f.brand === 'Autre' ? f.brand_other || f.brand : f.brand, f.model === 'Autre' ? f.model_other : f.model].filter(Boolean).join(' ') || null}</Row>}
              <Row label="Filage (pi)">{f.control_wire_feet || null}</Row>
              <Row label="Thermostat de secours">{yesNo(f.backup_thermostat)}</Row>
            </div>
            </ResponseGroup>
          ))}
        {(g.permission_level === 'chief_grower' || (g.irrigation_zones != null && g.irrigation_zones !== '')) && <ResponseGroup title="Irrigation" {...checkProps([
          zones > 0 && g.needs_orisha_valves === false && ['valves', 'Valves du client vérifiées'],
        ])}>
          <div className="system-response-grid">
            <Row label="Zones">{g.irrigation_zones === 0 || g.irrigation_zones === '0' ? 0 : zones || null}</Row>
            {zones > 0 && <Row label="Valves à fournir">{g.needs_orisha_valves === true ? (g.orisha_valves_count || null) : g.needs_orisha_valves === false ? 0 : null}</Row>}
            {zones > 0 && <Row label="Fil à fournir (pi)">{g.valve_control_wire_feet ?? null}</Row>}
            {g.needs_orisha_valves === false && <Row label="Valves en place">{g.valve_brand === 'Autre marque' ? [g.valve_brand_other, g.valve_model].filter(Boolean).join(' ') || g.valve_brand : [g.valve_brand, g.valve_model].filter(Boolean).join(' ') || null}</Row>}
          </div>
        </ResponseGroup>}
        {!helperOnly && response.form_options?.humidity_retention && <ResponseGroup title="Rétention d’humidité">
          <div className="system-response-grid">
            <Row label="Valve humidité">{yesNo(g.humidity_valve)}</Row>
            <Row label="HAF à automatiser">{yesNo(g.humidity_haf)}</Row>
          </div>
        </ResponseGroup>}
        {extraRows.length > 0 && <ResponseGroup title="Autres réponses">
          <div className="system-response-grid">{extraRows}</div>
        </ResponseGroup>}
      </div>
      </div>
      {equipment && <EquipmentPreview equipment={equipment} images={images} types={types} />}
      </div>
    </section>
  )
}

// Regroupe les équipements par type de produit, dans l'ordre d'apparition.
function groupByType(items, types) {
  const groups = new Map()
  for (const item of items) {
    const type = types[item.role] || 'Autre'
    if (!groups.has(type)) groups.set(type, [])
    groups.get(type).push(item)
  }
  return [...groups]
}

function EquipmentPreview({ equipment: g, images = {}, types = {} }) {
  return <div className="system-greenhouse-equipment min-w-0">
    <h3 className="text-sm font-semibold text-slate-900">Équipements</h3>
    <p className="text-xs text-slate-500 mt-1 mb-3">{g.slots == null ? 'Dimensionnement à compléter' : `${g.slots} sortie${g.slots !== 1 ? 's' : ''} · ${g.activation_modules} module${g.activation_modules !== 1 ? 's' : ''} V2`}</p>
    {g.items.length > 0 ? <table className="w-full text-sm">
      <caption className="sr-only">Équipements pour la serre #{g.greenhouse}</caption>
      <thead><tr className="text-xs text-slate-500 border-b border-slate-200"><th scope="col" className="font-medium text-left pb-2">Équipement</th><th scope="col" className="font-medium text-right pb-2 pl-3">Qté</th></tr></thead>
      {groupByType(g.items, types).map(([type, items]) => <tbody key={type}>
      <tr><th scope="colgroup" colSpan={2} className="pt-3 pb-1 text-left text-xs font-medium text-slate-500">{type}</th></tr>
      {items.map((item, i) => <tr key={i} className="border-b border-slate-100 last:border-0">
        <td className="py-2 text-slate-700 break-words"><div className="flex items-start gap-2">{images[item.role] ? <TableThumb src={images[item.role]} className="shrink-0 border border-slate-200" /> : <div className={`${TABLE_THUMB_CLASS} shrink-0`} />}<div className="min-w-0">{ROLE_LABELS[item.role] || item.role}{item.note && item.role !== 'activation_v2' && <span className="block text-xs text-slate-500">{item.note}</span>}{item.role === 'activation_v2' && g.slot_sources?.length > 0 && <ul className="mt-1 text-xs text-slate-500">
          {g.slot_sources.map(s => <li key={s.label} className="flex justify-between gap-2"><span className="min-w-0">{s.label}{s.qty > 1 && ` ×${s.qty}`}</span><span className="tabular-nums shrink-0">{s.slots}</span></li>)}
          <li className="flex justify-between gap-2 border-t border-slate-100 mt-0.5 pt-0.5 font-medium"><span>Sorties</span><span className="tabular-nums">{g.slots} / {item.qty * 4}</span></li>
        </ul>}</div></div></td>
        <td className="py-2 pl-3 text-right align-top font-medium tabular-nums text-slate-900">{item.qty}</td>
      </tr>)}</tbody>)}
    </table> : <p className="text-sm text-slate-500">Aucun équipement à ajouter.</p>}
  </div>
}

export default function DiscoveryFormDetail({ recordId: id, onClose, onDeleted }) {
  const confirm = useConfirm()
  const { addToast } = useToast()
  const [schema, setSchema] = useState(null)
  const [preview, setPreview] = useState(null)
  const [previewError, setPreviewError] = useState(false)
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const [creatingOrder, setCreatingOrder] = useState(false)
  const [savingVerification, setSavingVerification] = useState(false)
  const [editingOptions, setEditingOptions] = useState(false)

  const { record: form, setRecord, loading, loadError, reload } = useDetailRecord(
    () => api.discoveryForms.get(id), [id], { clearOnError: true },
  )

  useEffect(() => {
    api.discoveryFormSchema.get().then(d => setSchema(d.schema)).catch(() => {})
  }, [])
  useEffect(() => {
    let active = true
    setPreview(null)
    setPreviewError(false)
    api.discoveryForms.equipmentPreview(id).then(data => {
      if (active) setPreview(data)
    }).catch(() => { if (active) setPreviewError(true) })
    return () => { active = false }
  }, [id, previewAttempt])
  const formSchema = useMemo(() => buildForm(schema), [schema])

  // Suppression définitive : la table n'est pas soft-delete, donc on confirme.
  async function handleDelete() {
    if (!(await confirm('Supprimer ce système ? Le lien du formulaire cessera de fonctionner.'))) return
    try {
      await api.discoveryForms.delete(id)
      onDeleted?.()
      onClose?.()
    } catch (err) {
      addToast({ message: err.message || 'Erreur lors de la suppression', type: 'error' })
    }
  }

  const pending = detailPending({ loading, loadError, onRetry: reload, record: form, notFound: 'Système introuvable.' })
  if (pending) return pending

  async function setVerification(key, checked) {
    const verification = { ...(form.verification || {}), [key]: checked }
    if (savingVerification) return
    setSavingVerification(true)
    setRecord(current => current?.id === form.id ? { ...current, verification } : current)
    try {
      await api.discoveryForms.saveVerification(id, verification)
    } catch (err) {
      setRecord(current => current?.id === form.id ? { ...current, verification: form.verification } : current)
      addToast({ message: err.message || 'Enregistrement impossible', type: 'error' })
    } finally {
      setSavingVerification(false)
    }
  }
  async function saveAddress(key, value) {
    if (savingVerification) return
    setSavingVerification(true)
    try {
      await api.discoveryForms.saveAddresses(id, { [key]: value })
      await reload()
      setPreviewAttempt(n => n + 1)
    } catch (err) {
      addToast({ message: err.message || 'Enregistrement impossible', type: 'error' })
    } finally { setSavingVerification(false) }
  }
  async function createOrder() {
    setCreatingOrder(true)
    try {
      const order = await api.discoveryForms.createOrder(id)
      setRecord(current => current?.id === form.id ? { ...current, generated_order_id: order.id, generated_order_number: order.order_number } : current)
      addToast({ message: `Commande #${order.order_number} créée`, type: 'success' })
      reload()
    }
    catch (err) { addToast({ message: err.message || 'Création impossible', type: 'error' }) }
    finally { setCreatingOrder(false) }
  }

  const submitted = form.status === 'submitted'
  const greenhouses = form.greenhouses || []
  const extras = form.extras || []
  // Équipements supplémentaires fixés par Orisha à la création, par serre.
  const extraRows = (Array.isArray(form.form_options?.additional_equipment) ? form.form_options.additional_equipment : [])
    .map((e, i) => [i, [['furnaces', 'fournaise'], ['valves', 'valve'], ['rollups', 'roll-up'], ['roofs', 'toit ouvrant']]
      .filter(([key]) => e?.[key] > 0).map(([key, label]) => `${e[key]} ${label}${e[key] > 1 ? 's' : ''}`).join(', ')])
    .filter(([, text]) => text)
  const sameShipping = form.shipping_same_as_farm === true
  // Questions hors serre, toutes sections confondues, dans l'ordre de l'éditeur.
  const formLevelCustom = CUSTOM_SECTIONS
    .filter(s => s.id !== 'greenhouse' && s.id !== 'greenhouse_chief')
    .flatMap(s => customRows(formSchema.custom(s.id), form.custom_answers))

  return (
    <DetailShell
      className="system-builder-detail px-4 sm:px-5 py-4"
      header={{
        badge: <Badge color={submitted ? 'green' : 'blue'} size="sm">{submitted ? 'Soumis' : 'En cours'}</Badge>,
        meta: (
          <>
            {form.company_id && <Link to={`/companies/${form.company_id}`} className="link-record">{form.company_name || 'Entreprise'}</Link>}
            <span>Créé le {fmtDate(form.created_at)}</span>
            {form.submitted_at && <span>Soumis le {fmtDate(form.submitted_at)}</span>}
            {form.generated_order_id && (
              <Link to={`/orders/${form.generated_order_id}`} className="link-record inline-flex items-center gap-1">
                <ShoppingCart size={11} /> Commande{form.generated_order_number ? ` #${form.generated_order_number}` : ''}
              </Link>
            )}
            {form.public_url && (
              <a href={form.public_url} target="_blank" rel="noopener noreferrer" className="link-record inline-flex items-center gap-1">
                <ExternalLink size={11} /> Formulaire
              </a>
            )}
          </>
        ),
        actions: (
          <div className="flex flex-wrap items-center gap-2">
            {!form.generated_order_id && <button onClick={() => setEditingOptions(true)} className="btn-ghost btn-sm"><Pencil size={14} /> Modifier</button>}
            {!form.generated_order_id && <button onClick={createOrder} disabled={creatingOrder || savingVerification || preview?.calculationComplete === false} className="btn-primary btn-sm"><ShoppingCart size={14} /> {creatingOrder ? 'Création…' : 'Créer une commande'}</button>}
            <button onClick={handleDelete} className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg" title="Supprimer" aria-label="Supprimer ce système"><Trash2 size={16} /></button>
          </div>
        ),
      }}
    >
    <div className="space-y-4">
      <div className="system-site-grid">
      <Section title="Site">
        <Row label="Type">{choiceLabel(formSchema, 'order_type.options', form.is_new_site, SITE_LABELS)}</Row>
        {form.is_new_site === 'add_to_existing' && !form.form_options?.mobile_controller && <>
          <Row label="Distance du contrôleur">{choiceLabel(formSchema, 'controller_distance.options', controllerDistanceValue(form), {}) || 'À compléter'}</Row>
          {typeof form.within_central_controller_range === 'boolean' && <Row label="Contrôleur central">{formSchema.t(form.within_central_controller_range ? 'controller_distance.near' : 'controller_distance.far')}</Row>}
        </>}
        <Row label="Serres">{form.num_greenhouses || null}</Row>
        {[["farm", "Adresse de la ferme"], ["shipping", "Adresse de livraison"]].map(([kind, label]) => {
          const address = form[`${kind}_address`]
          const addressId = form[`${kind}_address_id`]
          return <Row key={kind} label={label} wide>
            <LinkedRecordField
              name={`${kind}_address_id`}
              value={addressId}
              options={addressId ? [{ id: addressId, name: fmtAddress(address) || label }] : []}
              searchTarget="adresses"
              searchFilter={[{ column: 'company_id', op: 'is', value: form.company_id }]}
              getHref={a => `/adresses/${a.id}`}
              allowClear={false}
              wrap
              saving={savingVerification}
              disabled={savingVerification || creatingOrder}
              onChange={value => saveAddress(`${kind}_address_id`, value)}
            />
            {!addressId && fmtAddress(address) && <span>{fmtAddress(address)}</span>}
            {kind === 'shipping' && sameShipping && <span className="text-xs text-slate-500">Même que la ferme</span>}
          </Row>
        })}
      </Section>

      <Section title="Réseau">
        <Row label="Accès">{choiceLabel(formSchema, 'network.options', form.network_access, NETWORK_LABELS)}</Row>
        <Row label="Wi-Fi">{form.wifi_ssid}</Row>
        {form.wifi_password && <Row label="Mot de passe">Configuré</Row>}
      </Section>

      </div>

      {submitted && !preview && <div className="card p-4 text-sm text-slate-500" role={previewError ? 'alert' : 'status'}>
        {previewError ? <div className="flex flex-wrap items-center justify-between gap-3"><span>Calcul des équipements indisponible.</span><button className="btn-secondary btn-sm" onClick={() => setPreviewAttempt(n => n + 1)}>Réessayer</button></div> : 'Calcul des équipements…'}
      </div>}
      {preview?.warnings?.length > 0 && <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-medium">Dimensionnement à compléter</p><ul className="mt-2 space-y-1">{preview.warnings.map((w, i) => <li key={i}>{w.greenhouse ? `Serre #${w.greenhouse} · ` : ''}{w.role ? `Sorties V2 à définir : ${EQUIPMENT_OUTPUTS.find(([role]) => role === w.role)?.[1] || ROLE_LABELS[w.role] || w.role.replaceAll('_', ' ')}` : w.message}</li>)}</ul><Link to="/discovery-form-editor" className="inline-flex mt-2 underline">Configurer les équipements</Link></div>}
      {submitted && preview?.unconfigured.length > 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-medium">Produits à associer</p>
        <p className="mt-1">{preview.unconfigured.map(x => ROLE_LABELS[x] || x).join(', ')}</p>
        <Link to="/discovery-form-editor" className="inline-flex mt-2 underline underline-offset-2 font-medium">Configurer les équipements</Link>
      </div>}

      {formLevelCustom.length > 0 && (
        <Section title="Autres réponses">{formLevelCustom}</Section>
      )}

      {greenhouses.length === 0
        ? <div className="card p-5 text-sm text-slate-400">Les serres apparaîtront ici lorsque le client aura rempli le formulaire.</div>
        : greenhouses.map((g, i) => <GreenhouseCard key={i} g={g} idx={i} form={formSchema} equipment={submitted ? preview?.greenhouses.find(item => item.greenhouse === i + 1) : null} images={preview?.productImages} types={preview?.productTypes} response={form} onCheck={setVerification} saving={savingVerification} />)}


      {(form.form_options?.mobile_controller || form.form_options?.humidity_retention || SENSOR_PRODUCTS.some(([role]) => form.form_options?.sensors?.[role] > 0) || extraRows.length > 0) && <Section title="Options achetées" cols={1}>
        {extraRows.map(([i, text]) => <Row key={i} label={`Serre #${i + 1} · extras`}>{text}</Row>)}
        {form.form_options.mobile_controller && <Row label="Internet">Contrôleur mobile</Row>}
        {form.form_options.humidity_retention && <Row label="Option">Conservation de l’humidité</Row>}
        {SENSOR_PRODUCTS.filter(([role]) => form.form_options.sensors?.[role] > 0).map(([role, label]) => <Row key={role} label={label}>{form.form_options.sensors[role]}</Row>)}
      </Section>}
      {extras.length > 0 && (
        <Section title="Extras" cols={1}>
          {extras.map((it, i) => (
            <div key={i} className="text-sm text-slate-900">
              {it.qty ? `${it.qty} × ` : ''}{it.description || it.role}
            </div>
          ))}
        </Section>
      )}
    </div>
    <Modal isOpen={editingOptions} title="Modifier le système" onClose={() => setEditingOptions(false)}>
      {editingOptions && <EditOptionsForm form={form} onClose={() => setEditingOptions(false)} onSaved={() => { setEditingOptions(false); reload(); setPreviewAttempt(n => n + 1) }} />}
    </Modal>
    </DetailShell>
  )
}

// Options achetées et extras par serre : ce qu'Orisha a fixé à la création.
function EditOptionsForm({ form, onClose, onSaved }) {
  const { addToast } = useToast()
  const initial = form.form_options || {}
  const [options, setOptions] = useState({ ...initial, sensors: { ...(initial.sensors || {}) } })
  const cards = (form.greenhouses || []).map((g, i) => ({ key: String(i), helper: sideVentsOnly(g.permission_level || form.permission_level) }))
  const [extras, setExtras] = useState(() => Object.fromEntries(cards.map((card, i) => [card.key, { ...(initial.additional_equipment?.[i] || {}) }])))
  const [saving, setSaving] = useState(false)
  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    try {
      await api.discoveryForms.saveOptions(form.id, { ...options, additional_equipment: additionalEquipment(extras, cards) })
      onSaved()
    } catch (err) {
      addToast({ message: err.message || 'Enregistrement impossible', type: 'error' })
      setSaving(false)
    }
  }
  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <DiscoveryExtrasTable cards={cards} values={extras} onChange={setExtras} disabled={saving} />
      <DiscoveryFormOptions value={options} onChange={setOptions} disabled={saving} />
      <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
        <button type="button" onClick={onClose} className="btn-ghost">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Enregistrement…' : 'Enregistrer'}</button>
      </div>
    </form>
  )
}
