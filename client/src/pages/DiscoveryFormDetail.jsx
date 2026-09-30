import { ROOF_ANSWER_KEYS, roofInverterSupplyKey, roofVentAnswers, thermalScreen } from '../lib/discoveryRoofs.js'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { EQUIPMENT_LABELS as ROLE_LABELS, INVERTER_MODELS, JWT_ROLES, SENSOR_PRODUCTS } from '../lib/discoveryEquipmentCatalog.js'
import { createContext, Fragment, useContext, useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { InlineNumber, InlineText, InlineTextarea } from '../components/InlineFields.jsx'
import { Link, useNavigate } from 'react-router-dom'
import { ExternalLink, Trash2, ShoppingCart, Pencil, ChevronDown, ChevronRight } from 'lucide-react'
import { Modal } from '../components/Modal.jsx'
import DiscoveryFormOptions, { CountStepper } from '../components/DiscoveryFormOptions.jsx'
import DiscoveryExtrasTable, { additionalEquipment, EXTRA_COLUMNS, FLAG_COLUMNS, MATERIAL_COLUMNS } from '../components/DiscoveryExtrasTable.jsx'
import { DISCOVERY_LANGS } from '../lib/discoveryFormI18n.js'
import api from '../lib/api.js'
import { Badge } from '../components/Badge.jsx'
import TableThumb, { TABLE_THUMB_CLASS } from '../components/TableThumb.jsx'
import Attachments from '../components/Attachments.jsx'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { fmtDate } from '../lib/formatDate.js'
import { fmtAddress } from '../utils/formatters.js'
import { buildForm, controllerDistanceValue, CUSTOM_SECTIONS, sideVentsOnly, FANS_HP_RANGE_OPTIONS, fansHpRangeValue } from '../lib/discoveryFormSchema.js'
import { LOUVER_COMBOS, louverComboValue, louverSummary } from '../components/LouverTypeChoice.jsx'
import { unknownAnswers } from '../lib/discoveryUnknownAnswers.js'

// Fiche d'un formulaire de découverte : lecture des réponses telles que
// remplies par le client (le formulaire lui-même vit sur /d/:token).
// Les codes stockés en base sont traduits ici avec les mêmes libellés que
// ceux affichés au client dans pages/CustomerPostPayment.jsx.

// Avertissements réglables dans le Form builder ; les autres relèvent du client.

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
  present: 'Déjà présents',
  needed: 'À fournir',
  unknown: 'Je ne sais pas',
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

// Correction des réponses depuis la fiche : `null` une fois la commande créée.
const AnswerEdit = createContext(null)
// Compteur propre à la fiche : chaque réponse visible se signale, y compris
// les champs vides affichés « Je ne sais pas ». Les groupes masqués ne comptent pas.
const UnknownAnswerCount = createContext(null)

const DONT_KNOW = 'Je ne sais pas'
// Wi-Fi que le client ne fournira pas, accepté par Orisha.
const WIFI_NONE = 'Non fourni'
const wifiShown = v => (v === WIFI_NONE ? 'Pas nécessaire' : v)

const BOOL_OPTIONS = [{ value: true, label: 'Oui' }, { value: false, label: 'Non' }]
const BOOL_UNKNOWN_OPTIONS = [...BOOL_OPTIONS, { value: 'unknown', label: 'Je ne sais pas' }]
const SIDE_INVERTER_RATIO_OPTIONS = [
  { value: 'per_two', label: '1 inverseur pour deux moteurs' },
  { value: 'per_motor', label: '1 inverseur par moteur' },
  { value: 'unknown', label: DONT_KNOW },
]
const SIDE_INVERTER_OPTIONS = [
  ...INVERTER_MODELS.filter(([kind]) => kind === 'side').map(([, model]) => ({ value: model, label: model })),
  { value: 'other', label: 'Autre' },
  { value: DONT_KNOW, label: DONT_KNOW },
]

// `edit` : { kind: 'text'|'number'|'select', value, options?, patch(v) → corps de la route }.
function EditableValue({ edit, children }) {
  const ctx = useContext(AnswerEdit)
  const [open, setOpen] = useState(false)
  const box = useRef(null)
  const cancelled = useRef(false)
  useEffect(() => {
    if (open) { cancelled.current = false; box.current?.querySelector('input,select')?.focus() }
  }, [open])
  const save = v => {
    setOpen(false)
    if (!cancelled.current) ctx.save(edit.patch(v))
  }
  if (!open) return (
    <button type="button" onClick={() => setOpen(true)} disabled={ctx.saving} title="Modifier"
      className="group -mx-1 px-1 rounded text-left max-w-full inline-flex items-center gap-1 hover:bg-slate-100">
      <span className="min-w-0">{children}</span>
      <Pencil size={11} aria-hidden="true" className="shrink-0 text-slate-400 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  )
  const options = edit.options || []
  const selected = options.findIndex(o => o.value === edit.value || (o.value != null && edit.value != null && String(o.value) === String(edit.value)))
  return (
    <div ref={box} onBlur={() => setOpen(false)}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.stopPropagation(); cancelled.current = true; e.target.blur() }
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur()
      }}>
      {edit.kind === 'select'
        ? <select className="input text-sm w-full" value={selected < 0 ? '' : String(selected)}
            onChange={e => { if (e.target.value !== '') save(options[Number(e.target.value)].value) }}>
            {selected < 0 && <option value="">{edit.value == null || edit.value === '' ? '—' : String(edit.value)}</option>}
            {options.map((o, i) => <option key={i} value={String(i)}>{o.label}</option>)}
          </select>
        : edit.kind === 'number'
          ? <InlineNumber value={edit.value} min={0} className="input text-sm w-28" onSave={save} />
          : <InlineText value={edit.value} onSave={save} />}
    </div>
  )
}

// Champ sans valeur : masqué, sauf s'il reste modifiable (on peut alors
// compléter la réponse manquante).
// `verify` : marque/modèle déclaré par le client, en rouge tant que sa case n'est pas cochée.
// `action` : bouton discret à côté de la valeur, seulement si elle est modifiable.
function Row({ label, children, wide = false, verify = null, edit = null, action = null }) {
  const editable = !!useContext(AnswerEdit) && !!edit
  const setUnknownCount = useContext(UnknownAnswerCount)
  const empty = children == null || children === '' || children === false
  const hidden = empty && !editable
  // Sans réponse : « Je ne sais pas », comme une réponse à corriger.
  const shown = empty ? 'Je ne sais pas' : children
  // « Je ne sais pas » : réponse à corriger, en rouge.
  const unsure = empty || (typeof children === 'string' && /^je ne sais pas/i.test(children.trim()))
  const counted = !hidden && unsure
  useLayoutEffect(() => {
    if (!counted || !setUnknownCount) return
    setUnknownCount(n => n + 1)
    return () => setUnknownCount(n => n - 1)
  }, [counted, setUnknownCount])
  if (hidden) return null
  const red = unsure || (verify && !verify.checked)
  return (
    <div className={`min-w-0 break-words${wide ? ' col-span-full' : ''}`}>
      <div className="flex items-center gap-2 text-xs font-medium text-slate-500 mb-1">{label}{verify?.box && <VerifyCheck verify={verify} />}</div>
      <div className={`text-sm ${red ? 'text-red-600 font-medium' : 'text-slate-900'}`}>{editable ? <EditableValue edit={edit}>{shown}</EditableValue> : shown}{editable && action}</div>
    </div>
  )
}

