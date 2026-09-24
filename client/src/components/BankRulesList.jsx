// La liste des règles bancaires, partagée par la page /regles-bancaires et par
// le volet « Règles » du rapprochement : même liste, mêmes piles, même éditeur.
// Une règle PRÉPARE l'écriture, elle ne publie jamais seule — c'est l'invariant
// que les deux écrans doivent raconter de la même façon.
import { useEffect, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Modal } from './Modal.jsx'
import Spinner from './Spinner.jsx'
import ErrorBanner from './ErrorBanner.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'
import api from '../lib/api.js'
import { fmtMoney } from '../utils/formatters.js'

const money = (n) => fmtMoney(n, 'CAD')
const DIRECTIONS = [
  { value: 'sortie', label: 'Sortie' },
  { value: 'entree', label: 'Entrée' },
  { value: 'tous', label: 'Les deux' },
]

const EMPTY = {
  name: '', priority: 100, active: 1, account_id: '', direction: 'sortie',
  label_pattern: '', amount_min: '', amount_max: '', day_of_month: '', tolerance_days: 3,
  vendor_name: '', expense_account_id: '', tax_code_id: '', memo: '', qb_type: '',
}

// ── L'éditeur d'une règle, avec son aperçu de portée ───────────────────────
export function RuleForm({ rule, accounts, qbAccounts, taxCodes, onSaved, onCancel }) {
  const [form, setForm] = useState({ ...EMPTY, ...(rule || {}) })
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))

  // « Cette règle couvrirait N lignes » — recalculé à chaque changement de
  // condition, jamais sur les valeurs posées (elles ne filtrent rien).
  const conditions = JSON.stringify([form.label_pattern, form.account_id, form.direction,
    form.amount_min, form.amount_max, form.day_of_month, form.tolerance_days])
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      api.bank.rules.preview(form).then((p) => { if (alive) setPreview(p) }).catch(() => {})
    }, 300)
    return () => { alive = false; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conditions])

  const save = async () => {
    setBusy(true); setError(null)
    try {
      const body = { ...form }
      for (const k of ['amount_min', 'amount_max', 'day_of_month', 'priority', 'tolerance_days']) {
        body[k] = body[k] === '' || body[k] == null ? null : Number(body[k])
      }
      if (rule?.id) await api.bank.rules.update(rule.id, body)
      else await api.bank.rules.create(body)
      onSaved()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const input = 'w-full border border-slate-300 rounded-lg px-2 py-1 text-sm'
  const lbl = 'text-xs text-slate-500'

  return (
    <div className="space-y-3 text-sm">
      {error && <ErrorBanner>{error}</ErrorBanner>}

      <div className="grid grid-cols-3 gap-2">
        <label className="col-span-2 block">
          <span className={lbl}>Nom</span>
          <input className={input} value={form.name} onChange={(e) => set('name')(e.target.value)} />
        </label>
        <label className="block">
          <span className={lbl}>Priorité</span>
          <input type="number" className={input} value={form.priority ?? ''} onChange={(e) => set('priority')(e.target.value)} />
        </label>
      </div>

      <div className="rounded-lg border border-slate-200 p-2.5 space-y-2">
        <div className="text-xs font-medium text-slate-600">Si</div>
        <label className="block">
          <span className={lbl}>Le libellé contient</span>
          <input className={input} value={form.label_pattern || ''} onChange={(e) => set('label_pattern')(e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className={lbl}>Compte</span>
            <SearchableSelect value={form.account_id || ''} onChange={set('account_id')}
              options={accounts} getOptionValue={(a) => a.id} getOptionLabel={(a) => a.name}
              emptyOption="Tous les comptes" placeholder="Tous les comptes" />
          </label>
          <label className="block">
            <span className={lbl}>Sens</span>
            <select className={`${input} bg-white`} value={form.direction} onChange={(e) => set('direction')(e.target.value)}>
              {DIRECTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <label className="block">
            <span className={lbl}>Montant min</span>
            <input type="number" step="0.01" className={input} value={form.amount_min ?? ''} onChange={(e) => set('amount_min')(e.target.value)} />
          </label>
          <label className="block">
            <span className={lbl}>Max</span>
            <input type="number" step="0.01" className={input} value={form.amount_max ?? ''} onChange={(e) => set('amount_max')(e.target.value)} />
          </label>
          <label className="block">
            <span className={lbl}>Jour du mois</span>
            <input type="number" min="1" max="31" className={input} value={form.day_of_month ?? ''} onChange={(e) => set('day_of_month')(e.target.value)} />
          </label>
          <label className="block">
            <span className={lbl}>± jours</span>
            <input type="number" min="0" max="15" className={input} value={form.tolerance_days ?? ''} onChange={(e) => set('tolerance_days')(e.target.value)} />
          </label>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 p-2.5 space-y-2">
        <div className="text-xs font-medium text-slate-600">Alors préremplir</div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className={lbl}>Fournisseur</span>
            <input className={input} value={form.vendor_name || ''} onChange={(e) => set('vendor_name')(e.target.value)} />
          </label>
          <label className="block">
            <span className={lbl}>Type</span>
            <select className={`${input} bg-white`} value={form.qb_type || ''} onChange={(e) => set('qb_type')(e.target.value)}>
              <option value="">—</option>
              <option value="purchase">Dépense</option>
              <option value="bill">Facture fournisseur</option>
            </select>
          </label>
        </div>
        <label className="block">
          <span className={lbl}>Compte de dépense</span>
          <SearchableSelect value={form.expense_account_id || ''} onChange={set('expense_account_id')}
            options={qbAccounts} getOptionValue={(a) => String(a.Id)}
            getOptionLabel={(a) => `${a.AcctNum ? `${a.AcctNum} · ` : ''}${a.Name}`}
            emptyOption="—" placeholder="—" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className={lbl}>Taxe</span>
            <SearchableSelect value={form.tax_code_id || ''} onChange={set('tax_code_id')}
              options={taxCodes} getOptionValue={(t) => String(t.Id)} getOptionLabel={(t) => t.Name}
              emptyOption="—" placeholder="—" />
          </label>
          <label className="block">
            <span className={lbl}>Mémo</span>
            <input className={input} value={form.memo || ''} onChange={(e) => set('memo')(e.target.value)} />
          </label>
        </div>
      </div>

      {preview && (
        <div className={`rounded-lg px-2.5 py-2 text-xs space-y-1 ${preview.warnings?.length ? 'bg-amber-50 text-amber-800' : 'bg-slate-50 text-slate-600'}`}>
          <div>
            {preview.count} lignes · {preview.a_traiter} encore à traiter
            {preview.checked > 0 && ` · vérifiée sur ${preview.checked} déjà comptabilisées`}
          </div>
          {preview.warnings?.map((w) => <div key={w}>{w}</div>)}
          {preview.conflicts?.map((c) => (
            <div key={c.txn_date + c.label} className="truncate">{c.txn_date} · {money(c.amount)} · {c.why}</div>
          ))}
          {preview.overlaps?.map((o) => <div key={o.id}>recoupe « {o.name} »</div>)}
          {!preview.warnings?.length && preview.sample.map((r) => (
            <div key={r.id} className="text-slate-500 truncate">{r.txn_date} · {money(r.amount)} · {r.label}</div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <button type="button" className="px-3 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
          disabled={busy || !form.name} onClick={save}>
          {busy ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        <button type="button" className="px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </div>
  )
}

// ── Une ligne de la liste : un nom, un point, un nombre ────────────────────
//
// Tout le reste — la condition, ce que la règle pose, la preuve, l'alerte —
// vit un cran plus bas et ne s'ouvre qu'au clic. La page doit se lire d'un
// coup d'œil : ce qui va bien ne demande rien, ce qui cloche saute aux yeux.
const STATE_DOT = { ok: 'bg-emerald-500', warn: 'bg-amber-500', dead: 'bg-slate-300' }
const stateOf = (r) => (!r.covers ? 'dead' : (r.warnings?.length ? 'warn' : 'ok'))

function RuleRow({ rule, open, onToggle, accountName, onEdit, onRelax, onRemove }) {
  const r = rule
  const poses = [r.vendor_name, r.expense_account_id && accountName(r.expense_account_id), r.memo].filter(Boolean)
  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-slate-50">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATE_DOT[stateOf(r)]}`} />
        <span className="text-sm text-slate-700 truncate">{r.name}</span>
        <span className="flex-1" />
        <span className={`text-xs tabular-nums shrink-0 ${r.covers ? 'text-slate-500' : 'text-slate-300'}`}>
          {r.covers ? `${r.covers} lignes` : '—'}
        </span>
        <ChevronRight size={13} className={`shrink-0 text-slate-300 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && (
        <div className="px-3 pb-3 pl-8 bg-slate-50 text-xs space-y-2">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 pt-1">
            <span className="text-slate-400">Si</span>
            <span className="font-mono text-slate-600 break-words">
              {r.label_pattern}
              {r.account_name && ` · ${r.account_name}`}
              {r.amount_min != null && ` · ≥ ${money(r.amount_min)}`}
              {r.amount_max != null && ` · ≤ ${money(r.amount_max)}`}
              {r.day_of_month && ` · le ${r.day_of_month} ±${r.tolerance_days ?? 3} j`}
            </span>
            <span className="text-slate-400">Alors</span>
            <span className="text-slate-600">{poses.join(' · ') || 'rien'}</span>
            {r.checked > 0 && <>
              <span className="text-slate-400">Vérifiée</span>
              <span className="text-slate-600">sur {r.checked} lignes déjà comptabilisées</span>
            </>}
          </div>

          {(r.warnings?.length || !r.covers) && (
            <div className="rounded-lg bg-amber-100/70 text-amber-800 px-2.5 py-1.5 space-y-0.5">
              {r.warnings?.map((w) => <div key={w}>{w}</div>)}
              {!r.covers && !r.warnings?.length && (
                <div>{r.relaxation
                  ? 'Le libellé de QuickBooks est plus long que le nôtre.'
                  : 'Ce libellé n\'apparaît nulle part au relevé.'}</div>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-0.5">
            {r.relaxation && (
              <button type="button" onClick={onRelax}
                className="px-2 py-1 rounded-lg border border-amber-400 text-amber-800 hover:bg-amber-100">
                Assouplir → {r.relaxation.check.covers} lignes
              </button>
            )}
            <button type="button" onClick={onEdit} className="px-2 py-1 rounded-lg border border-slate-300 text-slate-600 hover:bg-white">
              Modifier
            </button>
            <button type="button" onClick={onRemove} className="px-2 py-1 rounded-lg text-slate-400 hover:text-red-600">
              Supprimer
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Les trois piles ────────────────────────────────────────────────────────
//
// « À regarder » et « Sans effet » sont ouvertes : ce sont les seules qui
// demandent quelque chose. « Travaillent » se replie derrière son chiffre —
// on n'a rien à y faire, mais on veut le voir.
const PILES = [
  { key: 'warn', label: 'À regarder', open: true, tone: 'text-amber-700 bg-amber-50' },
  { key: 'dead', label: 'Sans effet', open: true, tone: 'text-slate-500' },
  { key: 'ok', label: 'Travaillent', open: false, tone: 'text-slate-500' },
]

/**
 * Les règles rangées par pile, avec leur éditeur.
 *
 * `reloadKey` : un compteur que la page change quand l'Atelier, le Ménage ou
 * l'import ont touché aux règles — la liste se relit alors toute seule.
 */
export function BankRulesList({ reloadKey = 0, footer = null }) {
  const [rules, setRules] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [qbAccounts, setQbAccounts] = useState([])
  const [taxCodes, setTaxCodes] = useState([])
  const [error, setError] = useState(null)
  const [openId, setOpenId] = useState(null)
  const [editing, setEditing] = useState(null)
  const [shut, setShut] = useState(() => new Set(PILES.filter((p) => !p.open).map((p) => p.key)))

  const load = () => api.bank.rules.list().then(setRules).catch((e) => setError(e.message))

  useEffect(() => { load() }, [reloadKey])
  useEffect(() => {
    api.bank.accounts().then(setAccounts).catch(() => {})
    Promise.all([api.quickbooks.accounts(), api.quickbooks.taxCodes()])
      .then(([a, t]) => { setQbAccounts(a || []); setTaxCodes(t || []) }).catch(() => {})
  }, [])

  const accountName = (id) => qbAccounts.find((a) => String(a.Id) === String(id))?.Name || id

  const piles = useMemo(() => PILES.map((p) => ({
    ...p,
    rules: (rules || []).filter((r) => stateOf(r) === p.key).sort((a, b) => b.covers - a.covers),
  })), [rules])

  const remove = async (r) => { await api.bank.rules.remove(r.id); load() }
  // Aligner le libellé de la règle sur celui de NOTRE relevé, sans rien inventer :
  // on retire seulement les mots de tête que notre banque ne nous transmet pas.
  const relax = async (r) => { await api.bank.rules.relax(r.id); load() }

  return (
    <div className="space-y-3">
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {!rules ? <Spinner /> : rules.length === 0 ? (
        <div className="text-sm text-slate-400 py-8 text-center">Aucune règle.</div>
      ) : (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          {piles.map((p) => p.rules.length > 0 && (
            <div key={p.key}>
              <button type="button" aria-expanded={!shut.has(p.key)}
                onClick={() => setShut((s) => {
                  const n = new Set(s)
                  if (n.has(p.key)) n.delete(p.key); else n.add(p.key)
                  return n
                })}
                className={`w-full flex items-center gap-2 px-3 py-2 border-t border-slate-200 first:border-t-0 ${p.tone}`}>
                <ChevronRight size={13} className={`transition-transform ${shut.has(p.key) ? '' : 'rotate-90'}`} />
                <span className="text-xs font-semibold uppercase tracking-wide">{p.label}</span>
                <span className="ml-auto text-xs tabular-nums">{p.rules.length}</span>
              </button>
              {!shut.has(p.key) && (
                <div className="divide-y divide-slate-100">
                  {p.rules.map((r) => (
                    <RuleRow key={r.id} rule={r} accountName={accountName}
                      open={openId === r.id}
                      onToggle={() => setOpenId((id) => (id === r.id ? null : r.id))}
                      onEdit={() => setEditing(r)} onRelax={() => relax(r)} onRemove={() => remove(r)} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="text-xs text-slate-400">Une règle prépare l'écriture. Elle ne publie jamais seule.</div>
      {footer}

      {editing && (
        <Modal isOpen onClose={() => setEditing(null)} title="Règle">
          <RuleForm rule={editing} accounts={accounts} qbAccounts={qbAccounts} taxCodes={taxCodes}
            onSaved={() => { setEditing(null); load() }} onCancel={() => setEditing(null)} />
        </Modal>
      )}
    </div>
  )
}

export default BankRulesList
