import { Modal } from './Modal.jsx'
import { NAV_SHORTCUTS } from './Layout.jsx'

// Touche d'affichage : Mac montre ⌘, le reste Ctrl.
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
const cmdKey = isMac ? '⌘' : 'Ctrl'

// Raccourcis « système » qui ne sont pas de la simple navigation. Listés en
// plus de NAV_SHORTCUTS pour que la modale documente tout le comportement.
const SYSTEM_SHORTCUTS = [
  { keys: [cmdKey, 'K'], label: 'Recherche globale' },
  { keys: [cmdKey, '/'], label: 'File de travaux (ajouter un prompt, répondre à Claude)' },
  { keys: ['?'], label: 'Afficher cette aide' },
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

export function KeyboardShortcutsModal({ isOpen, onClose }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Raccourcis clavier" size="md">
      <div data-testid="keyboard-shortcuts-modal">
        <section>
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Navigation</h3>
          <div className="divide-y divide-slate-100">
            {NAV_SHORTCUTS.map(s => (
              <ShortcutRow key={s.key} keys={[s.key.toUpperCase()]} label={s.label} />
            ))}
          </div>
        </section>

        <section className="mt-5">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Général</h3>
          <div className="divide-y divide-slate-100">
            {SYSTEM_SHORTCUTS.map((s, i) => (
              <ShortcutRow key={i} keys={s.keys} label={s.label} />
            ))}
          </div>
        </section>

        <p className="mt-5 text-xs text-slate-400">
          Les raccourcis d'une seule touche sont ignorés pendant la saisie dans un champ.
        </p>
      </div>
    </Modal>
  )
}