// Éditeur d'un champ racine du formulaire.
const formEdit = (kind, field, value, options, extra = () => ({})) => ({
  kind, value, options, patch: v => ({ answers: { [field]: v, ...extra(v) } }),
})
// Éditeur d'un champ de la carte de serre ; `values(v)` donne les champs à écrire.
const ghEdit = (idx, kind, value, values, options) => ({
  kind, value, options, patch: v => ({ greenhouse: { index: idx, values: values(v) } }),
})
// Réponse d'une question ajoutée dans l'éditeur, selon son type.
function customEdit(q, value, patch) {
  if (q.type === 'number') return { kind: 'number', value, patch }
  if (q.type === 'yesno' || q.type === 'checkbox') return { kind: 'select', value, options: BOOL_OPTIONS, patch }
  if (q.type === 'select' || q.type === 'radio') return { kind: 'select', value, options: q.options || [], patch }
  return { kind: 'text', value, patch }
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
// `patch(q)` : corps de la route pour corriger la réponse à `q`.
function customRows(questions, answers, patch) {
  const a = answers || {}
  return questions
    .filter(q => a[q.id] != null && a[q.id] !== '')
    .map(q => {
      const v = a[q.id]
      const text = typeof v === 'boolean'
        ? (v ? 'Oui' : 'Non')
        : (q.options?.find(o => o.value === v)?.label ?? String(v))
      return <Row key={q.id} label={q.label} edit={patch && customEdit(q, v, patch(q))}>{text}</Row>
    })
}

// Case de vérification seule, posée à côté de l'élément vérifié ; son libellé
// ne sert qu'aux lecteurs d'écran et à l'infobulle.
function VerifyCheck({ verify }) {
  return (
    <label title={verify.label} className="-m-1.5 inline-flex shrink-0 cursor-pointer p-1.5">
      <input type="checkbox" aria-label={verify.label} disabled={verify.saving} className="h-4 w-4 rounded accent-green-600 cursor-pointer disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-600" checked={verify.checked} onChange={e => verify.onCheck(verify.key, e.target.checked)} />
    </label>
  )
}

// Réponse explicite à zéro (0, '0', false) — distincte d'une question sans réponse.
const isZero = v => v === false || (v != null && v !== '' && Number(v) === 0)

// `none` : l'équipement est absent — le groupe ne montre que « Aucun » (ou `noneLabel`).
// `noneEdit` : en correction, « Aucun » ouvre l'éditeur de la question qui l'a décidé.
function ResponseGroup({ title, children, none = false, noneLabel = 'Aucun', noneEdit = null }) {
  const correcting = !!useContext(AnswerEdit)
  return (
    <section aria-label={title} className="min-w-0 rounded-lg border border-slate-200 p-3">
      <h4 className="flex items-center gap-2 text-xs font-semibold text-slate-700 mb-3">{title}</h4>
      {none ? <div className="text-sm text-slate-900">{correcting && noneEdit ? <EditableValue edit={noneEdit}>{noneLabel}</EditableValue> : noneLabel}</div> : children}
    </section>
  )
}

// Guides fournis par Orisha : le diamètre de ceux du client ne compte plus.
const shipsGuides = g => g.guide_pipes_state === 'needed' || !!g.wants_compatible_guide_pipes
// Marques et modèles déclarés par le client, tels qu'affichés.
const motorText = g => [g.side_vent_motor_brand, g.side_vent_motor_model].filter(Boolean).join(' ')
// Seul un moteur saisi dans « Autre » est à vérifier : ceux de la liste sont connus.
// Sans choix enregistré (anciennes réponses), la marque a été tapée par le client.
const otherMotor = g => (g.side_vent_motor_choice ? g.side_vent_motor_choice === 'other' : true) && !!motorText(g)
const furnaceText = f => [f.brand === 'Autre' ? f.brand_other || f.brand : f.brand, f.model === 'Autre' ? f.model_other : f.model].filter(Boolean).join(' ')
// Toits (ou toiles) décrits, dans l'ordre de la fiche.
const roofList = (rec, legacy) => rec.has_roof_vents ? roofVentAnswers(rec, { legacy }) : rec.roof_motor_voltage ? [rec] : []
// Seul un inverseur saisi dans « Autre » est à vérifier : ceux de la liste sont connus.
const otherInverter = r => r?.has_roof_inverter === true && r.roof_inverter_type === 'other'

// Marques/modèles à vérifier avant la commande : [clé, libellé].
// « motors » et « furnace:i » gardent les clés des anciennes vérifications.
function greenhouseChecks(g, idx) {
  const n = idx + 1
  const list = []
  if (g.has_existing_side_vent_motors && g.side_has_inverters !== true && otherMotor(g)) list.push(['motors', 'Moteurs vérifiés'])
  if (g.has_existing_side_vent_motors && g.side_has_inverters === true && g.side_inverter_model === 'other') list.push(['inverters', 'Inverseurs vérifiés'])
  roofList(g, true).forEach((r, i) => { if (otherInverter(r)) list.push([`roof:${i}`, 'Inverseur vérifié']) })
  roofList(thermalScreen(g), false).forEach((r, i) => { if (otherInverter(r)) list.push([`screen:${i}`, 'Inverseur vérifié']) })
  ;(Array.isArray(g.furnaces) ? g.furnaces : []).forEach((f, i) => { if (furnaceText(f || {})) list.push([`furnace:${i}`, `Fournaise #${i + 1} vérifiée`]) })
  return list.map(([key, label]) => [`g${n}:${key}`, label])
}

function GreenhouseCard({ g, idx, form, equipment, images, types, ids, names, response, onCheck, saving }) {
  const perm = PERMISSION_LABELS[g.permission_level]
  const correcting = !!useContext(AnswerEdit)
  // Serre Helper : côtés ouvrants seulement — les autres automatisations ne lui
  // sont pas demandées, inutile de montrer leurs lignes.
  const helperOnly = sideVentsOnly(g.permission_level || response.permission_level)
  const zones = Number(g.irrigation_zones) || 0
  const furnaces = Array.isArray(g.furnaces) ? g.furnaces : []
  // Seuls les équipements du client nécessitent une vérification.
  const checkLabels = Object.fromEntries(equipment ? greenhouseChecks(g, idx) : [])
  // `box: false` : ligne en rouge liée à la case d'une autre ligne.
  const verify = (name, box = true) => {
    const key = `g${idx + 1}:${name}`
    if (!checkLabels[key]) return null
    return { key, label: checkLabels[key], checked: !!response.verification?.[key], box, onCheck, saving }
  }
  const weShipGuides = shipsGuides(g)
  // Éditeurs des réponses de cette serre (mêmes remises à zéro que le formulaire public).
  const ed = (kind, value, values, options) => ghEdit(idx, kind, value, values, options)
  const set = field => v => ({ [field]: v })
  const customPatch = q => v => ({ greenhouse: { index: idx, values: { custom: { [q.id]: v } } } })
  const extraRows = [
    ...customRows(form.custom('greenhouse'), g.custom, customPatch),
    ...(g.permission_level === 'chief_grower' ? customRows(form.custom('greenhouse_chief'), g.custom, customPatch) : []),
  ]
  // Toit #1 sur la serre, les suivants dans `extra_roof_vents` (voir roofVentAnswers).
  const roofValues = (i, values, rec = g) => {
    if (i === 0) return values
    const extra = roofVentAnswers(rec, { legacy: rec === g }).slice(1).map(r => Object.fromEntries(ROOF_ANSWER_KEYS.filter(k => k in r).map(k => [k, r[k]])))
    extra[i - 1] = { ...extra[i - 1], ...values }
    return { extra_roof_vents: extra }
  }
  // Toile thermique : mêmes réponses que le toit, rangées dans `thermal_screen`.
  const screen = thermalScreen(g)
  const ventGroups = [
    { title: 'Toits ouvrants', one: 'Toit ouvrant', key: 'roof', many: 'Nombre de toits ouvrants', rec: g, wrap: v => v },
    { title: 'Toiles thermiques', one: 'Toile thermique', key: 'screen', many: 'Nombre de toiles thermiques', rec: screen, wrap: v => ({ thermal_screen: { ...screen, ...v } }) },
  ]
  // Longueur : plage choisie, puis la longueur exacte au-delà de 200 pi (comme le formulaire client).
  const lengthRange = g.length_range || (Number(g.length) > 0 ? (Number(g.length) > 200 ? 'over_200' : 'up_to_200') : '')
  const keepsLength = range => (range === 'up_to_200' ? Number(g.length) > 0 && Number(g.length) <= 200 : range === 'over_200' && Number(g.length) > 200)
  const furnaceValues = (i, field) => v => ({ furnaces: furnaces.map((f, j) => (j === i ? { ...f, [field]: v } : f)) })
  // Même lecture que le formulaire client : 25/50/75/100 tels quels, tout autre nombre = « Plus de 100 pi ».
  const wireRange = f => f.control_wire_range || (Number(f.control_wire_feet) > 0 ? (['25', '50', '75', '100'].includes(String(Number(f.control_wire_feet))) ? String(Number(f.control_wire_feet)) : 'over_100') : '')
  // Question qui décide de chaque groupe : aussi l'éditeur de son « Aucun ».
  const sideCountEdit = ed('number', g.has_side_vents === false ? 0 : g.num_side_vent_motors, n => (n === 0
    ? { has_side_vents: false, side_vent_height: '', side_vent_height_range: '', side_pipe_type: '', side_pipe_diameter: '', guide_pipes_state: '', guide_pipe_diameter: '', wants_compatible_guide_pipes: false, num_side_vent_motors: 0, has_existing_side_vent_motors: null }
    : n === '' ? { has_side_vents: null, num_side_vent_motors: '' } : { has_side_vents: true, num_side_vent_motors: n }))
  const fansEdit = ed('select', g.num_fans, n => ({ num_fans: n, fans_combined_hp: n === '2' ? g.fans_combined_hp : '', fans_hp_range: n === '2' ? g.fans_hp_range : '' }), ['0', '1', '2'].map(v => ({ value: v, label: v })))
  const furnacesEdit = ed('select', g.has_furnaces, set('has_furnaces'), BOOL_OPTIONS)
  const zonesEdit = ed('number', g.irrigation_zones, set('irrigation_zones'))
  // Louvres : la liste entière est réécrite (même redimensionnement que le formulaire public).
  const louvers = Array.isArray(g.louvers) ? g.louvers : []
  const louverValues = (i, values) => ({ louvers: louvers.map((l, j) => (j === i ? { ...l, ...values } : l)) })
  const louverTypeValues = (i, combo) => {
    const def = LOUVER_COMBOS.find(c => c.value === combo)
    return louverValues(i, { control_type: def?.control_type || combo, voltage: def?.voltage ?? '', voltage_other: '' })
  }
  const louverCountEdit = ed('number', g.has_louvers === false ? 0 : louvers.length || '', n => (n === ''
    ? { has_louvers: null, louvers: [] }
    : { has_louvers: n > 0, louvers: Array.from({ length: n }, (_, i) => louvers[i] || {}) }))
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
        <ResponseGroup title="Côtés" none={g.has_side_vents === false || (g.has_side_vents !== true && isZero(g.num_side_vent_motors))} noneEdit={sideCountEdit}>
        <div className="system-response-grid">
        <Row label="Côtés ouvrants" edit={sideCountEdit}>{g.has_side_vents === true ? (g.num_side_vent_motors || 'Oui') : yesNo(g.has_side_vents)}</Row>
        {g.has_side_vents === true && (
          <>
            <Row label="Longueur" edit={ed('select', lengthRange, range => ({ length_range: range, length: keepsLength(range) ? g.length : '' }), form.opts('greenhouse.length_range_options'))}>{choiceLabel(form, 'greenhouse.length_range_options', lengthRange)}</Row>
            {lengthRange === 'over_200' && <Row label="Longueur (pi)" edit={ed('number', g.length, v => ({ length_range: 'over_200', length: v }))}>{Number(g.length) > 0 ? g.length : null}</Row>}
            <Row label="Hauteur côtés (pi)" edit={ed('number', Number(g.side_vent_height) > 0 ? g.side_vent_height : '', v => ({ side_vent_height: v, side_vent_height_range: v === '' ? '' : v > 6 ? 'over_6' : 'up_to_6' }))}>{g.side_vent_height || (g.side_vent_height_range === 'up_to_6' ? '6 pi et moins' : null)}</Row>
            <Row label="Tuyau de côté" edit={ed('select', g.side_pipe_type, v => ({ side_pipe_type: v, side_pipe_diameter: '' }), form.opts('greenhouse.side_pipe_type_options'))}>{choiceLabel(form, 'greenhouse.side_pipe_type_options', g.side_pipe_type, PIPE_LABELS)}</Row>
            <Row label="Diamètre côté" edit={ed('text', g.side_pipe_diameter, set('side_pipe_diameter'))}>{g.side_pipe_diameter}</Row>
            <Row label="Tuyaux guides 1 à 1 5/16 po" edit={ed('select', g.guide_pipes_state, v => ({ guide_pipes_state: v, guide_pipe_diameter: '' }), form.opts('greenhouse.guide_pipes_options'))}>{choiceLabel(form, 'greenhouse.guide_pipes_options', g.guide_pipes_state, GUIDE_LABELS)}</Row>
            {!weShipGuides && <Row label="Diamètre guides" edit={ed('text', g.guide_pipe_diameter, set('guide_pipe_diameter'))}>{g.guide_pipe_diameter}</Row>}
            {g.wants_compatible_guide_pipes && <Row label="Guides compatibles">À fournir</Row>}
          </>
        )}
        {g.has_existing_side_vent_motors && g.side_has_inverters !== true && <Row label="Moteurs déclarés" verify={verify('motors')}>{motorText(g) || null}</Row>}
        {g.has_existing_side_vent_motors && (typeof g.side_has_inverters === 'boolean' || g.side_has_inverters === 'unknown') && <Row label="Inverseurs" edit={ed('select', g.side_has_inverters, v => ({ side_has_inverters: v, side_inverter_ratio: '', side_inverter_model: '', side_inverter_brand_other: '', side_inverter_model_other: '', ...(v === true ? { length_range: '', length: '', side_vent_motor_choice: '', side_vent_motor_brand: '', side_vent_motor_model: '' } : {}) }), BOOL_UNKNOWN_OPTIONS)}>{g.side_has_inverters === 'unknown' ? 'Je ne sais pas' : g.side_has_inverters
          ? 'Oui'
          : 'Aucun'}</Row>}
        {g.has_existing_side_vent_motors && g.side_has_inverters === true && <>
          <Row label="Répartition des inverseurs" edit={ed('select', g.side_inverter_ratio, set('side_inverter_ratio'), SIDE_INVERTER_RATIO_OPTIONS)}>{SIDE_INVERTER_RATIO_OPTIONS.find(o => o.value === g.side_inverter_ratio)?.label || DONT_KNOW}</Row>
          <Row label="Modèle de l’inverseur" verify={verify('inverters')} edit={ed('select', g.side_inverter_model, v => ({ side_inverter_model: v, side_inverter_brand_other: '', side_inverter_model_other: '' }), SIDE_INVERTER_OPTIONS)}>{SIDE_INVERTER_OPTIONS.find(o => o.value === g.side_inverter_model)?.label || g.side_inverter_model}</Row>
          {g.side_inverter_model === 'other' && <>
            <Row label="Marque" verify={verify('inverters', false)} edit={ed('text', g.side_inverter_brand_other, set('side_inverter_brand_other'))}>{g.side_inverter_brand_other}</Row>
            <Row label="Modèle" verify={verify('inverters', false)} edit={ed('text', g.side_inverter_model_other, set('side_inverter_model_other'))}>{g.side_inverter_model_other}</Row>
          </>}
        </>}
        </div>
        </ResponseGroup>
        {ventGroups.map(({ title, one, key, many, rec: g, wrap }) => {
          if (g.has_roof_vents == null && g.num_roof_vents == null && !g.roof_motor_voltage) return null
          // Le nombre porte aussi le Oui / Non : « Oui » sans nombre = 1 (voir roofVentAnswers).
          const count = g.has_roof_vents === true ? Math.max(1, Number(g.num_roof_vents) || 0) : g.num_roof_vents
          const roofEdit = ed('number', count, v => wrap(v === '' ? { num_roof_vents: '' } : { num_roof_vents: v, has_roof_vents: Number(v) > 0 }))
          const none = g.has_roof_vents !== true && (g.has_roof_vents === false || isZero(g.num_roof_vents))
          const fields = roofList(g, g === ventGroups[0].rec).map((r, i) => {
            const roof = (kind, field, options, extra = {}) => g.has_roof_vents ? ed(kind, r[field], v => wrap(roofValues(i, { [field]: v, ...extra }, g)), options) : null
            return <Fragment key={i}>
              <Row label="Inverseur déjà présent" edit={roof('select', 'has_roof_inverter', BOOL_UNKNOWN_OPTIONS)}>{r.has_roof_inverter === 'unknown' ? 'Je ne sais pas' : yesNo(r.has_roof_inverter)}</Row>
              {(r.has_roof_inverter !== true || r.roof_motor_voltage) && <Row label="Tension du moteur" edit={roof('select', 'roof_motor_voltage', form.opts('roofs.voltage_options'))}>{choiceLabel(form, 'roofs.voltage_options', r.roof_motor_voltage)}</Row>}
              {r.has_roof_inverter === true && <>
                <Row label="Modèle de l’inverseur" verify={verify(`${key}:${i}`)} edit={roof('select', 'roof_inverter_type', form.opts('roofs.inverter_options'))}>{choiceLabel(form, 'roofs.inverter_options', r.roof_inverter_type)}</Row>
                {r.roof_inverter_type === 'other' && <><Row label="Marque" verify={verify(`${key}:${i}`, false)} edit={roof('text', 'roof_inverter_brand')}>{r.roof_inverter_brand}</Row><Row label="Modèle" verify={verify(`${key}:${i}`, false)} edit={roof('text', 'roof_inverter_model')}>{r.roof_inverter_model}</Row></>}
              </>}
              {r.has_roof_inverter === false && <>
                {r.roof_motor_voltage === '240' && <Row label="Ridder RW240, 1 phase, 5 fils" edit={roof('select', 'roof_motor_ridder_rw240', BOOL_OPTIONS)}>{yesNo(r.roof_motor_ridder_rw240)}</Row>}
                <Row label="Fourniture de l’inverseur">{form.t(roofInverterSupplyKey(r))}</Row>
              </>}
            </Fragment>
          })
          // Plusieurs toits : un groupe par toit (comme les fournaises) ; le nombre
          // se lit aux cartes, sa carte ne reste qu'en correction pour le modifier.
          if (none || fields.length < 2) return <ResponseGroup key={title} title={title} noneEdit={roofEdit} none={none}>
            <Row label={many} edit={roofEdit}>{count}</Row>
            {fields}
          </ResponseGroup>
          return <Fragment key={title}>
            {correcting && <ResponseGroup title={title}><Row label={many} edit={roofEdit}>{count}</Row></ResponseGroup>}
            {fields.map((f, i) => <ResponseGroup key={i} title={`${one} #${i + 1}`}><div className="system-response-grid">{f}</div></ResponseGroup>)}
          </Fragment>
        })}
        {!helperOnly && <>
          {!g.has_louvers || !g.louvers?.length ? <ResponseGroup title="Louvres" noneLabel="Aucune" noneEdit={louverCountEdit} none={g.has_louvers === false}>
          <Row label="Louvres" edit={louverCountEdit}>{g.louvers?.length || null}</Row>
          </ResponseGroup> : g.louvers.map((l, i) => <ResponseGroup key={i} title={`Louvre #${i + 1}`}>
            <div className="system-response-grid"><Row label="Type de louvre" edit={ed('select', louverComboValue(l), c => louverTypeValues(i, c), form.opts('louvers.types'))}>{l.control_type === 'other' ? 'Je ne sais pas' : louverSummary(l) || null}</Row><Row label="Ventilateur associé" edit={ed('select', l.has_fan, v => louverValues(i, { has_fan: v }), BOOL_OPTIONS)}>{yesNo(l.has_fan)}</Row>{l.has_fan && l.control_type === 'open_close' && <Row label="Commande">Contrôle séparé du ventilateur non proposé — à vérifier</Row>}</div>
          </ResponseGroup>)}
        </>}
        {!helperOnly && <ResponseGroup title="Ventilateurs" noneEdit={fansEdit} none={isZero(g.num_fans)}>
          <div className="system-response-grid">
            <Row label="Ventilateurs" edit={fansEdit}>{g.num_fans || null}</Row>
            {Number(g.num_fans) === 2 && <Row label="Puissance ventilateurs" edit={ed('select', fansHpRangeValue(g), v => ({ fans_hp_range: v, fans_combined_hp: '' }), FANS_HP_RANGE_OPTIONS)}>{fansHpLabel(g)}</Row>}
          </div>
        </ResponseGroup>}
        {(g.permission_level === 'chief_grower' || g.has_furnaces != null) && furnaces.length === 0 && <ResponseGroup title="Fournaises" noneLabel="Aucune" noneEdit={furnacesEdit} none={g.has_furnaces === false}>
          <Row label="Fournaises" edit={furnacesEdit}>{yesNo(g.has_furnaces)}</Row>
        </ResponseGroup>}
          {furnaces.map((f, i) => (
            <ResponseGroup key={i} title={`Fournaise #${i + 1}`}>
            <div className="system-response-grid">
              <Row label="Compatible" edit={ed('select', f.dry_contact_24v, furnaceValues(i, 'dry_contact_24v'), form.opts('furnace.dry_contact_options'))}>{form.opts('furnace.dry_contact_options').find(o => o.value === f.dry_contact_24v)?.label || null}</Row>
              {/* Les réponses d'avant la question du contact sec ne portent que la marque et le modèle. */}
              {(f.brand || f.model) && <Row label="Marque / modèle" verify={verify(`furnace:${i}`)}>{furnaceText(f) || null}</Row>}
              <Row label="Filage (pi)" edit={ed('select', wireRange(f), v => ({ furnaces: furnaces.map((x, j) => (j === i ? { ...x, control_wire_range: v, control_wire_feet: /^\d+$/.test(v) ? v : v === 'over_100' && Number(x.control_wire_feet) > 100 ? x.control_wire_feet : '' } : x)) }), form.opts('furnace.wire_options'))}>{form.opts('furnace.wire_options').find(o => o.value === wireRange(f))?.label || null}</Row>
              {wireRange(f) === 'over_100' && <Row label="Filage exact (pi)" edit={ed('number', f.control_wire_feet, furnaceValues(i, 'control_wire_feet'))}>{f.control_wire_feet || null}</Row>}
              <Row label="Besoin d'un thermostat" edit={ed('select', f.backup_thermostat, furnaceValues(i, 'backup_thermostat'), BOOL_OPTIONS)}>{yesNo(f.backup_thermostat)}</Row>
            </div>
            </ResponseGroup>
          ))}
        {(g.permission_level === 'chief_grower' || (g.irrigation_zones != null && g.irrigation_zones !== '')) && <ResponseGroup title="Irrigation" noneLabel="Aucune" noneEdit={zonesEdit} none={isZero(g.irrigation_zones)}>
          <div className="system-response-grid">
            <Row label="Zones" edit={zonesEdit}>{g.irrigation_zones === 0 || g.irrigation_zones === '0' ? 0 : zones || null}</Row>
            {zones > 0 && <Row label="Valves à fournir" edit={ed('number', g.needs_orisha_valves === false ? 0 : g.orisha_valves_count, v => (v === 0 ? { needs_orisha_valves: false, orisha_valves_count: '' } : v === '' ? { orisha_valves_count: '' } : { needs_orisha_valves: true, orisha_valves_count: v, valve_brand: '', valve_model: '' }))}>{g.needs_orisha_valves === true ? (g.orisha_valves_count || null) : g.needs_orisha_valves === false ? 0 : null}</Row>}
            {zones > 0 && <Row label="Fil à fournir (pi)" edit={ed('number', g.valve_control_wire_feet, set('valve_control_wire_feet'))}>{g.valve_control_wire_feet ?? null}</Row>}
            {g.needs_orisha_valves === false && <Row label="Valves en place">{g.valve_brand === 'Autre marque' ? [g.valve_brand_other, g.valve_model].filter(Boolean).join(' ') || g.valve_brand : [g.valve_brand, g.valve_model].filter(Boolean).join(' ') || null}</Row>}
          </div>
        </ResponseGroup>}
        {extraRows.length > 0 && <ResponseGroup title="Autres réponses">
          <div className="system-response-grid">{extraRows}</div>
        </ResponseGroup>}
      </div>
      </div>
      {equipment && <EquipmentPreview equipment={equipment} images={images} types={types} ids={ids} names={names} />}
      </div>
    </section>
  )
}

