import { useState, useEffect } from 'react'
import { Plus, X } from 'lucide-react'
import { Layout } from './Layout.jsx'
import { PageTitle } from './PageTitle.jsx'
import { Modal } from './Modal.jsx'
import { RecordForm } from './RecordForm.jsx'

// Squelette d'une page liste : en-tête, actions, modale « Nouveau X »
// (RecordForm), bandeaux, puis le DataTable fourni par la page. `children`
// peut être une fonction pour recevoir `openCreate` (cta de l'emptyState).
export function ListPage({ title, icon, titleExtra, subtitle, actions, create, before, banner, className = 'p-6', children }) {
  const [showCreate, setShowCreate] = useState(false)
  const openCreate = () => setShowCreate(true)
  const closeCreate = () => setShowCreate(false)
  const { label, size, submitLabel, savingLabel, onSubmit, onOpenChange, ...formProps } = create || {}
  useEffect(() => { onOpenChange?.(showCreate) }, [showCreate, onOpenChange])

  return (
    <Layout>
      <div className={className}>
        {before}
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="flex items-center gap-3">
              <PageTitle icon={icon}>{title}</PageTitle>
              {titleExtra}
            </div>
            {subtitle}
          </div>
          <div className="flex items-center gap-2">
            {typeof actions === 'function' ? actions({ openCreate }) : actions}
            {create && (
              <button onClick={openCreate} className="btn-primary">
                <Plus size={16} /> {label}
              </button>
            )}
          </div>
        </div>

        {banner}

        {typeof children === 'function' ? children({ openCreate }) : children}
      </div>

      {create && (
        <Modal isOpen={showCreate} onClose={closeCreate} title={label} size={size}>
          <RecordForm
            {...formProps}
            onSubmit={onSubmit}
            onClose={closeCreate}
            submitLabel={submitLabel}
            savingLabel={savingLabel}
          />
        </Modal>
      )}
    </Layout>
  )
}

export function FilterBanner({ children, onClear, testId, clearLabel = 'Effacer', className = '' }) {
  return (
    <div className={`flex items-center gap-2 mb-3 px-3 py-2 bg-brand-50 border border-brand-200 rounded-lg text-sm text-brand-700 ${className}`} data-testid={testId}>
      <span>{children}</span>
      <button
        onClick={onClear}
        className="ml-auto flex items-center gap-1 text-xs text-brand-500 hover:text-brand-700"
        data-testid={testId ? testId.replace(/-filter$/, '-clear') : undefined}
      >
        <X size={13} /> {clearLabel}
      </button>
    </div>
  )
}
