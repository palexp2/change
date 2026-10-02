import { useCallback, useMemo, useState, useEffect } from 'react'
import { ShoppingCart } from 'lucide-react'
import api from '../lib/api.js'
import { patchRecord, useTable } from '../lib/dataStore.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import PurchaseDetail from './PurchaseDetail.jsx'
import { usePeekOpenId } from '../lib/usePeekOpenId.js'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import ExpenseLineLinks from '../components/ExpenseLineLinks.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { todayIso } from '../lib/bankDays.js'

// Plus de rendu sur mesure : la seule colonne native restante (emplacement)
// s'affiche telle quelle. Tout le reste de la description d'un achat vient des
// champs personnalisés, que DataTable rend lui-même.
// Deux colonnes calculées : lignes de facture fournisseur reliées (extraction des
// factures) et prix unitaire payé qui en découle (GET /purchases/expense-lines).
const RECEIVED_KEY = 'cf_date_de_reception_complete'
const COLUMNS = [
  ...TABLE_COLUMN_META.purchases.map(meta => ({ ...meta, editable: meta.field === 'emplacement' })),
  { id: 'expense_lines', label: 'Factures', field: 'expense_lines_label', render: r => <ExpenseLineLinks info={r.expense_info} singleLine /> },
  { id: 'unit_price_paid_cad', label: 'Prix payé', field: 'unit_price_paid_cad', type: 'currency' },
]
// « Fournisseur » (champ lien Airtable, éditable) : le nom ouvre la fiche dès le
// premier clic ; cliquer à côté sélectionne la cellule.
const COLUMN_PATCHES = { fournisseur: { linkChips: true, linkOpenOnClick: true } }

export default function Purchases() {
  const { peekOpenId, consumePeekOpen } = usePeekOpenId()

  const { rows: purchasesRaw, loading } = useListData({ table: 'purchases' })
  const companies = useTable('companies')
  const [expense, setExpense] = useState({})
  useEffect(() => { api.purchases.expenseLines().then(setExpense).catch(() => setExpense({})) }, [purchasesRaw])

  const purchases = useMemo(() => {
    const cById = new Map(companies.map(c => [c.id, c.name]))
    return purchasesRaw.map(r => {
      const info = expense[r.id] || null
      return {
        ...r,
        supplier_company_name: cById.get(r.supplier_company_id) || r.supplier_company_name,
        expense_info: info,
        expense_lines_label: info ? info.lines.map(l => l.reference || l.vendor).join(', ') || (info.airtable_links.length ? 'Airtable' : null) : null,
        unit_price_paid_cad: info?.unit_price_paid_cad ?? null,
      }
    })
  }, [purchasesRaw, companies, expense])

  // Édition en ligne (mode tableur), comme Retours : DataTable n'ouvre que les
  // champs `writable`, le PATCH revérifie (import Airtable seul → 400).
  const { addToast } = useToast()
  const updateField = useCallback(async (row, col, value) => {
    try {
      const updated = await api.purchases.update(row.id, { [col.field]: value })
      patchRecord('purchases', row.id, updated || { [col.field]: value })
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }, [addToast])

  // « Reçu » vide → bouton « Réceptionner » (date du jour). Remplace le champ
  // personnalisé du même id (la colonne de page gagne, libellé repris du champ).
  // Sans facture liée, le serveur refuse la date : bouton grisé.
  // stopPropagation : le clic ne sélectionne pas la cellule ni n'ouvre la fiche.
  const columns = useMemo(() => [...COLUMNS, {
    id: RECEIVED_KEY, field: RECEIVED_KEY, label: 'Date de réception complète', type: 'date', editable: true,
    render: row => {
      if (row[RECEIVED_KEY]) return fmtDate(row[RECEIVED_KEY])
      const linked = !!(row.expense_info?.lines?.length || row.expense_info?.airtable_links?.length)
      const stop = e => e.stopPropagation()
      return (
        <button type="button" data-testid="purchase-receive-btn"
          className="btn-secondary px-2 py-0.5 text-xs"
          disabled={!linked} title={linked ? undefined : "Liez d'abord la facture"}
          onMouseDown={stop} onDoubleClick={stop}
          onClick={e => { stop(e); updateField(row, { field: RECEIVED_KEY }, todayIso()) }}>
          Réceptionner
        </button>
      )
    },
  }], [updateField])

  // Pas de création ici : un achat naît d'un PO ou d'une fiche de pièce.
  return (
    <ListPage title="Achats">
      <DataTable
        table="purchases"
        manageViews
        sortIndicator
        columns={columns}
        columnPatches={COLUMN_PATCHES}
        data={purchases}
        loading={loading}
        onCellEdit={updateField}
        dateCellPicker
        fullHeightCells
        seamlessCellInput
        peek={{
          title: row => row.at_id || `Achat #${row.id}`,
          subtitle: row => row.supplier_company_name || row.supplier_vendor_name || '',
          to: row => `/purchases/${row.id}`,
          width: 680,
          openId: peekOpenId,
          onOpenConsumed: consumePeekOpen,
          render: (row, { close }) => <PurchaseDetail recordId={row.id} embedded onClose={close} /> }}
        searchFields={['at_id', 'supplier_company_name', 'supplier_vendor_name']}
        emptyState={{ icon: ShoppingCart, title: 'Aucun achat', description: "Aucune ligne d'achat n'est enregistrée. Les achats naissent des PO et des fiches de pièces." }}
      />
    </ListPage>
  )
}
