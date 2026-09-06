import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw, SlidersHorizontal } from 'lucide-react'
import api from '../lib/api.js'
import { fmtDateTime } from '../lib/formatDate.js'
import { Modal } from '../components/Modal.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'

// Pickers recherchables pour bases/tables Airtable. Un workspace expose couramment
// 50+ bases et 30+ tables — au-delà du seuil de 10 options de la règle « dropdowns
// recherchables » (CLAUDE.md). Bases et tables ont la même forme `{ id, name }`.
function BaseSelect({ value, onChange, bases, loadingBases, testId }) {
  return (
    <SearchableSelect
      testId={testId}
      className="input"
      size="sm"
      value={value}
      options={bases}
      getOptionValue={o => o.id}
      getOptionLabel={o => o.name}
      onChange={onChange}
      emptyOption="—"
      placeholder={loadingBases ? 'Chargement…' : '—'}
      searchPlaceholder="Rechercher une base…"
    />
  )
}

function TableSelect({ value, onChange, tables, testId }) {
  return (
    <SearchableSelect
      testId={testId}
      className="input"
      size="sm"
      value={value}
      options={tables}
      getOptionValue={o => o.id}
      getOptionLabel={o => o.name}
      onChange={onChange}
      emptyOption="—"
      searchPlaceholder="Rechercher une table…"
    />
  )
}

// Modules resynchronisés par « Sync tout » (POST /connectors/sync/airtable-all).
// Aligné sur ALL_AIRTABLE_MODULES côté serveur (server/src/routes/connectors.js).
// Sert au récap de la modale de confirmation avant un import massif.
const SYNC_ALL_MODULES = [
  'Contacts & entreprises', 'Projets', 'Pièces', 'Commandes', 'Achats',
  'Billets', 'N° de série', 'Envois', 'Soumissions', 'Retours',
  'Items de retour', 'Adresses', 'BOM', 'États de série', 'Assemblages',
  'Employés', 'Paies', 'Lignes de paie', 'Mouvements de stock',
]

