import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import api from '../lib/api.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { fmtMoney } from '../utils/formatters.js'
import { fmtDate } from '../lib/formatDate.js'

// La comptabilisation d'un versement de dette : la ventilation exacte qui va
// partir dans QuickBooks, puis le bouton qui la publie.
//
// Deux appelants, un seul composant : la modale de /dettes-lt et le panneau
// latéral du rapprochement bancaire, où la ligne du relevé porte justement ce
// versement — on comptabilise sans changer d'écran.
export default function DebtPaymentPublish({ debt, payment, onPublished, onCancel }) {
  const [publishing, setPublishing] = useState(false)
  const { addToast } = useToast()
  const total = Math.round((payment.principal + payment.interest) * 100) / 100
  const done = !!payment.pushed_at

  async function publish() {
    setPublishing(true)
    try {
      const r = await api.ltDebts.publishPayment(payment.id)
      addToast({
        message: r.warning || `Dépense publiée dans QB (#${r.qb_txn_id}) — cédule jointe en PDF`,
        type: r.warning ? 'error' : 'success',
      })
      await onPublished?.(r)
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setPublishing(false)
    }
  }

  const row = (label, acct, dr, cr) => (
    <tr className="border-t border-slate-100">
      <td className="py-1.5 pr-3">{label}</td>
      <td className="py-1.5 pr-3 text-slate-500 font-mono text-xs">{acct ? `#${acct}` : <span className="text-red-600">manquant</span>}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{dr ? fmtMoney(dr, debt.currency) : ''}</td>
      <td className="py-1.5 text-right tabular-nums">{cr ? fmtMoney(cr, debt.currency) : ''}</td>
    </tr>
  )

  return (
    <div data-testid="debt-payment-publish">
      <p className="text-sm text-slate-600 mb-3">
        {debt.label}{debt.loan_number ? ` · prêt ${debt.loan_number}` : ''} — versement du {fmtDate(payment.payment_date)}
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-400">
            <th className="text-left font-medium pb-1">Compte</th><th className="text-left font-medium pb-1">No</th>
            <th className="text-right font-medium pb-1">Débit</th><th className="text-right font-medium pb-1">Crédit</th>
          </tr>
        </thead>
        <tbody>
          {payment.principal > 0 && row('Dette à long terme (capital)', debt.qb_debt_acctnum, payment.principal, null)}
          {payment.interest > 0 && row("Frais d'intérêts", debt.qb_interest_acctnum, payment.interest, null)}
          {row('Banque', debt.qb_bank_acctnum, null, total)}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-200 font-medium">
            <td className="py-1.5" colSpan={2}>Total</td>
            <td className="py-1.5 text-right tabular-nums">{fmtMoney(payment.principal + payment.interest, debt.currency)}</td>
            <td className="py-1.5 text-right tabular-nums">{fmtMoney(total, debt.currency)}</td>
          </tr>
        </tfoot>
      </table>
      {/* La date qui sera comptabilisée : celle du débit au compte, pas celle de
          la cédule (prélèvement du 14 pour une échéance au 11). */}
      {payment.bank_date && payment.bank_date !== payment.payment_date && (
        <p className="text-xs text-slate-500 mt-2">Comptabilisée au {fmtDate(payment.bank_date)}, date du débit au compte.</p>
      )}
      {payment.balance_after != null && (
        <p className="text-xs text-slate-500 mt-2">Solde de la dette après ce versement : {fmtMoney(payment.balance_after, debt.currency)}</p>
      )}
      {/* L'écart constaté au relevé : les frais annuels quand ils sont reconnus,
          sinon un montant en plus à expliquer — il ne fait pas partie de la
          ventilation publiée. */}
      {Number(payment.bank_extra_amount) > 0 && (
        <p className="text-xs text-amber-700 mt-1">
          {fmtMoney(payment.bank_extra_amount, debt.currency)} de plus au relevé
          {debt.annual_fee_label ? ` · ${debt.annual_fee_label}` : ''}
        </p>
      )}
      {/* Bouton requis : action transactionnelle (publication d'une dépense dans QB) */}
      <div className="flex justify-end gap-2 mt-4">
        {onCancel && <button onClick={onCancel} className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">Annuler</button>}
        {done ? (
          <span className="inline-flex items-center gap-1 text-sm text-slate-500">
            Publié
            {payment.qb_url && (
              <a href={payment.qb_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-600 hover:underline">
                <ExternalLink size={12} /> QuickBooks
              </a>
            )}
          </span>
        ) : (
          <button onClick={publish} disabled={publishing} data-testid="debt-payment-publish-btn"
            className="px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
            {publishing ? 'Publication…' : 'Publier dans QuickBooks'}
          </button>
        )}
      </div>
    </div>
  )
}
