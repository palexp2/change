// Budget marketing (Émilie) — automatise la procédure Drive « Suivi - Budget
// marketing » : les dépenses des comptes QB marketing, détectées automatiquement
// plusieurs fois par jour (cron aux 3 h), arrivent « à valider » ici ; on tranche pertinente / non pertinente / jamais
// pertinente (règle mémorisée par fournisseur), et le mardi un message Slack
// court part à Émilie avec les dépenses validées. Le tableau Budget vs Réel
// remplace le fichier Drive « Annual Marketing budget ».
import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, ExternalLink, Check, X, Ban, Trash2, Send, Eye } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { fmtDate, fmtDateTime } from '../lib/formatDate.js'
import { useToast } from '../contexts/ToastContext.jsx'

import { fmtMoney } from '../utils/formatters.js'
import Spinner from '../components/Spinner.jsx'

const STATUS_META = {
  pending: { label: 'À valider', color: 'amber' },
  relevant: { label: 'Pertinente', color: 'green' },
  not_relevant: { label: 'Non pertinente', color: 'gray' },
}

// Année financière courante (avril → mars) : année du dernier 1er avril.
function currentFy() {
  const now = new Date()
  return String(now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1)
}

const MONTH_LABELS = { '01': 'Jan', '02': 'Fév', '03': 'Mar', '04': 'Avr', '05': 'Mai', '06': 'Juin', '07': 'Juil', '08': 'Août', '09': 'Sep', 10: 'Oct', 11: 'Nov', 12: 'Déc' }
const monthLabel = m => MONTH_LABELS[m.slice(5)] || m

function ExpenseRow({ e, onDecide, onNever }) {
  const meta = STATUS_META[e.status] || STATUS_META.pending
  return (
    <tr data-expense-id={e.id} className={`border-b border-slate-50 ${e.status === 'pending' ? 'bg-amber-50/30' : ''}`}>
      <td className="px-4 py-2 whitespace-nowrap text-slate-600">{fmtDate(e.txn_date)}</td>
      <td className="px-2 py-2">
        <span className="font-medium text-slate-800">{e.vendor || '—'}</span>
        {e.memo && <span className="text-slate-500"> — {e.memo}</span>}
        {e.qb_url && (
          <a href={e.qb_url} target="_blank" rel="noreferrer" title="Ouvrir dans QuickBooks"
            className="ml-1.5 inline-block align-middle text-slate-400 hover:text-brand-600">
            <ExternalLink size={12} />
          </a>
        )}
      </td>
      <td className="px-2 py-2 text-xs text-slate-500 whitespace-nowrap">{e.acctnum} {e.account_name}</td>
      <td className="px-2 py-2 text-right tabular-nums font-medium whitespace-nowrap">
        {fmtMoney(e.amount)}
        {e.currency !== 'CAD' && e.amount_foreign != null && (
          <span className="block text-xs font-normal text-slate-400">{fmtMoney(e.amount_foreign, e.currency)}</span>
        )}
      </td>
      <td className="px-2 py-2 whitespace-nowrap">
        <Badge color={meta.color}>{meta.label}</Badge>
        {e.rule_label && <span className="block text-[11px] text-slate-400 mt-0.5">règle : {e.rule_label}</span>}
        {e.notified_at && <span className="block text-[11px] text-slate-400 mt-0.5">annoncée à Émilie</span>}
      </td>
      <td className="px-4 py-2 text-right whitespace-nowrap">
        {/* Un clic = décision appliquée, sans confirmation : la ligne quitte la
            liste immédiatement (l'enregistrement suit en arrière-plan). */}
        {e.status !== 'relevant' && !e.notified_at && (
          <button onClick={() => onDecide(e, 'relevant')} title="Pertinente pour le budget d'Émilie"
            className="px-2 py-1 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-md transition-colors">
            <Check size={13} className="inline -mt-0.5" /> Pertinente
          </button>
        )}
        {e.status !== 'not_relevant' && !e.notified_at && (
          <button onClick={() => onDecide(e, 'not_relevant')} title="Non pertinente (cette dépense seulement)"
            className="ml-1.5 px-2 py-1 text-xs text-slate-600 border border-slate-200 hover:bg-slate-50 rounded-md transition-colors">
            <X size={13} className="inline -mt-0.5" /> Non
          </button>
        )}
        {e.status === 'pending' && e.vendor && (
          <button onClick={() => onNever(e)} title={`Jamais pertinente — « ${e.vendor} » sera écarté automatiquement à l'avenir (annulable dans la liste des fournisseurs exclus)`}
            className="ml-1.5 px-2 py-1 text-xs text-red-600 border border-red-200 hover:bg-red-50 rounded-md transition-colors">
            <Ban size={13} className="inline -mt-0.5" /> Jamais
          </button>
        )}
      </td>
    </tr>
  )
}