// Familles d'équipements : un appareil et ses accessoires (fil, marettes…)
// restent ensemble. Ordre du tableau = ordre d'affichage.
const EQUIPMENT_FAMILIES = [
  ['Contrôle', r => r === 'activation_v2' || /^(central_controller|mobile_controller_|coax_antenna_kit)/.test(r)],
  ['Toits ouvrants', (r, note) => /^(roof_|inverter_extra_roof_)/.test(r) || (r === 'side_vent_controller_24v' && /^(Toit|Toile)/.test(note || ''))],
  ['Côtés ouvrants', r => /^(side_|motor_wire_|guide_pipe|inverter_extra_side_)/.test(r)],
  ['Louvres', r => r.startsWith('louver_')],
  ['Ventilateurs', r => r === 'fan_box_110v'],
  ['Brumisation et HAF', r => r.startsWith('humidity_')],
  ['Chauffage', r => /^(furnace_wire_|backup_thermostat|thermostat_wire)/.test(r)],
  ['Irrigation', r => r === 'valve' || r.startsWith('valve_wire')],
  ['Capteurs', r => r.endsWith('_sensor') || r === 'weather_box'],
  ['Permissions JWT', r => JWT_ROLES.includes(r)],
]

// Regroupe les équipements par famille (le reste par type de produit, à la fin)
// et fusionne les lignes d'un même produit : quantités additionnées.
function groupByType(items, types) {
  const groups = new Map(EQUIPMENT_FAMILIES.map(([label]) => [label, []]))
  for (const item of items) {
    const type = EQUIPMENT_FAMILIES.find(([, match]) => match(item.role, item.note))?.[0] || types[item.role] || 'Autre'
    if (!groups.has(type)) groups.set(type, [])
    const list = groups.get(type)
    const same = list.find(x => x.role === item.role)
    if (!same) { list.push({ ...item, parts: [item.qty] }); continue }
    same.qty += item.qty
    same.parts.push(item.qty)
    if (item.note && !same.note?.split(', ').includes(item.note)) same.note = same.note ? `${same.note}, ${item.note}` : item.note
  }
  return [...groups].filter(([, list]) => list.length)
}

