import { useState, useEffect, useMemo } from 'react'
import api from '../lib/api.js'
import { useTable } from '../lib/dataStore.js'
import { Modal } from './Modal.jsx'
import { RecordForm } from './RecordForm.jsx'
import LinkedRecordField from './LinkedRecordField.jsx'
import { fmtAddress } from '../utils/formatters.js'

// Formulaire STANDARD « Nouvelle commande » — un seul jeu de champs pour toute
// l'app (page Commandes, fiche projet…). Le sortir de la page Commandes évite
// deux formulaires de création qui divergent, et fait profiter chaque point
// d'entrée de la configuration partagée (« Modifier le formulaire »).
//
// Champs NATIFS proposés. Les autres champs saisissables de la table (champs
// perso, colonnes adoptées d'Airtable) s'y ajoutent tout seuls via le catalogue
// du registre — `includeAllFields` sur le RecordForm, cf.
// server/src/services/formFieldCatalog.js. Voir RecordForm.jsx pour la
// sémantique de `visible` / `required` (configurables par l'utilisateur).
export function orderFormFields({ companies, users, projects, adresses }) {
  return [
    {
      field: 'company_id', label: 'Entreprise',
      input: ({ value, onChange }) => (
        <LinkedRecordField
          name="order_company_id"
          value={value}
          options={companies}
          labelFn={c => c.name}
          onChange={onChange}
        />
      ),
    },
    {
      field: 'assigned_to', label: 'Assigné à',
      input: ({ value, onChange }) => (
        <LinkedRecordField
          name="order_assigned_to"
          value={value}
          options={users}
          labelFn={u => u.name}
          onChange={onChange}
        />
      ),
    },
    // Priorité : champ perso, proposé par le catalogue du registre (ses choix
    // viennent de sa config) — plus besoin de le déclarer ici.
    { field: 'date_commande', label: 'Date de commande', type: 'date' },
    { field: 'notes', label: 'Notes', type: 'textarea' },
    // Masqués par défaut — disponibles via « Modifier le formulaire ».
    {
      field: 'project_id', label: 'Projet', visible: false,
      input: ({ value, onChange }) => (
        <LinkedRecordField
          name="order_project_id"
          value={value}
          options={projects}
          labelFn={p => p.name}
          onChange={onChange}
        />
      ),
    },
    // Statut : champ FORMULE côté Airtable (Airtable le calcule, Boréal le
    // recopie), donc en import seul depuis /champs/orders. `readOnly` empêche
    // de le poser dans le formulaire — la route refuserait le POST en 400, et
    // la valeur serait de toute façon écrasée au sync suivant. Le serveur pose
    // le défaut « Commande vide ».
    { field: 'status', label: 'Statut', type: 'select', visible: false, readOnly: true },
    {
      field: 'address_id', label: 'Adresse de livraison', visible: false,
      input: ({ value, onChange }) => (
        <LinkedRecordField
          name="order_address_id"
          value={value}
          options={adresses}
          labelFn={fmtAddress}
          onChange={onChange}
          getHref={a => `/adresses/${a.id}`}
        />
      ),
    },
    { field: 'is_subscription', label: 'Abonnement', type: 'checkbox', visible: false },
    { field: 'revenue_override_cad', label: 'Revenu forcé (CAD)', type: 'currency', visible: false },
    { field: 'cogs_override_cad', label: 'Coût des marchandises forcé (CAD)', type: 'currency', visible: false },
  ]
}

// Champs du formulaire, options des pickers incluses. `active` = le formulaire
// est à l'écran : les adresses sont hors cache global et ne servent qu'au champ
// « Adresse de livraison » (masqué par défaut) — chargées à l'ouverture, une
// fois.
export function useOrderFormFields(active) {
  const companies = useTable('companies')
  const users = useTable('users')
  const projects = useTable('projects')

  const [adresses, setAdresses] = useState([])
  useEffect(() => {
    if (!active || adresses.length) return
    let alive = true
    api.adresses.lookup().then(d => { if (alive) setAdresses(Array.isArray(d) ? d : []) }).catch(() => {})
    return () => { alive = false }
  }, [active, adresses.length])

  return useMemo(
    () => orderFormFields({ companies, users, projects, adresses }),
    [companies, users, projects, adresses],
  )
}

// Modale de création réutilisable : le même formulaire que la page Commandes,
// ouvrable depuis n'importe quelle fiche. `initial` préremplit (ex. project_id
// et company_id depuis une fiche projet) — un champ masqué mais prérempli part
// quand même dans le POST (cf. RecordForm.handleSubmit).
export function OrderCreateModal({ isOpen, onClose, onCreated, initial, title = 'Nouvelle commande' }) {
  const fields = useOrderFormFields(isOpen)

  async function handleSubmit(form) {
    const order = await api.orders.create(form)
    await onCreated?.(order)
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title}>
      <RecordForm
        table="orders"
        fields={fields}
        includeAllFields
        initial={initial}
        onSubmit={handleSubmit}
        onClose={onClose}
        submitLabel="Créer la commande"
        savingLabel="Création..."
      />
    </Modal>
  )
}
