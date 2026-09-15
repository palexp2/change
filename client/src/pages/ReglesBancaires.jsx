// Les règles bancaires — ce que Charles tient dans QuickBooks (Banque →
// Règles), rapatrié dans Boréal.
//
// Une règle est une liste de CONDITIONS (libellé, compte et sens, fourchette de
// montant, jour du mois) qui posent des VALEURS (fournisseur, compte de
// dépense, code de taxe, mémo, type d'écriture). Décision du 2026-09-12 :
// **une règle prépare, elle ne publie pas** — il n'y a pas de case « publier
// automatiquement », même règle par règle. Une règle remplit le dossier de
// préparation de la ligne, et un clic humain l'envoie dans QuickBooks.
//
// Trois façons d'en avoir : l'écrire, laisser Boréal la déduire de ce qu'on a
// déjà publié, ou importer le fichier exporté de QuickBooks (l'API, elle, ne
// donne pas les règles).
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Upload, Sparkles, Brush, ChevronRight } from 'lucide-react'
import { Layout } from '../components/Layout.jsx'
import { Modal } from '../components/Modal.jsx'
import Spinner from '../components/Spinner.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import api from '../lib/api.js'
import { fmtMoney } from '../utils/formatters.js'

const money = (n) => fmtMoney(n, 'CAD')
const accountLabel = (accounts, id) =>
  accounts.find((a) => String(a.Id) === String(id))?.Name || `compte ${id}`

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
function RuleForm({ rule, accounts, qbAccounts, taxCodes, onSaved, onCancel }) {
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

// ── L'import du fichier exporté de QuickBooks ──────────────────────────────
function ImportQb({ onDone, onCancel }) {
  const fileRef = useRef(null)
  const [result, setResult] = useState(null)
  const [picked, setPicked] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const read = async (file) => {
    setBusy(true); setError(null)
    try {
      const r = await api.bank.rules.previewQbFile(file)
      setResult(r)
      // Tout ce qui se traduit entièrement est coché d'office ; ce qui laisse
      // un trou attend une décision.
      setPicked(new Set(r.rules.filter((x) => !x.unresolved.length).map((x) => x.source_row)))
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const commit = async () => {
    setBusy(true); setError(null)
    try {
      const rules = result.rules.filter((r) => picked.has(r.source_row)).map((r) => r.rule)
      await api.bank.rules.importQb(rules)
      onDone()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3 text-sm">
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="text-xs text-slate-500">
        Dans QuickBooks : Opérations bancaires → Règles → Exporter. Déposez le fichier ici.
      </div>
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="text-xs"
        onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />

      {busy && <Spinner />}

      {result?.warnings?.map((w) => <div key={w} className="text-xs text-amber-700">{w}</div>)}

      {!!result?.rules?.length && (
        <>
          <div className="max-h-80 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-lg">
            {result.rules.map((r) => (
              <label key={r.source_row} className="flex gap-2 px-2.5 py-2 text-xs cursor-pointer hover:bg-slate-50">
                <input type="checkbox" className="mt-0.5" checked={picked.has(r.source_row)}
                  onChange={() => setPicked((s) => {
                    const n = new Set(s)
                    if (n.has(r.source_row)) n.delete(r.source_row); else n.add(r.source_row)
                    return n
                  })} />
                <div className="min-w-0">
                  <div className="font-medium text-slate-700 truncate">{r.rule.name}</div>
                  <div className="text-slate-500 truncate">
                    contient « {r.rule.label_pattern} »
                    {r.rule.amount_min != null && ` · ≥ ${money(r.rule.amount_min)}`}
                    {r.rule.amount_max != null && ` · ≤ ${money(r.rule.amount_max)}`}
                  </div>
                  {r.unresolved.map((u) => <div key={u} className="text-amber-700">{u}</div>)}
                </div>
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <button type="button" className="px-3 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
              disabled={busy || !picked.size} onClick={commit}>
              Importer {picked.size}
            </button>
            <button type="button" className="px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50" onClick={onCancel}>
              Annuler
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ── L'atelier : les habitudes que le relevé raconte ────────────────────────
//
// Trois degrés, et on ne fait jamais semblant d'avoir le troisième : la règle
// complète se crée d'un clic (ou en lot), celle à compléter attend son compte,
// celle à qualifier attend qu'on dise de quel fournisseur il s'agit.
const TIER_BAR = { complete: 'bg-emerald-500', a_completer: 'bg-amber-400', a_qualifier: 'bg-slate-300' }

function Atelier({ qbAccounts, onDone }) {
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(false)
  const [gone, setGone] = useState(() => new Set())
  const [picks, setPicks] = useState({})

  useEffect(() => { api.bank.rules.habits().then(setRows).catch(() => setRows([])) }, [])

  const left = (rows || []).filter((h) => !gone.has(h.label_pattern))
  const ready = left.filter((h) => h.tier === 'complete' || picks[h.label_pattern])

  const create = async (h) => {
    const account = picks[h.label_pattern] || h.expense_account_id || null
    setBusy(true)
    try {
      await api.bank.rules.create({
        name: h.name, label_pattern: h.label_pattern, direction: h.direction,
        vendor_name: h.vendor_name, expense_account_id: account,
        tax_code_id: h.tax_code_id, origin: 'releve', priority: 100,
      })
      setGone((g) => new Set(g).add(h.label_pattern))
    } finally { setBusy(false) }
  }

  const createReady = async () => {
    setBusy(true)
    try {
      for (const h of ready) {
        await api.bank.rules.create({
          name: h.name, label_pattern: h.label_pattern, direction: h.direction,
          vendor_name: h.vendor_name, expense_account_id: picks[h.label_pattern] || h.expense_account_id,
          tax_code_id: h.tax_code_id, origin: 'releve', priority: 100,
        })
      }
      setGone((g) => { const n = new Set(g); ready.forEach((h) => n.add(h.label_pattern)); return n })
    } finally { setBusy(false) }
  }

  if (!rows) return <Spinner />
  if (!left.length) return (
    <div className="space-y-3 text-sm">
      <div className="text-slate-500 py-6 text-center">Plus rien à examiner.</div>
      <button type="button" className="px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50" onClick={onDone}>Fermer</button>
    </div>
  )

  return (
    <div className="space-y-2 text-sm">
      <div className="text-xs text-slate-500">{left.length} habitudes du relevé, les plus prêtes d'abord.</div>

      <div className="max-h-[26rem] overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-lg">
        {left.map((h) => (
          <div key={h.label_pattern} className="flex gap-3 px-2.5 py-2">
            <span className={`w-0.5 rounded self-stretch shrink-0 ${TIER_BAR[h.tier]}`} />
            <div className="min-w-0 flex-1">
              <div className="font-mono text-xs text-slate-700 truncate">{h.label_pattern}</div>
              <div className="text-xs text-slate-400">
                {h.lines} lignes sur {h.months} mois · {h.direction === 'entree' ? 'entrées' : 'sorties'}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                {h.tier === 'complete' && <>remplirait <b className="font-medium text-slate-700">{h.vendor_name}</b> · {accountLabel(qbAccounts, h.expense_account_id)}</>}
                {h.tier === 'a_completer' && <>remplirait <b className="font-medium text-slate-700">{h.vendor_name}</b></>}
                {h.tier === 'a_qualifier' && 'aucun fournisseur reconnu'}
              </div>
              {h.tier === 'a_completer' && (
                <div className="mt-1">
                  <SearchableSelect value={picks[h.label_pattern] || ''}
                    onChange={(v) => setPicks((p) => ({ ...p, [h.label_pattern]: v }))}
                    options={qbAccounts} getOptionValue={(a) => String(a.Id)}
                    getOptionLabel={(a) => `${a.AcctNum ? `${a.AcctNum} · ` : ''}${a.Name}`}
                    emptyOption="Choisir un compte" placeholder="Choisir un compte" />
                </div>
              )}
              {h.warnings?.map((w) => <div key={w} className="text-xs text-amber-700">{w}</div>)}
            </div>
            <div className="flex flex-col gap-1 shrink-0">
              <button type="button" disabled={busy || h.tier === 'a_qualifier'}
                className={`px-2 py-1 text-xs rounded-lg disabled:opacity-40 ${h.tier === 'complete' || picks[h.label_pattern] ? 'bg-brand-600 text-white hover:bg-brand-700' : 'border border-slate-300 text-slate-600 hover:bg-slate-50'}`}
                onClick={() => create(h)}>Créer</button>
              <button type="button" className="px-2 py-1 text-xs rounded-lg text-slate-400 hover:text-slate-700"
                onClick={() => setGone((g) => new Set(g).add(h.label_pattern))}>Passer</button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500 mr-auto">{ready.length} prêtes</span>
        <button type="button" disabled={busy || !ready.length}
          className="px-3 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-40"
          onClick={createReady}>Créer les {ready.length} prêtes</button>
        <button type="button" className="px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50" onClick={onDone}>Fermer</button>
      </div>
    </div>
  )
}

// ── Le ménage : ce qui encombre, nommé et chiffré ──────────────────────────
//
// Rien n'est effacé — une règle rangée est désactivée et se restaure. Les
// règles qui débordent ne se rangent pas toutes seules : seule une personne
// sait ce qu'elles devaient viser.
function Menage({ onDone }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [undo, setUndo] = useState(null)

  const load = () => api.bank.rules.housekeeping().then(setData).catch(() => setData(null))
  useEffect(() => { load() }, [])

  const archive = async (lot) => {
    const ids = lot.items.map((i) => i.id)
    setBusy(true)
    try { await api.bank.rules.archive(ids); setUndo({ ids, label: lot.label }); await load() }
    finally { setBusy(false) }
  }

  const restore = async () => {
    setBusy(true)
    try { await api.bank.rules.restore(undo.ids); setUndo(null); await load() }
    finally { setBusy(false) }
  }

  if (!data) return <Spinner />

  return (
    <div className="space-y-2 text-sm">
      <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
        {data.lots.map((lot) => (
          <div key={lot.key} className="flex items-center gap-3 px-3 py-2.5">
            <span className={`text-2xl leading-none tabular-nums w-9 text-right shrink-0 ${lot.warn ? 'text-amber-600' : 'text-slate-400'}`}>
              {lot.items.length}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-slate-700">{lot.label}</div>
              <div className="text-xs text-slate-400 truncate">{lot.items.map((i) => i.name).join(', ')}</div>
            </div>
            {lot.action && (
              <button type="button" disabled={busy}
                className="shrink-0 px-2.5 py-1 text-xs rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                onClick={() => archive(lot)}>{lot.action}</button>
            )}
          </div>
        ))}
        <div className="flex items-center gap-3 px-3 py-2.5">
          <span className="text-2xl leading-none tabular-nums w-9 text-right shrink-0 text-emerald-600">{data.healthy}</span>
          <div className="text-slate-700">En bon état</div>
        </div>
      </div>

      {undo && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="mr-auto">{undo.label} rangées.</span>
          <button type="button" className="underline hover:text-slate-700" onClick={restore}>Annuler</button>
        </div>
      )}

      <button type="button" className="px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50" onClick={onDone}>Fermer</button>
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

export default function ReglesBancaires() {
  const [rules, setRules] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [qbAccounts, setQbAccounts] = useState([])
  const [taxCodes, setTaxCodes] = useState([])
  const [modal, setModal] = useState(null) // 'new' | 'import' | 'suggest' | rule
  const [error, setError] = useState(null)
  const [openId, setOpenId] = useState(null)
  const [shut, setShut] = useState(() => new Set(PILES.filter((p) => !p.open).map((p) => p.key)))

  const load = () => api.bank.rules.list().then(setRules).catch((e) => setError(e.message))

  useEffect(() => {
    load()
    api.bank.accounts().then(setAccounts).catch(() => {})
    Promise.all([api.quickbooks.accounts(), api.quickbooks.taxCodes()])
      .then(([a, t]) => { setQbAccounts(a || []); setTaxCodes(t || []) }).catch(() => {})
  }, [])

  const accountName = (id) => qbAccounts.find((a) => String(a.Id) === String(id))?.Name || id

  // Les règles rangées par pile, la plus productive en tête de chacune.
  const piles = useMemo(() => PILES.map((p) => ({
    ...p,
    rules: (rules || []).filter((r) => stateOf(r) === p.key).sort((a, b) => b.covers - a.covers),
  })), [rules])

  const remove = async (r) => {
    await api.bank.rules.remove(r.id)
    load()
  }

  // Aligner le libellé de la règle sur celui de NOTRE relevé, sans rien inventer :
  // on retire seulement les mots de tête que notre banque ne nous transmet pas.
  const relax = async (r) => {
    await api.bank.rules.relax(r.id)
    load()
  }

  const close = () => { setModal(null); load() }
  const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50'

  return (
    <Layout>
      <div className="p-4 max-w-3xl space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-lg font-semibold text-slate-800 mr-auto">Règles bancaires</h1>
          <button type="button" className={btn} onClick={() => setModal('suggest')}><Sparkles size={15} /> Atelier</button>
          <button type="button" className={btn} onClick={() => setModal('menage')}><Brush size={15} /> Ménage</button>
          <button type="button" className={btn} onClick={() => setModal('import')}><Upload size={15} /> QuickBooks</button>
          <button type="button" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700"
            onClick={() => setModal('new')}><Plus size={15} /> Règle</button>
        </div>

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
                        onEdit={() => setModal(r)} onRelax={() => relax(r)} onRemove={() => remove(r)} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="text-xs text-slate-400">Une règle prépare l'écriture. Elle ne publie jamais seule.</div>
      </div>

      {modal && (
        <Modal isOpen onClose={() => setModal(null)}
          title={modal === 'import' ? 'Importer les règles de QuickBooks'
            : modal === 'suggest' ? 'Habitudes du relevé'
              : modal === 'menage' ? 'Ménage'
              : modal === 'new' ? 'Nouvelle règle' : 'Règle'}>
          {modal === 'import' ? <ImportQb onDone={close} onCancel={() => setModal(null)} />
            : modal === 'suggest' ? <Atelier qbAccounts={qbAccounts} onDone={close} />
              : modal === 'menage' ? <Menage onDone={close} />
              : (
                <RuleForm rule={modal === 'new' ? null : modal} accounts={accounts}
                  qbAccounts={qbAccounts} taxCodes={taxCodes}
                  onSaved={close} onCancel={() => setModal(null)} />
              )}
        </Modal>
      )}
    </Layout>
  )
}
