// Plan comptable — les comptes actifs du grand livre miroir (gl_accounts, recopié
// de QuickBooks et tenu à jour par sys_gl_mirror_sync) : numéro, nom, type et
// solde en CAD calculé par Boréal depuis ses propres lignes (bilan : depuis le
// début ; résultats : exercice en cours). Plus d'appel à QuickBooks à
// l'affichage. Clic sur un compte → son historique d'opérations.
import { useEffect, useState } from 'react'
import { ListTree } from 'lucide-react'
import api from '../lib/api.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtMoney } from '../utils/formatters.js'
import { fmtDate } from '../lib/formatDate.js'
import QbAccountLedger from './QbAccountLedger.jsx'

const toRow = a => ({
  id: a.qb_id,
  acct_num: a.acct_num || '',
  name: a.fully_qualified_name || a.name || '',
  account_type: a.account_type || '',
  account_sub_type: a.account_sub_type || '',
  classification: a.classification || '',
  currency: a.currency || 'CAD',
  balance: Number(a.balance || 0),
  description: a.description || '',
  sub_account: !!a.sub_account,
})

const RENDERS = {
  acct_num: row => <span className="font-mono text-xs text-slate-600 tabular-nums">{row.acct_num}</span>,
  name: row => <span className={row.sub_account ? 'text-slate-600' : 'text-slate-800 font-medium'}>{row.name}</span>,
  balance: row => <span className="tabular-nums text-slate-800">{fmtMoney(row.balance, 'CAD')}</span>,
}

const COLUMNS = TABLE_COLUMN_META.qb_accounts.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

const byNumber = (x, y) => (x.acct_num || '~').localeCompare(y.acct_num || '~') || x.name.localeCompare(y.name)

export default function PlanComptable() {
  const [error, setError] = useState(null)
  // Compteur du grand livre miroir (admin) : écritures recopiées de QBO.
  const [gl, setGl] = useState(null)
  useEffect(() => { api.quickbooks.glRuns().then(r => setGl(r.summary)).catch(() => {}) }, [])
  const { rows, loading } = useListData({
    cacheKey: 'qb_accounts',
    fetch: async () => {
      try {
        const list = await api.quickbooks.glAccounts()
        setError(null)
        return { data: (Array.isArray(list) ? list : []).map(toRow).sort(byNumber) }
      } catch (e) {
        setError(e.message || 'Plan comptable indisponible')
        throw e
      }
    },
  })

  return (
    <ListPage
      title="Plan comptable"
      icon={ListTree}
      subtitle={gl?.entries ? (
        <p className="text-xs text-slate-400 mt-0.5 tabular-nums" title={`${fmtDate(gl.first_date)} → ${fmtDate(gl.last_date)}`}>
          Grand livre : {gl.entries.toLocaleString('fr-CA')} écritures
        </p>
      ) : null}
      banner={error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}>
      <DataTable
        table="qb_accounts"
        manageViews
        columns={COLUMNS}
        data={rows}
        loading={loading}
        searchFields={['acct_num', 'name', 'account_type', 'account_sub_type', 'description']}
        // Comptes QB hors du registre des fiches : panneau du tableau.
        peek={{
          title: row => [row.acct_num, row.name].filter(Boolean).join(' '),
          subtitle: row => fmtMoney(row.balance, 'CAD'),
          key: 'qb_accounts',
          width: 960,
          render: row => <QbAccountLedger account={row} />,
        }}
      />
    </ListPage>
  )
}
