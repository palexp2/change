import { hasRole } from '../../../shared/roles.mjs'
import { Modal } from './Modal.jsx'
import { NAV_SHORTCUTS } from './Layout.jsx'
import { useAuth } from '../lib/auth.jsx'

// Touche d'affichage : Mac montre ⌘, le reste Ctrl.
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
const cmdKey = isMac ? '⌘' : 'Ctrl'

// Raccourcis « système » qui ne sont pas de la simple navigation. Listés en
// plus de NAV_SHORTCUTS pour que la modale documente tout le comportement.
// `admin` : raccourci réservé aux admins (masqué pour les autres).
const SYSTEM_SHORTCUTS = [
  { keys: [cmdKey, 'K'], label: 'Recherche globale' },
  { keys: [cmdKey, '/'], label: 'File de travaux (ajouter un prompt, répondre à Claude)' },
  { keys: ['M'], label: 'Modifier le système', admin: true },
  { keys: ['?'], label: 'Aide des raccourcis' },
]

// Mode tableur d'un tableau (cellule sélectionnée).
const TABLE_SHORTCUTS = [
  { keys: ['↑', '↓', '←', '→'], label: 'Déplacer la sélection (Maj : étendre)' },
  { keys: ['Entrée'], label: 'Modifier la cellule' },
  { keys: [cmdKey, 'C'], label: 'Copier' },
  { keys: [cmdKey, 'V'], label: 'Coller' },
  { keys: [cmdKey, 'D'], label: 'Recopier vers le bas' },
  { keys: ['Suppr'], label: 'Vider' },
  { keys: ['Échap'], label: 'Désélectionner' },
]

function Kbd({ children }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.75rem] h-7 px-2 text-sm font-semibold text-slate-700 bg-slate-100 border border-slate-300 border-b-2 rounded-md">
      {children}
    </kbd>
  )
}

function ShortcutRow({ keys, label }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-slate-700">{label}</span>
      <span className="flex items-center gap-1" data-testid="shortcut-keys">
        {keys.map((k, i) => (
          <Kbd key={i}>{k}</Kbd>
        ))}
      </span>
    </div>
  )
}

function Group({ title, items, first }) {
  return (
    <section className={first ? '' : 'mt-5'}>
      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">{title}</h3>
      <div className="divide-y divide-slate-100">
        {items.map((s, i) => <ShortcutRow key={i} keys={s.keys} label={s.label} />)}
      </div>
    </section>
  )
}

// Liste complète, partagée par la modale « ? » et la section Paramètres → Raccourcis.
export function KeyboardShortcutsList() {
  const { user } = useAuth()
  const isAdmin = hasRole(user, 'admin')
  return (
    <div data-testid="keyboard-shortcuts-list">
      <Group first title="Navigation" items={NAV_SHORTCUTS.map(s => ({ keys: [s.key.toUpperCase()], label: s.label }))} />
      <Group title="Général" items={SYSTEM_SHORTCUTS.filter(s => !s.admin || isAdmin)} />
      <Group title="Tableaux" items={TABLE_SHORTCUTS} />
      <p className="mt-5 text-xs text-slate-400">
        Les raccourcis d'une seule touche sont ignorés pendant la saisie dans un champ.
      </p>
    </div>
  )
}

export function KeyboardShortcutsModal({ isOpen, onClose }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Raccourcis clavier" size="md">
      <div data-testid="keyboard-shortcuts-modal">
        <KeyboardShortcutsList />
      </div>
    </Modal>
  )
}
