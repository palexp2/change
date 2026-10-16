import { useNavigate } from 'react-router-dom'
import { Mail, MailPlus } from 'lucide-react'
import api from '../lib/api.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'

// Clients → Modèles de courriel : objets et textes réutilisables.
// Marketing → Courriels marketing : même table, famille kind='marketing'.
// Fiche : panneau latéral (EmailTemplateDetail, registre recordPeekRoutes).

export const TEMPLATE_KINDS = {
  vente: { path: '/modeles-courriel', title: 'Modèles de courriel', icon: Mail, table: 'email_templates' },
  marketing: { path: '/courriels-marketing', title: 'Courriels marketing', icon: MailPlus, table: 'marketing_email_templates' },
}

const RENDERS = {
  name: row => <span className="font-medium text-slate-800">{row.name}</span>,
  subject: row => <span className="text-slate-700 truncate">{row.subject}</span>,
  language: row => String(row.language || '').toUpperCase() || '—',
  updated_at: row => <span className="text-slate-600">{fmtDate(row.updated_at)}</span>,
}
const COLUMNS = TABLE_COLUMN_META.email_templates.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export function MarketingEmailTemplates() {
  return <EmailTemplates kind="marketing" />
}

export default function EmailTemplates({ kind = 'vente' }) {
  const navigate = useNavigate()
  const { path, title, icon, table } = TEMPLATE_KINDS[kind]
  const list = useListData({ fetch: () => api.emailTemplates.list(kind).then(data => ({ data })), cacheKey: table })

  async function handleCreate(values) {
    const created = await api.emailTemplates.create({ ...values, kind })
    await list.reload()
    navigate(`${path}/${created.id}`)
  }

  return (
    <ListPage
      title={title}
      icon={icon}
      create={{
        label: 'Nouveau modèle',
        submitLabel: 'Créer',
        onSubmit: handleCreate,
        fields: [{ field: 'name', label: 'Nom', required: true, locked: true }],
      }}
    >
      {({ openCreate }) => (
        <DataTable
          table={table}
          columns={COLUMNS}
          data={list.rows}
          loading={list.loading}
          searchFields={['name', 'subject', 'body']}
          manageViews
          onRowClick={row => navigate(`${path}/${row.id}`)}
          emptyState={{ icon, title: 'Aucun modèle', cta: { label: 'Nouveau modèle', onClick: openCreate } }}
        />
      )}
    </ListPage>
  )
}
