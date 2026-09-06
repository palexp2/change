// Écritures de fin de mois — hub de clôture mensuelle.
//
// Remplace la ronde de fichiers Drive du dernier jour du mois :
// feuille_de_temps du mois → R&D_Suivi_Feuilles de temps → Provisions_mensuelles_CTB
// → modèles d'écritures récurrentes dans QuickBooks. Tout est ici : les heures
// R&D importées, les deux provisions calculées, l'imputation des frais payés
// d'avance, et un bouton de comptabilisation par écriture.
//
// Les intrants (heures, PARI, montant manuel) sont en autosave ; seule la
// comptabilisation dans QuickBooks passe par un bouton — action transactionnelle
// irréversible côté QB, elle ne doit jamais partir d'un simple blur.
import { useState, useEffect, useCallback, useRef } from 'react'
import { ChevronLeft, ChevronRight, CheckCircle2, AlertTriangle, XCircle, Download, Plus, Trash2, Info, RotateCw, FileSpreadsheet, Send, ExternalLink } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useQbAccounts } from '../lib/qbAccounts.js'

const MONTH_LABELS = { '01': 'Janvier', '02': 'Février', '03': 'Mars', '04': 'Avril', '05': 'Mai', '06': 'Juin', '07': 'Juillet', '08': 'Août', '09': 'Septembre', 10: 'Octobre', 11: 'Novembre', 12: 'Décembre' }
const monthLabel = m => `${MONTH_LABELS[m.slice(5, 7)]} ${m.slice(0, 4)}`

import { fmtMoney, fmtNumber } from '../utils/formatters.js'
import { fmtDateTime } from '../lib/formatDate.js'
import Spinner from '../components/Spinner.jsx'
const fmtHours = n => `${fmtNumber(n, { maximumFractionDigits: 2, nullIsZero: true })} h`

const inputCls = 'px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400'

// « HTTP 502 » / « Failed to fetch » ne veut rien dire pour un comptable : on
// traduit les pannes de transport, on garde tel quel un vrai message du serveur.
function friendlyLoadError(e) {
  const status = e?.status
  if (status === 502 || status === 503 || status === 504) {
    return 'Le serveur n\'a pas répondu (il redémarre peut-être). Réessaie dans quelques secondes.'
  }
  if (!status) return 'Connexion au serveur impossible. Vérifie ta connexion, puis réessaie.'
  return e?.message || 'Chargement impossible.'
}

// Pastille d'état d'une écriture, dérivée — jamais saisie.
function StatusPill({ pushed, ready, amount }) {
  if (pushed) return <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-50 text-emerald-700"><CheckCircle2 size={12} /> Comptabilisé</span>
  if (ready) return <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-brand-50 text-brand-700">Prêt à comptabiliser</span>
  if (!amount) return <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-slate-100 text-slate-500">Rien à comptabiliser</span>
  return <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-amber-50 text-amber-700">À compléter</span>
}

function Card({ title, subtitle, right, children }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 mb-5">
      <div className="flex items-start justify-between mb-3 gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">{right}</div>
      </div>
      {children}
    </div>
  )
}

function Warnings({ items }) {
  if (!items?.length) return null
  return (
    <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <div className="space-y-0.5">{items.map((w, i) => <div key={i}>{w}</div>)}</div>
    </div>
  )
}

// Champ numérique en autosave (blur ou Entrée) avec état de sauvegarde discret.
function NumberField({ value, onSave, disabled, suffix, className = '', testId }) {
  const [draft, setDraft] = useState(value ?? '')
  const [saving, setSaving] = useState(false)
  const lastSaved = useRef(value)
  useEffect(() => { setDraft(value ?? ''); lastSaved.current = value }, [value])

  async function commit() {
    if (String(draft) === String(lastSaved.current ?? '')) return
    setSaving(true)
    try {
      await onSave(draft === '' ? null : Number(draft))
      lastSaved.current = draft === '' ? null : Number(draft)
    } finally {
      setSaving(false)
    }
  }
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number" step="0.01" value={draft} disabled={disabled} data-testid={testId}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
        className={`${inputCls} text-right tabular-nums disabled:bg-slate-50 disabled:text-slate-400 ${className}`}
      />
      {suffix && <span className="text-xs text-slate-400">{suffix}</span>}
      {saving && <span className="text-xs text-slate-400">…</span>}
    </span>
  )
}

// ── Checklist de préparation ────────────────────────────────────────────────

// Tout ce qui peut faire échouer un import ou une comptabilisation, vérifié
// AVANT de cliquer : connexions Google/QuickBooks, fraîcheur de la feuille de
// temps dans le Drive, paies du mois, comptes QB. Chargée à part (la recherche
// Drive prend une seconde) pour ne pas retarder l'affichage des provisions.
const CHECK_STYLE = {
  ok: { Icon: CheckCircle2, cls: 'text-emerald-500' },
  warn: { Icon: AlertTriangle, cls: 'text-amber-500' },
  error: { Icon: XCircle, cls: 'text-red-500' },
}

