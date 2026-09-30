import { Link } from 'react-router-dom'
import { fmtMoney } from '../utils/formatters.js'

// Lignes de facture fournisseur reliées à un achat (extraction des factures, code LIA).
// Dépense QuickBooks → /fournisseurs/achats ; reçu ERP → sa fiche ; lien Airtable en repli.
const chip = 'inline-flex items-center px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 hover:underline text-xs whitespace-nowrap'

export function lineHref(l) {
  return l.source === 'erp' ? `/sale-receipts/${l.record_id}` : `/fournisseurs/achats?id=${l.record_id}`
}

// Décimales réglables depuis « Modifier le champ » (champ Devise « Prix payé »), 2 par défaut.
export function fmtUnitPrice(v, decimals = 2) {
  return fmtMoney(v, 'CAD', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

// `singleLine` (cellule de tableau, hauteur fixe) : pastilles côte à côte sans
// retour à la ligne — sinon la 2e déborde sur la ligne suivante.
export default function ExpenseLineLinks({ info, singleLine = false }) {
  if (!info) return <span className="text-slate-300">—</span>
  return (
    <span className={singleLine ? 'flex flex-nowrap gap-1 overflow-hidden min-w-0' : 'inline-flex flex-wrap gap-1'}>
      {info.lines.map(l => (
        <Link
          key={`${l.source}:${l.record_id}:${l.line}`}
          to={lineHref(l)}
          onClick={e => e.stopPropagation()}
          className={`${chip}${singleLine ? ' shrink-0' : ''}`}
          title={[l.vendor, l.date, l.description, fmtMoney(l.amount, l.currency)].filter(Boolean).join(' · ')}
        >
          {l.reference || l.vendor || 'Facture'}
        </Link>
      ))}
      {info.airtable_links.map(url => (
        <a key={url} href={url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className={`${chip}${singleLine ? ' shrink-0' : ''}`}>
          Airtable
        </a>
      ))}
    </span>
  )
}