// Preuve visible que la détection tourne d'elle-même : fréquence et heure du
// dernier passage automatique. Sans ça, rien ne distingue « ça tourne en
// arrière-plan » de « le bouton est le seul moyen d'alimenter la file ».
function AutoSyncNote({ info }) {
  if (!info) return null
  const failed = info.status === 'error'
  const dot = !info.active ? 'bg-slate-300' : failed ? 'bg-red-500' : 'bg-emerald-500'
  return (
    <span data-auto-sync className="inline-flex items-center gap-1.5 align-middle">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
      {info.active ? (
        <span>
          Détection automatique {info.schedule}
          {info.at && <> — dernier passage {fmtDateTime(info.at)}</>}
          {failed && <span className="text-red-600"> (échec — voir le journal de l’automation)</span>}
        </span>
      ) : (
        <span className="text-amber-700">
          Détection automatique désactivée dans les automations — seul le bouton alimente la file
        </span>
      )}
    </span>
  )
}

// Cellule budget éditable (autosave au blur — règle de design).
function BudgetCell({ acctnum, month, value, onSaved }) {
  const [text, setText] = useState(value != null ? String(value) : '')
  const { addToast } = useToast()
  useEffect(() => { setText(value != null ? String(value) : '') }, [value])
  const save = async () => {
    const n = text.trim() === '' ? 0 : Number(text.replace(',', '.'))
    if (!Number.isFinite(n) || n < 0) { setText(value != null ? String(value) : ''); return }
    if (n === (value ?? 0)) return
    try {
      await api.marketingBudget.setBudget({ acctnum, month, budget: n })
      onSaved(acctnum, month, n)
    } catch (e) {
      addToast({ message: `Sauvegarde échouée : ${e.message}`, type: 'error' })
      setText(value != null ? String(value) : '')
    }
  }
  return (
    <input
      value={text}
      onChange={e => setText(e.target.value)}
      onBlur={save}
      onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
      className="w-full px-1 py-0.5 text-right text-xs tabular-nums bg-transparent border border-transparent rounded
        hover:border-slate-200 focus:border-brand-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-400/30"
    />
  )
}

