import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { Link } from 'react-router-dom'
import { Plus, RefreshCw, Landmark, ShieldAlert, CheckCircle2, HeartHandshake, Receipt, ExternalLink, Paperclip, Wallet, List, CalendarDays, ChevronLeft, ChevronRight, ChevronDown, AlertTriangle } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Modal } from '../components/Modal.jsx'
import { fmtDate, localISODate } from '../lib/formatDate.js'
import { fmtMoney, formatRelativeTime, parseAmountInput } from '../utils/formatters.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { useAutosave } from '../lib/useAutosave.js'
import { MissingReceiptsSection } from './VendorSubscriptions.jsx'

const fmtCad = (n, digits = 0) => fmtMoney(n, 'CAD', { maximumFractionDigits: digits, minimumFractionDigits: digits })

function Card({ title, description, icon: Icon, iconClass = 'bg-slate-100 text-slate-500', actions, children, testId, className = '' }) {
  return (
    <section className={`bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col ${className}`} data-testid={testId}>
      <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          {Icon && (
            <span className={`shrink-0 mt-0.5 h-8 w-8 rounded-lg flex items-center justify-center ${iconClass}`}>
              <Icon size={16} />
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-slate-900 leading-tight">{title}</h2>
            {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
          </div>
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      <div className="p-5 flex-1">{children}</div>
    </section>
  )
}

// ── Projection BNC ───────────────────────────────────────────────────────────

function RecurringModal({ item, onClose, onChanged }) {
  const isNew = !item?.id
  const [form, setForm] = useState(item || { frequency: 'monthly', active: 1 })
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // Édition d'une récurrente existante : autosave au blur / changement.
  // compare () => false : le save part même si la valeur semble inchangée
  // (comportement historique de cette modale — pas de skip).
  const { save, saving: autosaving } = useAutosave(item, patch => api.treasury.recurring.update(item.id, patch), {
    enabled: !isNew,
    compare: () => false,
    onSaved: () => onChanged(),
  })

  async function create() {
    if (!form.label?.trim()) { addToast({ message: 'Libellé requis', type: 'error' }); return }
    setSaving(true)
    try {
      await api.treasury.recurring.create(form)
      onChanged()
      onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30'
  const labelCls = 'block text-xs font-medium text-slate-500 mb-1'
  const field = (k, label, props = {}) => (
    <div>
      <label className={labelCls}>{label}</label>
      <input
        className={inputCls}
        value={form[k] ?? ''}
        onChange={e => set(k, e.target.value)}
        onBlur={e => save(k, e.target.value.trim() === '' ? null : e.target.value)}
        {...props}
      />
    </div>
  )

  return (
    <Modal isOpen onClose={onClose} title={isNew ? 'Nouvelle sortie récurrente' : form.label} size="md">
      <div className="grid grid-cols-2 gap-3">
        {field('label', 'Libellé', { 'data-testid': 'recurring-label' })}
        {field('amount', 'Montant (CAD)', { type: 'number', step: '0.01', min: '0' })}
        <div>
          <label className={labelCls}>Type de montant</label>
          <select
            className={inputCls}
            data-testid="recurring-variable"
            value={form.variable_amount ? 1 : 0}
            onChange={e => { const v = Number(e.target.value); set('variable_amount', v); save('variable_amount', v) }}
          >
            <option value={0}>Fixe — même montant à chaque occurrence</option>
            <option value={1}>Variable — à ressaisir à chaque occurrence</option>
          </select>
          {!!form.variable_amount && (
            <p className="text-[11px] text-slate-400 mt-1">
              Le montant saisi ne s'applique qu'à la prochaine occurrence (ex. relevé Mastercard). Une fois la date passée, il faudra le ressaisir.
            </p>
          )}
        </div>
        <div>
          <label className={labelCls}>Fréquence</label>
          <select
            className={inputCls}
            value={form.frequency ?? 'monthly'}
            onChange={e => { set('frequency', e.target.value); save('frequency', e.target.value) }}
          >
            <option value="weekly">Hebdomadaire</option>
            <option value="biweekly">Aux 2 semaines</option>
            <option value="monthly">Mensuelle</option>
            <option value="quarterly">Trimestrielle</option>
          </select>
        </div>
        {(form.frequency === 'monthly')
          ? field('day_of_month', 'Jour du mois (1-31)', { type: 'number', min: 1, max: 31 })
          : field('anchor_date', 'Date d\'ancrage (une occurrence connue)', { type: 'date' })}
        {/* Bornes : une dette dont les versements ne commencent que plus tard
            (DEC : nov. 2028) ou qui se termine à la fin de sa cédule ne doit
            pas être projetée en dehors de cette fenêtre. */}
        {field('starts_on', 'Débute le (optionnel)', { type: 'date', 'data-testid': 'recurring-starts-on' })}
        {field('ends_on', 'Se termine le (optionnel)', { type: 'date', 'data-testid': 'recurring-ends-on' })}
        <div>
          <label className={labelCls}>Statut</label>
          <select
            className={inputCls}
            value={form.active ?? 1}
            onChange={e => { const v = Number(e.target.value); set('active', v); save('active', v) }}
          >
            <option value={1}>Active</option>
            <option value={0}>Suspendue</option>
          </select>
        </div>
        <div className="col-span-2">
          <label className={labelCls}>Remplacée par les factures du fournisseur</label>
          <input
            className={inputCls}
            placeholder="ex. Inverness — laisser vide si la récurrente est la seule source"
            value={form.vendor_match ?? ''}
            onChange={e => set('vendor_match', e.target.value)}
            onBlur={e => save('vendor_match', e.target.value.trim() === '' ? null : e.target.value.trim())}
          />
          <p className="text-[11px] text-slate-400 mt-1">
            Quand une facture ou un paiement de ce fournisseur tombe près de l&apos;occurrence, c&apos;est le montant réel
            qui est projeté — plus la récurrente. Évite de compter deux fois le loyer.
          </p>
        </div>
        <div className="col-span-2">
          <label className={labelCls}>Notes</label>
          <textarea
            className={inputCls} rows={2}
            value={form.notes ?? ''}
            onChange={e => set('notes', e.target.value)}
            onBlur={e => save('notes', e.target.value.trim() === '' ? null : e.target.value)}
          />
        </div>
      </div>
      <div className="flex items-center justify-between mt-4">
        {isNew ? (
          // Bouton requis : pas encore d'id, autosave impossible avant l'INSERT.
          <div className="flex gap-2 ml-auto">
            <button onClick={onClose} className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">Annuler</button>
            <button onClick={create} disabled={saving} data-testid="recurring-create"
              className="px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
              {saving ? 'Création…' : 'Créer'}
            </button>
          </div>
        ) : (
          <>
            <button
              onClick={async () => {
                try { await api.treasury.recurring.delete(item.id); onChanged(); onClose() }
                catch (e) { addToast({ message: e.message, type: 'error' }) }
              }}
              className="text-sm text-red-600 hover:underline"
            >
              Supprimer
            </button>
            <span className="text-xs text-slate-400">{autosaving ? 'Sauvegarde…' : 'Modifications sauvegardées automatiquement'}</span>
          </>
        )}
      </div>
    </Modal>
  )
}

const FREQ_LABELS = { weekly: 'Hebdo', biweekly: 'Aux 2 sem.', monthly: 'Mensuelle', quarterly: 'Trimestrielle' }

// Mouvements du passé attendus par l'ERP mais pas retrouvés au relevé bancaire
// (voir `expectedStatus` côté serveur). Le relevé est importé à la main : sans
// cette couche, une sortie récurrente déjà tombée (loyer du 1er) n'apparaissait
// nulle part — ni dans la projection, qui repart d'aujourd'hui, ni dans le passé,
// qui ne connaît que le relevé.
const EXPECTED_SUFFIX = {
  missing: ' · attendu, absent du relevé',
  pending_statement: ' · attendu, relevé pas encore importé',
  still_due: ' · encore dû, compté aujourd\'hui',
  cleared: ' · confirmé sorti',
}
const EXPECTED_TITLE = {
  missing: 'Attendu mais introuvable au relevé — prélèvement non passé, ou montant différent',
  pending_statement: 'Attendu — le relevé BNC n\'est pas encore importé jusque-là',
  still_due: 'Attendu et encore dû — reprojeté aujourd\'hui dans la projection',
  cleared: 'Attendu, confirmé sorti du compte à la main',
}

// Fiche résumée d'une facture fournisseur, ouverte depuis un mouvement de la
// projection — l'essentiel seulement (montant à sortir, échéance, lignes, PDF),
// sans quitter le dashboard. Lien vers la fiche complète pour le reste.
function BillPeekModal({ peek, onClose }) {
  const [achat, setAchat] = useState(null)
  const [attachments, setAttachments] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    setAchat(null); setAttachments([]); setError(null)
    if (!peek) return
    api.achatsFournisseurs.get(peek.id).then(setAchat).catch(e => setError(e.message))
    api.achatsFournisseurs.attachments.list(peek.id).then(setAttachments).catch(() => {})
  }, [peek])

  async function download(att) {
    try {
      const { blob, filename } = await api.achatsFournisseurs.attachments.download(peek.id, att.id)
      const url = URL.createObjectURL(blob)
      const a = Object.assign(document.createElement('a'), { href: url, download: filename })
      a.click()
      URL.revokeObjectURL(url)
    } catch {}
  }

  let lines = []
  try { lines = JSON.parse(achat?.lines || '[]') } catch {}
  if (!Array.isArray(lines)) lines = []

  // À la fermeture, `peek` repasse à null avant que l'effet ne vide `achat` :
  // ne rien rendre plutôt que de lire peek.date sur null.
  if (!peek) return null

  return (
    <Modal isOpen={!!peek} title="Mouvement projeté — facture fournisseur" onClose={onClose}>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {!achat && !error && <div className="h-24 flex items-center justify-center text-sm text-slate-400">Chargement…</div>}
      {achat && (
        <div className="space-y-4">
          <div>
            <p className="text-lg font-semibold text-slate-900">{achat.vendor || 'Fournisseur inconnu'}</p>
            <p className="text-sm text-slate-500">
              {achat.vendor_invoice_number || achat.bill_number ? `Facture ${achat.vendor_invoice_number || achat.bill_number} · ` : ''}
              statut {achat.status}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Sortie projetée</p>
              <p className="font-semibold text-slate-900 tabular-nums">{fmtCad(achat.balance_due_cad, 2)}</p>
              {peek.date && <p className="text-xs text-slate-500">paiement prévu le {fmtDate(peek.date)}</p>}
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Échéance</p>
              <p className="font-semibold text-slate-900">{achat.due_date ? fmtDate(achat.due_date) : '—'}</p>
              <p className="text-xs text-slate-500">total {fmtCad(achat.total_cad, 2)}{Number(achat.amount_paid_cad) > 0 ? ` · payé ${fmtCad(achat.amount_paid_cad, 2)}` : ''}</p>
            </div>
          </div>

          {lines.length > 0 && (
            <div className="rounded-lg border border-slate-100 divide-y divide-slate-100 text-sm">
              {lines.map((l, i) => (
                <div key={i} className="px-3 py-1.5 flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-slate-700">{l.description || l.account_name || `Ligne ${i + 1}`}</span>
                  <span className="shrink-0 tabular-nums text-slate-600">{fmtCad(l.amount, 2)}</span>
                </div>
              ))}
            </div>
          )}

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map(att => (
                <button key={att.id} onClick={() => download(att)}
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">
                  <Paperclip size={13} /> {att.file_name || 'Pièce jointe'}
                </button>
              ))}
            </div>
          )}

          <div className="flex justify-end items-center gap-4 pt-1 border-t border-slate-100">
            {peek.qbUrl && (
              <a href={peek.qbUrl} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 hover:underline">
                Ouvrir dans QuickBooks <ExternalLink size={14} />
              </a>
            )}
            <Link to={`/fournisseurs/achats?id=${achat.id}`}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline">
              Ouvrir la fiche complète <ExternalLink size={14} />
            </Link>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ── Projection BNC : une carte qui se lit d'un coup d'œil ────────────────────
//
// Principe de lecture (refonte du 18 août 2026, demande utilisateur « je veux
// que ce soit très simple à scanner ») :
//   1. TROIS chiffres en haut — combien j'ai, quand ça devient serré, combien
//      virer. C'est la seule chose qu'on regarde 9 fois sur 10.
//   2. UNE ligne d'attention, repliée, qui ne s'ouvre d'elle-même que si de
//      l'argent risque de manquer (anomalie de lecture du fichier, montant non
//      compté). Tout le détail (sync du fichier, rentrées écartées, sorties en
//      retard, propositions apprises du relevé) vit dedans.
//   3. Le tableau des mouvements de la fenêtre d'action — le reste de l'horizon
//      est derrière un lien.
// Rien d'autre à l'écran : pas de description, pas de légende, pas de bandeau
// permanent. Le serveur, lui, garde tous ses garde-fous.


// Un des trois chiffres du haut. Pas d'icône, pas de bordure : la grille et la
// taille du chiffre suffisent à la hiérarchie.
function Stat({ label, value, sub, tone = 'slate', testId }) {
  const tones = { slate: 'text-slate-900', emerald: 'text-emerald-700', amber: 'text-amber-600', rose: 'text-rose-600' }
  return (
    <div className="px-4 py-3 first:pl-0 min-w-0">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400 truncate">{label}</p>
      <p className={`text-[26px] leading-tight font-semibold tabular-nums ${tones[tone] || tones.slate}`} data-testid={testId}>
        {value}
      </p>
      {sub && <p className="text-[11px] text-slate-400 truncate">{sub}</p>}
    </div>
  )
}

// Ligne du fichier Google Sheet — au fond du panneau d'attention. La sync est
// AUTOMATIQUE (horaire + à l'ouverture de la page) : le bouton ne reste que
// comme échappatoire, l'information utile est « lu il y a X ».
function SheetLine({ status, onSynced }) {
  const [syncing, setSyncing] = useState(false)
  const { addToast } = useToast()
  const run = status?.last_run
  const chain = run?.chain || null

  async function syncNow() {
    setSyncing(true)
    try {
      const r = await api.treasury.soldeSheet.sync()
      addToast({ message: r.summary, type: 'success' })
      onSynced?.()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSyncing(false)
    }
  }

  // Désactivée le 2026-08-29 (Charles : le fichier créait des paiements en
  // double avec Pmt_Suivi/la cédule — voir project memory). Le bouton
  // disparaît : le laisser cliquable aurait rouvert la même porte.
  if (status && !status.active) {
    return (
      <div className="text-[11px] text-slate-400" data-testid="treasury-sheet-sync">
        « Maintien du solde disponible BNC » · synchronisation désactivée (créait des paiements en double)
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between gap-3 text-[11px] text-slate-400" data-testid="treasury-sheet-sync">
      <span className="min-w-0 truncate">
        « Maintien du solde disponible BNC »
        {status?.every_minutes > 0 && (
          <span data-testid="treasury-sheet-cadence"> · auto {status.every_minutes} min</span>
        )}
        {' · '}
        {run
          ? (run.status === 'error'
            ? <span className="text-rose-600">échec — {run.error}</span>
            : <>
              synchronisé le {fmtDate(run.executed_at)}
              {chain && (
                <span className={chain.ok ? '' : 'text-rose-600'} data-testid="treasury-sheet-chain">
                  {' · '}{chain.checked} ligne{chain.checked > 1 ? 's' : ''} vérifiée{chain.checked > 1 ? 's' : ''}
                  {chain.ok ? '' : ` · ${chain.breaks.length} incohérence(s)`}
                </span>
              )}
            </>)
          : 'aucune sync encore exécutée'}
      </span>
      {/* Lecture du Drive + ajustements : action transactionnelle, donc bouton. */}
      <button onClick={syncNow} disabled={syncing} data-testid="treasury-sheet-sync-run"
        className="shrink-0 text-slate-400 hover:text-slate-700 disabled:opacity-40" title="Synchroniser maintenant">
        <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
      </button>
    </div>
  )
}

// Une ligne du panneau d'attention : étiquette courte à gauche, contenu à
// droite. La colonne d'étiquettes rend le panneau scannable — on saute à la
// rubrique cherchée sans lire de phrases.
function AttnRow({ label, tone = 'text-slate-600', testId, children }) {
  return (
    <div className="flex gap-2 items-baseline" data-testid={testId}>
      <span className="w-[68px] shrink-0 text-[10px] uppercase tracking-wide text-slate-400">{label}</span>
      <div className={`flex-1 min-w-0 ${tone}`}>{children}</div>
    </div>
  )
}

// Panneau d'attention : TOUT ce qui n'est pas un chiffre du haut ni un
// mouvement. Replié par défaut ; ouvert d'office quand de l'argent peut
// manquer (anomalie de lecture, montant non compté, découvert projeté).
function AttentionPanel({ proj, sheet, learning, recurring, onChanged, onSynced }) {
  const anomalies = sheet?.last_run?.anomalies || []
  const notCounted = sheet?.last_run?.not_counted || null
  const diffs = sheet?.last_run?.differences || []
  const late = proj?.late_events || []
  const excluded = proj?.inflows?.excluded || []
  const counted = proj?.inflows?.counted || []
  const learned = proj?.learned || []
  // Montant périmé mais estimé depuis l'historique : la sortie EST projetée, il
  // n'y a donc rien à saisir en urgence.
  const estimatedIds = new Set(learned.filter(l => l.estimated).map(l => l.id))
  const needsAmount = (recurring || []).filter(r => r.active
    && (!(Number(r.amount) > 0) || r.amount_stale) && !estimatedIds.has(r.id))
  // Propositions écartées par l'utilisateur : gardées localement, elles ne
  // doivent pas revenir le harceler à chaque ouverture de page.
  const [ignored, setIgnored] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('treasury_ignored_suggestions') || '[]')) } catch { return new Set() }
  })
  const ignore = key => {
    const next = new Set([...ignored, key])
    setIgnored(next)
    localStorage.setItem('treasury_ignored_suggestions', JSON.stringify([...next]))
  }
  const suggestions = (learning?.suggestions || []).filter(s => !ignored.has(s.key))
  const unseen = learning?.unseen || []
  const autoCleared = proj?.auto_cleared || []

  const hard = anomalies.filter(a => a.severity === 'error').length + (notCounted?.total > 0 ? 1 : 0)
  const soft = anomalies.length - anomalies.filter(a => a.severity === 'error').length
    + late.length + excluded.length + needsAmount.length + suggestions.length + unseen.length
  const total = hard + soft
  const [open, setOpen] = useState(false)
  // L'ouverture forcée ne se fait qu'une fois : si l'utilisateur referme, on ne
  // lui rouvre pas le panneau sous le nez à chaque rafraîchissement.
  const [forced, setForced] = useState(false)
  useEffect(() => {
    if (hard > 0 && !forced) { setOpen(true); setForced(true) }
  }, [hard, forced])

  const [busyKey, setBusyKey] = useState(null)
  const { addToast } = useToast()

  async function markCleared(e) {
    setBusyKey(e.event_key)
    try {
      await api.treasury.markCleared({
        event_key: e.event_key, label: e.label, amount: e.amount, event_date: e.original_date,
      })
      onChanged()
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally { setBusyKey(null) }
  }

  async function adopt(s) {
    setBusyKey(s.key)
    try {
      await api.treasury.learning.adopt(s)
      addToast({ message: `${s.label} ajouté aux sorties récurrentes`, type: 'success' })
      onChanged()
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally { setBusyKey(null) }
  }

  if (!total && !learned.length && !autoCleared.length && !sheet) return null

  const tone = hard ? 'text-rose-700' : total ? 'text-amber-700' : 'text-slate-400'
  const summary = total
    ? `${total} point${total > 1 ? 's' : ''} à vérifier`
    : 'Tout concorde avec la banque et le fichier'

  return (
    <div className="mb-4 rounded-lg border border-slate-200" data-testid="treasury-attention">
      <button type="button" onClick={() => setOpen(o => !o)} data-testid="treasury-attention-toggle"
        className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-slate-50 rounded-lg">
        {open ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
        {hard ? <AlertTriangle size={13} className="text-rose-600" /> : total ? <AlertTriangle size={13} className="text-amber-500" /> : <CheckCircle2 size={13} className="text-emerald-500" />}
        <span className={`font-medium ${tone}`}>{summary}</span>
        {notCounted?.total > 0 && (
          <span className="text-rose-700" data-testid="treasury-sheet-not-counted">
            · {fmtCad(notCounted.total, 2)} non comptés
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-slate-100 px-3 py-2.5 space-y-1.5 text-xs">
          {/* Lecture du fichier : une ligne illisible est de l'argent qui sortira
              sans avoir été projeté — c'est le plus grave de ce panneau. */}
          {anomalies.length > 0 && (
            <AttnRow label="Lecture">
              <ul className="space-y-0.5" data-testid="treasury-sheet-anomalies">
                {anomalies.map((a, i) => (
                  <li key={i} className={a.severity === 'error' ? 'text-rose-800' : 'text-amber-800'}>{a.text}</li>
                ))}
              </ul>
            </AttnRow>
          )}

          {/* Sorties datées depuis la saisie du solde que la banque ne confirme
              pas encore. Le relevé en confirme la plupart tout seul — il ne
              reste ici que le doute. La date du solde tient dans l'étiquette :
              chaque pastille porte déjà son propre montant et sa date. */}
          {late.length > 0 && (
            <AttnRow label="Encore dû" testId="treasury-late-events">
              <div className="flex flex-wrap gap-1">
                {late.map(e => (
                  <span key={e.event_key} className="inline-flex items-center gap-1 bg-white border border-amber-200 rounded-full pl-2 pr-1 py-px text-amber-900">
                    {e.label} {fmtCad(e.amount, 2)} · {fmtDate(e.original_date)}
                    <button type="button" onClick={() => markCleared(e)} disabled={busyKey === e.event_key}
                      className="text-amber-600 hover:text-amber-900 px-1 disabled:opacity-40" title="Déjà sorti du compte">
                      {busyKey === e.event_key ? '…' : 'déjà sorti'}
                    </button>
                  </span>
                ))}
                <span className="text-slate-400 self-center">depuis le solde du {fmtDate(proj.balance_day)}</span>
              </div>
            </AttnRow>
          )}

          {/* Rentrées : ce qui est compté, ce qui est écarté faute de certitude. */}
          {(counted.length > 0 || excluded.length > 0) && (
            <AttnRow label="Rentrées" tone="text-slate-500" testId="treasury-inflows">
              {counted.length > 0 && (
                <span>{counted.length} comptée{counted.length > 1 ? 's' : ''} · {fmtCad(proj.inflows.total_counted, 2)}</span>
              )}
              {excluded.length > 0 && (
                <span className="text-amber-800" data-testid="treasury-inflows-excluded">
                  {counted.length > 0 ? ' · ' : ''}
                  {fmtCad(proj.inflows.total_excluded, 2)} non compté ({excluded.map(p => p.reason).join(' ; ')})
                </span>
              )}
            </AttnRow>
          )}

          {needsAmount.length > 0 && (
            <AttnRow label="À saisir" tone="text-amber-800">
              {needsAmount.map(r => r.label).join(', ')} <span className="text-slate-400">— hors projection</span>
            </AttnRow>
          )}

          {/* Ce que le relevé a corrigé tout seul : la trace de l'apprentissage.
              Sans elle, un montant projeté différent du montant saisi serait
              incompréhensible. */}
          {learned.length > 0 && (
            <AttnRow label="Relevé" tone="text-slate-500" testId="treasury-learned">
              {learned.map(l => `${l.label} ${fmtCad(l.to, 0)}${l.estimated ? ' (moy.)' : l.from ? ` (saisi ${fmtCad(l.from, 0)})` : ''}`).join(' · ')}
            </AttnRow>
          )}

          {autoCleared.length > 0 && (
            <AttnRow label="Passés" tone="text-slate-500" testId="treasury-auto-cleared">
              {autoCleared.map(e => `${e.label} ${fmtCad(e.bank_amount, 2)} le ${fmtDate(e.bank_date)}`).join(' · ')}
            </AttnRow>
          )}

          {unseen.length > 0 && (
            <AttnRow label="Jamais vu" tone="text-amber-800" testId="treasury-unseen">
              {unseen.map(u => `${u.label} ${fmtCad(u.amount, 0)}`).join(' · ')}
            </AttnRow>
          )}

          {/* Prélèvements périodiques détectés au relevé mais absents de l'ERP :
              proposés, jamais ajoutés d'office. */}
          {suggestions.length > 0 && (
            <AttnRow label="Proposé" testId="treasury-suggestions">
              <div className="flex flex-wrap gap-1">
                {suggestions.map(s => (
                  <span key={s.key} className="inline-flex items-center gap-1 bg-white border border-slate-200 rounded-full pl-2 pr-1 py-px text-slate-600">
                    {s.label} {fmtCad(s.amount, 2)} · {FREQ_LABELS[s.frequency] || s.frequency} · {s.n}×
                    <button type="button" onClick={() => adopt(s)} disabled={busyKey === s.key}
                      className="text-brand-600 hover:text-brand-800 px-1 disabled:opacity-40" title="Ajouter aux sorties récurrentes">
                      {busyKey === s.key ? '…' : 'ajouter'}
                    </button>
                    <button type="button" onClick={() => ignore(s.key)}
                      className="text-slate-300 hover:text-slate-600 px-0.5" title="Ne plus proposer">×</button>
                  </span>
                ))}
                <span className="text-slate-400 self-center">{fmtCad(learning.suggestions_monthly_total, 0)}/mois</span>
              </div>
            </AttnRow>
          )}

          {diffs.length > 0 && (
            <AttnRow label="Ajusté" tone="text-slate-500">
              <ul className="space-y-0.5" data-testid="treasury-sheet-sync-diffs">
                {diffs.map((d, i) => (
                  <li key={i}>{d.text}{!d.adjusted && <span className="text-slate-400"> — non ajusté</span>}</li>
                ))}
              </ul>
            </AttnRow>
          )}

          {sheet && <AttnRow label="Fichier"><SheetLine status={sheet} onSynced={onSynced} /></AttnRow>}
        </div>
      )}
    </div>
  )
}

// Vue calendrier mensuelle de la projection : chaque jour de l'horizon affiche
// son solde projeté (coloré selon le seuil) et ses mouvements en pastilles
// cliquables — mêmes cibles que la vue liste (facture, payout, récurrente).
function ProjectionCalendar({ days, threshold, renderEvent }) {
  const todayStr = localISODate()
  const [month, setMonth] = useState(todayStr.slice(0, 7)) // 'YYYY-MM'
  const byDate = useMemo(() => new Map(days.map(d => [d.date, d])), [days])

  const [y, m] = month.split('-').map(Number)
  const first = new Date(y, m - 1, 1)
  // Grille alignée sur dimanche ; les semaines entièrement hors mois sont omises.
  const start = new Date(y, m - 1, 1 - first.getDay())
  const weeks = []
  for (let w = 0; w < 6; w++) {
    const week = []
    for (let i = 0; i < 7; i++) {
      const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + i)
      week.push({ date: localISODate(dt), inMonth: dt.getMonth() === m - 1, dayNum: dt.getDate() })
    }
    if (week.some(c => c.inMonth)) weeks.push(week)
  }
  const nav = delta => setMonth(localISODate(new Date(y, m - 1 + delta, 1)).slice(0, 7))
  const monthLabel = first.toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' })
  const navBtn = 'h-6 w-6 rounded-md flex items-center justify-center text-slate-500 hover:bg-slate-100'

  return (
    <div className="rounded-lg border border-slate-100 overflow-hidden" data-testid="treasury-calendar">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100">
        <span className="text-sm font-semibold text-slate-800 capitalize" data-testid="treasury-calendar-month">{monthLabel}</span>
        <div className="flex items-center gap-1">
          {month !== todayStr.slice(0, 7) && (
            <button type="button" onClick={() => setMonth(todayStr.slice(0, 7))}
              className="text-xs font-medium text-brand-600 hover:underline mr-1.5">
              Aujourd&apos;hui
            </button>
          )}
          <button type="button" onClick={() => nav(-1)} className={navBtn} title="Mois précédent" data-testid="treasury-calendar-prev"><ChevronLeft size={15} /></button>
          <button type="button" onClick={() => nav(1)} className={navBtn} title="Mois suivant" data-testid="treasury-calendar-next"><ChevronRight size={15} /></button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-[10px] font-medium uppercase tracking-wide text-slate-400 border-b border-slate-100">
        {['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'].map(d => <div key={d} className="py-1">{d}</div>)}
      </div>
      {weeks.map((week, wi) => (
        <div key={wi} className={`grid grid-cols-7 ${wi > 0 ? 'border-t border-slate-100' : ''}`}>
          {week.map(cell => {
            const day = byDate.get(cell.date)
            const isToday = cell.date === todayStr
            const balCls = day == null ? '' : day.balance < 0 ? 'text-rose-600' : day.balance < threshold ? 'text-amber-600' : 'text-slate-400'
            return (
              <div key={cell.date}
                className={`min-h-[4.5rem] p-1 border-l border-slate-100 first:border-l-0 ${cell.inMonth ? '' : 'bg-slate-50/70'}`}>
                <div className="flex items-center justify-between gap-1 mb-0.5">
                  <span className={`text-[11px] tabular-nums leading-none ${isToday
                    ? 'h-[1.125rem] min-w-[1.125rem] px-0.5 rounded-full bg-brand-600 text-white font-semibold flex items-center justify-center'
                    : cell.inMonth ? 'text-slate-500' : 'text-slate-300'}`}>
                    {cell.dayNum}
                  </span>
                  {day != null && (
                    <span className={`text-[10px] tabular-nums font-medium truncate ${balCls}`} title={`Solde projeté : ${fmtCad(day.balance)}`}>
                      {fmtCad(day.balance)}
                    </span>
                  )}
                </div>
                <div className="space-y-0.5">
                  {(day?.events || []).map((e, i) => renderEvent(e, cell.date, i, true))}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

export function TreasuryProjectionSection() {
  const [proj, setProj] = useState(null)
  const [recurring, setRecurring] = useState([])
  const [sheet, setSheet] = useState(null)
  const [learning, setLearning] = useState(null)
  const [balanceInput, setBalanceInput] = useState('')
  const [noting, setNoting] = useState(false)
  const [editing, setEditing] = useState(null) // {} = nouveau, {id...} = édition
  const [billPeek, setBillPeek] = useState(null) // {id, date} = facture fournisseur cliquée
  const [showBeyond, setShowBeyond] = useState(false)
  // Vue des mouvements : liste chronologique ou calendrier mensuel (mémorisé).
  const [projView, setProjView] = useState(() => localStorage.getItem('treasury_proj_view') || 'list')
  const switchView = v => { setProjView(v); localStorage.setItem('treasury_proj_view', v) }
  const [recurringOpen, setRecurringOpen] = useState(() => localStorage.getItem('treasury_recurring_open') === '1')
  useEffect(() => { localStorage.setItem('treasury_recurring_open', recurringOpen ? '1' : '0') }, [recurringOpen])
  const { addToast } = useToast()

  const load = useCallback(() => {
    api.treasury.projection().then(setProj).catch(() => {})
    api.treasury.recurring.list().then(setRecurring).catch(() => {})
    api.treasury.soldeSheet.status().then(setSheet).catch(() => {})
    api.treasury.learning.get().then(setLearning).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  // Sync du fichier À L'OUVERTURE quand il n'a pas été lu depuis 20 min : la
  // page affiche toujours la donnée du fichier sans que personne ne clique.
  // Silencieuse — seul le résultat (chiffres, panneau d'attention) est visible.
  useEffect(() => {
    let alive = true
    api.treasury.soldeSheet.syncIfStale(20)
      .then(r => { if (alive && r && r.skipped === false) load() })
      .catch(() => {})
    return () => { alive = false }
  }, [load])

  async function noteBalance() {
    const n = Number(balanceInput.replace(/\s/g, '').replace(',', '.'))
    if (!Number.isFinite(n)) { addToast({ message: 'Entrer un montant valide', type: 'error' }); return }
    setNoting(true)
    try {
      await api.treasury.noteBalance(n)
      setBalanceInput('')
      load()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setNoting(false)
    }
  }

  const entry = proj?.balance_entry
  const aw = proj?.action_window
  const eventDays = (proj?.days || []).filter(d => d.events.length > 0)
  const awEndDate = aw && proj?.days?.[Math.min(aw.days, proj.days.length - 1)]?.date
  const withinDays = awEndDate ? eventDays.filter(d => d.date <= awEndDate) : eventDays
  const beyondDays = awEndDate ? eventDays.filter(d => d.date > awEndDate) : []
  const visibleDays = showBeyond ? eventDays : withinDays
  const learnedById = new Map((proj?.learned || []).map(l => [l.id, l]))
  // « À saisir » ne compte que ce qui manque VRAIMENT : une récurrente dont le
  // montant est estimé depuis le relevé est déjà projetée.
  const needsAmount = recurring.filter(r => r.active
    && (!(Number(r.amount) > 0) || r.amount_stale) && !learnedById.get(r.id)?.estimated)
  // Point de tension : le premier passage sous le seuil, ou le négatif s'il y en a.
  const low = proj?.first_negative || proj?.first_below_threshold || null

  // Pastille d'un mouvement — partagée entre la vue liste et le calendrier
  // (compact) : chaque mouvement mène à sa source (facture fournisseur en
  // modale, payout Stripe en fiche, récurrente en modale ici).
  const renderEvent = (e, date, i, compact = false) => {
    const tone = e.expected
      ? 'bg-white border border-dashed border-slate-300 text-slate-500'
      : e.amount >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'
    const cls = compact
      ? `block w-full text-left truncate text-[10px] leading-4 px-1 py-px rounded ${tone}`
      : `inline-block mr-1.5 mb-0.5 text-xs px-2 py-0.5 rounded-full ${tone}`
    const amountTxt = `${e.amount >= 0 ? '+' : '−'}${fmtCad(Math.abs(e.amount))}`
    const suffix = e.expected ? EXPECTED_SUFFIX[e.expected_status] || ' · attendu' : ''
    // En calendrier la cellule est étroite : le montant d'abord, le libellé
    // tronqué ensuite, et tout le détail dans l'infobulle.
    const text = compact
      ? <>{amountTxt} {e.label}</>
      : <>{e.label} {amountTxt}<span className="opacity-70">{suffix}</span></>
    // Montant appris du relevé : dit dans l'infobulle, pas à l'écran.
    const learnedTitle = e.learned
      ? `Montant observé au compte (${e.learned.n} occurrences) — saisi : ${fmtCad(e.learned.from, 2)}`
      : null
    const expectedTitle = e.expected
      ? `${EXPECTED_TITLE[e.expected_status] || 'Attendu'} · ${e.label} ${amountTxt} le ${fmtDate(e.date)}`
      : null
    const compactTitle = `${e.label} · ${amountTxt}${suffix}`
    const title = learnedTitle || expectedTitle || (compact ? compactTitle : undefined)
    if (e.kind === 'bill' && e.ref) {
      const open = () => setBillPeek({ id: e.ref, date, qbUrl: e.qb_url })
      if (compact) return (
        <button key={i} type="button" onClick={open}
          className={`${cls} hover:ring-1 hover:ring-slate-300`}
          title={`${title || compactTitle} — voir la facture fournisseur`}>{text}</button>
      )
      return (
        <span key={i} className="inline-flex items-center mr-1.5 mb-0.5">
          <button type="button" onClick={open}
            className={`${cls} !mr-0 !mb-0 ${e.qb_url ? '!rounded-r-none' : ''} hover:ring-1 hover:ring-slate-300`}
            title="Voir la facture fournisseur">{text}</button>
          {e.qb_url && (
            <a href={e.qb_url} target="_blank" rel="noreferrer"
              className="inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-r-full border-l border-white bg-slate-100 text-slate-500 hover:bg-emerald-50 hover:text-emerald-700"
              title="Ouvrir l'écriture dans QuickBooks">QB</a>
          )}
        </span>
      )
    }
    if (e.kind === 'payment') return (
      <Link key={i} to="/paiements-emis" className={`${cls} hover:ring-1 hover:ring-slate-300`}
        title={`${e.label} ${amountTxt} — paiement émis, pas encore passé à la banque`}>{text}</Link>
    )
    if (e.kind === 'payout' && e.ref) return (
      <Link key={i} to={`/stripe-payouts/${e.ref}`} className={`${cls} hover:ring-1 hover:ring-emerald-300`}
        title={compact ? `${title || compactTitle} — voir le payout Stripe` : 'Voir le payout Stripe'}>{text}</Link>
    )
    if (e.kind === 'recurring' && e.ref) {
      const rec = recurring.find(r => r.id === e.ref)
      if (rec) return (
        <button key={i} type="button" onClick={() => setEditing(rec)} className={`${cls} hover:ring-1 hover:ring-slate-300`}
          title={learnedTitle || (compact ? `${compactTitle} — voir la sortie récurrente` : 'Voir la sortie récurrente')}>{text}</button>
      )
    }
    return <span key={i} className={cls} title={title}>{text}</span>
  }

  return (
    <div data-testid="treasury-section">
      <Card
        title="Projection du solde BNC (CAD)"
        icon={Landmark}
        iconClass="bg-brand-50 text-brand-600"
        actions={
          <div className="flex items-center gap-2">
            <input
              type="text" inputMode="decimal"
              value={balanceInput}
              onChange={e => setBalanceInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') noteBalance() }}
              placeholder="Corriger le solde"
              className="w-40 px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              data-testid="treasury-balance-input"
            />
            {/* Action transactionnelle : chaque saisie crée une entrée horodatée */}
            <button onClick={noteBalance} disabled={noting} data-testid="treasury-balance-save"
              className="px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50 whitespace-nowrap">
              {noting ? '…' : 'Noter'}
            </button>
          </div>
        }
        className="mb-6"
      >
        {!proj && <div className="h-24 flex items-center justify-center text-sm text-slate-400">Chargement…</div>}

        {proj && (
          <>
            {/* Les trois chiffres. Rien d'autre au premier regard. */}
            <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-slate-100 mb-4">
              <Stat
                label="Solde BNC noté"
                value={entry ? fmtCad(entry.balance, 0) : '—'}
                sub={entry
                  ? [formatRelativeTime(entry.noted_at), sheet?.last_run && !sheet.last_run.error ? `fichier lu ${formatRelativeTime(sheet.last_run.executed_at)}` : null]
                    .filter(Boolean).join(' · ')
                  : 'aucune saisie'}
                tone={entry && !proj.balance_stale ? 'slate' : 'amber'}
              />
              {low ? (
                <Stat
                  label={proj.first_negative ? 'Découvert projeté' : 'Passage sous le seuil'}
                  value={fmtCad(low.balance)}
                  sub={`le ${fmtDate(low.date)}`}
                  tone={proj.first_negative ? 'rose' : 'amber'}
                  testId="treasury-min-balance"
                />
              ) : (
                <Stat
                  label="Point bas"
                  value={fmtCad(proj.min_balance)}
                  sub={`le ${fmtDate(proj.min_date)} · au-dessus du seuil`}
                  tone="emerald"
                  testId="treasury-min-balance"
                />
              )}
              {aw?.suggested_transfer > 0 ? (
                <Stat
                  label={`Virement d'ici ${aw.days} j`}
                  value={fmtCad(aw.suggested_transfer)}
                  sub="Venn → BNC (Interac)"
                  tone="rose"
                  testId="treasury-transfer-suggestion"
                />
              ) : (
                <Stat label="Virement" value="Aucun" sub={`d'ici ${aw?.days ?? 14} jours`} tone="emerald"
                  testId="treasury-transfer-suggestion" />
              )}
            </div>

            <AttentionPanel proj={proj} sheet={sheet} learning={learning} recurring={recurring}
              onChanged={load} onSynced={load} />

            <div className="min-w-0">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Mouvements à venir</h3>
                <div className="flex items-center rounded-lg border border-slate-200 p-0.5" role="tablist" aria-label="Vue des mouvements">
                  {[{ v: 'list', icon: List, label: 'Liste' }, { v: 'calendar', icon: CalendarDays, label: 'Calendrier' }].map(({ v, icon: Icon, label }) => (
                    <button key={v} type="button" onClick={() => switchView(v)} title={label}
                      role="tab" aria-selected={projView === v} data-testid={`treasury-view-${v}`}
                      className={`h-6 w-7 rounded-md flex items-center justify-center transition-colors ${projView === v ? 'bg-slate-100 text-slate-700' : 'text-slate-400 hover:text-slate-600'}`}>
                      <Icon size={14} />
                    </button>
                  ))}
                </div>
              </div>
              {projView === 'calendar' ? (
                <ProjectionCalendar days={proj.days || []} threshold={proj.threshold} renderEvent={renderEvent} />
              ) : (
              <>
              <div className="overflow-x-auto rounded-lg border border-slate-100">
                <table className="w-full text-sm">
                  <tbody>
                    {visibleDays.map(d => {
                      const beyond = awEndDate && d.date > awEndDate
                      const weekday = new Date(`${d.date}T12:00:00`).toLocaleDateString('fr-CA', { weekday: 'short' })
                      return (
                        <tr key={d.date} className={`border-b border-slate-50 last:border-0 align-top hover:bg-slate-50/60 ${beyond ? 'opacity-50' : ''}`}>
                          <td className="py-2 pl-3 pr-2 whitespace-nowrap text-slate-500 w-32">
                            <span className="text-slate-400 mr-1">{weekday.replace('.', '')}</span>{fmtDate(d.date)}
                          </td>
                          <td className="py-2 px-2">{d.events.map((e, i) => renderEvent(e, d.date, i))}</td>
                          <td className={`py-2 pl-2 pr-3 text-right tabular-nums font-semibold whitespace-nowrap w-28 ${d.balance < 0 ? 'text-rose-600' : d.balance < proj.threshold ? 'text-amber-600' : 'text-slate-700'}`}>
                            {fmtCad(d.balance)}
                          </td>
                        </tr>
                      )
                    })}
                    {!visibleDays.length && (
                      <tr><td className="py-4 px-3 text-sm text-slate-400">Aucun mouvement d&apos;ici {aw?.days ?? 14} jours.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {beyondDays.length > 0 && (
                <button type="button" onClick={() => setShowBeyond(v => !v)} data-testid="treasury-beyond-toggle"
                  className="mt-1.5 text-[11px] text-slate-400 hover:text-slate-600">
                  {showBeyond
                    ? `Masquer au-delà de ${aw.days} jours`
                    : `+ ${beyondDays.length} jour${beyondDays.length > 1 ? 's' : ''} au-delà de ${aw.days} jours`}
                </button>
              )}
              </>
              )}
            </div>

            {/* Sorties récurrentes : de la configuration, donc repliée. */}
            <div className="mt-4 min-w-0 rounded-lg border border-slate-100">
              <div className="flex items-center justify-between px-3 py-2">
                <button type="button" onClick={() => setRecurringOpen(o => !o)}
                  data-testid="treasury-recurring-toggle"
                  className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-700">
                  {recurringOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  Sorties récurrentes
                  <span className="normal-case font-normal text-slate-400">
                    {recurring.filter(r => r.active).length}
                    {needsAmount.length > 0 && <span className="text-amber-600"> · {needsAmount.length} à saisir</span>}
                  </span>
                </button>
                <button onClick={() => setEditing({})} data-testid="recurring-add"
                  className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">
                  <Plus size={13} /> Ajouter
                </button>
              </div>
              {recurringOpen && (
                <div className="border-t border-slate-100 divide-y divide-slate-100">
                  {recurring.map(r => {
                    const lrn = learnedById.get(r.id)
                    return (
                      <button key={r.id} onClick={() => setEditing(r)}
                        className={`w-full text-left px-3 py-2 flex items-center justify-between gap-3 hover:bg-slate-50 ${r.active ? '' : 'opacity-50'}`}>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-slate-800 truncate">{r.label}</span>
                          <span className="block text-[11px] text-slate-400">
                            {FREQ_LABELS[r.frequency] || r.frequency}
                            {r.frequency === 'monthly' && r.day_of_month ? ` · le ${lrn?.to_day || r.day_of_month}` : ''}
                            {r.vendor_match ? ` · via les factures « ${r.vendor_match} »` : ''}
                            {r.ends_on ? ` · jusqu'au ${fmtDate(r.ends_on)}` : ''}
                            {r.starts_on ? ` · dès le ${fmtDate(r.starts_on)}` : ''}
                            {!r.active ? ' · suspendue' : ''}
                          </span>
                        </span>
                        <span className="shrink-0 text-sm tabular-nums font-medium text-slate-700">
                          {lrn
                            // Montant projeté = celui du relevé ; la saisie reste
                            // visible en infobulle pour ne rien cacher.
                            ? <span title={`Observé au compte (${lrn.n} occurrences) · saisi ${fmtCad(lrn.from, 2)}`}>
                              {fmtCad(lrn.to, 2)}
                            </span>
                            : !(Number(r.amount) > 0) || (r.variable_amount && r.amount_stale)
                              ? <span className="text-amber-600">à saisir</span>
                              : fmtCad(r.amount, 2)}
                        </span>
                      </button>
                    )
                  })}
                  {!recurring.length && (
                    <p className="px-3 py-3 text-sm text-slate-400">Aucune sortie récurrente.</p>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {editing !== null && (
          <RecurringModal
            item={editing.id ? editing : null}
            onClose={() => setEditing(null)}
            onChanged={load}
          />
        )}

        <BillPeekModal peek={billPeek} onClose={() => setBillPeek(null)} />
      </Card>
    </div>
  )
}

// Comptabilisation de la paie — réplique la section « SALAIRES » de l'onglet
// Paie & Ass. coll. du CTB - Suivi : on saisit le montant passé au compte BNC,
// les remboursements de dépenses (items de la paie) et le téléphone Martin sont
// déduits, le reste est réparti au prorata entre les départements, puis la
// dépense QB (fournisseur « Salaires ») est publiée au modèle des transactions
// historiques, avec la période de paie en mémo et en description.
// Paies à comptabiliser : période terminée (le débit bancaire suit la fin de
// période) et pas encore de dépense QB associée.
function todoPaies(paies) {
  const today = localISODate()
  return paies.filter(p => p.period_end && p.period_end <= today && !p.salary_purchase_id)
}

// Ce que la carte propose : les paies à comptabiliser + la dernière déjà
// comptabilisée — sans elle, une dépense publiée deviendrait inatteignable
// (donc incorrigible) dès le rechargement de la page.
function selectablePaies(paies) {
  const done = paies.filter(p => p.salary_purchase_id).slice(0, 1)
  return [...todoPaies(paies), ...done]
}

function PaieComptabilisationCard() {
  const [paies, setPaies] = useState([])
  const [paieId, setPaieId] = useState('')
  const [loaded, setLoaded] = useState(false)
  // Montant saisi à la main = le débit réellement vu au compte BNC (pas de
  // pré-remplissage, demande utilisateur — le total Airtable/l'estimation ne
  // servent que de repère). Seule la date est pré-remplie (« Débité » Airtable).
  const [bankAmount, setBankAmount] = useState('')
  const [txnDate, setTxnDate] = useState(() => localISODate())
  // Téléphone Martin : détecté dans les items de la paie (remboursement de
  // dépense de 25 $ de Martin, une fois par mois) — jamais saisi ici, jamais
  // compté en double avec les remboursements.
  const [preview, setPreview] = useState(null)
  // Déductions du montant BNC (remb. de dépenses par employé + téléphone) :
  // connues dès la sélection de la paie, donc affichées sans attendre le
  // montant, sous le champ de saisie.
  const [deductions, setDeductions] = useState(null)
  const [deductionsOpen, setDeductionsOpen] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [fixing, setFixing] = useState(false)
  const [error, setError] = useState(null)
  const [pushing, setPushing] = useState(false)
  const [pushed, setPushed] = useState(null)
  const { addToast } = useToast()

  useEffect(() => {
    // Réconciliation d'abord : marque les paies dont la dépense « Paie – X au Y »
    // existe déjà dans QB (comptabilisées à la main / avant l'ERP), pour ne
    // proposer que les périodes réellement à faire.
    api.paies.salaryExpenseReconcile().catch(() => {}).then(() =>
      api.paies.list({ limit: 12 }).then(({ data }) => {
        setPaies(data)
        setLoaded(true)
        // Présélection : la plus ancienne paie passée pas encore comptabilisée
        // (on comptabilise dans l'ordre chronologique) ; sinon la dernière
        // comptabilisée, pour rester consultable et corrigeable.
        const opts = selectablePaies(data)
        if (opts.length) selectPaie(todoPaies(data).slice(-1)[0] || opts[0])
      })
    ).catch(() => setLoaded(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const paie = paies.find(p => p.id === paieId)
  const todos = selectablePaies(paies)
  // Le total Airtable n'existe qu'une fois les remises aux organismes saisies
  // (avant ça, la formule Airtable est ≤ 0 et le sync laisse le champ vide).
  const airtableTotal = Number(paie?.total_with_charges_and_reimb) > 0 ? Number(paie.total_with_charges_and_reimb) : null

  // Sélection d'une paie : pré-remplit le montant avec le total Airtable
  // (à confirmer contre le débit BNC) et rafraîchit l'aperçu.
  function selectPaie(p) {
    setPaieId(p.id)
    setPushed(null)
    setPreview(null)
    setError(null)
    // Date : « Débité » des items Airtable (jour du débit BNC), sinon aujourd'hui.
    const date = p.debited_date || localISODate()
    setTxnDate(date)
    // Paie déjà comptabilisée : on remet le montant débité enregistré pour
    // revoir la ventilation telle qu'elle est dans QuickBooks. Sinon vide — le
    // montant BNC se saisit toujours à la main.
    const booked = p.salary_purchase_id && Number(p.total_with_charges_and_reimb) > 0
      ? String(p.total_with_charges_and_reimb) : ''
    setBankAmount(booked)
    setDeductions(null)
    api.paies.salaryExpenseDeductions(p.id).then(setDeductions).catch(() => setDeductions(null))
    if (booked) loadPreview({ paieId: p.id, bankAmount: booked, txnDate: date })
  }

  // Libellé de période : « du X au Y » quand le début est connu, sinon l'ancien format.
  function periodLabel(p) {
    if (p.period_start && p.period_end) return `Période du ${p.period_start} au ${p.period_end}`
    return `Période finissant le ${p.period_end || '?'}`
  }

  function paieOptionLabel(p) {
    return [
      p.number != null ? `#${p.number}` : null,
      periodLabel(p),
      p.salary_purchase_id ? '✓ comptabilisée' : null,
    ].filter(Boolean).join(' — ')
  }

  const loadPreview = useCallback((opts = {}) => {
    const id = opts.paieId ?? paieId
    // Virgule décimale et espaces de milliers tolérés.
    const n = parseAmountInput(opts.bankAmount ?? bankAmount)
    if (!id || !(n > 0)) { setPreview(null); setError(null); return }
    api.paies.salaryExpensePreview(id, { bank_amount: n, txn_date: opts.txnDate ?? txnDate })
      .then(p => { setPreview(p); setError(null) })
      .catch(e => { setError(e.message); setPreview(null) })
  }, [paieId, bankAmount, txnDate])

  // Resynchronise les items de paie depuis Airtable (colonne « Remb. dépenses »)
  // puis recharge déductions et aperçu.
  async function refreshDeductions() {
    if (!paieId) return
    setRefreshing(true)
    try {
      setDeductions(await api.paies.salaryExpenseDeductionsRefresh(paieId))
      loadPreview()
      addToast({ message: 'Items de paie resynchronisés depuis Airtable', type: 'success' })
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setRefreshing(false)
    }
  }

  // Republie une dépense déjà comptabilisée à partir des données courantes —
  // pour rattraper un remboursement arrivé dans Airtable après la publication.
  // Un clic = l'action (pas de re-confirmation) : le bouton dit déjà ce qu'il fait.
  async function fixPushed() {
    setFixing(true)
    try {
      const out = await api.paies.salaryExpenseUpdate(paieId, { txn_date: txnDate })
      setPreview(out.preview)
      addToast({ message: `Dépense QuickBooks #${out.qb_purchase_id} corrigée`, type: 'success' })
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setFixing(false)
    }
  }

  async function push() {
    setPushing(true)
    try {
      const out = await api.paies.salaryExpensePush(paieId, {
        bank_amount: parseAmountInput(bankAmount), txn_date: txnDate,
      })
      setPushed({ id: out.qb_purchase_id, url: out.qb_purchase_url })
      setPaies(ps => ps.map(p => p.id === paieId ? { ...p, salary_purchase_id: out.qb_purchase_id } : p))
      addToast({ message: `Dépense publiée dans QuickBooks (#${out.qb_purchase_id})`, type: 'success' })
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setPushing(false)
    }
  }

  const alreadyPushed = pushed?.id || paie?.salary_purchase_id
  const alreadyPushedUrl = pushed?.url || paie?.salary_purchase_url
  const inputCls = 'px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30'
  const KIND_LABELS = { reimb: 'Remb. dépenses' }

  return (
    <Card
      title="Comptabilisation de la paie"
      description="Montant passé au compte BNC − remboursements − téléphone → répartition par département → dépense QuickBooks."
      icon={Wallet}
      iconClass="bg-emerald-50 text-emerald-600"
      testId="compta-paie"
      className="lg:col-span-2"
    >
      {loaded && !paie ? (
        <p className="text-sm text-slate-500" data-testid="compta-paie-empty">
          Aucune paie à comptabiliser — toutes les périodes terminées ont leur dépense QuickBooks. ✓
        </p>
      ) : (
      <>
      <div className="flex flex-wrap items-start gap-3 mb-3">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Paie à comptabiliser</label>
          {/* Les paies à comptabiliser (période terminée, pas de dépense QB) plus
              la dernière comptabilisée (marquée ✓, pour la revoir ou la
              corriger). Une seule option → libellé fixe. */}
          {todos.length > 1 ? (
            <select className={`${inputCls} min-w-56`} value={paieId} data-testid="compta-paie-select"
              onChange={e => { const p = paies.find(x => x.id === e.target.value); if (p) selectPaie(p) }}>
              {todos.map(p => (
                <option key={p.id} value={p.id}>{paieOptionLabel(p)}</option>
              ))}
            </select>
          ) : (
            <div className="px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg bg-slate-50 min-w-56" data-testid="compta-paie-select">
              {paie ? paieOptionLabel(paie) : 'Aucune'}
            </div>
          )}
        </div>
        <div className="w-80">
          <label className="block text-xs font-medium text-slate-500 mb-1">Montant passé au compte BNC</label>
          <input type="text" inputMode="decimal" className={`${inputCls} w-40`} data-testid="compta-paie-amount"
            value={bankAmount} placeholder="ex. 23 570,19"
            onChange={e => { setBankAmount(e.target.value); setPushed(null) }}
            onBlur={e => loadPreview({ bankAmount: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') loadPreview() }} />
          {airtableTotal != null && (
            <p className="text-[11px] text-slate-400 mt-0.5" title="À titre de repère — le montant à saisir est le débit réellement vu au compte BNC">
              Repère — total Airtable : {fmtCad(airtableTotal, 2)}
            </p>
          )}
          {/* Ce qui sera retiré du montant BNC avant de répartir les salaires :
              remboursements de dépenses par employé (compte « <Employé>
              (rembourser à) ») et téléphone de Martin. Visible dès la sélection
              de la paie — pas besoin d'avoir saisi le montant. */}
          {deductions && (
            <div className="mt-1.5 rounded-lg border border-slate-200 bg-slate-50/70 overflow-hidden"
              data-testid="compta-paie-deductions">
              <div className="flex items-center">
                <button type="button" onClick={() => setDeductionsOpen(o => !o)}
                  data-testid="compta-paie-deductions-toggle"
                  className="flex-1 min-w-0 flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-left hover:bg-slate-100/70 transition-colors">
                  <ChevronDown className={`w-3.5 h-3.5 text-slate-400 shrink-0 transition-transform ${deductionsOpen ? '' : '-rotate-90'}`} />
                  <span className="text-slate-600">À déduire — remb. de dépenses</span>
                  <span className="ml-auto tabular-nums font-medium text-slate-700">{fmtCad(deductions.total > 0 ? -deductions.total : 0, 2)}</span>
                </button>
                {/* Les remboursements viennent de la colonne « Remb. dépenses »
                    des items de paie Airtable : un sync trop vieux = un
                    remboursement manquant à la publication. */}
                <button type="button" onClick={refreshDeductions} disabled={refreshing}
                  data-testid="compta-paie-deductions-refresh"
                  title={`Rafraîchir depuis Airtable${deductions.synced_at ? ` — dernier sync des items de paie : ${new Date(deductions.synced_at).toLocaleString('fr-CA')}` : ''}`}
                  className="px-2 py-1.5 text-slate-400 hover:text-slate-600 disabled:opacity-50">
                  <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                </button>
              </div>
              {deductionsOpen && (
                <div className="border-t border-slate-200 px-2.5 py-1.5 text-xs space-y-1"
                  data-testid="compta-paie-deductions-detail">
                  {deductions.reimbs.map((r, i) => (
                    <div key={i} className="flex justify-between gap-3">
                      <span className="text-slate-600 truncate" title={`Compte « ${r.account_label} » · ${r.taxcode}`}>
                        {r.employee_name}
                        <span className="text-slate-400"> · rembourser à</span>
                      </span>
                      <span className="tabular-nums whitespace-nowrap">{fmtCad(r.amount, 2)}</span>
                    </div>
                  ))}
                  {deductions.phone > 0 && (
                    <>
                      <div className="flex justify-between gap-3">
                        <span className="text-slate-600 truncate"
                          title={`Compte ${deductions.phone_acctnum} · ${deductions.phone_taxcode} — c'est le remboursement de dépense de ${deductions.phone_employee || 'Martin'}, jamais compté en double`}>
                          Téléphone Martin
                          <span className="text-slate-400"> · {deductions.phone_acctnum}</span>
                        </span>
                        <span className="tabular-nums whitespace-nowrap" data-testid="compta-paie-phone">{fmtCad(deductions.phone, 2)}</span>
                      </div>
                      {deductions.phone_tax > 0 && (
                        <div className="flex justify-between gap-3 text-slate-400">
                          <span className="truncate pl-3" title={`${deductions.phone_taxcode} — le 25 $ est hors taxes, la TPS/TVQ s'ajoute par-dessus`}>
                            + TPS/TVQ (en sus)
                          </span>
                          <span className="tabular-nums whitespace-nowrap">{fmtCad(deductions.phone_tax, 2)}</span>
                        </div>
                      )}
                    </>
                  )}
                  {deductions.total <= 0 && (
                    <p className="text-slate-400">Aucun remboursement de dépenses dans cette paie.</p>
                  )}
                  {deductions.warnings?.map((w, i) => (
                    <p key={i} className="text-amber-700 leading-snug">⚠️ {w}</p>
                  ))}
                  {/* Total masqué (sans rien retirer du DOM) quand il n'y a rien
                      à déduire : la ligne « Aucun remboursement » suffit. */}
                  <div className={`flex justify-between gap-3 font-medium text-slate-700 ${deductions.total > 0 ? 'border-t border-slate-200 pt-1' : 'sr-only'}`}>
                    <span>Total à déduire</span>
                    <span className="tabular-nums whitespace-nowrap" data-testid="compta-paie-deductions-total">{fmtCad(deductions.total, 2)}</span>
                  </div>
                  {preview && (
                    <div className="flex justify-between gap-3 border-t border-slate-200 pt-1 text-slate-700">
                      <span>Salaires à répartir</span>
                      <span className="tabular-nums whitespace-nowrap font-semibold" data-testid="compta-paie-base">{fmtCad(preview.base, 2)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Date (débit bancaire)</label>
          <input type="date" className={inputCls} value={txnDate}
            onChange={e => { setTxnDate(e.target.value); loadPreview({ txnDate: e.target.value }) }} />
          {paie?.debited_date && txnDate === paie.debited_date && (
            <p className="text-[11px] text-slate-400 mt-0.5" title="Colonne « Débité » des items de paie dans Airtable">
              Date « Débité » (Airtable)
            </p>
          )}
        </div>
        <div className="ml-auto mt-5">
          {alreadyPushed ? (
            <div className="flex items-center gap-2">
              {alreadyPushedUrl ? (
                <a href={alreadyPushedUrl} target="_blank" rel="noreferrer" title="Ouvrir la dépense dans QuickBooks"
                  className="text-xs text-green-700 bg-green-100 hover:bg-green-200 px-2 py-1 rounded-full whitespace-nowrap">
                  Comptabilisée — dépense QB #{alreadyPushed} ↗
                </a>
              ) : (
                <span className="text-xs text-green-700 bg-green-100 px-2 py-1 rounded-full whitespace-nowrap">
                  Comptabilisée — dépense QB #{alreadyPushed}
                </span>
              )}
              {/* Recalcule la dépense déjà publiée (items complétés dans
                  Airtable après coup) — transactionnel, donc bouton explicite. */}
              <button onClick={fixPushed} disabled={fixing} data-testid="compta-paie-fix"
                title="Recalculer la dépense QuickBooks à partir des données Airtable actuelles (total inchangé)"
                className="text-xs text-slate-500 hover:text-slate-700 underline underline-offset-2 disabled:opacity-50 whitespace-nowrap">
                {fixing ? 'Correction…' : 'Corriger'}
              </button>
            </div>
          ) : (
            // Action transactionnelle (publication QB) : bouton volontaire.
            <button onClick={push} disabled={pushing || !preview} data-testid="compta-paie-push"
              title={!preview ? 'Saisis le montant passé au compte BNC pour publier' : undefined}
              className="px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50 whitespace-nowrap">
              {pushing ? 'Publication…' : 'Pousser dans QuickBooks'}
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}

      {/* Le détail du calcul de la base vit maintenant dans l'encadré du montant
          BNC (déductions) — ici, uniquement les lignes de la dépense. */}
      {preview && (
        <div>
            <table className="text-sm w-full">
              <tbody>
                {preview.lines.map((l, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="py-1 pr-3 font-mono text-xs text-slate-500">{l.acctnum || ''}</td>
                    <td className="py-1 pr-3 text-slate-600">
                      {l.kind === 'salary' ? l.description : (l.kind === 'reimb' ? `${KIND_LABELS.reimb} — ${l.employee_name}` : l.description)}
                    </td>
                    {/* Code de taxe de chaque ligne, tel qu'il sera poussé dans QB. */}
                    <td className="py-1 pr-3 text-xs text-slate-400 whitespace-nowrap">{l.taxcode || ''}</td>
                    <td className="py-1 pr-3 text-right text-xs text-slate-400 tabular-nums">{l.pct != null ? `${l.pct} %` : ''}</td>
                    <td className="py-1 text-right tabular-nums font-medium">{fmtCad(l.amount, 2)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="py-1.5" colSpan={3}><span className="text-xs text-slate-400">Mémo : {preview.memo}</span></td>
                  <td className="py-1.5 pr-3 text-right text-xs text-slate-500">Total</td>
                  <td className="py-1.5 text-right tabular-nums font-semibold">{fmtCad(preview.total, 2)}</td>
                </tr>
              </tbody>
            </table>
            {preview.warnings?.map((w, i) => <p key={i} className="text-xs text-amber-700 mt-1">⚠️ {w}</p>)}
        </div>
      )}
      {!preview && !error && (
        <p className="text-xs text-slate-400">Inscris le montant passé au compte BNC (la date « Débité » est pré-remplie depuis Airtable) : la dépense QuickBooks est créée et le total reporté dans Airtable.</p>
      )}
      </>
      )}
    </Card>
  )
}

// Répartition de l'assurance collective AGA par département. Aperçu puis
// publication de la DÉPENSE QB (Purchase Cash sur la banque, fournisseur Groupe
// Financier AGA, Exonéré) — au patron des comptabilisations historiques, pas une
// écriture de journal.
function AgaRepartitionCard() {
  const [amount, setAmount] = useState('')
  const [txnDate, setTxnDate] = useState(() => localISODate())
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState(null)
  const [pushing, setPushing] = useState(false)
  const [pushed, setPushed] = useState(null)
  const { addToast } = useToast()

  async function loadPreview(v) {
    const n = parseAmountInput(v ?? amount)
    if (!(n > 0)) { setPreview(null); setError(null); return }
    try {
      setPreview(await api.paies.agaRepartitionPreview(n, txnDate))
      setError(null)
    } catch (e) {
      setError(e.message)
      setPreview(null)
    }
  }

  async function push() {
    setPushing(true)
    try {
      const out = await api.paies.agaRepartitionPush(parseAmountInput(amount), txnDate)
      setPushed({ id: out.qb_purchase_id, url: out.qb_purchase_url })
      addToast({ message: `Dépense publiée (#${out.qb_purchase_id})`, type: 'success' })
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setPushing(false)
    }
  }

  return (
    <Card
      title="Assurance collective (AGA)"
      description="Prélèvement ventilé par département dans les comptes de salaires (pas de compte d'assurance) → dépense QuickBooks sur le compte bancaire, fournisseur Groupe Financier AGA."
      icon={HeartHandshake}
      iconClass="bg-violet-50 text-violet-600"
      testId="compta-aga"
    >
      <div className="flex items-end gap-3 mb-3">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Montant du prélèvement AGA (CAD)</label>
          {/* type="text" + inputMode : un input number rejette la virgule décimale
              du clavier fr-CA (la valeur arrive vide). parseAmountInput normalise. */}
          <input type="text" inputMode="decimal" data-testid="compta-aga-amount"
            value={amount}
            onChange={e => { setAmount(e.target.value); setPushed(null) }}
            onBlur={e => loadPreview(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') loadPreview() }}
            placeholder="ex. 2 737,95"
            className="w-44 px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Date du prélèvement</label>
          <input type="date" value={txnDate}
            onChange={e => { setTxnDate(e.target.value); setPushed(null) }}
            className="px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30" />
        </div>
        {preview && !preview.warnings?.length && !pushed && (
          // Action transactionnelle (publication QB) : bouton volontaire.
          <button onClick={push} disabled={pushing} data-testid="compta-aga-push"
            className="px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
            {pushing ? 'Publication…' : 'Publier sur QB'}
          </button>
        )}
        {pushed && (pushed.url ? (
          <a href={pushed.url} target="_blank" rel="noreferrer" title="Ouvrir la dépense dans QuickBooks"
            className="text-xs text-green-700 bg-green-100 hover:bg-green-200 px-2 py-1 rounded-full">
            Publiée — dépense #{pushed.id} ↗
          </a>
        ) : (
          <span className="text-xs text-green-700 bg-green-100 px-2 py-1 rounded-full">Publiée — dépense #{pushed.id}</span>
        ))}
      </div>
      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
      {preview && (
        <>
          <table className="text-sm w-full">
            <tbody>
              {preview.lines.map((l, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="py-1 pr-3 text-xs text-slate-500">Débit</td>
                  <td className="py-1 pr-3 font-mono text-xs">{l.acctnum}</td>
                  <td className="py-1 pr-3 text-slate-600">{l.label}</td>
                  <td className="py-1 text-right tabular-nums font-medium">{fmtCad(l.amount, 2)}</td>
                </tr>
              ))}
              <tr>
                <td className="pt-1.5 pr-3 text-xs text-slate-500">Payé</td>
                <td className="pt-1.5 pr-3 font-mono text-xs">{preview.bank_acctnum}</td>
                <td className="pt-1.5 pr-3 text-slate-600">{preview.vendor_name} · {preview.taxcode}</td>
                <td className="pt-1.5 text-right tabular-nums font-semibold">{fmtCad(preview.amount, 2)}</td>
              </tr>
            </tbody>
          </table>
          {preview.warnings?.map((w, i) => <p key={i} className="text-xs text-amber-700 mt-1.5">⚠️ {w}</p>)}
        </>
      )}
      {!preview && !error && (
        <p className="text-xs text-slate-400">Entre le montant du prélèvement pour voir l'aperçu de la dépense avant publication.</p>
      )}
    </Card>
  )
}

// ── Anomalies transactionnelles ──────────────────────────────────────────────
// Doublons probables, montants hors norme et devises incohérentes détectés sur les
// factures fournisseurs (à l'extraction + scan périodique). Un doublon ouvert bloque
// la publication QB du reçu tant qu'il n'est pas rejeté ici.

const ANOMALY_KIND_LABELS = {
  duplicate_number: 'Doublon (nº facture)',
  duplicate_amount: 'Doublon (montant)',
  already_in_qb: 'Déjà dans QuickBooks',
  possible_duplicate_in_qb: 'Peut-être déjà dans QB',
  amount_outlier: 'Montant inhabituel',
  currency_mismatch: 'Devise incohérente',
  zero_total: 'Document à 0 $',
  extraction_incomplete: 'Extraction ratée',
  qb_entry_missing: 'Écriture QB disparue',
}

function AnomaliesCard() {
  const [rows, setRows] = useState(null)
  const [scanning, setScanning] = useState(false)
  const { addToast } = useToast()

  const load = useCallback(async () => {
    try {
      const out = await api.anomalies.list({ status: 'open' })
      setRows(out.data || [])
    } catch (e) {
      addToast({ message: `Anomalies : ${e.message}`, type: 'error' })
    }
  }, [addToast])

  useEffect(() => { load() }, [load])

  // Un clic = rejeté. Action réversible (l'anomalie se rouvre depuis la fiche du
  // reçu), donc pas de fenêtre de confirmation : la ligne disparaît tout de suite
  // et revient si le serveur refuse.
  async function dismiss(a) {
    setRows(rs => rs.filter(r => r.id !== a.id))
    try {
      await api.anomalies.dismiss(a.id, null)
    } catch (e) {
      setRows(rs => [a, ...rs])
      addToast({ message: e.message, type: 'error' })
    }
  }

  async function scan() {
    setScanning(true)
    try {
      const out = await api.anomalies.scan()
      addToast({
        message: `${out.scanned} reçus scannés, ${out.anomalies} anomalie(s) détectée(s)`
          + (out.qb_checked ? ` · ${out.qb_checked} lien(s) QB vérifié(s), ${out.qb_missing} disparue(s)` : ''),
        type: 'success',
      })
      await load()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setScanning(false)
    }
  }

  return (
    <Card
      title="Anomalies transactions"
      description="Doublons probables, montants hors norme, devises incohérentes, captures ratées et liens QuickBooks périmés. Un doublon ouvert bloque le push QB."
      icon={ShieldAlert}
      iconClass="bg-amber-50 text-amber-600"
      testId="compta-anomalies"
      actions={(
        <button onClick={scan} disabled={scanning} title="Relancer le scan complet"
          className="px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-50 flex items-center gap-1.5">
          <RefreshCw size={12} className={scanning ? 'animate-spin' : ''} /> Scanner
        </button>
      )}
    >
      {rows === null && <p className="text-xs text-slate-400">Chargement…</p>}
      {rows && rows.length === 0 && (
        <p className="text-xs text-slate-400 flex items-center gap-1.5"><CheckCircle2 size={13} className="text-green-500" /> Aucune anomalie ouverte.</p>
      )}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {rows.map(a => (
            <li key={a.id} className="py-2.5 flex items-start gap-3">
              <span className={`shrink-0 mt-0.5 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${a.severity === 'high' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                {ANOMALY_KIND_LABELS[a.kind] || a.kind}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-slate-700 leading-snug">{a.message}</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  {a.entity_type === 'sale_receipt' && !a.receipt_deleted_at && (
                    <Link to={`/sale-receipts/${a.entity_id}`} className="text-brand-600 hover:underline mr-2">Ouvrir le reçu</Link>
                  )}
                  {fmtDate(a.created_at)}
                </p>
              </div>
              <button onClick={() => dismiss(a)} title="Faux positif — ne plus signaler"
                className="shrink-0 px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 rounded-lg">
                Rejeter
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// ── Plafond des cartes de crédit ─────────────────────────────────────────────
// Question complémentaire du rappel « payer les cartes » : la carte a-t-elle
// encore de la place ? Scan-first — trois chiffres, le reste replié.

function CardCeilingRow({ card, onChanged }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(card)
  useEffect(() => { setForm(card) }, [card])

  // Autosave au blur : pas de bouton « Enregistrer » (règle de design).
  // Comparaison String() : les valeurs viennent d'inputs (chaînes) alors que
  // la fiche stocke des nombres.
  const { save, saving } = useAutosave(card, patch => api.treasury.cardCeilings.update(card.id, patch), {
    compare: (a, b) => String(a ?? '') === String(b ?? ''),
    onSaved: () => onChanged(),
    onError: () => setForm(card),
  })

  const tone = card.over_limit ? 'rose' : card.over_ceiling ? 'amber' : 'emerald'
  const inputCls = 'w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30'
  const field = (k, label, props = {}) => (
    <div>
      <label className="block text-[11px] font-medium text-slate-500 mb-1">{label}</label>
      <input
        className={inputCls}
        value={form[k] ?? ''}
        onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
        onBlur={e => save(k, e.target.value)}
        {...props}
      />
    </div>
  )

  return (
    <div className="py-3 first:pt-0 last:pb-0" data-testid="card-ceiling-row">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold text-slate-800 truncate" data-testid="card-ceiling-name">{card.name}</p>
        <span className="text-[11px] text-slate-400 shrink-0">
          {saving ? 'Enregistrement…' : card.draft_date ? `prélèvement le ${fmtDate(card.draft_date)}` : 'aucun prélèvement configuré'}
        </span>
      </div>

      {card.qb_error && (
        <p className="mt-1 text-xs text-rose-600 flex items-center gap-1.5" data-testid="card-ceiling-error">
          <AlertTriangle size={12} /> QuickBooks : {card.qb_error}
        </p>
      )}

      {/* Les trois chiffres qui décident : où on en est, ce qu'il reste, ce qu'il faut payer. */}
      <div className="mt-2 grid grid-cols-3 divide-x divide-slate-100">
        <Stat label="Solde projeté" value={fmtCad(card.projected)} tone={tone} testId="card-ceiling-projected"
          sub={card.ceiling ? `plafond ${fmtCad(card.ceiling)}` : 'sans plafond'} />
        <Stat label="Marge restante" value={card.room == null ? '—' : fmtCad(card.room)}
          tone={card.room != null && card.room < 0 ? 'rose' : 'slate'} testId="card-ceiling-room"
          sub={card.credit_limit ? `limite ${fmtCad(card.credit_limit)}` : null} />
        <Stat label="Paiement recommandé" value={card.recommended > 0 ? fmtCad(card.recommended) : '—'}
          tone={card.recommended > 0 ? 'amber' : 'slate'} testId="card-ceiling-recommended"
          sub={card.recommended > 0 && card.pay_date ? `à payer le ${fmtDate(card.pay_date)}` : 'sous le plafond'} />
      </div>

      <button type="button" onClick={() => setOpen(o => !o)} data-testid="card-ceiling-toggle"
        className="mt-2 flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-700">
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        {fmtCad(card.posted, 2)} comptabilisé · {fmtCad(card.pending, 2)} en attente
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-slate-100 bg-slate-50/60 p-3 space-y-3" data-testid="card-ceiling-detail">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600">
            <span>Comptabilisé dans QuickBooks</span>
            <span className="text-right tabular-nums" data-testid="card-ceiling-posted">{fmtCad(card.posted, 2)}</span>
            <span>En attente de comptabilisation ({card.pending_count})</span>
            <span className="text-right tabular-nums" data-testid="card-ceiling-pending">{fmtCad(card.pending, 2)}</span>
            <span className="font-medium text-slate-800">Solde projeté</span>
            <span className="text-right tabular-nums font-medium text-slate-800">{fmtCad(card.projected, 2)}</span>
          </div>
          {card.pending_stale_count > 0 && (
            <p className="text-[11px] text-slate-400" data-testid="card-ceiling-stale">
              {card.pending_stale_count} transaction(s) plus ancienne(s) que le {fmtDate(card.pending_since)}
              {' '}({fmtCad(card.pending_stale_amount, 2)}) ne sont pas comptées : leur relevé est payé depuis longtemps.
            </p>
          )}
          {card.pay_date && card.pay_date !== card.draft_date && (
            <p className="text-[11px] text-amber-700">
              Le prélèvement du {fmtDate(card.draft_date)} tombe {card.pay_reason === 'holiday' ? `un férié (${card.pay_holiday})` : 'une fin de semaine'} :
              {' '}payer le {fmtDate(card.pay_date)}.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            {field('credit_limit', 'Limite de crédit ($)', { inputMode: 'decimal', 'data-testid': 'card-ceiling-limit-input' })}
            {field('ceiling', 'Plafond cible ($)', { inputMode: 'decimal', 'data-testid': 'card-ceiling-ceiling-input' })}
            {field('draft_day', 'Jour du prélèvement', { inputMode: 'numeric', 'data-testid': 'card-ceiling-draft-day-input' })}
            {field('qb_acctnum', 'Compte QuickBooks (n°)', { 'data-testid': 'card-ceiling-acctnum-input' })}
          </div>
          <p className="text-[11px] text-slate-400">
            {card.qb_account_name ? `QuickBooks : ${card.qb_account_name}` : 'Compte QuickBooks non résolu'}
            {card.bank_account_name ? ` · relevé : ${card.bank_account_name}` : ''}
          </p>
        </div>
      )}
    </div>
  )
}

function CardCeilingsCard() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const { addToast } = useToast()

  const load = useCallback(async (refresh = false) => {
    setLoading(true)
    try {
      setData(await api.treasury.cardCeilings.list({ refresh }))
    } catch (e) {
      addToast({ message: `Soldes de cartes : ${e.message}`, type: 'error' })
      setData({ cards: [] })
    } finally {
      setLoading(false)
    }
  }, [addToast])

  useEffect(() => { load() }, [load])

  const cards = data?.cards || []
  return (
    <Card
      title="Plafond des cartes"
      description="Solde QuickBooks + achats pas encore comptabilisés, confrontés au plafond cible et au prélèvement pré-programmé."
      icon={Wallet}
      iconClass="bg-indigo-50 text-indigo-600"
      testId="compta-card-ceilings"
      actions={(
        <button onClick={() => load(true)} disabled={loading} title="Relire les soldes dans QuickBooks"
          className="px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-50 flex items-center gap-1.5">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Actualiser
        </button>
      )}
    >
      {data === null && <p className="text-xs text-slate-400">Chargement…</p>}
      {data && cards.length === 0 && <p className="text-xs text-slate-400">Aucune carte suivie.</p>}
      <div className="divide-y divide-slate-100">
        {cards.map(c => <CardCeilingRow key={c.id} card={c} onChanged={() => load(true)} />)}
      </div>
    </Card>
  )
}

export default function ComptaDashboard() {
  return (
    <Layout>
      <div className="p-6 max-w-7xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Dashboard comptabilité</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Trésorerie, projection BNC et reçus manquants.
          </p>
        </div>

        <TreasuryProjectionSection />

        <div className="grid gap-6 lg:grid-cols-2 items-start">
          <CardCeilingsCard />
          <AnomaliesCard />
          <PaieComptabilisationCard />
          <AgaRepartitionCard />

          <Card
            title="Reçus manquants"
            description="Charges d'abonnements attendues sans reçu ingéré via factures@orisha.io."
            icon={Receipt}
            iconClass="bg-rose-50 text-rose-500"
            testId="compta-missing-receipts"
          >
            <MissingReceiptsSection />
            <p className="text-xs text-slate-400 flex items-center gap-1 mt-2">
              <RefreshCw size={11} /> Géré depuis la page Abonnements fournisseurs.
            </p>
          </Card>
        </div>
      </div>
    </Layout>
  )
}