// Modules dont les champs Airtable sont contrôlables via la page ModuleFields
// (/airtable/fields/:module). Aligné sur AIRTABLE_FIELD_MODULES côté serveur.
// Les clés d'onglet correspondent aux clés de module sauf exceptions ci-dessous.
const FIELD_MODULE_TABS = new Set([
  'contacts', 'companies', 'adresses', 'soumissions', 'pieces', 'serials',
  'assemblages', 'orders', 'achats', 'envois', 'billets', 'retours', 'retour_items',
  'serial_changes',
])

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
  const [confirmSyncAll, setConfirmSyncAll] = useState(false)

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
      {/* Reconnexion volontaire (ex. après un changement des droits demandés à
          Airtable) : relancer l'autorisation écrase le jeton existant, aucune
          déconnexion préalable n'est nécessaire. */}
      <div className="flex justify-end">
        <button
          onClick={() => window.location.href = `/erp/api/connectors/airtable/connect?token=${localStorage.getItem('erp_token')}`}
          className="btn-secondary btn-sm py-1"
          title="Relance l'autorisation Airtable (utile après un changement des droits demandés)"
        >Reconnecter Airtable</button>
      </div>

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
            {FIELD_MODULE_TABS.has(tab) && (
              <Link to={`/airtable/fields/${tab}`} className="btn-secondary btn-sm py-1" title="Choisir quels champs Airtable sont importés, renommer, geler ou supprimer des colonnes">
                <SlidersHorizontal size={12} /> Gérer les champs
              </Link>
            )}
            <button
              onClick={() => setConfirmSyncAll(true)}
              disabled={isRunning}
              className="btn-secondary btn-sm py-1"
            >
              <RefreshCw size={12} className={isRunning ? 'animate-spin' : ''} />
              {isRunning ? 'En cours…' : 'Sync tout'}
            </button>
          </div>
        )
      })()}

      <Modal isOpen={confirmSyncAll} onClose={() => setConfirmSyncAll(false)} title="Resynchroniser tous les modules ?" size="md">
        <p className="text-sm text-slate-600 mb-3">
          Une resynchronisation complète depuis Airtable va être lancée. C'est une opération
          lourde et longue qui réimporte les enregistrements de <strong>{SYNC_ALL_MODULES.length} modules</strong> :
        </p>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-slate-700 mb-4 list-disc list-inside">
          {SYNC_ALL_MODULES.map(m => <li key={m}>{m}</li>)}
        </ul>
        <p className="text-xs text-slate-400 mb-6">
          Les modules s'exécutent en arrière-plan ; vous pouvez suivre leur progression dans chaque onglet.
        </p>
        <div className="flex justify-end gap-3">
          <button onClick={() => setConfirmSyncAll(false)} className="btn-secondary">Annuler</button>
          <button
            onClick={() => { setConfirmSyncAll(false); setSyncingAll(true); api.airtable.syncAll() }}
            className="btn-primary"
          >
            <RefreshCw size={14} /> Resynchroniser tout
          </button>
        </div>
      </Modal>

      <div className="flex gap-0.5 border-b border-slate-200 flex-wrap">
        {TABS.filter(([k]) => !(k === 'abonnements' && stripeConfigured)).map(([k, l]) => {
          const configured = syncConfigs[k]?.base_id
          return (
            <button key={k} onClick={() => setTab(k)}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 ${tab === k ? 'border-brand-600 text-brand-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
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
            <BaseSelect testId="contacts-base-select" value={contactsForm.base_id} bases={bases} loadingBases={loadingBases} onChange={v => setContactsForm(f => ({ ...f, base_id: v, contacts_table_id: '', field_map_contacts: {} }))} />
          </div>
          {tables.length > 0 && (
            <div>
              <label className="label">Table contacts</label>
              <TableSelect testId="contacts-table-select" value={contactsForm.contacts_table_id} tables={tables} onChange={v => setContactsForm(f => ({ ...f, contacts_table_id: v, field_map_contacts: {} }))} />
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={saveContacts} className="btn-primary btn-sm">Enregistrer</button>
            {contactsSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="airtable" syncStatus={syncStatus} onSync={() => api.airtable.sync('airtable')} />
            )}
          </div>
          {contactsSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {fmtDateTime(contactsSync.last_synced_at)}</p>}
        </div>
      )}

      {tab === 'companies' && (
        <div className="space-y-3">
          <div>
            <label className="label">Base Airtable</label>
            <BaseSelect testId="companies-base-select" value={companiesForm.base_id} bases={bases} loadingBases={loadingBases} onChange={v => setCompaniesForm(f => ({ ...f, base_id: v, companies_table_id: '', field_map_companies: {} }))} />
          </div>
          {companiesTables.length > 0 && (
            <div>
              <label className="label">Table entreprises</label>
              <TableSelect testId="companies-table-select" value={companiesForm.companies_table_id} tables={companiesTables} onChange={v => setCompaniesForm(f => ({ ...f, companies_table_id: v, field_map_companies: {} }))} />
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={saveCompanies} className="btn-primary btn-sm">Enregistrer</button>
            {companiesSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="airtable" syncStatus={syncStatus} onSync={() => api.airtable.sync('airtable')} />
            )}
          </div>
          {companiesSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {fmtDateTime(companiesSync.last_synced_at)}</p>}
        </div>
      )}

      {tab === 'pieces' && (
        <div className="space-y-3">
          <div>
            <label className="label">Base Airtable</label>
            <BaseSelect testId="pieces-base-select" value={piecesForm.base_id} bases={bases} loadingBases={loadingBases} onChange={v => setPiecesForm(f => ({ ...f, base_id: v, table_id: '', field_map: {} }))} />
          </div>
          {piecesTables.length > 0 && (
            <div>
              <label className="label">Table pièces</label>
              <TableSelect testId="pieces-table-select" value={piecesForm.table_id} tables={piecesTables} onChange={v => setPiecesForm(f => ({ ...f, table_id: v, field_map: {} }))} />
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={savePieces} className="btn-primary btn-sm">Enregistrer</button>
            {piecesSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="pieces" syncStatus={syncStatus} onSync={() => api.airtable.sync('pieces')} />
            )}
          </div>
          {piecesSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {fmtDateTime(piecesSync.last_synced_at)}</p>}
        </div>
      )}

      {tab === 'orders' && (
        <div className="space-y-3">
          <div>
            <label className="label">Base Airtable</label>
            <BaseSelect testId="orders-base-select" value={ordersForm.base_id} bases={bases} loadingBases={loadingBases} onChange={v => setOrdersForm(f => ({ ...f, base_id: v, orders_table_id: '', items_table_id: '', field_map_items: {} }))} />
          </div>
          {ordersTables.length > 0 && (<>
            <div>
              <label className="label">Table commandes</label>
              <TableSelect testId="orders-table-select" value={ordersForm.orders_table_id} tables={ordersTables} onChange={v => setOrdersForm(f => ({ ...f, orders_table_id: v }))} />
            </div>
            <div>
              <label className="label">Table lignes d'items (optionnel)</label>
              <TableSelect testId="orders-items-table-select" value={ordersForm.items_table_id} tables={itemsTables} onChange={v => setOrdersForm(f => ({ ...f, items_table_id: v, field_map_items: {} }))} />
            </div>
          </>)}
          <div className="flex gap-2">
            <button onClick={saveOrders} className="btn-primary btn-sm">Enregistrer</button>
            {ordersSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="orders" syncStatus={syncStatus} onSync={() => api.airtable.sync('orders')} />
            )}
          </div>
          {ordersSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {fmtDateTime(ordersSync.last_synced_at)}</p>}
        </div>
      )}

      {tab === 'achats' && (
        <div className="space-y-3">
          <div>
            <label className="label">Base Airtable</label>
            <BaseSelect testId="achats-base-select" value={achatsForm.base_id} bases={bases} loadingBases={loadingBases} onChange={v => setAchatsForm(f => ({ ...f, base_id: v, table_id: '', field_map: {} }))} />
          </div>
          {achatsTables.length > 0 && (
            <div>
              <label className="label">Table achats</label>
              <TableSelect testId="achats-table-select" value={achatsForm.table_id} tables={achatsTables} onChange={v => setAchatsForm(f => ({ ...f, table_id: v, field_map: {} }))} />
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={saveAchats} className="btn-primary btn-sm">Enregistrer</button>
            {achatsSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="achats" syncStatus={syncStatus} onSync={() => api.airtable.sync('achats')} />
            )}
          </div>
          {achatsSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {fmtDateTime(achatsSync.last_synced_at)}</p>}
        </div>
      )}

      {tab === 'billets' && (
        <div className="space-y-3">
          <div>
            <label className="label">Base Airtable</label>
            <BaseSelect testId="billets-base-select" value={billetsForm.base_id} bases={bases} loadingBases={loadingBases} onChange={v => setBilletsForm(f => ({ ...f, base_id: v, table_id: '', field_map: {} }))} />
          </div>
          {billetsTables.length > 0 && (
            <div>
              <label className="label">Table billets</label>
              <TableSelect testId="billets-table-select" value={billetsForm.table_id} tables={billetsTables} onChange={v => setBilletsForm(f => ({ ...f, table_id: v, field_map: {} }))} />
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={saveBillets} className="btn-primary btn-sm">Enregistrer</button>
            {billetsSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="billets" syncStatus={syncStatus} onSync={() => api.airtable.sync('billets')} />
            )}
          </div>
          {billetsSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {fmtDateTime(billetsSync.last_synced_at)}</p>}
        </div>
      )}

      {tab === 'serials' && (
        <div className="space-y-3">
          <div>
            <label className="label">Base Airtable</label>
            <BaseSelect testId="serials-base-select" value={serialsForm.base_id} bases={bases} loadingBases={loadingBases} onChange={v => setSerialsForm(f => ({ ...f, base_id: v, table_id: '', field_map: {} }))} />
          </div>
          {serialsTables.length > 0 && (
            <div>
              <label className="label">Table numéros de série</label>
              <TableSelect testId="serials-table-select" value={serialsForm.table_id} tables={serialsTables} onChange={v => setSerialsForm(f => ({ ...f, table_id: v, field_map: {} }))} />
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={saveSerials} className="btn-primary btn-sm">Enregistrer</button>
            {serialsSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="serials" syncStatus={syncStatus} onSync={() => api.airtable.sync('serials')} />
            )}
          </div>
          {serialsSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {fmtDateTime(serialsSync.last_synced_at)}</p>}
        </div>
      )}

      {tab === 'envois' && (
        <div className="space-y-3">
          <div>
            <label className="label">Base Airtable</label>
            <BaseSelect testId="envois-base-select" value={envoisForm.base_id} bases={bases} loadingBases={loadingBases} onChange={v => setEnvoisForm(f => ({ ...f, base_id: v, table_id: '', field_map: {} }))} />
          </div>
          {envoisForm.base_id && (
            <div>
              <label className="label">Table des envois</label>
              <TableSelect testId="envois-table-select" value={envoisForm.table_id} tables={envoisTables} onChange={v => setEnvoisForm(f => ({ ...f, table_id: v, field_map: {} }))} />
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={saveEnvois} className="btn-primary btn-sm">Enregistrer</button>
            {envoisSync?.base_id && (
              <SyncBtn label="Synchroniser" syncKey="envois" syncStatus={syncStatus} onSync={() => api.airtable.sync('envois')} />
            )}
          </div>
          {envoisSync?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {fmtDateTime(envoisSync.last_synced_at)}</p>}
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
        <BaseSelect testId={`${syncKey}-base-select`} value={form.base_id} bases={bases} loadingBases={loadingBases} onChange={v => setForm(f => ({ ...f, base_id: v, table_id: '', field_map: {} }))} />
      </div>
      {tables.length > 0 && (
        <div>
          <label className="label">{tableLabel}</label>
          <TableSelect testId={`${syncKey}-table-select`} value={form.table_id} tables={tables} onChange={v => setForm(f => ({ ...f, table_id: v, field_map: {} }))} />
        </div>
      )}
      <div className="flex gap-2">
        <button onClick={onSave} className="btn-primary btn-sm">Enregistrer</button>
        {syncConfig?.base_id && (
          <SyncBtn label="Synchroniser" syncKey={syncKey} syncStatus={syncStatus} onSync={() => api.airtable.sync(syncKey)} />
        )}
      </div>
      {syncConfig?.last_synced_at && <p className="text-xs text-slate-400">Dernier sync: {fmtDateTime(syncConfig.last_synced_at)}</p>}
    </div>
  )
}
