import { useState, lazy, Suspense } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { fmtMoney } from '../utils/formatters.js'
import RecordPeekDrawer from './RecordPeekDrawer.jsx'

// Lignes de facture fournisseur reliées à un achat (extraction des factures, code LIA).
// Dépense QuickBooks → /fournisseurs/achats ; reçu ERP → sa fiche ; lien Airtable en repli.
const chip = 'inline-flex items-center px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 hover:underline text-xs whitespace-nowrap'

// Formulaire de l'achat fournisseur (pas de route de fiche), chargé à la demande.
const AchatPanel = lazy(() => import('../pages/AchatsFournisseurs.jsx').then(m => ({ default: m.AchatModal })))

export function lineHref(l) {
  return l.source === 'erp' ? `/sale-receipts/${l.record_id}` : `/fournisseurs/achats?id=${l.record_id}`
}

// Décimales réglables depuis « Modifier le champ » (champ Devise « Prix payé »), 2 par défaut.
export function fmtUnitPrice(v, decimals = 2) {
  return fmtMoney(v, 'CAD', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

// `singleLine` (cellule de tableau, hauteur fixe) : pastilles côte à côte sans
// retour à la ligne — sinon la 2e déborde sur la ligne suivante.
// `peek` : la facture QuickBooks s'ouvre en panneau latéral au lieu de quitter
// la page pour /fournisseurs/achats (les reçus ERP s'empilent déjà seuls).
export default function ExpenseLineLinks({ info, singleLine = false, peek = false }) {
  const [achat, setAchat] = useState(null)
  if (!info) return <span className="text-slate-300">—</span>
  const cls = `${chip}${singleLine ? ' shrink-0' : ''}`
  const open = async (e, l) => {
    e.preventDefault()
    e.stopPropagation()
    try { setAchat(await api.achatsFournisseurs.get(l.record_id)) } catch { /* lien mort */ }
  }
  return (
    <span className={singleLine ? 'flex flex-nowrap gap-1 overflow-hidden min-w-0' : 'inline-flex flex-wrap gap-1'}>
      {info.lines.map(l => (
        <Link
          key={`${l.source}:${l.record_id}:${l.line}`}
          to={lineHref(l)}
          onClick={peek && l.source !== 'erp' ? e => open(e, l) : e => e.stopPropagation()}
          className={cls}
          title={[l.vendor, l.date, l.description, fmtMoney(l.amount, l.currency)].filter(Boolean).join(' · ')}
        >
          {l.reference || l.vendor || 'Facture'}
        </Link>
      ))}
      {info.airtable_links.map(url => (
        <a key={url} href={url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className={cls}>
          Airtable
        </a>
      ))}
      {achat && (
        <RecordPeekDrawer open onClose={() => setAchat(null)} peekKey="achats" width={640}
          title={achat.vendor || 'Facture fournisseur'}
          subtitle={[achat.vendor_invoice_number, achat.invoice_date].filter(Boolean).join(' · ')}>
          <div className="px-5 py-4">
            <Suspense fallback={<div className="p-6 text-sm text-slate-400">Chargement…</div>}>
              <AchatPanel achat={achat} onClose={() => setAchat(null)} onSaved={() => {}} />
            </Suspense>
          </div>
        </RecordPeekDrawer>
      )}
    </span>
  )
}
