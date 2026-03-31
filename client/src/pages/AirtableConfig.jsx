import { useState, useEffect, useRef } from 'react'
import { X, ChevronDown } from 'lucide-react'
import api from '../lib/api.js'

function FieldSelect({ value, onChange, options }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    function handler(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const filtered = options.filter(o => o.toLowerCase().includes(search.toLowerCase()))
  const display = value || ''

  function select(opt) {
    onChange(opt)
    setSearch('')
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative flex-1">
      <div
        onClick={() => { setOpen(o => !o); setSearch('') }}
        className="input flex items-center justify-between cursor-pointer pr-2 py-1 text-xs min-h-[32px]"
      >
        <span className={display ? 'text-slate-800' : 'text-slate-400'}>{display || '— ignorer —'}</span>
        <div className="flex items-center gap-1 flex-shrink-0">
          {display && (
            <button onClick={e => { e.stopPropagation(); select('') }} className="text-slate-400 hover:text-slate-600">
              <X size={12} />
            </button>
          )}
          <ChevronDown size={12} className="text-slate-400" />
        </div>
      </div>
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg">
          <div className="p-1.5 border-b border-slate-100">
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Rechercher…"
              className="w-full text-xs px-2 py-1 border border-slate-200 rounded outline-none focus:border-indigo-400"
              onClick={e => e.stopPropagation()}
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            <div onClick={() => select('')} className="px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-50 cursor-pointer">— ignorer —</div>
            {filtered.length === 0
              ? <div className="px-3 py-1.5 text-xs text-slate-400">Aucun résultat</div>
              : filtered.map(o => (
                <div key={o} onClick={() => select(o)}
                  className={`px-3 py-1.5 text-xs cursor-pointer hover:bg-indigo-50 hover:text-indigo-700 ${o === value ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-slate-700'}`}
                >{o}</div>
              ))
            }
          </div>
        </div>
      )}
    </div>
  )
}

import { RefreshCw } from 'lucide-react'