export default function MarketingBudget() {
  const { addToast } = useToast()
  const [data, setData] = useState(null)          // { expenses, pending }
  const [rules, setRules] = useState(null)
  const [summary, setSummary] = useState(null)
  const [fy, setFy] = useState(currentFy())
  const [filter, setFilter] = useState('pending')
  const [syncing, setSyncing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null)    // modal aperçu Slack

  const load = useCallback(async () => {
    const [exp, r, sum] = await Promise.all([
      api.marketingBudget.expenses(filter),
      api.marketingBudget.rules(),
      api.marketingBudget.summary(fy),
    ])
    setData(exp); setRules(r); setSummary(sum)
  }, [filter, fy])

  useEffect(() => { load().catch(e => addToast({ message: e.message, type: 'error' })) }, [load, addToast])

  // Resynchronisation d'arrière-plan après une décision : le réel du Budget vs
  // Réel et la liste des règles changent, mais la liste des dépenses a déjà
  // réagi au clic — on ne la fait pas clignoter en la rechargeant.
  const refreshSide = useCallback(({ withRules = false } = {}) => {
    api.marketingBudget.summary(fy).then(setSummary).catch(() => {})
    if (withRules) api.marketingBudget.rules().then(setRules).catch(() => {})
  }, [fy])

  // Décision appliquée LOCALEMENT d'abord : la ligne quitte la liste au clic,
  // sans attendre le réseau. Retourne l'état d'avant pour pouvoir le remettre
  // si l'appel échoue.
  const patchExpenseLocal = (id, patch) => {
    let snapshot = null
    setData(d => {
      if (!d) return d
      snapshot = d
      const target = d.expenses.find(x => x.id === id)
      if (!target) return d
      const next = { ...target, ...patch }
      const stillListed = filter === 'all' || next.status === filter
      return {
        ...d,
        expenses: stillListed ? d.expenses.map(x => (x.id === id ? next : x)) : d.expenses.filter(x => x.id !== id),
        pending: (d.pending ?? 0) - (target.status === 'pending' ? 1 : 0) + (next.status === 'pending' ? 1 : 0),
      }
    })
    return () => { if (snapshot) setData(snapshot) }
  }

  async function runSync() {
    setSyncing(true)
    try {
      const out = await api.marketingBudget.sync()
      addToast({ message: out.result || 'Sync terminée', type: 'success' })
      await load()
    } catch (e) {
      addToast({ message: `Sync échouée : ${e.message}`, type: 'error' })
    } finally {
      setSyncing(false)
    }
  }

  // « Pertinente » / « Non » : un seul clic, effet immédiat, aucune confirmation.
  async function decide(e, status) {
    const revert = patchExpenseLocal(e.id, { status, rule_label: null, decided_at: new Date().toISOString() })
    try {
      await api.marketingBudget.decide(e.id, status)
      refreshSide()
    } catch (err) {
      revert()
      addToast({ message: `Échec de l'enregistrement : ${err.message}`, type: 'error' })
    }
  }

  // « Jamais » : la dépense est écartée ET le fournisseur exclu pour l'avenir,
  // en un seul clic. Pas de confirmation — la règle se défait d'un clic dans la
  // liste « Fournisseurs jamais pertinents » juste à côté.
  async function never(e) {
    const revert = patchExpenseLocal(e.id, {
      status: 'not_relevant', rule_label: e.vendor, decided_at: new Date().toISOString(),
    })
    try {
      const out = await api.marketingBudget.never(e.id, {})
      addToast({
        message: `« ${out.rule.vendor_label} » ne sera plus proposé` +
          (out.applied_to_pending ? ` · ${out.applied_to_pending} autre(s) dépense(s) écartée(s)` : ''),
        type: 'success',
      })
      refreshSide({ withRules: true })
      // La règle peut avoir écarté d'autres lignes en attente : on remet la
      // liste à jour en arrière-plan (l'affichage a déjà réagi au clic).
      if (out.applied_to_pending) load().catch(() => {})
    } catch (err) {
      revert()
      addToast({ message: `Échec de l'exclusion : ${err.message}`, type: 'error' })
    }
  }

  async function deleteRule(r) {
    try {
      const out = await api.marketingBudget.deleteRule(r.id)
      addToast({
        message: `Règle supprimée${out.reopened ? ` — ${out.reopened} dépense(s) remise(s) à valider` : ''}`,
        type: 'success',
      })
      await load()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }

  async function showPreview() {
    try { setPreview(await api.marketingBudget.slackPreview()) }
    catch (e) { addToast({ message: e.message, type: 'error' }) }
  }

  // Clic = envoi. Aucune confirmation : le texte exact du message est affiché
  // juste au-dessus du bouton, la relire dans une boîte de dialogue ne
  // renseignait rien de plus. `busy` sert seulement à empêcher un double envoi
  // par double-clic — ce n'est pas une étape de validation.
  async function sendNow() {
    if (busy) return
    setBusy(true)
    try {
      const out = await api.marketingBudget.slackSend()
      addToast({ message: `Message envoyé — ${out.count} dépense(s) annoncée(s)`, type: 'success' })
      setPreview(null)
      await load()
    } catch (e) {
      addToast({ message: `Envoi échoué : ${e.message}`, type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const setBudgetLocal = (acctnum, month, n) => {
    setSummary(s => ({
      ...s,
      categories: s.categories.map(c => c.acctnum !== acctnum ? c : (() => {
        const budget = { ...c.budget, [month]: n }
        const total = Object.values(budget).reduce((a, v) => a + v, 0)
        return { ...c, budget, budget_total: Math.round(total * 100) / 100 }
      })()),
    }))
  }

  const expenses = data?.expenses || []
  const pendingCount = data?.pending ?? 0

  return (
    <Layout>
      <div className="flex items-center justify-between mb-1">
        <PageTitle>
          Budget marketing
          {pendingCount > 0 && <Badge color="amber">{pendingCount} à valider</Badge>}
        </PageTitle>
        <div className="flex items-center gap-2">
          <button onClick={showPreview}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 hover:bg-slate-50 rounded-lg">
            <Eye size={13} /> Aperçu du message Slack
          </button>
          <button onClick={runSync} disabled={syncing}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 hover:bg-slate-50 rounded-lg disabled:opacity-50">
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} /> {syncing ? 'Sync…' : 'Détecter les nouvelles dépenses'}
          </button>
        </div>
      </div>
      <p className="text-xs text-slate-500 mb-1 max-w-3xl">
        Les dépenses des comptes QuickBooks marketing (75910–75930) sont détectées automatiquement plusieurs fois par jour —
        le bouton ci-dessus n’est qu’un raccourci pour ne pas attendre le prochain passage.
        Marquer <b>Pertinente</b> celles liées au développement de nouveaux clients (Canada anglais / USA) :
        elles partent à Émilie sur Slack le mardi. <b>Jamais</b> exclut le fournisseur définitivement.
      </p>
      <p className="text-xs text-slate-400 mb-4">
        <AutoSyncNote info={data?.last_sync} />
      </p>

      {/* File de validation */}
      <div className="bg-white border border-slate-200 rounded-xl mb-6">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="font-medium text-slate-800">Dépenses détectées</div>
          <div className="flex gap-1">
            {[['pending', 'À valider'], ['relevant', 'Pertinentes'], ['not_relevant', 'Non pertinentes'], ['all', 'Toutes']].map(([k, label]) => (
              <button key={k} onClick={() => setFilter(k)}
                className={`px-2.5 py-1 text-xs rounded-lg ${filter === k ? 'bg-brand-600 text-white font-medium' : 'text-slate-500 hover:bg-slate-50'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-400 border-b border-slate-100">
              <th className="text-left font-medium px-4 py-2 w-24">Date</th>
              <th className="text-left font-medium px-2 py-2">Dépense</th>
              <th className="text-left font-medium px-2 py-2 w-48">Compte</th>
              <th className="text-right font-medium px-2 py-2 w-28">Montant</th>
              <th className="text-left font-medium px-2 py-2 w-36">Statut</th>
              <th className="px-4 py-2 w-64"></th>
            </tr>
          </thead>
          <tbody>
            {data === null && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400"><Spinner size="xs" label="Chargement…" /></td></tr>}
            {data !== null && expenses.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                {filter === 'pending' ? 'Rien à valider — toutes les dépenses détectées sont tranchées. ✓' : 'Aucune dépense.'}
              </td></tr>
            )}
            {expenses.map(e => (
              <ExpenseRow key={e.id} e={e} onDecide={decide} onNever={never} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
        {/* Budget vs Réel */}
        <div className="xl:col-span-2 bg-white border border-slate-200 rounded-xl">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
            <div>
              <div className="font-medium text-slate-800">Budget vs Réel</div>
              <div className="text-xs text-slate-500 mt-0.5">
                Remplace le fichier « Annual Marketing budget » — budget éditable (clic sur une cellule), réel calculé des dépenses pertinentes.
              </div>
            </div>
            <select value={fy} onChange={e => setFy(e.target.value)}
              className="px-2 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none">
              {[Number(currentFy()) - 1, Number(currentFy()), Number(currentFy()) + 1].map(y => (
                <option key={y} value={String(y)}>AF {y}–{y + 1} (avr–mars)</option>
              ))}
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-400 border-b border-slate-100">
                  <th className="text-left font-medium px-4 py-2 sticky left-0 bg-white">Catégorie</th>
                  <th className="px-1 py-2"></th>
                  {(summary?.months || []).map(m => <th key={m} className="text-right font-medium px-2 py-2 min-w-[72px]">{monthLabel(m)}</th>)}
                  <th className="text-right font-medium px-4 py-2 min-w-[80px]">Total</th>
                </tr>
              </thead>
              <tbody>
                {(summary?.categories || []).map(c => (
                  <ExpandableCategory key={c.acctnum} c={c} months={summary.months} onSaved={setBudgetLocal} />
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Règles d'exclusion */}
        <div className="bg-white border border-slate-200 rounded-xl">
          <div className="px-4 py-3 border-b border-slate-100">
            <div className="font-medium text-slate-800">Fournisseurs jamais pertinents</div>
            <div className="text-xs text-slate-500 mt-0.5">Leurs dépenses sont exclues automatiquement à la détection.</div>
          </div>
          <div className="divide-y divide-slate-50">
            {rules === null && <div className="px-4 py-4 text-sm text-slate-400"><Spinner size="xs" label="Chargement…" /></div>}
            {rules?.length === 0 && (
              <div className="px-4 py-4 text-sm text-slate-400">
                Aucune règle — utiliser « Jamais » sur une dépense pour en créer une.
              </div>
            )}
            {rules?.map(r => (
              <div key={r.id} data-rule-id={r.id} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <div className="text-sm font-medium text-slate-700">{r.vendor_label}</div>
                  <div className="text-[11px] text-slate-400">
                    {r.acctnum ? `Compte ${r.acctnum} seulement` : 'Tous les comptes marketing'}
                    {r.note ? ` · ${r.note}` : ''}
                  </div>
                </div>
                <button onClick={() => deleteRule(r)} title="Supprimer la règle (ses exclusions automatiques repassent à valider)"
                  className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Modal aperçu / envoi Slack */}
      {preview && (
        <Modal isOpen onClose={() => setPreview(null)} title="Message Slack du mardi" size="lg">
          <div className="text-xs text-slate-500 mb-3">{preview.summary}</div>
          <pre className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm whitespace-pre-wrap font-sans">{preview.apercu}</pre>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setPreview(null)} className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">Fermer</button>
            {/* Envoi externe : bouton volontaire (pas d'autosave), mais UN SEUL
                clic — le message ci-dessus EST la validation. */}
            <button onClick={sendNow} disabled={busy}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-60">
              <Send size={14} className={busy ? 'animate-pulse' : ''} /> {busy ? 'Envoi…' : 'Envoyer maintenant'}
            </button>
          </div>
        </Modal>
      )}

    </Layout>
  )
}

// Une catégorie du Budget vs Réel : ligne Budget (éditable) + ligne Réel.
function ExpandableCategory({ c, months, onSaved }) {
  const gap = Math.round((c.budget_total - c.real_total) * 100) / 100
  return (
    <>
      <tr className="border-b border-slate-50">
        <td className="px-4 py-1.5 font-medium text-slate-700 sticky left-0 bg-white whitespace-nowrap" rowSpan={2}>
          {c.label}
          <span className="block text-[10px] font-normal text-slate-400">
            #{c.acctnum} · écart <span className={gap < 0 ? 'text-red-600 font-medium' : 'text-emerald-600'}>{fmtMoney(gap)}</span>
          </span>
        </td>
        <td className="px-1 py-1 text-[10px] text-slate-400 uppercase">Budget</td>
        {months.map(m => (
          <td key={m} className="px-1 py-1 text-right">
            <BudgetCell acctnum={c.acctnum} month={m} value={c.budget[m]} onSaved={onSaved} />
          </td>
        ))}
        <td className="px-4 py-1.5 text-right tabular-nums text-slate-500">{fmtMoney(c.budget_total)}</td>
      </tr>
      <tr className="border-b border-slate-100">
        <td className="px-1 py-1 text-[10px] text-slate-400 uppercase">Réel</td>
        {months.map(m => (
          <td key={m} className={`px-2 py-1 text-right tabular-nums ${c.real[m] ? 'font-medium text-slate-800' : 'text-slate-300'}`}>
            {c.real[m] != null ? fmtMoney(c.real[m]).replace(/\u00a0\$$/, '') : '·'}
          </td>
        ))}
        <td className="px-4 py-1 text-right tabular-nums font-medium">{fmtMoney(c.real_total)}</td>
      </tr>
    </>
  )
}
