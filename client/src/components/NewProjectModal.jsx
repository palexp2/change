import { useState, useEffect } from 'react'
import api from '../lib/api.js'
import { Modal } from './Modal.jsx'
import { RecordForm } from './RecordForm.jsx'
import LinkedRecordField from './LinkedRecordField.jsx'
import { VendeurPicker } from '../pages/ProjectDetail.jsx'
import { useAuth } from '../lib/auth.jsx'
import Spinner from './Spinner.jsx'

// Champs proposés par le formulaire « Nouveau projet » — liste calquée sur ce
// que POST /api/projects persiste (voir RecordForm.jsx pour la configuration).
// « Raison du refus » n'y figure pas : la route de création ne l'accepte pas, un
// champ qui ne sauvegarde pas n'a rien à faire dans un formulaire d'ajout.
function projectFormFields(companies, vendeurOptions, defaultVendeur) {
  return [
    // Pas de « Nom du projet » : les projets n'ont pas de nom (demande de
    // P.-A. Papillon) — le serveur en dérive un de l'entreprise et du type.
    {
      field: 'company_id', label: 'Entreprise',
      input: ({ value, onChange }) => (
        <LinkedRecordField
          name="pipeline_company_id"
          value={value}
          options={companies}
          labelFn={c => c.name}
          getHref={c => `/companies/${c.id}`}
          onChange={onChange}
        />
      ),
    },
    // Vendeur : présélectionné sur l'utilisateur connecté (s'il est vendeur).
    {
      field: 'vendeur_ref', label: 'Vendeur', defaultValue: defaultVendeur,
      input: ({ value, onChange }) => (
        <VendeurPicker value={value || ''} options={vendeurOptions} onChange={v => onChange(v || '')} />
      ),
    },
    // Pas de « Type » : déduit par le serveur (Expansion si l'entreprise a déjà
    // un projet gagné, sinon Nouveau client) — demande de P.-A. Papillon.
    {
      field: 'probability', label: 'Probabilité (%)', defaultValue: 50,
      input: ({ value, onChange, id }) => (
        <>
          <input
            id={id}
            type="range" min="0" max="100" step="5" value={value}
            onChange={e => onChange(parseInt(e.target.value))}
            className="w-full mt-1"
          />
          <div className="text-center text-sm font-medium text-brand-600">{value}%</div>
        </>
      ),
    },
    // Pas de « Date de clôture prévue » : retirée du formulaire d'ajout (demande
    // de P.-A. Papillon) — la colonne reste dans la liste et sur la fiche.
    { field: 'notes', label: 'Notes', type: 'textarea', span: 2 },
    // Masqués par défaut — disponibles via « Modifier le formulaire ».
    { field: 'value_cad', label: 'Valeur (CAD)', type: 'currency', min: '0', visible: false },
    { field: 'monthly_cad', label: 'Récurrent mensuel (CAD)', type: 'currency', min: '0', visible: false },
    { field: 'nb_greenhouses', label: 'Nombre de serres', type: 'number', min: '0', visible: false },
    // Pas de champ « Statut » : il a été retiré des projets (voir /champs/projects
    // et e2e/tests/projects-no-status-field.test.js) — l'offrir ici le ferait
    // revenir par la porte de derrière.
  ]
}

// Modale « Nouveau projet » (page Projets, carte Projets d'une fiche
// entreprise). `companyId` pré-remplit l'entreprise ; `onCreated` reçoit le
// projet créé.
export function NewProjectModal({ isOpen, onClose, onCreated, companyId }) {
  const { user } = useAuth()
  const [companies, setCompanies] = useState([])
  const [vendeurOptions, setVendeurOptions] = useState(null)
  // Chargé à la première ouverture : la présélection du vendeur est lue au
  // montage du formulaire, qui attend donc la liste.
  useEffect(() => {
    if (!isOpen || vendeurOptions) return
    api.companies.lookup().then(setCompanies).catch(() => {})
    api.projects.vendeurOptions().then(r => setVendeurOptions(r?.data || r || [])).catch(() => setVendeurOptions([]))
  }, [isOpen, vendeurOptions])
  const myVendeurRef = user?.employee_id ? `employee:${user.employee_id}` : ''
  const defaultVendeur = vendeurOptions?.some(o => o.ref === myVendeurRef) ? myVendeurRef : ''

  async function handleCreate(form) {
    const created = await api.projects.create(form)
    onCreated?.(created)
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Nouveau projet" size="lg">
      {vendeurOptions ? (
        <RecordForm
          table="projects"
          fields={projectFormFields(companies, vendeurOptions, defaultVendeur)}
          initial={companyId ? { company_id: companyId } : undefined}
          columns={2}
          onSubmit={handleCreate}
          onClose={onClose}
        />
      ) : <Spinner />}
    </Modal>
  )
}
