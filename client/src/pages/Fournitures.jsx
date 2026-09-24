import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, RefreshCw } from 'lucide-react'
import api from '../lib/api.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'
import { Modal } from '../components/Modal.jsx'
import { RecordForm } from '../components/RecordForm.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { fmtMoney, fmtNumber } from '../utils/formatters.js'
import FournitureDetail from './FournitureDetail.jsx'

// Fournitures (bureau, entretien, emballage) — lues depuis la table Airtable
// « Fournitures ». Leurs achats se voient et se saisissent dans la fiche.
const DASH = <span className="text-slate-300">—</span>
const money = n => fmtMoney(n, 'CAD', { fallback: DASH })

const RENDERS = {
  name: row => (
    <span className="inline-flex items-center gap-2 min-w-0">
      {row.image_url
        ? <img src={row.image_url} alt="" className="w-7 h-7 object-contain rounded shrink-0 bg-white" loading="lazy" />
        : <span className="w-7 h-7 shrink-0" />}
      {/* Le clic ouvre la fiche, qui porte le lien d'achat. */}
      <span className="truncate">{row.name || '—'}</span>
    </span>
  ),
  reference_price:   row => money(row.reference_price),
  last_purchased_at: row => row.last_purchased_at ? <span className="text-slate-500">{fmtDate(row.last_purchased_at)}</span> : DASH,
  achats_count:      row => row.achats_count ? fmtNumber(row.achats_count) : DASH,
  total_spent:       row => row.achats_count ? <span className="font-medium">{money(row.total_spent)}</span> : DASH,
}

// Champs que POST /api/fournitures sait créer (dans Airtable, puis ici).
const FORM_FIELDS = [
  { field: 'name',            label: 'Nom',          locked: true, required: true, span: 2 },
  { field: 'supplier',        label: 'Fournisseur' },
  { field: 'unit',            label: 'Unité' },
  { field: 'reference_price', label: 'Prix de réf.', type: 'currency', min: 0, step: '0.01' },
  { field: 'web_url',         label: 'Lien web',     type: 'url' },
  { field: 'notes',           label: 'Notes',        type: 'textarea', rows: 3, span: 2 },
]

const COLUMNS = TABLE_COLUMN_META.fournitures.map(meta => ({ ...meta, render: RENDERS[meta.id] }))
const byName = (x, y) => String(x.name || '').localeCompare(String(y.name || ''), 'fr', { sensitivity: 'base' })

export default function Fournitures() {
  const { rows, setRows, loading, reload } = useListData({ fetch: () => api.fournitures.list(), realtime: 'fournitures' })
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState(null)
  const navigate = useNavigate()
  const [showFourniture, setShowFourniture] = useState(false)

  // Modifs faites dans la fiche : reportées sur la ligne sans recharger la liste
  // (le rechargement repasse en chargement et fermerait le panneau). Un achat
  // ajouté ou modifié : relecture silencieuse, pour le résumé des achats.
  const applyChange = useCallback(({ fourniture: f, achat, created, deleted }) => {
    if (deleted) { setRows(prev => prev.filter(r => r.id !== deleted)); return }
    if (achat || created) { api.fournitures.list().then(r => setRows(r.data || [])).catch(() => {}); return }
    if (f) setRows(prev => prev.map(r => r.id === f.id ? { ...r, ...f } : r))
  }, [setRows])

  async function sync() {
    setSyncing(true); setError(null)
    try { await api.fournitures.sync(); await reload() }
    catch (e) { setError(e.message) }
    finally { setSyncing(false) }
  }

  return (
    <ListPage
      title="Fournitures"
      banner={error && <ErrorBanner>{error}</ErrorBanner>}
      actions={
        <button type="button" onClick={() => setShowFourniture(true)} className="btn-secondary">
          <Plus size={16} /> Nouvelle fourniture
        </button>
      }
    >
      <Modal isOpen={showFourniture} onClose={() => setShowFourniture(false)} title="Nouvelle fourniture">
        <RecordForm
          table="fournitures" fields={FORM_FIELDS} columns={2}
          onSubmit={async form => { 
            const f = await api.fournitures.create(form)
            setRows(prev => [...prev, { ...f, achats_count: 0 }].sort(byName))
            navigate(`/fournitures/${f.id}`)
          }}
          onClose={() => setShowFourniture(false)}
          submitLabel="Créer et ouvrir" savingLabel="Création…"
        />
      </Modal>
      <DataTable
        table="fournitures"
        manageViews
        columns={COLUMNS}
        data={rows}
        loading={loading}
        searchFields={['name', 'supplier', 'unit', 'notes']}
        peek={{
          title: row => row.name || 'Fourniture',
          subtitle: row => row.supplier || '',
          to: row => `/fournitures/${row.id}`,
          key: 'fournitures',
          width: 680,
          render: (row, { close }) => <FournitureDetail recordId={row.id} onClose={close} onChanged={applyChange} />,
        }}
        toolbarEnd={
          <button type="button" onClick={sync} disabled={syncing} title="Relire Airtable"
            className="ml-2 inline-flex items-center gap-1.5 px-2.5 h-7 text-xs rounded-md text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} /> Synchroniser
          </button>
        }
      />
    </ListPage>
  )
}