// `site` : équipements communs au site (contrôleur, capteurs), sans sorties V2.
// `ids` : produit du catalogue par rôle — le nom ouvre sa fiche.
// `names` : nom du produit en base, affiché à la place du libellé du rôle.
function EquipmentPreview({ equipment: g, images = {}, types = {}, ids = {}, names = {}, site = false }) {
  return <div className={site ? 'min-w-0' : 'system-greenhouse-equipment min-w-0'}>
    {!site && <>
      <h3 className="text-sm font-semibold text-slate-900">Équipements</h3>
      <p className="text-xs text-slate-500 mt-1 mb-3">{g.slots == null ? 'Dimensionnement à compléter' : `${g.slots_partial ? '≥ ' : ''}${g.slots} sortie${g.slots !== 1 ? 's' : ''} · ${g.slots_partial ? '≥ ' : ''}${g.activation_modules} module${g.activation_modules !== 1 ? 's' : ''} V2`}{g.slots_partial && <span className="text-amber-700"> · minimum, à compléter</span>}</p>
    </>}
    {g.items.length > 0 ? <table className="w-full text-sm">
      <caption className="sr-only">{site ? 'Équipements du site' : `Équipements pour la serre #${g.greenhouse}`}</caption>
      <thead><tr className="text-xs text-slate-500 border-b border-slate-200"><th scope="col" className="font-medium text-left pb-2">Équipement</th><th scope="col" className="font-medium text-right pb-2 pl-3">Qté</th></tr></thead>
      {groupByType(g.items, types).map(([type, items]) => <tbody key={type}>
      <tr><th scope="colgroup" colSpan={2} className="pt-3 pb-1 text-left text-xs font-medium text-slate-500">{type}</th></tr>
      {items.map((item, i) => <tr key={i} className="border-b border-slate-100 last:border-0">
        <td className="py-2 text-slate-700 break-words"><div className="flex items-start gap-2">{images[item.role] ? <TableThumb src={images[item.role]} className="shrink-0 border border-slate-200" /> : <div className={`${TABLE_THUMB_CLASS} shrink-0`} />}<div className="min-w-0">{ids[item.role] ? <Link to={`/products/${ids[item.role]}`} className="link-record">{names[item.role] || ROLE_LABELS[item.role] || item.role}</Link> : names[item.role] || ROLE_LABELS[item.role] || item.role}{item.note && item.role !== 'activation_v2' && !JWT_ROLES.includes(item.role) && <span className="block text-xs text-slate-500">{item.note}</span>}{item.role === 'activation_v2' && g.slot_sources?.length > 0 && <ul className="mt-1 text-xs text-slate-500">
          {g.slot_sources.map(s => <li key={s.label} className="flex justify-between gap-2"><span className="min-w-0">{s.label}{s.qty > 1 && ` ×${s.qty}`}</span><span className="tabular-nums shrink-0">{s.slots}</span></li>)}
          <li className="flex justify-between gap-2 border-t border-slate-100 mt-0.5 pt-0.5 font-medium"><span>{g.slots_partial ? 'Sorties connues' : 'Sorties'}</span><span className="tabular-nums">{g.slots} / {item.qty * 4}</span></li>
        </ul>}</div></div></td>
        <td className="py-2 pl-3 text-right align-top font-medium tabular-nums text-slate-900">{item.role.endsWith('_wire_per_foot') && item.parts?.length > 1 && item.parts.every(p => p === item.parts[0]) ? `${item.parts.length} × ${item.parts[0]} pi` : item.qty}</td>
      </tr>)}</tbody>)}
    </table> : <p className="text-sm text-slate-500">Aucun équipement à ajouter.</p>}
  </div>
}

