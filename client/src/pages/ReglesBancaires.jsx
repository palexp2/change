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
import { useEffect, useRef, useState } from 'react'
import { Plus, Upload, Sparkles, Brush } from 'lucide-react'
import { Layout } from '../components/Layout.jsx'
import { Modal } from '../components/Modal.jsx'
import Spinner from '../components/Spinner.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
// La liste, ses piles et l'éditeur vivent dans le composant partagé : le volet
// « Règles » du rapprochement montre exactement la même chose.
import { BankRulesList, RuleForm } from '../components/BankRulesList.jsx'
import api from '../lib/api.js'
import { fmtMoney } from '../utils/formatters.js'

const money = (n) => fmtMoney(n, 'CAD')
const accountLabel = (accounts, id) =>
  accounts.find((a) => String(a.Id) === String(id))?.Name || `compte ${id}`


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



export default function ReglesBancaires() {
  const [accounts, setAccounts] = useState([])
  const [qbAccounts, setQbAccounts] = useState([])
  const [taxCodes, setTaxCodes] = useState([])
  const [modal, setModal] = useState(null) // 'new' | 'import' | 'suggest' | 'menage' | rule
  const [error, setError] = useState(null)
  // Change quand l'Atelier, le Ménage ou l'import ont touché aux règles : la
  // liste partagée se relit alors toute seule.
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    api.bank.accounts().then(setAccounts).catch(() => {})
    Promise.all([api.quickbooks.accounts(), api.quickbooks.taxCodes()])
      .then(([a, t]) => { setQbAccounts(a || []); setTaxCodes(t || []) }).catch((e) => setError(e.message))
  }, [])

  const close = () => { setModal(null); setReloadKey((k) => k + 1) }
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

        <BankRulesList reloadKey={reloadKey} />
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
