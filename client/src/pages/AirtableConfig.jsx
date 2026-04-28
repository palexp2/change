import { useState, useEffect } from 'react'
import { RefreshCw } from 'lucide-react'
import api from '../lib/api.js'

function SyncBtn({ label, syncKey, syncStatus, onSync }) {
  const [localRunning, setLocalRunning] = useState(false)
  const serverRunning = syncStatus?.[syncKey]?.running
  const serverError = syncStatus?.[syncKey]?.error
  const isRunning = localRunning || serverRunning

  // Réinitialise localRunning dès que le poll confirme la fin
  useEffect(() => {
    if (localRunning && !serverRunning) setLocalRunning(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  ['billets',       'Billets'],
  ['retours',       'Retours'],
  ['retour_items',  'Items de retour'],
]

export default function AirtableConfig({ syncConfigs = {}, syncStatus, onRefresh, stripeConfigured = false }) {
  const {
    contacts: contactsSync,
    companies: companiesSync,
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
    retours: retoursSync,
    retour_items: retourItemsSync,
    abonnements: abonnementsSync,
  } = syncConfigs

  const [tab, setTab] = useState('contacts')
  const [syncingAll, setSyncingAll] = useState(false)

  const AIRTABLE_KEYS = ['airtable','projets','pieces','orders','achats','billets','serials','envois','soumissions','retours','retour_items','adresses','bom','serial_changes','abonnements','assemblages']

  // Réinitialise syncingAll quand le poll confirme que tous les modules sont arrêtés
  useEffect(() => {
    if (!syncingAll) return
    const anyStillRunning = AIRTABLE_KEYS.some(k => syncStatus?.[k]?.running)
    if (!anyStillRunning) setSyncingAll(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncStatus])
  const [bases, setBases] = useState([])
  const [basesError, setBasesError] = useState('')
  const [tables, setTables] = useState([])
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
  const [retoursTables, setRetoursTables] = useState([])
  const [retourItemsTables, setRetourItemsTables] = useState([])
  const [abonnementsTables, setAbonnementsTables] = useState([])
  const [loadingBases, setLoadingBases] = useState(false)

  // Contacts sync form
  const [contactsForm, setContactsForm] = useState({
    base_id: contactsSync?.base_id || '',
    contacts_table_id: contactsSync?.contacts_table_id || '',
    field_map_contacts: contactsSync?.field_map_contacts
      ? (typeof contactsSync.field_map_contacts === 'string' ? JSON.parse(contactsSync.field_map_contacts) : contactsSync.field_map_contacts)
      : {},
  })

  // Companies sync form
  const [companiesForm, setCompaniesForm] = useState({
    base_id: companiesSync?.base_id || '',
    companies_table_id: companiesSync?.companies_table_id || '',
    field_map_companies: companiesSync?.field_map_companies
      ? (typeof companiesSync.field_map_companies === 'string' ? JSON.parse(companiesSync.field_map_companies) : companiesSync.field_map_companies)
      : {},
  })

  const [companiesTables, setCompaniesTables] = useState([])

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

  async function saveContacts() {
    await api.airtable.saveConfig('contacts', contactsForm)
    onRefresh()
  }

  async function saveCompanies() {
    await api.airtable.saveConfig('companies', companiesForm)
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
  async function saveRetours() { await api.airtable.saveModuleConfig('retours', retoursForm); onRefresh() }
  async function saveRetourItems() { await api.airtable.saveModuleConfig('retour_items', retourItemsForm); onRefresh() }
  async function saveAbonnements() { await api.airtable.saveModuleConfig('abonnements', abonnementsForm); onRefresh() }

  useEffect(() => { loadBases() }, [])
  useEffect(() => { if (contactsForm.base_id) loadTables(contactsForm.base_id, setTables) }, [contactsForm.base_id])
  useEffect(() => { if (companiesForm.base_id) loadTables(companiesForm.base_id, setCompaniesTables) }, [companiesForm.base_id])
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
          const configured = syncConfigs[k]?.base_id
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
            <select value={contactsForm.base_id} onChange={e => setContactsForm(f => ({ ...f, base_id: e.target.value, contacts_table_id: '', field_map_contacts: {} }))} className="select">
              <option value="">—</option>
              {loadingBases ? <option disabled>Chargement…</option> : bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          {tables.length > 0 && (
            <div>
              <label className="label">Table contacts</label>
              <select value={contactsForm.contacts_table_id} onChange={e => setContactsForm(f => ({ ...f, contacts_table_id: e.target.value, field_map_contacts: {} }))} className="select">
                <option value="">—</option>
                {tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={saveContacts} className="btn-primary btn-sm">Enregistrer</button>
            {contactsSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="airtable" syncStatus={syncStatus} onSync={() => api.airtable.sync('airtable')} />
            )}
          </div>
          {contactsSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {new Date(contactsSync.last_synced_at).toLocaleString('fr-CA')}</p>}
        </div>
      )}

      {tab === 'companies' && (
        <div className="space-y-3">
          <div>
            <label className="label">Base Airtable</label>
            <select value={companiesForm.base_id} onChange={e => setCompaniesForm(f => ({ ...f, base_id: e.target.value, companies_table_id: '', field_map_companies: {} }))} className="select">
              <option value="">—</option>
              {loadingBases ? <option disabled>Chargement…</option> : bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          {companiesTables.length > 0 && (
            <div>
              <label className="label">Table entreprises</label>
              <select value={companiesForm.companies_table_id} onChange={e => setCompaniesForm(f => ({ ...f, companies_table_id: e.target.value, field_map_companies: {} }))} className="select">
                <option value="">—</option>
                {companiesTables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={saveCompanies} className="btn-primary btn-sm">Enregistrer</button>
            {companiesSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="airtable" syncStatus={syncStatus} onSync={() => api.airtable.sync('airtable')} />
            )}
          </div>
          {companiesSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {new Date(companiesSync.last_synced_at).toLocaleString('fr-CA')}</p>}
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
        />
      )}

      {tab === 'adresses' && (
        <SimpleModuleTab
          form={adressesForm} setForm={setAdressesForm}
          tables={adressesTables} bases={bases} loadingBases={loadingBases}
          onSave={saveAdresses} syncKey="adresses" syncStatus={syncStatus} syncConfig={adressesSync}
          tableLabel="Table adresses"
        />
      )}

      {tab === 'bom' && (
        <SimpleModuleTab
          form={bomForm} setForm={setBomForm}
          tables={bomTables} bases={bases} loadingBases={loadingBases}
          onSave={saveBom} syncKey="bom" syncStatus={syncStatus} syncConfig={bomSync}
          tableLabel="Table BOM"
        />
      )}

      {tab === 'assemblages' && (
        <SimpleModuleTab
          form={assemblagesForm} setForm={setAssemblagesForm}
          tables={assemblagesTables} bases={bases} loadingBases={loadingBases}
          onSave={saveAssemblages} syncKey="assemblages" syncStatus={syncStatus} syncConfig={assemblagesSync}
          tableLabel="Table assemblages"
        />
      )}

      {tab === 'serial_changes' && (
        <SimpleModuleTab
          form={serialChangesForm} setForm={setSerialChangesForm}
          tables={serialChangesTables} bases={bases} loadingBases={loadingBases}
          onSave={saveSerialChanges} syncKey="serial_changes" syncStatus={syncStatus} syncConfig={serialChangesSync}
          tableLabel="Table changements d'état"
        />
      )}

      {tab === 'abonnements' && (
        <SimpleModuleTab
          form={abonnementsForm} setForm={setAbonnementsForm}
          tables={abonnementsTables} bases={bases} loadingBases={loadingBases}
          onSave={saveAbonnements} syncKey="abonnements" syncStatus={syncStatus} syncConfig={abonnementsSync}
          tableLabel="Table abonnements"
        />
      )}

      {tab === 'retours' && (
        <SimpleModuleTab
          form={retoursForm} setForm={setRetoursForm}
          tables={retoursTables} bases={bases} loadingBases={loadingBases}
          onSave={saveRetours} syncKey="retours" syncStatus={syncStatus} syncConfig={retoursSync}
          tableLabel="Table retours"
        />
      )}

      {tab === 'retour_items' && (
        <SimpleModuleTab
          form={retourItemsForm} setForm={setRetourItemsForm}
          tables={retourItemsTables} bases={bases} loadingBases={loadingBases}
          onSave={saveRetourItems} syncKey="retour_items" syncStatus={syncStatus} syncConfig={retourItemsSync}
          tableLabel="Table items de retour"
        />
      )}
    </div>
  )
}

function SimpleModuleTab({ form, setForm, tables, bases, loadingBases, onSave, syncKey, syncStatus, syncConfig, tableLabel }) {
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
