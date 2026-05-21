import { useState, useMemo, lazy, Suspense } from 'react'
import { EyeOff } from 'lucide-react'
import { useFieldVisibilityRules, useFieldGuardContext } from '../lib/useFieldVisibilityRules.js'
import { shouldHide } from '../lib/fieldVisibility.js'
import { useAuth } from '../lib/auth.jsx'

// Lazy-load la modale — elle ne s'ouvre que sur clic droit, pas besoin de
// l'inclure dans le bundle principal de toutes les pages détail.
const FieldVisibilityRuleModal = lazy(() => import('./FieldVisibilityRuleModal.jsx'))

// Wrapper de champ avec règles de visibilité conditionnelle.
//
// Usage :
//   <FieldGuardProvider context="facture" record={facture} fields={FIELDS}>
//     ...
//     <FieldGuard fieldId="is_sent" label="Envoyée">
//       <div>...</div>
//     </FieldGuard>
//   </FieldGuard>
//
// - context / record / fields peuvent être passés en props OU hérités via
//   <FieldGuardProvider> qui pose le context React.
// - Clic droit sur le wrapper → ouvre la modale de configuration des règles
//   pour ce field_id (admin only).
export function FieldGuard({
  fieldId,
  label,
  context: contextProp,
  record: recordProp,
  fields: fieldsProp,
  children,
}) {
  const ctx = useFieldGuardContext()
  const context = contextProp || ctx?.context
  const record = recordProp ?? ctx?.record
  const fields = fieldsProp || ctx?.fields || []
  const { user } = useAuth()
  const { rules, invalidate } = useFieldVisibilityRules(context)
  const [menu, setMenu] = useState(null)
  const [modalOpen, setModalOpen] = useState(false)

  const rulesForField = useMemo(
    () => rules.filter(r => r.field_id === fieldId),
    [rules, fieldId]
  )

  const hidden = useMemo(
    () => shouldHide(rulesForField, record),
    [rulesForField, record]
  )

  function handleContextMenu(e) {
    // Pas de menu si pas authentifié (devrait toujours être true sur les pages détail)
    if (!user) return
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  function openModal() {
    setMenu(null)
    setModalOpen(true)
  }

  // Si le champ est masqué par une règle, on n'affiche rien — sauf en mode
  // admin où on garde un indicateur très discret pour pouvoir y revenir.
  // (Sinon on ne pourrait jamais retirer la règle via clic droit.)
  if (hidden) {
    if (user?.role !== 'admin') return null
    return (
      <>
        <div
          onContextMenu={handleContextMenu}
          className="inline-flex items-center gap-1.5 text-xs text-slate-300 italic px-2 py-1 border border-dashed border-slate-200 rounded cursor-context-menu hover:border-slate-300 hover:text-slate-400"
          title={`Champ masqué par règle (clic droit pour configurer)`}
          data-field-id={fieldId}
          data-field-hidden="true"
        >
          <EyeOff size={11} /> {label || fieldId}
        </div>
        {renderMenuAndModal()}
      </>
    )
  }

  return (
    <>
      <div
        onContextMenu={handleContextMenu}
        data-field-id={fieldId}
        className="contents"
      >
        {children}
      </div>
      {renderMenuAndModal()}
    </>
  )

  function renderMenuAndModal() {
    return (
      <>
        {menu && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setMenu(null)}
              onContextMenu={e => { e.preventDefault(); setMenu(null) }}
            />
            <div
              className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[240px]"
              style={{ top: menu.y, left: menu.x }}
            >
              <div className="px-3 py-1.5 text-xs text-slate-400 border-b border-slate-100">
                Champ : <span className="font-medium text-slate-600">{label || fieldId}</span>
              </div>
              {user?.role === 'admin' ? (
                <button
                  onClick={openModal}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 text-left"
                >
                  <EyeOff size={13} />
                  {rulesForField.length > 0
                    ? `Gérer les règles de visibilité (${rulesForField.length})`
                    : 'Masquer ce champ sous condition…'}
                </button>
              ) : (
                <div className="px-3 py-2 text-xs text-slate-400">
                  Réservé aux admins
                </div>
              )}
            </div>
          </>
        )}
        {modalOpen && (
          <Suspense fallback={null}>
            <FieldVisibilityRuleModal
              isOpen={modalOpen}
              onClose={() => setModalOpen(false)}
              context={context}
              fieldId={fieldId}
              fieldLabel={label || fieldId}
              record={record}
              fields={fields}
              existingRules={rulesForField}
              onChanged={invalidate}
            />
          </Suspense>
        )}
      </>
    )
  }
}

// Provider optionnel pour éviter de répéter context/record/fields sur chaque
// FieldGuard d'une même page.
import { FieldGuardContext } from '../lib/useFieldVisibilityRules.js'

export function FieldGuardProvider({ context, record, fields, children }) {
  const value = useMemo(() => ({ context, record, fields }), [context, record, fields])
  return (
    <FieldGuardContext.Provider value={value}>
      {children}
    </FieldGuardContext.Provider>
  )
}

export default FieldGuard