function ChoiceMapping({ fields, selectedFieldName, erpOptions, currentMap, onChange }) {
  if (!selectedFieldName) return null
  const atField = fields.find(f => f.name === selectedFieldName)
  const choices = atField?.options?.choices || []
  if (!choices.length) return null
  return (
    <div className="ml-44 mt-1 border border-slate-100 rounded p-2 space-y-1 bg-slate-50">
      <p className="text-xs text-slate-400 mb-1">Correspondance des options :</p>
      {choices.map(c => (
        <div key={c.id} className="flex items-center gap-2">
          <span className="text-xs text-slate-600 w-36 flex-shrink-0 truncate" title={c.name}>{c.name}</span>
          <span className="text-slate-300 text-xs">→</span>
          <select
            value={currentMap?.[c.name] || ''}
            onChange={e => onChange(c.name, e.target.value)}
            className="select text-xs py-0.5 flex-1"
          >
            <option value="">— ignorer —</option>
            {erpOptions.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      ))}
    </div>
  )
}

function SyncBtn({ label, syncKey, syncStatus, onSync }) {
  const [localRunning, setLocalRunning] = useState(false)
  const serverRunning = syncStatus?.[syncKey]?.running
  const serverError = syncStatus?.[syncKey]?.error
  const isRunning = localRunning || serverRunning

  // Réinitialise localRunning dès que le poll confirme la fin
  useEffect(() => {
    if (localRunning && !serverRunning) setLocalRunning(false)
  }, [serverRunning])

  function handleClick() {
    setLocalRunning(true)
    onSync()
  }

  return (
    <div className="flex items-center gap-2">
      <button onClick={handleClick} disabled={isRunning} className="btn-secondary btn-sm py-1">
        <RefreshCw size={12} className={isRunning ? 'animate-spin' : ''} /> {label}
      </button>
      {isRunning && <span className="text-xs text-amber-600 font-medium animate-pulse">En cours…</span>}
      {serverError && !isRunning && <span className="text-xs text-red-500" title={serverError}>⚠ Erreur</span>}
    </div>
  )
}

const TABS = [
  ['contacts',      'Contacts'],
  ['companies',     'Entreprises'],
  ['adresses',      'Adresses'],
  ['inv',           'Projets'],
  ['soumissions',   'Soumissions'],
  ['pieces',        'Pièces'],
  ['serials',       'N° de série'],
  ['bom',           'BOM'],
  ['assemblages',   'Assemblages'],
  ['serial_changes','États de série'],
  ['orders',        'Commandes'],
  ['achats',        'Achats'],
  ['envois',        'Envois'],
  ['abonnements',   'Abonnements'],
  ['factures',      'Factures'],
  ['billets',       'Billets'],
  ['retours',       'Retours'],
  ['retour_items',  'Items de retour'],
]

export default function AirtableConfig({ syncConfigs = {}, syncStatus, onRefresh, stripeConfigured = false }) {
  const {
    crm: airtableSync,
    inv: inventaireSync,
    pieces: piecesSync,
    orders: ordersSync,
    achats: achatsSync,
    billets: billetsSync,
    serials: serialsSync,
    envois: envoisSync,
    soumissions: soumissionsSync,
    adresses: adressesSync,
    bom: bomSync,
    serial_changes: serialChangesSync,
    assemblages: assemblagesSync,
    factures: facturesSync,
    retours: retoursSync,
    retour_items: retourItemsSync,
    abonnements: abonnementsSync,
  } = syncConfigs

  const [tab, setTab] = useState('contacts')
  const [syncingAll, setSyncingAll] = useState(false)

  const AIRTABLE_KEYS = ['airtable','inventaire','pieces','orders','achats','billets','serials','envois','soumissions','retours','retour_items','adresses','bom','serial_changes','abonnements','assemblages','factures']

  // Réinitialise syncingAll quand le poll confirme que tous les modules sont arrêtés
  useEffect(() => {
    if (!syncingAll) return
    const anyStillRunning = AIRTABLE_KEYS.some(k => syncStatus?.[k]?.running)
    if (!anyStillRunning) setSyncingAll(false)
  }, [syncStatus])
  const [bases, setBases] = useState([])
  const [basesError, setBasesError] = useState('')
  const [tables, setTables] = useState([])
  const [customContactFields, setCustomContactFields] = useState([])
  const [customCompanyFields, setCustomCompanyFields] = useState([])
  const [invTables, setInvTables] = useState([])
  const [piecesTables, setPiecesTables] = useState([])
  const [ordersTables, setOrdersTables] = useState([])
  const [itemsTables, setItemsTables] = useState([])
  const [achatsTables, setAchatsTables] = useState([])
  const [billetsTables, setBilletsTables] = useState([])
  const [serialsTables, setSerialsTables] = useState([])
  const [envoisTables, setEnvoisTables] = useState([])
  const [soumissionsTables, setSoumissionsTables] = useState([])
  const [adressesTables, setAdressesTables] = useState([])
  const [bomTables, setBomTables] = useState([])
  const [serialChangesTables, setSerialChangesTables] = useState([])
  const [assemblagesTables, setAssemblagesTables] = useState([])
  const [facturesTables, setFacturesTables] = useState([])
  const [retoursTables, setRetoursTables] = useState([])
  const [retourItemsTables, setRetourItemsTables] = useState([])
  const [abonnementsTables, setAbonnementsTables] = useState([])
  const [loadingBases, setLoadingBases] = useState(false)

  // CRM sync form
  const [crmForm, setCrmForm] = useState({
    base_id: airtableSync?.base_id || '',
    contacts_table_id: airtableSync?.contacts_table_id || '',
    companies_table_id: airtableSync?.companies_table_id || '',
    field_map_contacts: airtableSync?.field_map_contacts
      ? (typeof airtableSync.field_map_contacts === 'string' ? JSON.parse(airtableSync.field_map_contacts) : airtableSync.field_map_contacts)
      : {},
    field_map_companies: airtableSync?.field_map_companies
      ? (typeof airtableSync.field_map_companies === 'string' ? JSON.parse(airtableSync.field_map_companies) : airtableSync.field_map_companies)
      : {},
  })

  // Inventaire form
  const [invForm, setInvForm] = useState({
    base_id: inventaireSync?.base_id || '',
    projects_table_id: inventaireSync?.projects_table_id || '',
    field_map_projects: inventaireSync?.field_map_projects
      ? (typeof inventaireSync.field_map_projects === 'string' ? JSON.parse(inventaireSync.field_map_projects) : inventaireSync.field_map_projects)
      : {},
  })

  // Orders form
  const [ordersForm, setOrdersForm] = useState({
    base_id: ordersSync?.base_id || '',
    orders_table_id: ordersSync?.orders_table_id || '',
    items_table_id: ordersSync?.items_table_id || '',
    field_map_orders: ordersSync?.field_map_orders
      ? (typeof ordersSync.field_map_orders === 'string' ? JSON.parse(ordersSync.field_map_orders) : ordersSync.field_map_orders)
      : {},
    field_map_items: ordersSync?.field_map_items
      ? (typeof ordersSync.field_map_items === 'string' ? JSON.parse(ordersSync.field_map_items) : ordersSync.field_map_items)
      : {},
  })

  // Pièces form
  const [piecesForm, setPiecesForm] = useState({
    base_id: piecesSync?.base_id || '',
    table_id: piecesSync?.table_id || '',
    field_map: piecesSync?.field_map
      ? (typeof piecesSync.field_map === 'string' ? JSON.parse(piecesSync.field_map) : piecesSync.field_map)
      : {},
  })

  // Serials form
  const [serialsForm, setSerialsForm] = useState({
    base_id: serialsSync?.base_id || '',
    table_id: serialsSync?.table_id || '',
    field_map: serialsSync?.field_map
      ? (typeof serialsSync.field_map === 'string' ? JSON.parse(serialsSync.field_map) : serialsSync.field_map)
      : {},
  })

  // Billets form
  const [billetsForm, setBilletsForm] = useState({
    base_id: billetsSync?.base_id || '',
    table_id: billetsSync?.table_id || '',
    field_map: billetsSync?.field_map
      ? (typeof billetsSync.field_map === 'string' ? JSON.parse(billetsSync.field_map) : billetsSync.field_map)
      : {},
  })

  // Envois form
  const [envoisForm, setEnvoisForm] = useState({
    base_id: envoisSync?.base_id || '',
    table_id: envoisSync?.table_id || '',
    field_map: envoisSync?.field_map
      ? (typeof envoisSync.field_map === 'string' ? JSON.parse(envoisSync.field_map) : envoisSync.field_map)
      : {},
  })

  // Achats form
  const [achatsForm, setAchatsForm] = useState({
    base_id: achatsSync?.base_id || '',
    table_id: achatsSync?.table_id || '',
    field_map: achatsSync?.field_map
      ? (typeof achatsSync.field_map === 'string' ? JSON.parse(achatsSync.field_map) : achatsSync.field_map)
      : {},
  })

  function parseMap(sync) {
    if (!sync?.field_map) return {}
    return typeof sync.field_map === 'string' ? JSON.parse(sync.field_map) : sync.field_map
  }

  const [soumissionsForm, setSoumissionsForm] = useState({ base_id: soumissionsSync?.base_id || '', table_id: soumissionsSync?.table_id || '', field_map: parseMap(soumissionsSync) })
  const [adressesForm, setAdressesForm] = useState({ base_id: adressesSync?.base_id || '', table_id: adressesSync?.table_id || '', field_map: parseMap(adressesSync) })
  const [bomForm, setBomForm] = useState({ base_id: bomSync?.base_id || '', table_id: bomSync?.table_id || '', field_map: parseMap(bomSync) })
  const [serialChangesForm, setSerialChangesForm] = useState({ base_id: serialChangesSync?.base_id || '', table_id: serialChangesSync?.table_id || '', field_map: parseMap(serialChangesSync) })
  const [assemblagesForm, setAssemblagesForm] = useState({ base_id: assemblagesSync?.base_id || '', table_id: assemblagesSync?.table_id || '', field_map: parseMap(assemblagesSync) })
  const [facturesForm, setFacturesForm] = useState({ base_id: facturesSync?.base_id || '', table_id: facturesSync?.table_id || '', field_map: parseMap(facturesSync) })
  const [retoursForm, setRetoursForm] = useState({ base_id: retoursSync?.base_id || '', table_id: retoursSync?.table_id || '', field_map: parseMap(retoursSync) })
  const [retourItemsForm, setRetourItemsForm] = useState({ base_id: retourItemsSync?.base_id || '', table_id: retourItemsSync?.table_id || '', field_map: parseMap(retourItemsSync) })
  const [abonnementsForm, setAbonnementsForm] = useState({ base_id: abonnementsSync?.base_id || '', table_id: abonnementsSync?.table_id || '', field_map: parseMap(abonnementsSync) })

  async function loadBases() {
    setLoadingBases(true)
    setBasesError('')
    try { setBases(await api.airtable.bases() || []) }
    catch (e) { setBasesError(e.message || 'Erreur lors du chargement des bases') }
    finally { setLoadingBases(false) }
  }

  async function loadTables(baseId, setter) {
    if (!baseId) return
    const data = await api.airtable.tables(baseId)
    setter(Array.isArray(data) ? data : [])
  }

  async function saveCrm() {
    await api.airtable.saveConfig('crm', crmForm)
    onRefresh()
  }

  async function saveInv() {
    await api.airtable.saveConfig('inv', invForm)
    onRefresh()
  }

  async function savePieces() {
    await api.airtable.saveModuleConfig('pieces', piecesForm)
    onRefresh()
  }

  async function saveOrders() {
    await api.airtable.saveConfig('orders', ordersForm)
    onRefresh()
  }

  async function saveAchats() {
    await api.airtable.saveModuleConfig('achats', achatsForm)
    onRefresh()
  }

  async function saveSerials() {
    await api.airtable.saveModuleConfig('serials', serialsForm)
    onRefresh()
  }

  async function saveEnvois() {
    await api.airtable.saveModuleConfig('envois', envoisForm)
    onRefresh()
  }

  async function saveBillets() {
    await api.airtable.saveModuleConfig('billets', billetsForm)
    onRefresh()
  }

  async function saveSoumissions() { await api.airtable.saveModuleConfig('soumissions', soumissionsForm); onRefresh() }
  async function saveAdresses() { await api.airtable.saveModuleConfig('adresses', adressesForm); onRefresh() }
  async function saveBom() { await api.airtable.saveModuleConfig('bom', bomForm); onRefresh() }
  async function saveSerialChanges() { await api.airtable.saveModuleConfig('serial_changes', serialChangesForm); onRefresh() }
  async function saveAssemblages() { await api.airtable.saveModuleConfig('assemblages', assemblagesForm); onRefresh() }
  async function saveFactures() { await api.airtable.saveModuleConfig('factures', facturesForm); onRefresh() }
  async function saveRetours() { await api.airtable.saveModuleConfig('retours', retoursForm); onRefresh() }
  async function saveRetourItems() { await api.airtable.saveModuleConfig('retour_items', retourItemsForm); onRefresh() }
  async function saveAbonnements() { await api.airtable.saveModuleConfig('abonnements', abonnementsForm); onRefresh() }

  useEffect(() => { loadBases() }, [])
  useEffect(() => {
    api.fieldDefs.list('contacts').then(setCustomContactFields).catch(() => {})
    api.fieldDefs.list('companies').then(setCustomCompanyFields).catch(() => {})
  }, [])
  useEffect(() => { if (crmForm.base_id) loadTables(crmForm.base_id, setTables) }, [crmForm.base_id])
  useEffect(() => { if (invForm.base_id) loadTables(invForm.base_id, setInvTables) }, [invForm.base_id])
  useEffect(() => { if (piecesForm.base_id) loadTables(piecesForm.base_id, setPiecesTables) }, [piecesForm.base_id])
  useEffect(() => { if (ordersForm.base_id) loadTables(ordersForm.base_id, setOrdersTables) }, [ordersForm.base_id])
  useEffect(() => { if (ordersForm.base_id) loadTables(ordersForm.base_id, setItemsTables) }, [ordersForm.base_id])
  useEffect(() => { if (achatsForm.base_id) loadTables(achatsForm.base_id, setAchatsTables) }, [achatsForm.base_id])
  useEffect(() => { if (billetsForm.base_id) loadTables(billetsForm.base_id, setBilletsTables) }, [billetsForm.base_id])
  useEffect(() => { if (serialsForm.base_id) loadTables(serialsForm.base_id, setSerialsTables) }, [serialsForm.base_id])
  useEffect(() => { if (envoisForm.base_id) loadTables(envoisForm.base_id, setEnvoisTables) }, [envoisForm.base_id])
  useEffect(() => { if (soumissionsForm.base_id) loadTables(soumissionsForm.base_id, setSoumissionsTables) }, [soumissionsForm.base_id])
  useEffect(() => { if (adressesForm.base_id) loadTables(adressesForm.base_id, setAdressesTables) }, [adressesForm.base_id])
  useEffect(() => { if (bomForm.base_id) loadTables(bomForm.base_id, setBomTables) }, [bomForm.base_id])
  useEffect(() => { if (serialChangesForm.base_id) loadTables(serialChangesForm.base_id, setSerialChangesTables) }, [serialChangesForm.base_id])
  useEffect(() => { if (assemblagesForm.base_id) loadTables(assemblagesForm.base_id, setAssemblagesTables) }, [assemblagesForm.base_id])
  useEffect(() => { if (facturesForm.base_id) loadTables(facturesForm.base_id, setFacturesTables) }, [facturesForm.base_id])
  useEffect(() => { if (retoursForm.base_id) loadTables(retoursForm.base_id, setRetoursTables) }, [retoursForm.base_id])
  useEffect(() => { if (retourItemsForm.base_id) loadTables(retourItemsForm.base_id, setRetourItemsTables) }, [retourItemsForm.base_id])
  useEffect(() => { if (abonnementsForm.base_id) loadTables(abonnementsForm.base_id, setAbonnementsTables) }, [abonnementsForm.base_id])

  return (
    <div className="mt-4 space-y-4">
      {basesError && (
        <div className="flex items-center justify-between gap-3 text-sm bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
          <span className="text-red-600">⚠️ {basesError}</span>
          <button
            onClick={() => window.location.href = `/erp/api/connectors/airtable/connect?token=${localStorage.getItem('erp_token')}`}
            className="flex-shrink-0 text-sm font-medium text-white bg-red-500 hover:bg-red-600 px-3 py-1.5 rounded-lg"
          >Reconnecter Airtable</button>
        </div>
      )}

      {(() => {
        const pollRunning = AIRTABLE_KEYS.some(k => syncStatus?.[k]?.running)
        const isRunning   = syncingAll || pollRunning
        const anyError    = !isRunning && AIRTABLE_KEYS.some(k => syncStatus?.[k]?.error)
        return (
          <div className="flex items-center justify-end gap-3">
            {isRunning && (
              <span className="text-xs text-amber-600 font-medium animate-pulse">Synchronisation en cours…</span>
            )}
            {anyError && (
              <span className="text-xs text-red-500">⚠ Erreurs — vérifier les onglets</span>
            )}
            <button
              onClick={() => { setSyncingAll(true); api.airtable.syncAll() }}
              disabled={isRunning}
              className="btn-secondary btn-sm py-1"
            >
              <RefreshCw size={12} className={isRunning ? 'animate-spin' : ''} />
              {isRunning ? 'En cours…' : 'Sync tout'}
            </button>
          </div>
        )
      })()}

      <div className="flex gap-0.5 border-b border-slate-200 flex-wrap">
        {TABS.filter(([k]) => !(k === 'abonnements' && stripeConfigured)).map(([k, l]) => {
          const configKey = (k === 'contacts' || k === 'companies') ? 'crm' : k
          const configured = syncConfigs[configKey]?.base_id
          return (
            <button key={k} onClick={() => setTab(k)}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 ${tab === k ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
            >
              {l}
              {configured && <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />}
            </button>
          )
        })}
      </div>

      {tab === 'contacts' && (
        <div className="space-y-3">
          <div>
            <label className="label">Base Airtable</label>
            <select value={crmForm.base_id} onChange={e => setCrmForm(f => ({ ...f, base_id: e.target.value, contacts_table_id: '', companies_table_id: '' }))} className="select">
              <option value="">—</option>
              {loadingBases ? <option disabled>Chargement…</option> : bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          {tables.length > 0 && (
            <div>
              <label className="label">Table contacts</label>
              <select value={crmForm.contacts_table_id} onChange={e => setCrmForm(f => ({ ...f, contacts_table_id: e.target.value, field_map_contacts: {} }))} className="select">
                <option value="">—</option>
                {tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          {crmForm.contacts_table_id && (() => {
            const fieldNames = (tables.find(t => t.id === crmForm.contacts_table_id)?.fields || []).map(f => f.name)
            if (!fieldNames.length) return null
            return (
              <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Mapping des champs</p>
                {[
                  { key: 'first_name', label: 'Prénom *' },
                  { key: 'last_name',  label: 'Nom *' },
                  { key: 'email',      label: 'Courriel' },
                  { key: 'phone',      label: 'Téléphone' },
                  { key: 'mobile',     label: 'Mobile' },
                  { key: 'company',    label: 'Entreprise (lien)' },
                  { key: 'language',   label: 'Langue' },
                ].map(({ key, label }) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 w-40 flex-shrink-0">{label}</span>
                    <FieldSelect
                      value={crmForm.field_map_contacts?.[key] || ''}
                      onChange={v => setCrmForm(f => ({ ...f, field_map_contacts: { ...f.field_map_contacts, [key]: v || undefined } }))}
                      options={fieldNames}
                    />
                  </div>
                ))}
                {customContactFields.map(cf => (
                  <div key={cf.key} className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 w-40 flex-shrink-0 italic">{cf.label}</span>
                    <FieldSelect
                      value={crmForm.field_map_contacts?.[`cf_${cf.key}`] || ''}
                      onChange={v => setCrmForm(f => ({ ...f, field_map_contacts: { ...f.field_map_contacts, [`cf_${cf.key}`]: v || undefined } }))}
                      options={fieldNames}
                    />
                  </div>
                ))}
              </div>
            )
          })()}
          <div className="flex gap-2">
            <button onClick={saveCrm} className="btn-primary btn-sm">Enregistrer</button>
            {airtableSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="airtable" syncStatus={syncStatus} onSync={() => api.airtable.sync('airtable')} />
            )}
          </div>
          {airtableSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {new Date(airtableSync.last_synced_at).toLocaleString('fr-CA')}</p>}
        </div>
      )}

      {tab === 'companies' && (
        <div className="space-y-3">
          <div>
            <label className="label">Base Airtable</label>
            <select value={crmForm.base_id} onChange={e => setCrmForm(f => ({ ...f, base_id: e.target.value, contacts_table_id: '', companies_table_id: '' }))} className="select">
              <option value="">—</option>
              {loadingBases ? <option disabled>Chargement…</option> : bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          {tables.length > 0 && (
            <div>
              <label className="label">Table entreprises</label>
              <select value={crmForm.companies_table_id} onChange={e => setCrmForm(f => ({ ...f, companies_table_id: e.target.value, field_map_companies: {} }))} className="select">
                <option value="">—</option>
                {tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          {crmForm.companies_table_id && (() => {
            const compTable = tables.find(t => t.id === crmForm.companies_table_id)
            const fields = compTable?.fields || []
            const fieldNames = fields.map(f => f.name)
            if (!fieldNames.length) return null
            const ERP_TYPES = ['ASC', 'Serriculteur', 'Pépinière', 'Producteur fleurs', 'Centre jardin', 'Agriculture urbaine', 'Cannabis', 'Particulier', 'Distributeur', 'Partenaire', 'Compétiteur', 'Consultant', 'Autre']
            const ERP_PHASES = ['Contact', 'Qualified', 'Problem aware', 'Solution aware', 'Lead', 'Quote Sent', 'Customer', 'Not a Client Anymore']
            function CompChoiceMapping({ fieldKey, erpOptions, choicesKey }) {
              const selectedFieldName = crmForm.field_map_companies?.[fieldKey]
              if (!selectedFieldName) return null
              const atField = fields.find(f => f.name === selectedFieldName)
              const choices = atField?.options?.choices || []
              if (!choices.length) return null
              const map = crmForm.field_map_companies?.[choicesKey] || {}
              return (
                <div className="ml-40 mt-1 border border-slate-100 rounded p-2 space-y-1 bg-slate-50">
                  <p className="text-xs text-slate-400 mb-1">Correspondance des options :</p>
                  {choices.map(c => (
                    <div key={c.id} className="flex items-center gap-2">
                      <span className="text-xs text-slate-600 w-36 flex-shrink-0 truncate" title={c.name}>{c.name}</span>
                      <span className="text-slate-300 text-xs">→</span>
                      <select
                        value={map[c.name] || ''}
                        onChange={e => setCrmForm(f => ({ ...f, field_map_companies: { ...f.field_map_companies, [choicesKey]: { ...(f.field_map_companies?.[choicesKey] || {}), [c.name]: e.target.value || undefined } } }))}
                        className="select text-xs py-0.5 flex-1"
                      >
                        <option value="">— ignorer —</option>
                        {erpOptions.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              )
            }
            return (
              <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Mapping des champs</p>
                {[
                  { key: 'name',            label: 'Nom *' },
                  { key: 'phone',           label: 'Téléphone' },
                  { key: 'website',         label: 'Site web' },
                  { key: 'type',            label: 'Type' },
                  { key: 'lifecycle_phase', label: 'Phase du cycle de vie' },
                ].map(({ key, label }) => (
                  <div key={key}>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-600 w-40 flex-shrink-0">{label}</span>
                      <FieldSelect
                        value={crmForm.field_map_companies?.[key] || ''}
                        onChange={v => setCrmForm(f => ({ ...f, field_map_companies: { ...f.field_map_companies, [key]: v || undefined } }))}
                        options={fieldNames}
                      />
                    </div>
                    {key === 'type' && <CompChoiceMapping fieldKey="type" erpOptions={ERP_TYPES} choicesKey="type_choices" />}
                    {key === 'lifecycle_phase' && <CompChoiceMapping fieldKey="lifecycle_phase" erpOptions={ERP_PHASES} choicesKey="phase_choices" />}
                  </div>
                ))}
                {customCompanyFields.map(cf => (
                  <div key={cf.key} className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 w-40 flex-shrink-0 italic">{cf.label}</span>
                    <FieldSelect
                      value={crmForm.field_map_companies?.[`cf_${cf.key}`] || ''}
                      onChange={v => setCrmForm(f => ({ ...f, field_map_companies: { ...f.field_map_companies, [`cf_${cf.key}`]: v || undefined } }))}
                      options={fieldNames}
                    />
                  </div>
                ))}
              </div>
            )
          })()}
          <div className="flex gap-2">
            <button onClick={saveCrm} className="btn-primary btn-sm">Enregistrer</button>
            {airtableSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="airtable" syncStatus={syncStatus} onSync={() => api.airtable.sync('airtable')} />
            )}
          </div>
          {airtableSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {new Date(airtableSync.last_synced_at).toLocaleString('fr-CA')}</p>}
        </div>
      )}

      {tab === 'inv' && (
        <div className="space-y-3">
          <div>
            <label className="label">Base Airtable</label>
            <select value={invForm.base_id} onChange={e => setInvForm(f => ({ ...f, base_id: e.target.value, projects_table_id: '', field_map_projects: {}, extra_tables: [] }))} className="select">
              <option value="">—</option>
              {loadingBases ? <option disabled>Chargement…</option> : bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          {invTables.length > 0 && (
            <div>
              <label className="label">Table projets (principale)</label>
              <select value={invForm.projects_table_id} onChange={e => setInvForm(f => ({ ...f, projects_table_id: e.target.value, field_map_projects: {} }))} className="select">
                <option value="">—</option>
                {invTables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          {invForm.projects_table_id && (() => {
            const selectedTable = invTables.find(t => t.id === invForm.projects_table_id)
            const fields = selectedTable?.fields || []
            if (!fields.length) return null
            const fieldNames = fields.map(f => f.name)
            const ERP_STATUS = ['Ouvert', 'Gagné', 'Perdu']
            const ERP_TYPES = ['Nouveau client', 'Expansion', 'Ajouts mineurs', 'Pièces de rechange']
            const ERP_FIELDS = [
              { key: 'name',           label: 'Nom du projet *' },
              { key: 'company',        label: 'Entreprise' },
              { key: 'status',         label: 'Statut (Ouvert/Gagné/Perdu)' },
              { key: 'type',           label: 'Type de projet' },
              { key: 'value_cad',      label: 'Valeur (CAD)' },
              { key: 'probability',    label: 'Probabilité (%)' },
              { key: 'monthly_cad',    label: 'Mensuel récurrent (CAD)' },
              { key: 'nb_greenhouses', label: 'Nb serres' },
              { key: 'close_date',     label: 'Date de clôture' },
              { key: 'notes',          label: 'Notes' },
            ]
            return (
              <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Mapping des champs — Table principale</p>
                {ERP_FIELDS.map(({ key, label }) => (
                  <div key={key}>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-600 w-44 flex-shrink-0">{label}</span>
                      <FieldSelect
                        value={invForm.field_map_projects?.[key] || ''}
                        onChange={v => setInvForm(f => ({ ...f, field_map_projects: { ...f.field_map_projects, [key]: v || undefined } }))}
                        options={fieldNames}
                      />
                    </div>
                    {key === 'status' && (
                      <ChoiceMapping
                        fields={fields}
                        selectedFieldName={invForm.field_map_projects?.status}
                        erpOptions={ERP_STATUS}
                        currentMap={invForm.field_map_projects?.status_choices}
                        onChange={(optName, erpVal) => setInvForm(f => ({ ...f, field_map_projects: { ...f.field_map_projects, status_choices: { ...(f.field_map_projects?.status_choices || {}), [optName]: erpVal || undefined } } }))}
                      />
                    )}
                    {key === 'type' && (
                      <ChoiceMapping
                        fields={fields}
                        selectedFieldName={invForm.field_map_projects?.type}
                        erpOptions={ERP_TYPES}
                        currentMap={invForm.field_map_projects?.type_choices}
                        onChange={(optName, erpVal) => setInvForm(f => ({ ...f, field_map_projects: { ...f.field_map_projects, type_choices: { ...(f.field_map_projects?.type_choices || {}), [optName]: erpVal || undefined } } }))}
                      />
                    )}
                  </div>
                ))}
              </div>
            )
          })()}

          <div className="flex gap-2">
            <button onClick={saveInv} className="btn-primary btn-sm">Enregistrer</button>
            {inventaireSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="inventaire" syncStatus={syncStatus} onSync={() => api.airtable.sync('inventaire')} />
            )}
          </div>
          {inventaireSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {new Date(inventaireSync.last_synced_at).toLocaleString('fr-CA')}</p>}
        </div>
      )}

      {tab === 'pieces' && (
        <div className="space-y-3">
          <div>
            <label className="label">Base Airtable</label>
            <select value={piecesForm.base_id} onChange={e => setPiecesForm(f => ({ ...f, base_id: e.target.value, table_id: '', field_map: {} }))} className="select">
              <option value="">—</option>
              {loadingBases ? <option disabled>Chargement…</option> : bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          {piecesTables.length > 0 && (
            <div>
              <label className="label">Table pièces</label>
              <select value={piecesForm.table_id} onChange={e => setPiecesForm(f => ({ ...f, table_id: e.target.value, field_map: {} }))} className="select">
                <option value="">—</option>
                {piecesTables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          {piecesForm.table_id && (() => {
            const selectedTable = piecesTables.find(t => t.id === piecesForm.table_id)
            const fields = selectedTable?.fields || []
            if (!fields.length) return null
            const fieldNames = fields.map(f => f.name)
            const ERP_FIELDS = [
              { key: 'name_fr',          label: 'Nom (FR) *' },
              { key: 'name_en',          label: 'Nom (EN)' },
              { key: 'sku',              label: 'SKU / Code' },
              { key: 'type',             label: 'Type (Pièce / Produit / Kanban)' },
              { key: 'unit_cost',        label: 'Coût unitaire' },
              { key: 'price_cad',        label: 'Prix (CAD)' },
              { key: 'stock_qty',        label: 'Stock actuel' },
              { key: 'min_stock',        label: 'Stock minimum' },
              { key: 'supplier',         label: 'Fournisseur' },
              { key: 'procurement_type', label: 'Approvisionnement (Acheté/Fabriqué/Drop ship)' },
              { key: 'weight_lbs',       label: 'Poids (lbs)' },
              { key: 'image',            label: 'Image (champ pièce jointe)' },
            ]
            return (
              <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Mapping des champs</p>
                {ERP_FIELDS.map(({ key, label }) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 w-52 flex-shrink-0">{label}</span>
                    <FieldSelect
                      value={piecesForm.field_map?.[key] || ''}
                      onChange={v => setPiecesForm(f => ({ ...f, field_map: { ...f.field_map, [key]: v || undefined } }))}
                      options={fieldNames}
                    />
                  </div>
                ))}
              </div>
            )
          })()}
          <div className="flex gap-2">
            <button onClick={savePieces} className="btn-primary btn-sm">Enregistrer</button>
            {piecesSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="pieces" syncStatus={syncStatus} onSync={() => api.airtable.sync('pieces')} />
            )}
          </div>
          {piecesSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {new Date(piecesSync.last_synced_at).toLocaleString('fr-CA')}</p>}
        </div>
      )}

      {tab === 'orders' && (
        <div className="space-y-3">
          <div>
            <label className="label">Base Airtable</label>
            <select value={ordersForm.base_id} onChange={e => setOrdersForm(f => ({ ...f, base_id: e.target.value, orders_table_id: '', items_table_id: '', field_map_orders: {}, field_map_items: {} }))} className="select">
              <option value="">—</option>
              {loadingBases ? <option disabled>Chargement…</option> : bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          {ordersTables.length > 0 && (<>
            <div>
              <label className="label">Table commandes</label>
              <select value={ordersForm.orders_table_id} onChange={e => setOrdersForm(f => ({ ...f, orders_table_id: e.target.value, field_map_orders: {} }))} className="select">
                <option value="">—</option>
                {ordersTables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Table lignes d'items (optionnel)</label>
              <select value={ordersForm.items_table_id} onChange={e => setOrdersForm(f => ({ ...f, items_table_id: e.target.value, field_map_items: {} }))} className="select">
                <option value="">—</option>
                {itemsTables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          </>)}

          {ordersForm.orders_table_id && (() => {
            const fields = (ordersTables.find(t => t.id === ordersForm.orders_table_id)?.fields || []).map(f => f.name)
            if (!fields.length) return null
            const ERP_FIELDS = [
              { key: 'order_number', label: 'Numéro de commande' },
              { key: 'company',      label: 'Entreprise' },
              { key: 'project',      label: 'Projet' },
              { key: 'status',       label: 'Statut' },
              { key: 'priority',     label: 'Priorité' },
              { key: 'notes',        label: 'Notes' },
            ]
            return (
              <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Mapping — Commandes</p>
                {ERP_FIELDS.map(({ key, label }) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 w-44 flex-shrink-0">{label}</span>
                    <FieldSelect
                      value={ordersForm.field_map_orders?.[key] || ''}
                      onChange={v => setOrdersForm(f => ({ ...f, field_map_orders: { ...f.field_map_orders, [key]: v || undefined } }))}
                      options={fields}
                    />
                  </div>
                ))}
              </div>
            )
          })()}

          {ordersForm.items_table_id && (() => {
            const fields = (itemsTables.find(t => t.id === ordersForm.items_table_id)?.fields || []).map(f => f.name)
            if (!fields.length) return null
            const ERP_FIELDS = [
              { key: 'order',     label: 'Lien vers commande *' },
              { key: 'product',   label: 'Produit / Pièce' },
              { key: 'qty',       label: 'Quantité' },
              { key: 'unit_cost', label: 'Coût unitaire' },
              { key: 'item_type', label: 'Type (Facturable/Remplacement/Non facturable)' },
              { key: 'notes',     label: 'Notes' },
            ]
            return (
              <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Mapping — Lignes d'items</p>
                {ERP_FIELDS.map(({ key, label }) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 w-52 flex-shrink-0">{label}</span>
                    <FieldSelect
                      value={ordersForm.field_map_items?.[key] || ''}
                      onChange={v => setOrdersForm(f => ({ ...f, field_map_items: { ...f.field_map_items, [key]: v || undefined } }))}
                      options={fields}
                    />
                  </div>
                ))}
              </div>
            )
          })()}

          <div className="flex gap-2">
            <button onClick={saveOrders} className="btn-primary btn-sm">Enregistrer</button>
            {ordersSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="orders" syncStatus={syncStatus} onSync={() => api.airtable.sync('orders')} />
            )}
          </div>
          {ordersSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {new Date(ordersSync.last_synced_at).toLocaleString('fr-CA')}</p>}
        </div>
      )}

      {tab === 'achats' && (
        <div className="space-y-3">
          <div>
            <label className="label">Base Airtable</label>
            <select value={achatsForm.base_id} onChange={e => setAchatsForm(f => ({ ...f, base_id: e.target.value, table_id: '', field_map: {} }))} className="select">
              <option value="">—</option>
              {loadingBases ? <option disabled>Chargement…</option> : bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          {achatsTables.length > 0 && (
            <div>
              <label className="label">Table achats</label>
              <select value={achatsForm.table_id} onChange={e => setAchatsForm(f => ({ ...f, table_id: e.target.value, field_map: {} }))} className="select">
                <option value="">—</option>
                {achatsTables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          {achatsForm.table_id && (() => {
            const selectedTable = achatsTables.find(t => t.id === achatsForm.table_id)
            const fields = selectedTable?.fields || []
            if (!fields.length) return null
            const fieldNames = fields.map(f => f.name)
            const ERP_FIELDS = [
              { key: 'product',       label: 'Produit (champ lien vers pièces)' },
              { key: 'supplier',      label: 'Fournisseur' },
              { key: 'reference',     label: 'Référence / PO' },
              { key: 'order_date',    label: 'Date de commande' },
              { key: 'expected_date', label: 'Date prévue' },
              { key: 'received_date', label: 'Date de réception' },
              { key: 'qty_ordered',   label: 'Qté commandée' },
              { key: 'qty_received',  label: 'Qté reçue' },
              { key: 'unit_cost',     label: 'Coût unitaire' },
              { key: 'status',        label: 'Statut' },
              { key: 'notes',         label: 'Notes' },
            ]
            return (
              <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Mapping des champs</p>
                {ERP_FIELDS.map(({ key, label }) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 w-52 flex-shrink-0">{label}</span>
                    <FieldSelect
                      value={achatsForm.field_map?.[key] || ''}
                      onChange={v => setAchatsForm(f => ({ ...f, field_map: { ...f.field_map, [key]: v || undefined } }))}
                      options={fieldNames}
                    />
                  </div>
                ))}
              </div>
            )
          })()}
          <div className="flex gap-2">
            <button onClick={saveAchats} className="btn-primary btn-sm">Enregistrer</button>
            {achatsSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="achats" syncStatus={syncStatus} onSync={() => api.airtable.sync('achats')} />
            )}
          </div>
          {achatsSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {new Date(achatsSync.last_synced_at).toLocaleString('fr-CA')}</p>}
        </div>
      )}

      {tab === 'billets' && (
        <div className="space-y-3">
          <div>
            <label className="label">Base Airtable</label>
            <select value={billetsForm.base_id} onChange={e => setBilletsForm(f => ({ ...f, base_id: e.target.value, table_id: '', field_map: {} }))} className="select">
              <option value="">—</option>
              {loadingBases ? <option disabled>Chargement…</option> : bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          {billetsTables.length > 0 && (
            <div>
              <label className="label">Table billets</label>
              <select value={billetsForm.table_id} onChange={e => setBilletsForm(f => ({ ...f, table_id: e.target.value, field_map: {} }))} className="select">
                <option value="">—</option>
                {billetsTables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          {billetsForm.table_id && (() => {
            const selectedTable = billetsTables.find(t => t.id === billetsForm.table_id)
            const fields = selectedTable?.fields || []
            if (!fields.length) return null
            const fieldNames = fields.map(f => f.name)
            const ERP_FIELDS = [
              { key: 'title',            label: 'Titre / Sujet *' },
              { key: 'description',      label: 'Description' },
              { key: 'type',             label: 'Type' },
              { key: 'status',           label: 'Statut' },
              { key: 'company',          label: 'Entreprise (lien vers entreprises)' },
              { key: 'contact',          label: 'Contact (lien vers contacts)' },
              { key: 'duration_minutes', label: 'Durée (minutes)' },
              { key: 'notes',            label: 'Notes' },
              { key: 'created_at',       label: 'Date de création' },
            ]
            return (
              <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Mapping des champs</p>
                {ERP_FIELDS.map(({ key, label }) => (
                  <div key={key}>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-600 w-52 flex-shrink-0">{label}</span>
                      <FieldSelect
                        value={billetsForm.field_map?.[key] || ''}
                        onChange={v => setBilletsForm(f => ({ ...f, field_map: { ...f.field_map, [key]: v || undefined } }))}
                        options={fieldNames}
                      />
                    </div>
                    {key === 'status' && billetsForm.field_map?.status && (
                      <div>
                        <ChoiceMapping
                          fields={fields}
                          selectedFieldName={billetsForm.field_map.status}
                          erpOptions={['Waiting on us', 'Waiting on them', 'Closed']}
                          currentMap={billetsForm.field_map?.status_map || {}}
                          onChange={(choiceName, erpValue) => setBilletsForm(f => ({
                            ...f,
                            field_map: {
                              ...f.field_map,
                              status_map: { ...(f.field_map?.status_map || {}), [choiceName]: erpValue || undefined }
                            }
                          }))}
                        />
                        <p className="ml-44 mt-1 text-xs text-slate-400">Un statut vide dans Airtable est automatiquement mappé sur <span className="font-medium text-slate-600">Closed</span>.</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          })()}
          <div className="flex gap-2">
            <button onClick={saveBillets} className="btn-primary btn-sm">Enregistrer</button>
            {billetsSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="billets" syncStatus={syncStatus} onSync={() => api.airtable.sync('billets')} />
            )}
          </div>
          {billetsSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {new Date(billetsSync.last_synced_at).toLocaleString('fr-CA')}</p>}
        </div>
      )}

      {tab === 'serials' && (
        <div className="space-y-3">
          <div>
            <label className="label">Base Airtable</label>
            <select value={serialsForm.base_id} onChange={e => setSerialsForm(f => ({ ...f, base_id: e.target.value, table_id: '', field_map: {} }))} className="select">
              <option value="">—</option>
              {loadingBases ? <option disabled>Chargement…</option> : bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          {serialsTables.length > 0 && (
            <div>
              <label className="label">Table numéros de série</label>
              <select value={serialsForm.table_id} onChange={e => setSerialsForm(f => ({ ...f, table_id: e.target.value, field_map: {} }))} className="select">
                <option value="">—</option>
                {serialsTables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          {serialsForm.table_id && (() => {
            const selectedTable = serialsTables.find(t => t.id === serialsForm.table_id)
            const fields = selectedTable?.fields || []
            if (!fields.length) return null
            const fieldNames = fields.map(f => f.name)
            const ERP_FIELDS = [
              { key: 'serial',   label: 'Numéro de série *' },
              { key: 'product',  label: 'Produit (lien vers pièces)' },
              { key: 'company',  label: 'Entreprise (lien vers entreprises)' },
              { key: 'order_item',           label: 'Item de commande (lien vers items)' },
              { key: 'address',              label: 'Adresse' },
              { key: 'manufacture_date',     label: 'Date de fabrication' },
              { key: 'last_programmed_date', label: 'Date de la dernière programmation' },
              { key: 'manufacture_value',    label: 'Valeur au moment de la fabrication' },
              { key: 'status',               label: 'Statut' },
              { key: 'notes',                label: 'Notes' },
            ]
            return (
              <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Mapping des champs</p>
                {ERP_FIELDS.map(({ key, label }) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 w-52 flex-shrink-0">{label}</span>
                    <FieldSelect
                      value={serialsForm.field_map?.[key] || ''}
                      onChange={v => setSerialsForm(f => ({ ...f, field_map: { ...f.field_map, [key]: v || undefined } }))}
                      options={fieldNames}
                    />
                  </div>
                ))}
              </div>
            )
          })()}
          <div className="flex gap-2">
            <button onClick={saveSerials} className="btn-primary btn-sm">Enregistrer</button>
            {serialsSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="serials" syncStatus={syncStatus} onSync={() => api.airtable.sync('serials')} />
            )}
          </div>
          {serialsSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {new Date(serialsSync.last_synced_at).toLocaleString('fr-CA')}</p>}
        </div>
      )}

      {tab === 'envois' && (
        <div className="space-y-3">
          <div>
            <label className="label">Base Airtable</label>
            <select value={envoisForm.base_id} onChange={e => setEnvoisForm(f => ({ ...f, base_id: e.target.value, table_id: '', field_map: {} }))} className="select">
              <option value="">— Choisir une base —</option>
              {bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          {envoisForm.base_id && (
            <div>
              <label className="label">Table des envois</label>
              <select value={envoisForm.table_id} onChange={e => setEnvoisForm(f => ({ ...f, table_id: e.target.value, field_map: {} }))} className="select">
                <option value="">— Choisir une table —</option>
                {envoisTables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          {envoisForm.table_id && (() => {
            const selectedTable = envoisTables.find(t => t.id === envoisForm.table_id)
            const fields = selectedTable?.fields || []
            if (!fields.length) return null
            const fieldNames = fields.map(f => f.name)
            const ERP_FIELDS = [
              { key: 'order',           label: 'Commande (lien vers commandes)' },
              { key: 'tracking_number', label: 'Numéro de suivi' },
              { key: 'carrier',         label: 'Transporteur' },
              { key: 'status',          label: 'Statut' },
              { key: 'shipped_at',      label: "Date d'envoi" },
              { key: 'pays',            label: "Pays de l'envoi" },
              { key: 'notes',           label: 'Notes' },
            ]
            return (
              <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Mapping des champs</p>
                {ERP_FIELDS.map(({ key, label }) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 w-52 flex-shrink-0">{label}</span>
                    <FieldSelect
                      value={envoisForm.field_map?.[key] || ''}
                      onChange={v => setEnvoisForm(f => ({ ...f, field_map: { ...f.field_map, [key]: v || undefined } }))}
                      options={fieldNames}
                    />
                  </div>
                ))}
              </div>
            )
          })()}
          <div className="flex gap-2">
            <button onClick={saveEnvois} className="btn-primary btn-sm">Enregistrer</button>
            {envoisSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="envois" syncStatus={syncStatus} onSync={() => api.airtable.sync('envois')} />
            )}
          </div>
          {envoisSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {new Date(envoisSync.last_synced_at).toLocaleString('fr-CA')}</p>}
        </div>
      )}

      {tab === 'soumissions' && (
        <SimpleModuleTab
          form={soumissionsForm} setForm={setSoumissionsForm}
          tables={soumissionsTables} bases={bases} loadingBases={loadingBases}
          onSave={saveSoumissions} syncKey="soumissions" syncStatus={syncStatus} syncConfig={soumissionsSync}
          tableLabel="Table soumissions"
          fields={[
            { key: 'project',                label: 'Projet (lien)' },
            { key: 'quote_url',              label: 'URL de soumission' },
            { key: 'pdf_url',                label: 'URL du PDF' },
            { key: 'purchase_price_cad',     label: 'Prix d\'achat (CAD)' },
            { key: 'subscription_price_cad', label: 'Prix d\'abonnement (CAD)' },
            { key: 'expiration_date',        label: 'Date d\'expiration' },
          ]}
        />
      )}

      {tab === 'adresses' && (
        <SimpleModuleTab
          form={adressesForm} setForm={setAdressesForm}
          tables={adressesTables} bases={bases} loadingBases={loadingBases}
          onSave={saveAdresses} syncKey="adresses" syncStatus={syncStatus} syncConfig={adressesSync}
          tableLabel="Table adresses"
          fields={[
            { key: 'line1',        label: 'Adresse ligne 1' },
            { key: 'city',         label: 'Ville' },
            { key: 'province',     label: 'Province' },
            { key: 'postal_code',  label: 'Code postal' },
            { key: 'country',      label: 'Pays' },
            { key: 'language',     label: 'Langue' },
            { key: 'address_type', label: 'Type d\'adresse' },
            { key: 'company',      label: 'Entreprise (lien)' },
            { key: 'contact',      label: 'Contact (lien)' },
          ]}
        />
      )}

      {tab === 'bom' && (
        <SimpleModuleTab
          form={bomForm} setForm={setBomForm}
          tables={bomTables} bases={bases} loadingBases={loadingBases}
          onSave={saveBom} syncKey="bom" syncStatus={syncStatus} syncConfig={bomSync}
          tableLabel="Table BOM"
          fields={[
            { key: 'product',      label: 'Produit parent (lien) *' },
            { key: 'component',    label: 'Composant (lien) *' },
            { key: 'qty_required', label: 'Quantité requise' },
            { key: 'ref_des',      label: 'Ref. des.' },
          ]}
        />
      )}

      {tab === 'assemblages' && (
        <SimpleModuleTab
          form={assemblagesForm} setForm={setAssemblagesForm}
          tables={assemblagesTables} bases={bases} loadingBases={loadingBases}
          onSave={saveAssemblages} syncKey="assemblages" syncStatus={syncStatus} syncConfig={assemblagesSync}
          tableLabel="Table assemblages"
          fields={[
            { key: 'product',         label: 'Produit fabriqué (lien) *' },
            { key: 'qty_produced',    label: 'Quantité produite' },
            { key: 'assembled_at',    label: 'Date d\'assemblage' },
            { key: 'assembly_points', label: 'Points d\'assemblage' },
          ]}
        />
      )}

      {tab === 'serial_changes' && (
        <SimpleModuleTab
          form={serialChangesForm} setForm={setSerialChangesForm}
          tables={serialChangesTables} bases={bases} loadingBases={loadingBases}
          onSave={saveSerialChanges} syncKey="serial_changes" syncStatus={syncStatus} syncConfig={serialChangesSync}
          tableLabel="Table changements d'état"
          fields={[
            { key: 'serial',          label: 'N° de série (lien) *' },
            { key: 'previous_status', label: 'Ancien statut' },
            { key: 'new_status',      label: 'Nouveau statut' },
            { key: 'changed_at',      label: 'Date du changement' },
          ]}
        />
      )}

      {tab === 'abonnements' && (
        <SimpleModuleTab
          form={abonnementsForm} setForm={setAbonnementsForm}
          tables={abonnementsTables} bases={bases} loadingBases={loadingBases}
          onSave={saveAbonnements} syncKey="abonnements" syncStatus={syncStatus} syncConfig={abonnementsSync}
          tableLabel="Table abonnements"
          fields={[
            { key: 'company',              label: 'Entreprise (lien)' },
            { key: 'product',              label: 'Produit (lien)' },
            { key: 'status',               label: 'Statut' },
            { key: 'type',                 label: 'Type' },
            { key: 'start_date',           label: 'Date de début' },
            { key: 'end_date',             label: 'Date de fin' },
            { key: 'interval_count',       label: 'Intervalle' },
            { key: 'interval_type',        label: 'Type d\'intervalle' },
            { key: 'customer_id',          label: 'ID client (Stripe)' },
            { key: 'customer_email',       label: 'Courriel client' },
            { key: 'trial_end_date',       label: 'Fin de période d\'essai' },
            { key: 'stripe_url',           label: 'URL Stripe' },
            { key: 'amount_cad',           label: 'Montant (CAD)' },
            { key: 'amount_after_discount', label: 'Montant après rabais' },
          ]}
        />
      )}

      {tab === 'factures' && (
        <SimpleModuleTab
          form={facturesForm} setForm={setFacturesForm}
          tables={facturesTables} bases={bases} loadingBases={loadingBases}
          onSave={saveFactures} syncKey="factures" syncStatus={syncStatus} syncConfig={facturesSync}
          tableLabel="Table factures"
          fields={[
            { key: 'invoice_id',          label: 'ID de facture externe' },
            { key: 'company',             label: 'Entreprise (lien)' },
            { key: 'project',             label: 'Projet (lien)' },
            { key: 'order',               label: 'Commande (lien)' },
            { key: 'document_number',     label: 'Numéro de document' },
            { key: 'document_date',       label: 'Date du document' },
            { key: 'due_date',            label: 'Date d\'échéance' },
            { key: 'status',              label: 'Statut' },
            { key: 'currency',            label: 'Devise' },
            { key: 'amount_before_tax',   label: 'Montant avant taxes (CAD)' },
            { key: 'total_amount',        label: 'Montant total' },
            { key: 'balance_due',         label: 'Solde dû' },
            { key: 'notes',               label: 'Notes' },
          ]}
        />
      )}

      {tab === 'retours' && (
        <SimpleModuleTab
          form={retoursForm} setForm={setRetoursForm}
          tables={retoursTables} bases={bases} loadingBases={loadingBases}
          onSave={saveRetours} syncKey="retours" syncStatus={syncStatus} syncConfig={retoursSync}
          tableLabel="Table retours"
          fields={[
            { key: 'company',           label: 'Entreprise (lien)' },
            { key: 'contact',           label: 'Contact (lien)' },
            { key: 'return_number',     label: 'Numéro de retour' },
            { key: 'tracking_number',   label: 'Numéro de suivi' },
            { key: 'processing_status', label: 'Statut de traitement' },
          ]}
        />
      )}

      {tab === 'retour_items' && (
        <SimpleModuleTab
          form={retourItemsForm} setForm={setRetourItemsForm}
          tables={retourItemsTables} bases={bases} loadingBases={loadingBases}
          onSave={saveRetourItems} syncKey="retour_items" syncStatus={syncStatus} syncConfig={retourItemsSync}
          tableLabel="Table items de retour"
          fields={[
            { key: 'return',               label: 'Retour (lien) *' },
            { key: 'serial',               label: 'N° de série (lien)' },
            { key: 'company',              label: 'Entreprise (lien)' },
            { key: 'return_reason',        label: 'Raison du retour' },
            { key: 'return_reason_notes',  label: 'Notes sur la raison' },
            { key: 'action',               label: 'Action (Réparer / Remplacer…)' },
            { key: 'received_at',          label: 'Date de réception' },
            { key: 'product_to_receive',   label: 'Produit à recevoir (lien)' },
            { key: 'product_to_send',      label: 'Produit à envoyer (lien)' },
          ]}
        />
      )}
    </div>
  )
}

function SimpleModuleTab({ form, setForm, tables, bases, loadingBases, onSave, syncKey, syncStatus, syncConfig, tableLabel, fields }) {
  return (
    <div className="space-y-3">
      <div>
        <label className="label">Base Airtable</label>
        <select value={form.base_id} onChange={e => setForm(f => ({ ...f, base_id: e.target.value, table_id: '', field_map: {} }))} className="select">
          <option value="">—</option>
          {loadingBases ? <option disabled>Chargement…</option> : bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>
      {tables.length > 0 && (
        <div>
          <label className="label">{tableLabel}</label>
          <select value={form.table_id} onChange={e => setForm(f => ({ ...f, table_id: e.target.value, field_map: {} }))} className="select">
            <option value="">—</option>
            {tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      )}
      {form.table_id && (() => {
        const fieldNames = (tables.find(t => t.id === form.table_id)?.fields || []).map(f => f.name)
        if (!fieldNames.length) return null
        return (
          <div className="border border-slate-200 rounded-lg p-3 space-y-2">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Mapping des champs</p>
            {fields.map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs text-slate-600 w-52 flex-shrink-0">{label}</span>
                <FieldSelect
                  value={form.field_map?.[key] || ''}
                  onChange={v => setForm(f => ({ ...f, field_map: { ...f.field_map, [key]: v || undefined } }))}
                  options={fieldNames}
                />
              </div>
            ))}
          </div>
        )
      })()}
      <div className="flex gap-2">
        <button onClick={onSave} className="btn-primary btn-sm">Enregistrer</button>
        {syncConfig?.base_id && (
          <SyncBtn label="Synchroniser" syncKey={syncKey} syncStatus={syncStatus} onSync={() => api.airtable.sync(syncKey)} />
        )}
      </div>
      {syncConfig?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {new Date(syncConfig.last_synced_at).toLocaleString('fr-CA')}</p>}
    </div>
  )
}
