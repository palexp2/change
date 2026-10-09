import { fmtDate } from '../lib/formatDate.js'
import ThinkingOrb from './ThinkingOrb'
import { fmtMoney } from '../utils/formatters.js'

const SOURCE_LABELS = { email: 'Courriel', upload: 'Déposé', depot_rapprochement: 'Relevé' }
export function sourceLabel(src) {
  if (!src) return '—'
  if (src.startsWith('scraper')) return 'Portail'
  return SOURCE_LABELS[src] || src
}

// L'état utile d'un document, du plus urgent au plus calme — c'est ce que la
// colonne « Statut » affiche à la place du simple statut d'extraction.
export function receiptState(row) {
  if (row.status === 'error') return { tone: 'red', label: 'Erreur', title: row.error_message }
  if (row.status === 'pending' || row.status === 'processing') return { tone: 'blue', label: 'Lecture…' }
  if (row.quickbooks_id) return { tone: 'green', label: `QB #${row.quickbooks_id}`, href: row.quickbooks_url }
  if (row.archived_at) return { tone: 'slate', label: 'Archivé' }
  if (row.obsolete) return { tone: 'red', label: 'Doublon / 0 $', title: row.obsolete.message, testId: 'receipt-obsolete-pill' }
  if (row.fiscal_detection?.warnings?.length) return { tone: 'amber', label: 'Taxe à vérifier', title: row.fiscal_detection.warnings.join('\n') }
  if (row.bank_txn) return { tone: 'green', label: 'Débit trouvé', title: `${row.bank_txn.account_name} · ${fmtDate(row.bank_txn.txn_date)}` }
  return { tone: 'slate', label: 'Débit à venir' }
}

const TONES = {
  red: 'text-red-700 bg-red-50', blue: 'text-blue-700 bg-blue-50', green: 'text-green-700 bg-green-50',
  amber: 'text-amber-700 bg-amber-50', slate: 'text-slate-500 bg-slate-100',
}

// Variante `quiet` (liste Extraction de données, maquette E3, 2026-10-03) :
// seuls les problèmes parlent. Tout va bien → un ✓ discret (lien QuickBooks
// une fois publié) ; rien à dire → rien. Le détail reste en infobulle.
const QUIET = {
  'Erreur': { cls: 'text-red-600', text: '⚠ Erreur' },
  'Doublon / 0 $': { cls: 'text-amber-700', text: '⚠ Doublon' },
  'Taxe à vérifier': { cls: 'text-amber-700', text: '⚠ Taxe' },
}
// Débit retrouvé au relevé : montant · date · compte, en clair (Charles, 2026-10-06).
function BankTxnInfo({ txn }) {
  return (
    <span className="text-xs text-sky-800 whitespace-nowrap" title={txn.label || undefined} data-testid="receipt-bank-txn">
      {fmtMoney(Math.abs(txn.amount), txn.account_currency || 'CAD')} · {fmtDate(txn.txn_date)} · {txn.account_name}
    </span>
  )
}

function QuietState({ st, linkTestId, row }) {
  if (st.tone === 'blue') return <span className="inline-flex items-center gap-1 text-xs text-slate-400"><ThinkingOrb state="working" size={11} ink />Lecture…</span>
  const q = QUIET[st.label]
  if (q) return <span className={`text-xs font-medium whitespace-nowrap ${q.cls}`} title={st.title} data-testid={st.testId}>{q.text}</span>
  if (row?.bank_txn && st.tone !== 'red' && st.tone !== 'amber') {
    return (
      <span className="inline-flex items-center gap-1.5">
        {st.href
          ? <a href={st.href} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} title={st.label} data-testid={linkTestId} className="text-green-700 font-semibold hover:underline">✓</a>
          : <span className="text-green-700 font-semibold">✓</span>}
        <BankTxnInfo txn={row.bank_txn} />
      </span>
    )
  }
  if (st.href) return <a href={st.href} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} title={st.label} data-testid={linkTestId} className="text-green-700 font-semibold hover:underline">✓</a>
  if (st.tone === 'green') return <span className="text-green-700 font-semibold" title={st.title || st.label}>✓</span>
  return null
}

// linkTestId : data-testid du lien quand la pastille pointe vers QuickBooks.
export function ReceiptStatePill({ row, linkTestId, quiet = false }) {
  const st = receiptState(row)
  if (quiet) return <QuietState st={st} linkTestId={linkTestId} row={row} />
  const cls = `inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${TONES[st.tone]}`
  const body = <>{st.tone === 'blue' && <ThinkingOrb state="working" size={11} ink />}{st.label}</>
  return st.href
    ? <a href={st.href} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className={`${cls} hover:underline`} title={st.title} data-testid={linkTestId}>{body}</a>
    : <span className={cls} title={st.title} data-testid={st.testId}>{body}</span>
}

export default ReceiptStatePill
