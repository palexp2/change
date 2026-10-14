// Carte d'un dépôt de relevé : ce que l'ERP a lu et de quel compte il pense
// qu'il s'agit, à corriger au besoin. Ouverte depuis la bande orange du dépôt
// sans fenêtre (StatementDropStrip) quand un fichier demande un humain.
//
// Deux choses portent toute la confiance de l'écran et ne doivent jamais être
// enterrées : le COMPTE (modifiable, avec la preuve du choix) et l'ÉQUILIBRE
// (ouverture + mouvements = fermeture). Un écart non nul veut dire que la
// lecture a sauté ou inventé une ligne — on l'affiche en rouge et on laisse
// importer quand même : c'est l'humain qui tranche.
import { Link } from 'react-router-dom'
import { Trash2, RefreshCw, ChevronRight } from 'lucide-react'
import api from '../lib/api.js'
import { Badge } from './Badge.jsx'
import Spinner from './Spinner.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'
import { fmtMoney } from '../utils/formatters.js'
import { fmtDate } from '../lib/formatDate.js'

const SOURCE_LABEL = {
  tableur: 'Tableur', pdf_texte: 'PDF', pdf_image: 'PDF scanné', image: 'Capture',
}

// Le contrôle d'équilibre est ce qui distingue une lecture fiable d'une lecture
// inventée : il ne se cache jamais derrière un dépliant.
// Relevé mensuel rangé au Drive par Boréal (ou déjà présent).
const DRIVE_FILING = {
  depose: { color: 'green', label: 'Rangé au Drive' },
  deja: { color: 'gray', label: 'Déjà au Drive' },
  erreur: { color: 'red', label: 'Drive : échec' },
  autre_compte: { color: 'red', label: 'Autre compte' },
}

function BalanceBadge({ up }) {
  if (up.balance_ok == null) return <Badge color="gray">Équilibre non vérifiable</Badge>
  if (up.balance_ok) return <Badge color="green">{up.balance_method === 'chaine' ? 'Soldes enchaînés' : 'Équilibré'}</Badge>
  if (up.balance_method === 'chaine') return <Badge color="red">Soldes qui ne s'enchaînent pas</Badge>
  return <Badge color="red">Écart {fmtMoney(up.balance_check)}</Badge>
}

// Capture du solde seul : même solde que Boréal = aucune nouvelle transaction.
function SnapshotBadge({ snap }) {
  if (!snap || snap.verdict === 'inconnu') return <Badge color="gray">Solde non comparable</Badge>
  if (snap.verdict === 'identique') return <Badge color="green">Rien de nouveau</Badge>
  return <Badge color="yellow">Nouvelles transactions</Badge>
}

