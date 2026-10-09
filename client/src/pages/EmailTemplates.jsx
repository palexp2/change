import { useNavigate } from 'react-router-dom'
import { Mail } from 'lucide-react'
import api from '../lib/api.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'

// Clients → Modèles de courriel : objets et textes réutilisables.
// Fiche : panneau latéral (EmailTemplateDetail, registre recordPeekRoutes).

const RENDERS = {
  name: row => <span className="font-medium text-slate-800">{row.name}</span>,
  subject: row => <span className="text-slate-700 truncate">{row.subject}</span>,
  language: row => <span className="text-xs text-slate-500 uppercase">{row.language}</span>,
  updated_at: row => <span className="text-slate-600">{fmtDate(row.updated_at)}</span>,
}
const COLUMNS = TABLE_COLUMN_META.email_templates.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function EmailTemplates() {
  const navigate = useNavigate()
  const list = useListData({ fetch: () => api.emailTemplates.list().then(data => ({ data })), cacheKey: 'email_templates' })

  async function handleCreate(values) {
    const created = await api.emailTemplates.create(values)
    await list.reload()
    navigate(`/modeles-courriel/${created.id}`)
  }

  return (
    <ListPage
      title="Modèles de courriel"
      icon={Mail}
      create={{
        label: 'Nouveau modèle',
        submitLabel: 'Créer',
        onSubmit: handleCreate,
        fields: [{ field: 'name', label: 'Nom', required: true, locked: true }],
      }}
    >
      {({ openCreate }) => (
        <DataTable
          table="email_templates"
          columns={COLUMNS}
          data={list.rows}
          loading={list.loading}
          searchFields={['name', 'subject', 'body']}
          manageViews
          onRowClick={row => navigate(`/modeles-courriel/${row.id}`)}
          emptyState={{ icon: Mail, title: 'Aucun modèle', cta: { label: 'Nouveau modèle', onClick: openCreate } }}
        />
      )}
    </ListPage>
  )
}
