import { EQUIPMENT_LABELS as ROLE_LABELS, EQUIPMENT_OUTPUTS, SENSOR_PRODUCTS } from '../lib/discoveryEquipmentCatalog.js'
import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, Trash2, ShoppingCart } from 'lucide-react'
import api from '../lib/api.js'
import { Badge } from '../components/Badge.jsx'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { fmtDate } from '../lib/formatDate.js'
import { fmtAddress } from '../utils/formatters.js'
import { buildForm, CUSTOM_SECTIONS } from '../lib/discoveryFormSchema.js'

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
const PIPE_LABELS = {
  aluminum_C: 'Aluminium (profil C)',
  steel_O: 'Acier (profil rond)',
}
const GUIDE_LABELS = {
  present: 'Déjà présents',
  needed: 'À fournir',
}
const PERMISSION_LABELS = {
  chief_grower: 'Chef de culture',
  helper: 'Helper',
}

// Les tables ci-dessus abrègent les choix livrés par le code pour la lecture
// interne. Un choix ajouté dans l'éditeur n'y figure pas : on le résout alors
// dans le calque, où vit son libellé.
function choiceLabel(schema, listId, value, labels) {
  if (value == null || value === '') return null
  return labels[value] ?? schema.opts(listId).find(o => o.value === value)?.label ?? String(value)
}

function yesNo(v) {
  if (v == null || v === '') return null
  return v ? 'Oui' : 'Non'
}

