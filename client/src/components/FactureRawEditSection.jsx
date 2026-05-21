import { useState, useCallback } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import api from '../lib/api.js'
import RawEditPanel from './RawEditPanel.jsx'

const FACTURE_GROUPS = [
  { title: 'Identifiants', cols: ['id', 'airtable_id', 'invoice_id', 'customer_id', 'document_number', 'sync_source', 'kind'] },
  { title: 'Liens', cols: ['company_id', 'project_id', 'order_id', 'subscription_id', 'lien_stripe'] },
  { title: 'Dates', cols: ['document_date', 'due_date', 'date_equivalente', 'annee_de_facturation', 'created_at', 'updated_at'] },
  { title: 'Montants', cols: ['currency', 'amount_before_tax_cad', 'total_amount', 'balance_due', 'montant_avant_taxes'] },
  { title: 'Statut & envoi', cols: ['status', 'is_sent_manual', 'shipping_country', 'notes'] },
  { title: 'Paiement Stripe', cols: ['paid_at', 'paid_amount', 'paid_charge_id', 'paid_payment_intent'] },
  { title: 'Comptabilité (différé / constaté)', cols: ['deferred_revenue_at', 'deferred_revenue_amount_native', 'deferred_revenue_amount_cad', 'deferred_revenue_currency', 'deferred_revenue_qb_ref', 'revenue_recognized_at', 'revenue_recognized_je_id'] },
  { title: 'PDFs', cols: ['generated_pdf_path', 'airtable_pdf_path'] },
]

export default function FactureRawEditSection({ factureId, facture, onChanged }) {
  const [open, setOpen] = useState(false)

  const schemaLoader = useCallback(() => api.admin.factureRawSchema(factureId), [factureId])
  const onSave = useCallback(async (col, value) => {
    const res = await api.admin.factureRawUpdate(factureId, { [col]: value })
    if (!res?.rejected?.[col] && onChanged) await onChanged()
    return res
  }, [factureId, onChanged])

  return (
    <div className="bg-white rounded-xl border border-slate-200 mt-5">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-3 border-b border-slate-100 hover:bg-slate-50"
        data-testid="raw-edit-toggle"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
          <h2 className="text-sm font-semibold text-slate-900">Édition avancée</h2>
          <span className="text-xs text-slate-400">— admin · toutes les colonnes DB</span>
        </div>
        {open && (
          <span className="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
            Aucune validation métier — toucher paid_*, revenue_*, deferred_* peut désynchroniser Stripe / QB
          </span>
        )}
      </button>

      {open && (
        <div className="px-5 py-4">
          <RawEditPanel
            schemaLoader={schemaLoader}
            record={facture}
            onSave={onSave}
            groups={FACTURE_GROUPS}
            testIdPrefix="raw-edit"
          />
        </div>
      )}
    </div>
  )
}