export function UploadCard({ up, accounts, onChange, onRemove, onReanalyze, onToExtractor, expanded, onToggle }) {
  const rows = up.rows_json || []
  const fresh = rows.filter((r) => r._new)
  const busy = up.status === 'en_analyse'
  const isInvoice = up.document_kind === 'facture'
  const snap = up.document_kind === 'solde' ? (up.snapshot || {}) : null

  return (
    <div className="border border-slate-200 rounded-xl p-3 space-y-2">
      <div className="flex items-center gap-2">
        <a href={api.bank.statements.fileUrl(up.id)} target="_blank" rel="noreferrer"
          className="text-sm font-medium truncate flex-1 hover:underline" title={up.original_name}>{up.original_name}</a>
        {up.source && <Badge color="slate">{SOURCE_LABEL[up.source] || up.source}</Badge>}
        <button className="p-1 text-slate-400 hover:text-slate-700" title="Relire" onClick={() => onReanalyze(up.id)}>
          <RefreshCw size={14} />
        </button>
        <button className="p-1 text-slate-400 hover:text-red-600" title="Retirer" onClick={() => onRemove(up.id)}>
          <Trash2 size={14} />
        </button>
      </div>

      {(up.source === 'image' || up.mime?.startsWith('image/')) && (
        <a href={api.bank.statements.fileUrl(up.id)} target="_blank" rel="noreferrer" className="block">
          <img src={api.bank.statements.fileUrl(up.id)} alt="" data-testid="statement-preview"
            className="max-h-40 rounded border border-slate-200 object-contain" />
        </a>
      )}

      {busy && <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner size="sm" /> Lecture…</div>}
      {up.status === 'erreur' && <div className="text-sm text-red-600">{up.error}</div>}

      {/* Ce n'était pas un relevé : le document est parti à l'extraction de
          données, il n'y a rien à importer au compte. */}
      {isInvoice && (
        <div className="flex items-center gap-2 text-sm">
          <Badge color="blue">Facture</Badge>
          {up.sale_receipt_id ? (
            <Link to={`/sale-receipts/${up.sale_receipt_id}`} className="link-record" data-testid="statement-to-receipt-link">
              Ouvrir dans l'extraction de données
            </Link>
          ) : (
            <span className="text-slate-500">{up.error || 'Envoyée à l’extraction de données'}</span>
          )}
        </div>
      )}

      {!isInvoice && up.status !== 'en_analyse' && up.status !== 'erreur' && (
        <>
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <SearchableSelect
                value={up.account_id || ''}
                options={accounts.map((a) => ({ value: a.id, label: a.name }))}
                onChange={(v) => onChange(api.bank.statements.setAccount(up.id, v || null))}
                placeholder="Choisir le compte"
                testId="statement-account"
              />
            </div>
            {!up.account_id && <Badge color="red">Compte à choisir</Badge>}
            {up.account_id && up.detect_confidence < 0.6 && <Badge color="yellow">À confirmer</Badge>}
            {snap ? <SnapshotBadge snap={snap} /> : <BalanceBadge up={up} />}
            {up.drive_filing && (
              <span title={up.drive_file_name || ''} data-testid="statement-drive-filing">
                <Badge color={DRIVE_FILING[up.drive_filing].color}>{DRIVE_FILING[up.drive_filing].label}</Badge>
              </span>
            )}
          </div>

          {up.detect_evidence?.length > 0 && (
            <div className="text-xs text-slate-500">
              {up.detect_evidence.map((e) => `${e.label} : ${e.detail}`).join(' · ')}
            </div>
          )}
          {up.error && <div className="text-xs text-amber-700">{up.error}</div>}

          <button type="button" className="text-xs text-slate-400 hover:text-brand-600 underline"
            data-testid="statement-to-receipt" onClick={() => onToExtractor(up.id)}>
            c'est une facture
          </button>

          {snap && (
            <div className="text-sm text-slate-600" data-testid="statement-snapshot">
              {fmtMoney(snap.shown)}
              {snap.known != null && <span className="text-slate-400"> · Boréal {fmtMoney(snap.known)} ({fmtDate(snap.known_date)})</span>}
              {snap.verdict === 'different' && <span className="text-amber-700"> · Δ {fmtMoney(snap.delta)}</span>}
            </div>
          )}

          {!snap && <button className="flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900" onClick={onToggle}>
            <ChevronRight size={14} className={expanded ? 'rotate-90 transition-transform' : 'transition-transform'} />
            {fresh.length} neuve{fresh.length > 1 ? 's' : ''} · {rows.length - fresh.length} déjà en base
            {up.period_start && <span className="text-slate-400"> · {fmtDate(up.period_start)} → {fmtDate(up.period_end)}</span>}
          </button>}

          {!snap && expanded && (
            <div className="max-h-56 overflow-auto border-t border-slate-100 pt-1">
              <table className="w-full text-xs">
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className={`border-t border-slate-100 ${r._new ? '' : 'text-slate-400'}`}>
                      <td className="py-0.5 pr-2 whitespace-nowrap">{fmtDate(r.txn_date)}</td>
                      <td className="pr-2 truncate max-w-[20rem]">{r.description || r.details}</td>
                      <td className={`text-right whitespace-nowrap ${!r._new ? '' : r.amount < 0 ? 'text-red-700' : 'text-green-700'}`}>
                        {fmtMoney(r.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