function Row({ label, children }) {
  const empty = children == null || children === '' || children === false
  return (
    <div className="min-w-0 break-words">
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

function GreenhouseCard({ g, idx, form, equipment, response, onCheck, saving }) {
  const perm = PERMISSION_LABELS[g.permission_level]
  const zones = Number(g.irrigation_zones) || 0
  const furnaces = Array.isArray(g.furnaces) ? g.furnaces : []
  return (
    <section className="card p-4 sm:p-5" aria-label={`Serre #${idx + 1}`}>
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-sm font-semibold text-slate-900">Serre #{idx + 1}</h2>
        {perm && <Badge color={g.permission_level === 'chief_grower' ? 'green' : 'slate'} size="sm">{perm}</Badge>}
      </div>
      <div className={equipment ? 'system-greenhouse-grid' : undefined}>
      <div className="min-w-0">
      <h3 className="text-xs font-semibold text-slate-500 mb-3">Réponses du client</h3>
      <div className="system-response-grid">
        <Row label="Longueur (pi)">{g.length || null}</Row>
        <Row label="Côtés ouvrants">{yesNo(g.has_side_vents)}</Row>
        {g.has_side_vents === true && (
          <>
            <Row label="Hauteur côtés (pi)">{g.side_vent_height || (g.side_vent_height_range === 'up_to_6' ? '6 pi et moins' : null)}</Row>
            <Row label="Tuyau de côté">{choiceLabel(form, 'greenhouse.side_pipe_type_options', g.side_pipe_type, PIPE_LABELS)}</Row>
            <Row label="Diamètre côté">{g.side_pipe_diameter}</Row>
            <Row label="Tuyaux guides">{choiceLabel(form, 'greenhouse.guide_pipes_options', g.guide_pipes_state, GUIDE_LABELS)}</Row>
            <Row label="Diamètre guides">{g.guide_pipe_diameter}</Row>
            {g.wants_compatible_guide_pipes && <Row label="Guides compatibles">À fournir</Row>}
          </>
        )}
        {g.permission_level === 'chief_grower' && (
          <>
            <Row label="Fournaises">{yesNo(g.has_furnaces)}</Row>
            <Row label="Zones d'irrigation">{zones || null}</Row>
            {zones > 0 && <Row label="Valves 1 po par Orisha">{yesNo(g.needs_orisha_valves)}</Row>}
          </>
        )}
        <Row label="Ventilateurs">{g.num_fans || null}</Row>
        {Number(g.num_fans) === 2 && <Row label="Puissance ventilateurs">{g.fans_combined_hp ? `${g.fans_combined_hp} HP` : null}</Row>}
        {g.has_side_vents && <Row label="Moteurs de côtés">{g.num_side_vent_motors || null}</Row>}
        {g.has_existing_side_vent_motors && <Row label="Moteurs déclarés">{[g.side_vent_motor_brand, g.side_vent_motor_model].filter(Boolean).join(' ') || null}</Row>}
        <Row label="Louvres">{g.has_louvers === false ? 'Aucune' : g.louvers?.length || null}</Row>
        {response.form_options?.humidity_retention && <><Row label="Valve humidité">{yesNo(g.humidity_valve)}</Row><Row label="HAF à fournir">{g.humidity_haf ? g.humidity_haf_count : 0}</Row></>}
        {customRows(form.custom('greenhouse'), g.custom)}
        {g.permission_level === 'chief_grower' && customRows(form.custom('greenhouse_chief'), g.custom)}
      </div>
      {g.has_louvers && g.louvers?.map((l, i) => <div key={i} className="mt-3 border-t border-slate-100 pt-3 system-response-grid"><Row label={`Louvre #${i + 1}`}>{l.control_type === 'spring_loaded' ? 'Spring loaded' : l.control_type === 'open_close' ? 'Open/close signal' : l.control_type === 'other' ? 'Autre / Je ne sais pas — Appeler le client' : null}</Row><Row label="Voltage">{l.voltage === 'other' ? l.voltage_other : l.voltage ? `${l.voltage} V` : null}</Row><Row label="Ventilateur associé">{yesNo(l.has_fan)}</Row>{l.has_fan && l.control_type === 'open_close' && <Row label="Commande">Contrôle séparé du ventilateur non proposé — à vérifier</Row>}</div>)}
      {furnaces.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
          {furnaces.map((f, i) => (
            <div key={i} className="rounded-lg border border-slate-200 p-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Row label={`Fournaise #${i + 1}`}>{[f.brand, f.model === 'Autre' ? f.model_other : f.model].filter(Boolean).join(' ') || null}</Row>
              <Row label="Filage (pi)">{f.control_wire_feet || null}</Row>
              <Row label="Thermostat de secours">{yesNo(f.backup_thermostat)}</Row>
            </div>
          ))}
        </div>
      )}
      </div>
      {equipment && <EquipmentPreview equipment={equipment} form={response} onCheck={onCheck} saving={saving} />}
      </div>
    </section>
  )
}

function EquipmentPreview({ equipment: g, form, onCheck, saving }) {
  const checks = []
  if (g.items.some(x => x.role === 'side_vent_module' || x.role === 'side_vent_controller_24v')) checks.push([`g${g.greenhouse}:motors`, 'Moteurs vérifiés'])
  for (const [i] of (form.greenhouses?.[g.greenhouse - 1]?.furnaces || []).entries()) checks.push([`g${g.greenhouse}:furnace:${i}`, `Fournaise #${i + 1} vérifiée`])
  if (Number(form.greenhouses?.[g.greenhouse - 1]?.irrigation_zones) > 0) checks.push([`g${g.greenhouse}:valves`, 'Valves vérifiées'])
  for (const [i] of (form.greenhouses?.[g.greenhouse - 1]?.louvers || []).entries()) checks.push([`g${g.greenhouse}:louver:${i}`, `Louvre #${i + 1} vérifiée`])
  const checked = checks.filter(([key]) => form.verification?.[key]).length
  return <div className="system-greenhouse-equipment min-w-0">
    <h3 className="text-sm font-semibold text-slate-900">Équipements suggérés</h3>
    <p className="text-xs text-slate-500 mt-1 mb-3">{g.slots == null ? 'Dimensionnement à compléter' : `${g.slots} sortie${g.slots !== 1 ? 's' : ''} · ${g.activation_modules} module${g.activation_modules !== 1 ? 's' : ''} V2`}</p>
    {g.items.length > 0 ? <table className="w-full text-sm">
      <caption className="sr-only">Équipements suggérés pour la serre #{g.greenhouse}</caption>
      <thead><tr className="text-xs text-slate-500 border-b border-slate-200"><th scope="col" className="font-medium text-left pb-2">Équipement</th><th scope="col" className="font-medium text-right pb-2 pl-3">Qté</th></tr></thead>
      <tbody>{g.items.map((item, i) => <tr key={i} className="border-b border-slate-100 last:border-0">
        <td className="py-2 text-slate-700 break-words">{ROLE_LABELS[item.role] || item.role}{item.note && item.role !== 'activation_v2' && <span className="block text-xs text-slate-500">{item.note}</span>}</td>
        <td className="py-2 pl-3 text-right align-top font-medium tabular-nums text-slate-900">{item.qty}</td>
      </tr>)}</tbody>
    </table> : <p className="text-sm text-slate-500">Aucun équipement à ajouter.</p>}
    {checks.length > 0 && <fieldset disabled={saving} aria-busy={saving} className="mt-4 border-t border-slate-200 pt-3 disabled:opacity-60">
      <legend className="sr-only">Vérification des équipements de la serre #{g.greenhouse}</legend>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-xs font-semibold text-slate-700">Vérifications</span>
        <span role="status" className={`text-xs tabular-nums ${checked === checks.length ? 'text-green-700' : 'text-slate-500'}`}>{checked === checks.length ? 'Tout vérifié' : `${checked} / ${checks.length}`}</span>
      </div>
      {checks.map(([key, label]) => <label key={key} className="flex min-h-11 items-center gap-3 text-sm text-slate-700 cursor-pointer">
        <input type="checkbox" className="h-4 w-4 rounded accent-brand-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600" checked={!!form.verification?.[key]} onChange={e => onCheck(key, e.target.checked)} />{label}
      </label>)}
    </fieldset>}
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
  async function createOrder() {
    setCreatingOrder(true)
    try { const order = await api.discoveryForms.createOrder(id); setRecord(current => current?.id === form.id ? { ...current, generated_order_id: order.id } : current); addToast({ message: `Commande #${order.order_number} créée`, type: 'success' }); reload() }
    catch (err) { addToast({ message: err.message || 'Création impossible', type: 'error' }) }
    finally { setCreatingOrder(false) }
  }

  const submitted = form.status === 'submitted'
  const greenhouses = form.greenhouses || []
  const extras = form.extras || []
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
            {form.public_url && (
              <a href={form.public_url} target="_blank" rel="noopener noreferrer" className="link-record inline-flex items-center gap-1">
                <ExternalLink size={11} /> Formulaire
              </a>
            )}
          </>
        ),
        actions: (
          <div className="flex flex-wrap items-center gap-2">
            {form.generated_order_id ? <Link to={`/orders/${form.generated_order_id}`} className="btn-secondary btn-sm"><ShoppingCart size={14} /> Commande</Link> : <button onClick={createOrder} disabled={creatingOrder || preview?.calculationComplete === false} className="btn-primary btn-sm"><ShoppingCart size={14} /> {creatingOrder ? 'Création…' : 'Créer une commande'}</button>}
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
          <Row label="À 250 pi ou moins du contrôleur">{form.within_central_controller_range == null ? 'À compléter' : form.within_central_controller_range ? 'Oui' : 'Non'}</Row>
          {typeof form.within_central_controller_range === 'boolean' && <Row label="Contrôleur central">{formSchema.t(form.within_central_controller_range ? 'controller_distance.near' : 'controller_distance.far')}</Row>}
        </>}
        <Row label="Serres">{form.num_greenhouses || null}</Row>
        <Row label="Adresse de la ferme">{fmtAddress(form.farm_address) || null}</Row>
        <Row label="Adresse de livraison">
          {sameShipping ? 'Même que la ferme' : (fmtAddress(form.shipping_address) || null)}
        </Row>
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
        : greenhouses.map((g, i) => <GreenhouseCard key={i} g={g} idx={i} form={formSchema} equipment={submitted ? preview?.greenhouses.find(item => item.greenhouse === i + 1) : null} response={form} onCheck={setVerification} saving={savingVerification} />)}


      {(form.form_options?.mobile_controller || form.form_options?.humidity_retention || SENSOR_PRODUCTS.some(([role]) => form.form_options?.sensors?.[role] > 0)) && <Section title="Options achetées" cols={1}>
        {form.form_options.mobile_controller && <Row label="Internet">Contrôleur mobile</Row>}
        {form.form_options.humidity_retention && <Row label="Option">Conservation de l’humidité</Row>}
        {SENSOR_PRODUCTS.filter(([role]) => form.form_options.sensors?.[role] > 0).map(([role, label]) => <Row key={role} label={label}>{form.form_options.sensors[role]}</Row>)}
      </Section>}
      {preview?.siteItems?.length > 0 && <Section title="Équipements du site" cols={1}>{preview.siteItems.map((item, i) => <div key={i} className="flex justify-between gap-4 text-sm"><span>{ROLE_LABELS[item.role] || item.role}</span><span className="font-medium tabular-nums">{item.qty}</span></div>)}</Section>}
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
    </DetailShell>
  )
}