function ReadinessCard({ month, refreshKey }) {
  const [state, setState] = useState({ loading: true, checks: null, error: null })
  const shownMonth = useRef(null)

  // `refreshKey` change après chaque mutation (import, comptabilisation) : on
  // rafraîchit en gardant la liste affichée. Au changement de mois, on repart
  // du squelette — les résultats de l'autre mois seraient trompeurs.
  useEffect(() => {
    let alive = true
    const monthChanged = shownMonth.current !== month
    shownMonth.current = month
    setState(s => ({
      checks: monthChanged ? null : s.checks,
      loading: monthChanged || !s.checks,
      error: null,
    }))
    api.monthEnd.checks(month)
      .then(out => { if (alive) setState({ loading: false, checks: out, error: null }) })
      .catch(e => { if (alive) setState({ loading: false, checks: null, error: e.message }) })
    return () => { alive = false }
  }, [month, refreshKey])

  const { loading, checks, error } = state
  const allOk = checks?.ready

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 mb-5" data-testid="readiness-card">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-slate-800">Préparation de la clôture</h2>
        {loading && <span className="text-xs text-slate-400">Vérifications en cours…</span>}
        {!loading && allOk && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-50 text-emerald-700" data-testid="readiness-all-ok">
            <CheckCircle2 size={12} /> Tout est prêt
          </span>
        )}
        {!loading && checks && !allOk && (
          <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-amber-50 text-amber-700">À vérifier avant de comptabiliser</span>
        )}
      </div>
      {loading && (
        <div className="space-y-2 py-1" aria-hidden>
          {[0, 1, 2].map(i => <div key={i} className="h-4 rounded bg-slate-100 animate-pulse" style={{ width: `${70 - i * 15}%` }} />)}
        </div>
      )}
      {error && (
        <div className="text-xs text-red-600">Vérifications impossibles : {error}</div>
      )}
      {checks && (
        <ul className="divide-y divide-slate-50">
          {checks.checks.map(c => {
            const { Icon, cls } = CHECK_STYLE[c.status] || CHECK_STYLE.warn
            return (
              <li key={c.key} className="flex items-start gap-2 py-1.5" data-testid={`check-${c.key}`} data-status={c.status}>
                <Icon size={14} className={`${cls} mt-0.5 shrink-0`} />
                <div className="min-w-0">
                  <span className="text-sm text-slate-700">{c.label}</span>
                  {c.detail && <span className="text-xs text-slate-400"> — {c.detail}</span>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ── Heures R&D du mois ──────────────────────────────────────────────────────

function HoursCard({ month, hours, fileName, onChanged }) {
  const [importing, setImporting] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const { addToast } = useToast()

  async function handleImport() {
    setImporting(true)
    try {
      const out = await api.monthEnd.importHours(month)
      const parts = [`${out.imported.length} onglet(s) lus`, `${fmtHours(out.employee_hours)} employés`]
      if (out.contractor_hours) parts.push(`${fmtHours(out.contractor_hours)} sous-traitants`)
      if (out.skipped.length) parts.push(`${out.skipped.length} ligne(s) corrigée(s) à la main conservée(s)`)
      addToast({ message: `${out.file.name} importé — ${parts.join(', ')}`, type: 'success' })
      if (out.divergent?.length) {
        addToast({
          message: `Formule de total à corriger dans la feuille de temps pour : ${out.divergent.map(r => r.name).join(', ')}`
            + ' — l\'ERP a retenu son propre total (détail sur la carte).',
          type: 'warning',
        })
      }
      if (out.missing_from_previous?.length) {
        addToast({
          message: `Sans onglet ce mois-ci (heures le mois dernier) : ${out.missing_from_previous.join(', ')} — onglet oublié ?`,
          type: 'warning',
        })
      }
      await onChanged()
    } catch (e) {
      addToast({ message: `Import impossible : ${e.message}`, type: 'error' })
    } finally {
      setImporting(false)
    }
  }

  async function addRow() {
    if (!newName.trim()) return
    try {
      await api.monthEnd.addHours({ month, employee_name: newName.trim(), hours: 0 })
      setNewName(''); setAdding(false)
      await onChanged()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }

  const employees = hours?.rows?.filter(r => !r.contractor) || []
  const contractors = hours?.rows?.filter(r => r.contractor) || []

  return (
    <Card
      title="Heures R&D du mois"
      subtitle={`Total recalculé par l'ERP à partir des lignes de ${fileName} (Drive) — la ligne « total » du fichier n'est lue que pour signaler une formule incomplète. Les sous-traitants sont suivis mais exclus de la provision.`}
      right={
        <button onClick={handleImport} disabled={importing} data-testid="import-hours"
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg disabled:opacity-50">
          <Download size={14} /> {importing ? 'Import…' : 'Importer la feuille de temps'}
        </button>
      }
    >
      <Warnings items={hours?.warnings} />
      {hours?.rows?.length ? (
        <table className="w-full text-sm">
          <tbody>
            {[...employees, ...contractors].map(r => (
              <tr key={r.id} className="border-t border-slate-50">
                <td className="py-1.5 pr-4">
                  {r.employee_name}
                  {!!r.contractor && <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-slate-100 text-slate-500">sous-traitant</span>}
                  {r.source === 'manuel' && <span className="ml-2 text-[10px] text-amber-600">corrigé à la main</span>}
                </td>
                <td className="py-1.5 pr-4 text-right w-32">
                  <NumberField value={r.hours} className="w-24"
                    onSave={v => api.monthEnd.updateHours(r.id, { hours: v ?? 0 }).then(onChanged)} />
                </td>
                <td className="py-1.5 w-8 text-right">
                  <button onClick={() => api.monthEnd.deleteHours(r.id).then(onChanged)}
                    className="p-1 text-slate-300 hover:text-red-500"><Trash2 size={13} /></button>
                </td>
              </tr>
            ))}
            <tr className="border-t border-slate-200 font-medium">
              <td className="py-1.5 pr-4">Total employés (base de la provision)</td>
              <td className="py-1.5 pr-4 text-right tabular-nums">{fmtHours(hours.employee_hours)}</td>
              <td />
            </tr>
            {!!hours.contractor_hours && (
              <tr>
                <td className="py-1 pr-4 text-xs text-slate-500">Sous-traitants (exclus)</td>
                <td className="py-1 pr-4 text-right text-xs text-slate-500 tabular-nums">{fmtHours(hours.contractor_hours)}</td>
                <td />
              </tr>
            )}
          </tbody>
        </table>
      ) : (
        <div className="text-sm text-slate-400 py-2">Aucune heure pour ce mois — importer la feuille de temps.</div>
      )}

      {adding ? (
        <div className="flex items-center gap-2 mt-3">
          <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addRow(); if (e.key === 'Escape') setAdding(false) }} className={`${inputCls} flex-1`} />
          <button onClick={addRow} className="px-3 py-1.5 text-sm text-white bg-brand-600 hover:bg-brand-700 rounded-lg">Ajouter</button>
          <button onClick={() => setAdding(false)} className="px-3 py-1.5 text-sm text-slate-500">Annuler</button>
        </div>
      ) : (
        <button onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 mt-3 text-xs text-slate-500 hover:text-slate-700">
          <Plus size={13} /> Ajouter une personne
        </button>
      )}
    </Card>
  )
}

// ── Provisions ──────────────────────────────────────────────────────────────

function Step({ label, value, hint }) {
  return (
    <div className="flex items-baseline justify-between py-1 border-t border-slate-50 first:border-0">
      <span className="text-xs text-slate-500">{label}{hint && <span className="text-slate-300"> · {hint}</span>}</span>
      <span className="text-sm tabular-nums text-slate-700">{value}</span>
    </div>
  )
}

// Paramètres de la grille de calcul — les « cellules bleues » des fichiers
// Excel, rendues éditables ici plutôt que gelées dans du code. Autosave au blur.
function ProvisionSettings({ provision, onChanged }) {
  const cfg = provision.config || {}
  const saveConfig = (k, v) => api.monthEnd.updateProvision(provision.id, { config: { [k]: v } }).then(onChanged)
  const saveField = (k, v) => api.monthEnd.updateProvision(provision.id, { [k]: v }).then(onChanged)

  const num = (label, key, suffix) => (
    <label className="flex items-center justify-between gap-2">
      <span className="text-xs text-slate-500">{label}</span>
      <NumberField value={cfg[key] ?? ''} className="w-24" suffix={suffix} onSave={v => saveConfig(key, v)} />
    </label>
  )
  const text = (label, key, saver) => (
    <label className="flex items-center justify-between gap-2">
      <span className="text-xs text-slate-500">{label}</span>
      <input defaultValue={(saver === saveField ? provision[key] : cfg[key]) ?? ''}
        onBlur={e => saver(key, e.target.value)}
        className={`${inputCls} w-32`} />
    </label>
  )

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 mt-3 pt-3 border-t border-slate-100">
      {provision.kind === 'rd_credit' ? (
        <>
          {num('Taux horaire moyen RS&DE', 'hourly_rate', '$/h')}
          {num('Majoration vacances et cie', 'uplift_pct', '%')}
          {num('Taux de réclamation', 'claim_pct', '%')}
          {num('Arrondi de la provision', 'round_to', '$')}
        </>
      ) : (
        <>
          {num('Taux de contribution', 'pct', '%')}
          {num('Contribution maximale', 'cap_total', '$')}
          {text("Admissible à partir du", 'eligible_from', saveConfig)}
          {text("Admissible jusqu'au", 'eligible_to', saveConfig)}
          <label className="flex items-center justify-between gap-2 md:col-span-2">
            <span className="text-xs text-slate-500">Libellé à repérer dans le relevé bancaire (détection auto des versements reçus)</span>
            <input defaultValue={cfg.bank_match_label ?? ''}
              onBlur={e => saveConfig('bank_match_label', e.target.value.trim() || null)}
              className={`${inputCls} w-32`} />
          </label>
        </>
      )}
      {text('Compte au débit (Dr)', 'debit_acctnum', saveField)}
      {text('Compte au crédit (Cr)', 'credit_acctnum', saveField)}
    </div>
  )
}

function ProvisionCard({ month, provision, onChanged }) {
  const [publishing, setPublishing] = useState(false)
  const [correcting, setCorrecting] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const { addToast } = useToast()
  const d = provision.detail || {}
  const locked = !!provision.pushed_at
  const { accountName } = useQbAccounts()
  const acct = num => `#${num || '?'}${accountName(num) ? ` ${accountName(num)}` : ''}`

  async function handlePublish() {
    setPublishing(true)
    try {
      const out = await api.monthEnd.publish(provision.id, month)
      addToast({ message: `Écriture comptabilisée (JE #${out.qb_je_id})`, type: 'success' })
      await onChanged()
    } catch (e) {
      addToast({ message: `Comptabilisation échouée : ${e.message}`, type: 'error' })
    } finally {
      setPublishing(false)
    }
  }

  // Le calcul a bougé après la publication (heures réimportées, paie corrigée) :
  // corrige l'écriture existante dans QB plutôt que d'en créer une seconde.
  async function handleCorrect() {
    setCorrecting(true)
    try {
      const out = await api.monthEnd.correct(provision.id, month)
      addToast({ message: `Écriture corrigée (JE #${out.qb_je_id}) — ${fmtMoney(out.previous_amount)} → ${fmtMoney(out.amount)}`, type: 'success' })
      await onChanged()
    } catch (e) {
      addToast({ message: `Correction échouée : ${e.message}`, type: 'error' })
    } finally {
      setCorrecting(false)
    }
  }

  return (
    <Card
      title={provision.label}
      subtitle={`Dr ${acct(provision.debit_acctnum)} / Cr ${acct(provision.credit_acctnum)} · ${provision.memo || ''}`}
      right={
        <>
          <StatusPill pushed={locked} ready={provision.ready} amount={provision.amount} />
          {!locked && provision.ready && (
            <button onClick={handlePublish} disabled={publishing} data-testid={`publish-${provision.id}`}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
              {publishing ? 'Comptabilisation…' : `Comptabiliser — ${fmtMoney(provision.amount)}`}
            </button>
          )}
          {locked && provision.correctable && (
            <button onClick={handleCorrect} disabled={correcting} data-testid={`correct-${provision.id}`}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-lg disabled:opacity-50">
              {correcting ? 'Correction…' : `Corriger — ${fmtMoney(provision.computed_amount)}`}
            </button>
          )}
        </>
      }
    >
      <Warnings items={provision.warnings} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8">
        <div>
          {provision.kind === 'rd_credit' ? (
            <>
              <Step label="Heures R&D du mois (employés)" value={fmtHours(d.hours)} />
              <Step label="Taux horaire moyen RS&DE" value={fmtMoney(d.hourly_rate)} />
              <Step label="Majoration vacances et cie" value={`${d.uplift_pct} %`} />
              <Step label="Dépense R&D du mois" value={fmtMoney(d.gross)} hint={`${fmtHours(d.hours)} × ${fmtMoney(d.hourly_rate)} × ${(1 + (d.uplift_pct || 0) / 100).toFixed(2)}`} />
              <Step label="Moins PARI reçu dans le mois" value={fmtMoney(d.pari)} />
              <Step label="RS&DE à soumettre ce mois-ci" value={fmtMoney(d.rsde_month)} />
              <Step label="Projeté sur 12 mois" value={fmtMoney(d.projected_12m)} />
              <Step label={`× ${d.claim_pct} % (crédit réclamable)`} value={fmtMoney(d.claimable)} />
              <Step label="Ramené sur 1 mois" value={fmtMoney(d.before_rounding)} />
            </>
          ) : (
            <>
              <Step label="Salaire brut du mois" value={fmtMoney(d.gross)} hint={`${d.pay_count || 0} paie(s) débitée(s), remb. de dépenses exclus`} />
              <Step label="Taux de contribution" value={`${d.pct} %`} />
              <Step label="Provision calculée" value={fmtMoney(d.raw)} />
              {d.cap_total != null && (
                <>
                  <Step label="Contribution maximale" value={fmtMoney(d.cap_total)} />
                  <Step label="Déjà provisionné (cumul)" value={fmtMoney(d.cumulative_before)} />
                  <Step label="Marge restante sous le plafond" value={fmtMoney(d.cap_remaining)} />
                </>
              )}
              {(d.eligible_from || d.eligible_to) && (
                <Step label="Fenêtre d'admissibilité" value={`${d.eligible_from || '—'} → ${d.eligible_to || '—'}`} />
              )}
            </>
          )}
        </div>

        <div>
          {provision.kind === 'rd_credit' && (
            <div className="flex items-center justify-between py-2">
              <div>
                <div className="text-xs font-medium text-slate-600">PARI reçu dans le mois</div>
                <div className="text-[11px] text-slate-400">Montant à retrancher (50 % de la subvention du mois). Laisser à 0 s'il n'y a pas eu de demande de remboursement.</div>
              </div>
              <NumberField value={provision.inputs?.pari ?? 0} disabled={locked} className="w-32" testId="pari-input"
                onSave={v => api.monthEnd.updateMonth(provision.id, month, { inputs: { pari: v ?? 0 } }).then(onChanged)} />
            </div>
          )}
          <div className="flex items-center justify-between py-2 border-t border-slate-50">
            <div>
              <div className="text-xs font-medium text-slate-600">Montant manuel</div>
              <div className="text-[11px] text-slate-400">Écrase le calcul pour ce mois. Vider pour revenir au calcul automatique.</div>
            </div>
            <NumberField value={provision.source === 'manuel' ? provision.amount : ''} disabled={locked} className="w-32"
              onSave={v => api.monthEnd.updateMonth(provision.id, month, { override_amount: v }).then(onChanged)} />
          </div>
          <div className="flex items-center justify-between py-2 border-t border-slate-100 mt-1">
            <span className="text-sm font-semibold text-slate-800">Provision du mois</span>
            <span className="text-lg font-semibold tabular-nums text-slate-900" data-testid={`amount-${provision.id}`}>
              {fmtMoney(provision.amount)}
            </span>
          </div>
          {locked && (
            <div className="text-xs text-emerald-600 mt-1">
              {provision.qb_je_id ? (
                <>
                  Comptabilisé dans QuickBooks — {provision.qb_je_url ? (
                    <a href={provision.qb_je_url} target="_blank" rel="noreferrer" className="underline hover:text-emerald-700">
                      JE #{provision.qb_je_id}
                    </a>
                  ) : `JE #${provision.qb_je_id}`}
                </>
              ) : 'Repris de l\'historique — écriture déjà passée à la main dans QuickBooks'}
            </div>
          )}
        </div>
      </div>

      <button onClick={() => setShowSettings(s => !s)}
        className="mt-2 text-xs text-slate-400 hover:text-slate-600">
        {showSettings ? 'Masquer les paramètres' : 'Paramètres de calcul'}
      </button>
      {showSettings && <ProvisionSettings provision={provision} onChanged={onChanged} />}
      {provision.kind === 'wage_subsidy' && <SubsidyReceiptsPanel provision={provision} />}
    </Card>
  )
}

// ── Rapprochement encaissement de la subvention (Biotalent) ────────────────

// La provision mensuelle est une ESTIMATION (60 % du salaire) : ce que
// Biotalent verse réellement peut différer. Ce panneau suit les versements
// reçus (indépendants du calendrier des mois provisionnés) et permet de
// régulariser l'écart cumulé par une écriture Dr/Cr 12400 ↔ 49000 — jamais
// automatique.
function SubsidyReceiptsPanel({ provision }) {
  const [state, setState] = useState({ loading: true, receipts: [], reconciliation: null })
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ received_date: '', amount: '', note: '' })
  const [regularizing, setRegularizing] = useState(false)
  const [scanning, setScanning] = useState(false)
  const { addToast } = useToast()
  const bankLabel = provision.config?.bank_match_label || null

  const load = useCallback(async () => {
    try {
      const out = await api.monthEnd.receipts(provision.id)
      setState({ loading: false, ...out })
    } catch (e) {
      setState(s => ({ ...s, loading: false }))
      addToast({ message: `Chargement des réceptions impossible : ${e.message}`, type: 'error' })
    }
  }, [provision.id, addToast])

  useEffect(() => { load() }, [load])

  async function addRow() {
    if (!draft.received_date || !Number(draft.amount)) {
      addToast({ message: 'Date et montant requis', type: 'error' }); return
    }
    try {
      await api.monthEnd.addReceipt(provision.id, { ...draft, amount: Number(draft.amount) })
      setDraft({ received_date: '', amount: '', note: '' }); setAdding(false)
      await load()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }

  async function removeRow(id) {
    await api.monthEnd.deleteReceipt(id)
    await load()
  }

  // Relance la détection sans attendre le prochain import bancaire — utile
  // juste après avoir renseigné le libellé, ou pour vérifier tout de suite.
  async function handleScan() {
    setScanning(true)
    try {
      const out = await api.monthEnd.scanBankReceipts(provision.id)
      addToast({
        message: out.found.length
          ? `${out.found.length} versement(s) trouvé(s) dans le relevé bancaire`
          : 'Aucun nouveau versement trouvé dans le relevé bancaire',
        type: out.found.length ? 'success' : 'info',
      })
      await load()
    } catch (e) {
      addToast({ message: `Recherche impossible : ${e.message}`, type: 'error' })
    } finally {
      setScanning(false)
    }
  }

  async function handleRegularize() {
    setRegularizing(true)
    try {
      const out = await api.monthEnd.regularizeSubsidy(provision.id)
      addToast({ message: `Écriture de régularisation comptabilisée (JE #${out.qb_je_id})`, type: 'success' })
      await load()
    } catch (e) {
      addToast({ message: `Régularisation échouée : ${e.message}`, type: 'error' })
    } finally {
      setRegularizing(false)
    }
  }

  const { loading, receipts, reconciliation: r } = state

  return (
    <div className="mt-3 pt-3 border-t border-slate-100" data-testid="subsidy-receipts-panel">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-slate-600">Réception de la subvention (Biotalent)</h3>
        {bankLabel ? (
          <button onClick={handleScan} disabled={scanning} data-testid="scan-bank-receipts"
            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 disabled:opacity-50">
            <RotateCw size={12} className={scanning ? 'animate-spin' : ''} /> {scanning ? 'Recherche…' : 'Rechercher dans le relevé bancaire'}
          </button>
        ) : (
          <span className="text-[11px] text-slate-400">Détection auto désactivée — renseigner un libellé dans « Paramètres de calcul »</span>
        )}
      </div>
      {loading ? (
        <div className="text-xs text-slate-400"><Spinner size="xs" label="Chargement…" /></div>
      ) : (
        <>
          {receipts.length > 0 && (
            <table className="w-full text-sm mb-2">
              <tbody>
                {receipts.map(row => (
                  <tr key={row.id} className="border-t border-slate-50">
                    <td className="py-1 pr-4 text-xs text-slate-500 w-28">{row.received_date}</td>
                    <td className="py-1 pr-4 text-xs text-slate-500">
                      {row.note || '—'}
                      {row.source === 'banque' && (
                        <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-slate-100 text-slate-500">détecté dans le relevé</span>
                      )}
                    </td>
                    <td className="py-1 pr-4 text-right tabular-nums w-28">{fmtMoney(row.amount)}</td>
                    <td className="py-1 w-8 text-right">
                      <button onClick={() => removeRow(row.id)} className="p-1 text-slate-300 hover:text-red-500"><Trash2 size={13} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {adding ? (
            <div className="flex items-center gap-2 mb-2">
              <input type="date" value={draft.received_date} data-testid="receipt-date"
                onChange={e => setDraft(d => ({ ...d, received_date: e.target.value }))} className={`${inputCls} w-36`} />
              <input type="number" step="0.01" value={draft.amount} data-testid="receipt-amount"
                onChange={e => setDraft(d => ({ ...d, amount: e.target.value }))} className={`${inputCls} w-32`} />
              <input value={draft.note}
                onChange={e => setDraft(d => ({ ...d, note: e.target.value }))} className={`${inputCls} flex-1`} />
              <button onClick={addRow} data-testid="receipt-save" className="px-3 py-1.5 text-sm text-white bg-brand-600 hover:bg-brand-700 rounded-lg">Ajouter</button>
              <button onClick={() => setAdding(false)} className="px-3 py-1.5 text-sm text-slate-500">Annuler</button>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} data-testid="receipt-add"
              className="inline-flex items-center gap-1 mb-2 text-xs text-slate-500 hover:text-slate-700">
              <Plus size={13} /> Enregistrer un versement reçu
            </button>
          )}

          {r && (
            <div className="flex items-center justify-between gap-4 bg-slate-50 rounded-lg px-3 py-2 mt-1">
              <div className="text-xs text-slate-500 space-y-0.5">
                <div>Comptabilisé comme subvention à recevoir : <span className="font-medium text-slate-700 tabular-nums">{fmtMoney(r.provisioned)}</span></div>
                <div>Réellement reçu à ce jour : <span className="font-medium text-slate-700 tabular-nums">{fmtMoney(r.received)}</span></div>
                <div>Écart à régulariser : <span className="font-medium text-slate-700 tabular-nums" data-testid="subsidy-outstanding">{fmtMoney(r.outstanding)}</span></div>
              </div>
              {Math.abs(r.outstanding) > 0.005 && (
                <button onClick={handleRegularize} disabled={regularizing} data-testid="regularize-subsidy"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-lg disabled:opacity-50 shrink-0">
                  {regularizing ? 'Régularisation…' : `Imputer l'écart à l'état des résultats — ${fmtMoney(Math.abs(r.outstanding))}`}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Frais payés d'avance (servi par le module des comptes prépayés) ─────────

function FpaCard({ month, fpa, onChanged }) {
  const [publishing, setPublishing] = useState(false)
  const { addToast } = useToast()
  // Le numéro seul ne dit pas où l'imputation atterrit : « Intact Assurances » est le
  // LIBELLÉ du frais payé d'avance, le débit va au compte de dépense (60000 Assurances).
  // On affiche le nom du compte QB pour que ce soit vérifiable sans quitter la page.
  const { accountName } = useQbAccounts()
  if (!fpa) return null
  const pushedCount = fpa.lines?.filter(l => l.pushed_at).length || 0

  async function handlePublish() {
    setPublishing(true)
    try {
      const out = await api.prepaid.fpaPublish(month)
      addToast({ message: `Écriture comptabilisée (JE #${out.qb_je_id})`, type: 'success' })
      await onChanged()
    } catch (e) {
      addToast({ message: `Comptabilisation échouée : ${e.message}`, type: 'error' })
    } finally {
      setPublishing(false)
    }
  }

  return (
    <Card
      title="Imputation des frais payés d'avance"
      subtitle="Cédule de continuité #13000 — gérée dans Comptes prépayés, comptabilisable ici."
      right={
        <>
          <StatusPill
            pushed={!fpa.publishable_count && pushedCount > 0}
            ready={fpa.publishable_count > 0 && !fpa.missing_accounts?.length}
            amount={fpa.publishable_total}
          />
          {fpa.publishable_count > 0 && (
            <button onClick={handlePublish} disabled={publishing || fpa.missing_accounts?.length > 0} data-testid="publish-fpa"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
              {publishing ? 'Comptabilisation…' : `Comptabiliser — ${fmtMoney(fpa.publishable_total)}`}
            </button>
          )}
        </>
      }
    >
      <Warnings items={fpa.missing_accounts?.length ? [`Compte de dépense QB manquant sur : ${fpa.missing_accounts.join(', ')} — à renseigner dans Comptes prépayés.`] : []} />
      {fpa.lines?.length ? (
        <table className="w-full text-sm">
          <tbody>
            {fpa.lines.map(l => (
              <tr key={l.expense_id} className="border-t border-slate-50">
                <td className="py-1.5 pr-4">{l.label}</td>
                <td className="py-1.5 pr-4 text-xs text-slate-500">
                  Dr #{l.expense_acctnum || '?'}{accountName(l.expense_acctnum) ? ` ${accountName(l.expense_acctnum)}` : ''}
                  {' / '}Cr #{l.fpa_acctnum}{accountName(l.fpa_acctnum) ? ` ${accountName(l.fpa_acctnum)}` : ''}
                </td>
                <td className="py-1.5 pr-4 text-right tabular-nums">{fmtMoney(l.amount)}</td>
                <td className="py-1.5 text-right">
                  {l.pushed_at
                    ? (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                        <CheckCircle2 size={13} />
                        {l.qb_je_id
                          ? (l.qb_je_url
                            ? <a href={l.qb_je_url} target="_blank" rel="noreferrer" className="underline hover:text-emerald-700">JE #{l.qb_je_id}</a>
                            : `JE #${l.qb_je_id}`)
                          : 'Comptabilisé'}
                      </span>
                    )
                    : <span className="text-xs text-slate-400">À comptabiliser</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="text-sm text-slate-400 py-2">Aucun amortissement ce mois-ci.</div>
      )}
    </Card>
  )
}

// ── Déboursés de pièces ─────────────────────────────────────────────────────

// Remplace la procédure « Pièces_Déboursés_<mois> » : export du grand livre du
// compte 14000 vers Sheets, ménage des écritures de journal, report du bloc
// sommaire du mois précédent, dépôt dans le Drive, message à Guillaume.
//
// Le calcul et le fichier sont automatiques (cron du 7) ; le message Slack est
// un bouton — l'utilisateur signe le chiffre avant qu'il ne parte. Le détail
// des opérations est replié par défaut : ce qu'on vient vérifier ici, c'est le
// montant, pas les 15 lignes qui le composent.
function PiecesCard({ month }) {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(null)
  const [showLines, setShowLines] = useState(false)
  const { addToast } = useToast()

  const load = useCallback(() => {
    api.monthEnd.pieces(month).then(setState).catch(() => setState({ month, computed: false }))
  }, [month])
  useEffect(() => { setState(null); setShowLines(false); load() }, [load, month])

  async function run(key, fn, done) {
    setBusy(key)
    try {
      const out = await fn()
      setState(out)
      if (done) addToast({ message: done(out), type: 'success' })
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setBusy(null)
    }
  }

  async function handleSend() {
    let preview
    try {
      preview = await api.monthEnd.piecesSlackPreview(month)
    } catch (e) {
      return addToast({ message: e.message, type: 'error' })
    }
    if (!preview.webhook_configured) {
      return addToast({ message: `Webhook Slack absent : ajouter ${preview.webhook_env} dans server/.env`, type: 'error' })
    }
    await run('slack', () => api.monthEnd.piecesSlackSend(month), () => `Message envoyé à ${preview.recipient}`)
  }

  const sent = !!state?.slack_sent_at
  const computed = !!state?.computed
  const corrected = state && (state.override_debut != null || state.override_fin != null)

  return (
    <Card
      title="Déboursés de pièces"
      subtitle="Compte 14000 Stock de Pièces — dépenses et factures à payer du mois, écritures de journal exclues. Remplace le fichier Pièces_Déboursés du Drive et le message mensuel à Guillaume."
      right={
        <>
          {sent
            ? <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-50 text-emerald-700"><CheckCircle2 size={12} /> Envoyé</span>
            : computed
              ? <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-brand-50 text-brand-700">À valider puis envoyer</span>
              : <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-slate-100 text-slate-500">Pas encore calculé</span>}
          <button onClick={() => run('compute', () => api.monthEnd.piecesCompute(month), o => `Déboursés recalculés — ${fmtMoney(o.debourses)}`)}
            disabled={!!busy} data-testid="pieces-compute"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg disabled:opacity-50">
            <RotateCw size={14} className={busy === 'compute' ? 'animate-spin' : ''} />
            {busy === 'compute' ? 'Calcul…' : computed ? 'Recalculer' : 'Calculer le mois'}
          </button>
        </>
      }
    >
      {!state && <div className="text-sm text-slate-400 py-2"><Spinner size="xs" label="Chargement…" /></div>}

      {state && !computed && (
        <div className="text-sm text-slate-400 py-2">
          Aucun calcul pour ce mois. La préparation automatique tourne le 7 ; « Calculer le mois » la lance tout de suite.
        </div>
      )}

      {computed && (
        <>
          <Warnings items={corrected ? ['Un montant « à payer » a été corrigé à la main — le calcul QuickBooks est indiqué en dessous. La correction se reporte au mois suivant.'] : []} />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8">
            <div>
              <Step label="Achats du mois" value={fmtMoney(state.achats)} hint={`${state.lines.length} opération(s)`} />
              <Step label="(+) À payer au début" value={fmtMoney(state.a_payer_debut)} hint="dû à la fin du mois précédent" />
              <Step label="(−) À payer à la fin" value={fmtMoney(-state.a_payer_fin)} hint={`${state.unpaid_lines.length} facture(s) encore due(s)`} />
              <div className="flex items-baseline justify-between py-2 border-t border-slate-100 mt-1">
                <span className="text-sm font-semibold text-slate-800">Déboursés du mois</span>
                <span className="text-lg font-semibold tabular-nums text-slate-900" data-testid="pieces-debourses">{fmtMoney(state.debourses)}</span>
              </div>
              <button onClick={() => setShowLines(s => !s)} className="mt-1 text-xs text-slate-400 hover:text-slate-600">
                {showLines ? 'Masquer le détail des opérations' : `Voir le détail (${state.lines.length} opérations)`}
              </button>
            </div>

            <div>
              <div className="flex items-center justify-between py-2">
                <div>
                  <div className="text-xs font-medium text-slate-600">Correction — à payer au début</div>
                  <div className="text-[11px] text-slate-400">Calcul QuickBooks : {fmtMoney(state.a_payer_debut_calcule)}. Vider pour y revenir.</div>
                </div>
                <NumberField value={state.override_debut ?? ''} className="w-32" testId="pieces-override-debut"
                  onSave={v => api.monthEnd.piecesUpdate(month, { override_debut: v }).then(setState)} />
              </div>
              <div className="flex items-center justify-between py-2 border-t border-slate-50">
                <div>
                  <div className="text-xs font-medium text-slate-600">Correction — à payer à la fin</div>
                  <div className="text-[11px] text-slate-400">Calcul QuickBooks : {fmtMoney(state.a_payer_fin_calcule)}. Montant positif.</div>
                </div>
                <NumberField value={state.override_fin ?? ''} className="w-32" testId="pieces-override-fin"
                  onSave={v => api.monthEnd.piecesUpdate(month, { override_fin: v }).then(setState)} />
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-3 mt-1 border-t border-slate-100">
                <button onClick={() => run('sheet', () => api.monthEnd.piecesSheet(month), o => `${o.drive_name} déposé dans le Drive`)}
                  disabled={!!busy} data-testid="pieces-sheet"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg disabled:opacity-50">
                  <FileSpreadsheet size={14} />
                  {busy === 'sheet' ? 'Dépôt…' : state.drive_file_id ? 'Régénérer le fichier' : 'Générer le fichier Drive'}
                </button>
                <button onClick={handleSend} disabled={!!busy} data-testid="pieces-send"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
                  <Send size={14} />
                  {busy === 'slack' ? 'Envoi…' : sent ? 'Renvoyer à Guillaume' : `Envoyer à Guillaume — ${fmtMoney(state.debourses)}`}
                </button>
              </div>

              <div className="text-xs text-slate-500 mt-2 space-y-0.5">
                {state.drive_url && (
                  <a href={state.drive_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-600 hover:underline">
                    <ExternalLink size={12} /> {state.drive_name}
                  </a>
                )}
                {sent && <div className="text-emerald-600">Message envoyé le {fmtDateTime(state.slack_sent_at)}</div>}
              </div>
            </div>
          </div>

          {showLines && (
            <table className="w-full text-sm mt-3 border-t border-slate-100">
              <tbody>
                {state.lines.map((l, i) => (
                  <tr key={i} className="border-b border-slate-50">
                    <td className="py-1.5 pr-3 text-xs text-slate-500 whitespace-nowrap">{l.date}</td>
                    <td className="py-1.5 pr-3 text-xs text-slate-500 whitespace-nowrap">{l.type}</td>
                    <td className="py-1.5 pr-3">{l.name}</td>
                    <td className="py-1.5 pr-3 text-xs text-slate-400 max-w-md truncate">{l.memo}</td>
                    <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{fmtMoney(l.amount)}</td>
                  </tr>
                ))}
                {!!state.unpaid_lines.length && (
                  <tr>
                    <td colSpan={5} className="pt-3 text-xs text-slate-500">
                      Encore dû au dernier jour du mois : {state.unpaid_lines.map(l => `${l.name} (${fmtMoney(l.amount)})`).join(' · ')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </>
      )}
    </Card>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function FinDeMois() {
  // On ouvre sur le mois qui vient de se terminer : la clôture se fait au début
  // du mois suivant, pas sur le mois en cours.
  const [month, setMonth] = useState(() => {
    const d = new Date()
    d.setUTCDate(1)
    d.setUTCMonth(d.getUTCMonth() - 1)
    return d.toISOString().slice(0, 7)
  })
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [retrying, setRetrying] = useState(false)

  // Un échec de chargement ne doit pas laisser la page morte : le serveur peut
  // être en train de redémarrer (502 nginx) ou le réseau avoir hoqueté. On
  // retente une fois tout seul, puis on laisse un bouton « Réessayer » —
  // sinon l'écran reste bloqué sur un message d'erreur jusqu'à un F5 manuel.
  const load = useCallback(async ({ retry = true } = {}) => {
    setRetrying(true)
    try {
      setData(await api.monthEnd.month(month))
      setError(null)
      return true
    } catch (e) {
      if (retry) {
        await new Promise(r => setTimeout(r, 1500))
        return load({ retry: false })
      }
      setError(friendlyLoadError(e))
      setData(null)
      return false
    } finally {
      setRetrying(false)
    }
  }, [month])
  // Rechargement après une mutation (autosave, comptabilisation) : pas de
  // seconde tentative silencieuse, l'appelant affiche déjà un toast.
  const reload = useCallback(() => load({ retry: false }), [load])
  useEffect(() => { load() }, [load])

  const shiftMonth = delta => {
    const d = new Date(`${month}-15T12:00:00Z`)
    d.setUTCMonth(d.getUTCMonth() + delta)
    setMonth(d.toISOString().slice(0, 7))
  }

  const remaining = (data?.provisions || []).filter(p => p.active && !p.pushed_at && p.amount > 0).length
    + (data?.fpa?.publishable_count > 0 ? 1 : 0)

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-5">
          <div>
            <PageTitle>Écritures de fin de mois</PageTitle>
            <p className="text-xs text-slate-500 mt-0.5">
              Provisions mensuelles et imputations — remplace les fichiers Provisions_mensuelles_CTB, R&D_Suivi_Feuilles de temps et FPA_Continuité.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {data && (
              <span className="text-xs text-slate-500">
                {remaining ? `${remaining} écriture(s) à comptabiliser` : 'Mois clôturé ✓'}
              </span>
            )}
            <div className="flex items-center gap-1">
              <button onClick={() => shiftMonth(-1)} className="p-1 text-slate-400 hover:text-slate-600"><ChevronLeft size={18} /></button>
              <span className="text-sm font-semibold text-slate-800 w-32 text-center" data-testid="month-label">{monthLabel(month)}</span>
              <button onClick={() => shiftMonth(1)} className="p-1 text-slate-400 hover:text-slate-600"><ChevronRight size={18} /></button>
            </div>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4" data-testid="load-error">
            <AlertTriangle size={15} className="shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => load()} disabled={retrying} data-testid="retry-load"
              className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-60">
              <RotateCw size={12} className={retrying ? 'animate-spin' : ''} /> Réessayer
            </button>
          </div>
        )}

        {!data && !error && (
          <div className="text-sm text-slate-400" data-testid="month-end-loading">Chargement des écritures…</div>
        )}

        {data && (
          <>
            <ReadinessCard month={month} refreshKey={data} />
            <HoursCard month={month} hours={data.hours} fileName={data.timesheet_file} onChanged={reload} />
            {data.provisions.filter(p => p.active).map(p => (
              <ProvisionCard key={p.id} month={month} provision={p} onChanged={reload} />
            ))}
            <FpaCard month={month} fpa={data.fpa} onChanged={reload} />
            <PiecesCard month={month} />
            <div className="flex items-start gap-2 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
              <Info size={14} className="mt-0.5 shrink-0" />
              Chaque écriture est datée du dernier jour du mois et publiée seulement après approbation ici.
              Les paramètres de calcul se modifient sur chaque carte (« Paramètres de calcul ») ; l'historique des préparations automatiques du 1er du mois se consulte dans Automations → « Écritures de fin de mois ».
              Les déboursés de pièces sont préparés le 7 (Automations → « Déboursés mensuels en pièces ») — le message à Guillaume ne part qu'après validation du montant ici.
            </div>
          </>
        )}
      </div>
    </Layout>
  )
}