export default function DiscoveryFormDetail({ recordId: id, onClose, onDeleted }) {
  const confirm = useConfirm()
  const { addToast } = useToast()
  const navigate = useNavigate()
  const [schema, setSchema] = useState(null)
  const [preview, setPreview] = useState(null)
  const [previewError, setPreviewError] = useState(false)
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const [creatingOrder, setCreatingOrder] = useState(false)
  const [savingVerification, setSavingVerification] = useState(false)
  const [editingOptions, setEditingOptions] = useState(false)
  const [savingAnswer, setSavingAnswer] = useState(false)
  const [savingNotes, setSavingNotes] = useState(false)
  const [unknownCount, setUnknownCount] = useState(0)

  const { record: form, setRecord, loading, loadError, reload } = useDetailRecord(
    () => api.discoveryForms.get(id), [id], { clearOnError: true },
  )

  useEffect(() => {
    api.discoveryFormSchema.get().then(d => setSchema(d.schema)).catch(() => {})
  }, [])
  // Recalcul après une correction : l'ancien calcul reste affiché jusqu'au
  // nouveau, sinon la fiche entière se replie puis se redéploie.
  const previewFor = useRef(id)
  useEffect(() => {
    let active = true
    if (previewFor.current !== id) { previewFor.current = id; setPreview(null) }
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

  const [projects, setProjects] = useState([])
  useEffect(() => {
    if (!form?.company_id) return
    api.projects.list({ company_id: form.company_id, limit: 'all' }).then(r => setProjects(Array.isArray(r?.data) ? r.data : Array.isArray(r) ? r : [])).catch(() => {})
  }, [form?.company_id])
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
  async function saveProject(value) {
    if (savingVerification) return
    setSavingVerification(true)
    try {
      await api.discoveryForms.saveProject(id, value || null)
      await reload()
    } catch (err) {
      addToast({ message: err.message || 'Enregistrement impossible', type: 'error' })
    } finally { setSavingVerification(false) }
  }
  async function saveAnswer(body) {
    setSavingAnswer(true)
    try {
      const updated = await api.discoveryForms.saveAnswers(id, body)
      setRecord(current => current?.id === updated.id ? { ...current, ...updated } : current)
      setPreviewAttempt(n => n + 1)
    } catch (err) {
      addToast({ message: err.message || 'Enregistrement impossible', type: 'error' })
    } finally { setSavingAnswer(false) }
  }
  async function saveNotes(technical_notes) {
    setSavingNotes(true)
    try {
      await api.discoveryForms.saveNotes(id, technical_notes)
      setRecord(current => current?.id === form.id ? { ...current, technical_notes } : current)
    } catch (err) {
      addToast({ message: err.message || 'Enregistrement impossible', type: 'error' })
    } finally { setSavingNotes(false) }
  }
  async function createOrder() {
    setCreatingOrder(true)
    try {
      const order = await api.discoveryForms.createOrder(id)
      setRecord(current => current?.id === form.id ? { ...current, generated_order_id: order.id, generated_order_number: order.order_number } : current)
      addToast({ message: `Commande #${order.order_number} créée`, type: 'success' })
      navigate(`/orders/${order.id}`)
    }
    catch (err) { addToast({ message: err.message || 'Création impossible', type: 'error' }) }
    finally { setCreatingOrder(false) }
  }

  const submitted = form.status === 'submitted'
  const greenhouses = form.greenhouses || []
  const extras = form.extras || []
  // Marques/modèles pas encore vérifiés : la commande attend qu'elles le soient toutes.
  const uncheckedCount = submitted ? greenhouses.flatMap((g, i) => preview?.greenhouses.some(item => item.greenhouse === i + 1) ? greenhouseChecks(g, i) : [])
    .filter(([key]) => !form.verification?.[key]).length : 0
  // Validation métier de la commande, partagée avec le serveur. Le badge de la
  // fiche compte séparément les réponses affichées, dont les champs laissés vides.
  const questionLabels = Object.fromEntries(CUSTOM_SECTIONS.flatMap(s => formSchema.custom(s.id)).map(q => [q.id, q.label]))
  const unknown = unknownAnswers(form, { questionLabel: qid => questionLabels[qid] || 'Autre réponse' })
  // Équipements supplémentaires fixés par Orisha à la création, par serre.
  const extraRows = (Array.isArray(form.form_options?.additional_equipment) ? form.form_options.additional_equipment : [])
    .map((e, i) => [i, [...[['furnaces', 'fournaise'], ['valves', 'valve'], ['rollups', 'roll-up'], ['roofs', 'toit ouvrant'], ['screens', 'toile thermique']]
      .filter(([key]) => e?.[key] > 0).map(([key, label]) => `${e[key]} ${label}${e[key] > 1 ? 's' : ''}`),
    ...[...FLAG_COLUMNS, ...MATERIAL_COLUMNS].filter(([key]) => e?.[key] === true).map(([, label]) => label)].join(', ')])
    .filter(([, text]) => text)
  // Extras du site, même rendu que ceux d'une serre : « 1 contrôleur mobile, 2 capteurs solaires ».
  const siteOpts = form.form_options || {}
  const siteExtras = [
    [siteOpts.mobile_controller ? Math.max(1, siteOpts.mobile_controllers || 0) : 0, 'Contrôleur mobile'],
    [siteOpts.extra_central_controllers, 'Contrôleur central additionnel'],
    ...SENSOR_PRODUCTS.map(([role, label]) => [siteOpts.sensors?.[role], label]),
  ].filter(([n]) => n > 0).map(([n, label]) => `${n} ${countLabel(label, n)}`).join(', ')
  const sameShipping = form.shipping_same_as_farm === true
  // Questions hors serre, toutes sections confondues, dans l'ordre de l'éditeur.
  const formLevelCustom = CUSTOM_SECTIONS
    .filter(s => s.id !== 'greenhouse' && s.id !== 'greenhouse_chief')
    .flatMap(s => customRows(formSchema.custom(s.id), form.custom_answers, q => v => ({ custom_answers: { [q.id]: v } })))
  const answerEdit = form.generated_order_id ? null : { save: saveAnswer, saving: savingAnswer }
  const siteOptions = formSchema.opts('order_type.options').filter(o => o.value in SITE_LABELS).map(o => ({ value: o.value, label: SITE_LABELS[o.value] }))
  const wifi = !!form.wifi_ssid || !!form.wifi_password || String(form.network_access || '').startsWith('wifi')
  // Wi-Fi inconnu : on accepte de s'en passer, la commande n'attend plus.
  const wifiNone = (value, answers) => (!value || value === DONT_KNOW) && (
    <button type="button" onClick={() => saveAnswer({ answers })} disabled={savingAnswer}
      className="ml-2 text-xs font-normal text-slate-500 hover:text-slate-800 underline">Pas nécessaire</button>
  )

  return (
    <DetailShell
      className="system-builder-detail px-4 sm:px-5 py-4"
      header={{
        badge: <Badge color={submitted ? 'green' : 'blue'} size="sm">{submitted ? 'Soumis' : 'En cours'}</Badge>,
        // Ce qui reste à régler avant la commande.
        status: (unknownCount > 0 || uncheckedCount > 0) && <>
          {unknownCount > 0 && <Badge color="red" size="sm">{unknownCount} « Je ne sais pas »</Badge>}
          {uncheckedCount > 0 && <Badge color="orange" size="sm">{uncheckedCount} marque{uncheckedCount > 1 ? 's' : ''} à vérifier</Badge>}
        </>,
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
            {!form.generated_order_id && <button onClick={createOrder} disabled={creatingOrder || savingVerification || preview?.calculationComplete === false || (submitted && !preview) || uncheckedCount > 0 || unknown.length > 0} title={unknown.length > 0 ? `${unknown.length} « Je ne sais pas » à corriger` : uncheckedCount > 0 ? `${uncheckedCount} marque${uncheckedCount > 1 ? 's' : ''} à vérifier` : undefined} className="btn-primary btn-sm"><ShoppingCart size={14} /> {creatingOrder ? 'Création…' : 'Créer une commande'}</button>}
            <button onClick={handleDelete} className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg" title="Supprimer" aria-label="Supprimer ce système"><Trash2 size={16} /></button>
          </div>
        ),
      }}
    >
    <UnknownAnswerCount.Provider value={setUnknownCount}>
    <AnswerEdit.Provider value={answerEdit}>
    <div className="space-y-4">
      <div className="system-site-grid">
      <Section title="Site">
        <Row label="Type" edit={formEdit('select', 'is_new_site', form.is_new_site, siteOptions)}>{choiceLabel(formSchema, 'order_type.options', form.is_new_site, SITE_LABELS)}</Row>
        {form.is_new_site === 'add_to_existing' && !form.form_options?.mobile_controller && <>
          <Row label="Distance du contrôleur" edit={formEdit('select', 'central_controller_distance', controllerDistanceValue(form), formSchema.opts('controller_distance.options'), v => ({ within_central_controller_range: v !== 'no' }))}>{choiceLabel(formSchema, 'controller_distance.options', controllerDistanceValue(form), {}) || 'À compléter'}</Row>
          {typeof form.within_central_controller_range === 'boolean' && <Row label="Contrôleur central">{formSchema.t(form.within_central_controller_range ? 'controller_distance.near' : 'controller_distance.far')}</Row>}
        </>}
        <Row label="Projet" wide>
          <LinkedRecordField
            name="project_id"
            value={form.project_id}
            options={form.project_id && !projects.some(p => p.id === form.project_id) ? [{ id: form.project_id, name: form.project_name || 'Projet' }, ...projects] : projects}
            labelFn={p => p.name}
            getHref={p => `/projects/${p.id}`}
            saving={savingVerification}
            disabled={savingVerification || creatingOrder || !!form.generated_order_id}
            onChange={saveProject}
          />
        </Row>
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
        <Row label="Accès" edit={formEdit('select', 'network_access', form.network_access, formSchema.opts('network.options').map(o => ({ value: o.value, label: NETWORK_LABELS[o.value] || o.label })))}>{choiceLabel(formSchema, 'network.options', form.network_access, NETWORK_LABELS)}</Row>
        {wifi && <Row label="Wi-Fi" edit={formEdit('text', 'wifi_ssid', form.wifi_ssid)} action={wifiNone(form.wifi_ssid, { wifi_ssid: WIFI_NONE, wifi_password: WIFI_NONE })}>{wifiShown(form.wifi_ssid)}</Row>}
        {wifi && form.wifi_ssid !== WIFI_NONE && <Row label="Mot de passe" edit={formEdit('text', 'wifi_password', form.wifi_password)} action={wifiNone(form.wifi_password, { wifi_password: WIFI_NONE })}>{form.wifi_password === WIFI_NONE || form.wifi_password === DONT_KNOW ? wifiShown(form.wifi_password) :form.wifi_password ? 'Configuré' : null}</Row>}
      </Section>

      </div>

      {submitted && !preview && <div className="card p-4 text-sm text-slate-500" role={previewError ? 'alert' : 'status'}>
        {previewError ? <div className="flex flex-wrap items-center justify-between gap-3"><span>Calcul des équipements indisponible.</span><button className="btn-secondary btn-sm" onClick={() => setPreviewAttempt(n => n + 1)}>Réessayer</button></div> : 'Calcul des équipements…'}
      </div>}

      {formLevelCustom.length > 0 && (
        <Section title="Autres réponses">{formLevelCustom}</Section>
      )}

      {greenhouses.length === 0
        ? <div className="card p-5 text-sm text-slate-400">Les serres apparaîtront ici lorsque le client aura rempli le formulaire.</div>
        : greenhouses.map((g, i) => <GreenhouseCard key={i} g={g} idx={i} form={formSchema} equipment={submitted ? preview?.greenhouses.find(item => item.greenhouse === i + 1) : null} images={preview?.productImages} types={preview?.productTypes} ids={preview?.productIds} names={preview?.productNames} response={form} onCheck={setVerification} saving={savingVerification} />)}

      {submitted && preview?.siteItems?.length > 0 && <Section title="Site" cols={1}>
        <EquipmentPreview site equipment={{ items: preview.siteItems }} images={preview.productImages} types={preview.productTypes} ids={preview.productIds} names={preview.productNames} />
      </Section>}


      {(siteExtras || extraRows.length > 0) && <Section title="Extra" cols={1}>
        {siteExtras && <Row label="Site · extras">{siteExtras}</Row>}
        {extraRows.map(([i, text]) => <Row key={i} label={`Serre #${i + 1} · extras`}>{text}</Row>)}
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
      <Attachments entityType="discovery_forms" entityId={form.id} title="Documents techniques" renamable>
        <label className="block text-xs font-medium text-slate-500 mb-1">Notes
          <div className="mt-1 font-normal"><InlineTextarea value={form.technical_notes} saving={savingNotes} onSave={saveNotes} minRows={3} testId="discovery-technical-notes" /></div>
        </label>
      </Attachments>
    </div>
    </AnswerEdit.Provider>
    </UnknownAnswerCount.Provider>
    <Modal isOpen={editingOptions} title="Modifier le système" onClose={() => setEditingOptions(false)}>
      {editingOptions && <EditOptionsForm form={form} onClose={() => setEditingOptions(false)} onSaved={() => { setEditingOptions(false); reload(); setPreviewAttempt(n => n + 1) }} />}
    </Modal>
    </DetailShell>
  )
}

// « Capteur solaire » → « capteur solaire » / « capteurs solaires » ; on n'accorde pas après « de ».
function countLabel(label, n) {
  let plural = n > 1
  return label.toLowerCase().split(' ').map(word => {
    if (/^(de|du|d’)/.test(word)) plural = false
    if (!plural || /[sx]$/.test(word)) return word
    return word.endsWith('al') ? `${word.slice(0, -2)}aux` : `${word}s`
  }).join(' ')
}

// Options achetées et extras par serre : ce qu'Orisha a fixé à la création.
function EditOptionsForm({ form, onClose, onSaved }) {
  const { addToast } = useToast()
  const initial = form.form_options || {}
  const [options, setOptions] = useState({ ...initial, sensors: { ...(initial.sensors || {}) } })
  const cards = (form.greenhouses || []).map((g, i) => ({ key: String(i), helper: sideVentsOnly(g.permission_level || form.permission_level) }))
  const [extras, setExtras] = useState(() => Object.fromEntries(cards.map((card, i) => [card.key, { ...(initial.additional_equipment?.[i] || {}) }])))
  const [saving, setSaving] = useState(false)
  // Ouvert d'emblée : c'est ce qu'on vient modifier.
  const [advanced, setAdvanced] = useState(true)
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
  // Même présentation que la modale de création ; entreprise et serres restent
  // figées (le client a pu remplir les serres).
  const chiefs = cards.filter(c => !c.helper).length
  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div role="radiogroup" aria-label="Langue du formulaire" className="flex justify-end">
        <div className="inline-flex rounded-md border border-slate-200 p-0.5 text-xs">
          {DISCOVERY_LANGS.map(l => (
            <button key={l.value} type="button" role="radio" aria-checked={(options.lang || 'fr') === l.value}
              onClick={() => setOptions(o => ({ ...o, lang: l.value }))}
              className={`px-2 py-0.5 rounded font-medium ${(options.lang || 'fr') === l.value ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className="label">Entreprise *</label>
        <LinkedRecordField
          name="discovery_company_id"
          value={form.company_id}
          options={form.company_id ? [{ id: form.company_id, name: form.company_name || form.company_id }] : []}
          labelFn={c => c.name}
          getHref={c => `/companies/${c.id}`}
          disabled
          onChange={() => {}}
        />
      </div>
      <fieldset disabled className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="edit-system-chief-count" className="label">Nombre de Chef de culture</label>
          <CountStepper id="edit-system-chief-count" label="Chef de culture" max={50} value={chiefs} onChange={() => {}} />
        </div>
        <div>
          <label htmlFor="edit-system-helper-count" className="label">Nombre d'Assistant</label>
          <CountStepper id="edit-system-helper-count" label="Assistant" max={50} value={cards.length - chiefs} onChange={() => {}} />
        </div>
      </fieldset>
      <div className="border-t border-slate-200 pt-4">
        <button type="button" aria-expanded={advanced} onClick={() => setAdvanced(o => !o)} className="flex items-center gap-1 text-sm font-semibold text-slate-900">
          {advanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}Extra
        </button>
        {advanced && <div className="mt-4 space-y-4">
          <DiscoveryExtrasTable cards={cards} values={extras} onChange={setExtras} disabled={saving} title="Extra par serre" columns={[...EXTRA_COLUMNS, ...FLAG_COLUMNS, ...MATERIAL_COLUMNS]} helperLabel="Assistant" checkbox />
          <DiscoveryFormOptions flat mobileQty title="Extra pour le site" value={options} onChange={setOptions} disabled={saving} />
        </div>}
      </div>
      <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
        <button type="button" onClick={onClose} className="btn-ghost">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Enregistrement…' : 'Enregistrer'}</button>
      </div>
    </form>
  )
}
