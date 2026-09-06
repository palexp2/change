// Inventaire Drive — recensement décisionnel des documents de la comptabilité
// qui vivent encore dans Google Drive.
//
// L'unité de décision est l'ONGLET, pas le fichier : « CTB - Suivi » est
// partiellement repris par l'ERP, mais neuf de ses douze onglets (Abonn.,
// Récurrents, Paie & Ass. coll.…) attendent toujours. Le volet Suggestions
// remonte donc directement les onglets à importer, classés par pertinence ;
// l'onglet Documents garde la vue par classeur, dépliable.
//
// Rien n'est importé ici : l'analyse lit les métadonnées et un échantillon du
// contenu pour décider, et la décision est sauvegardée en autosave.
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  RefreshCw, ExternalLink, Search, Plus, Trash2, HardDrive, Info,
  ChevronRight, ChevronDown, Sparkles, ArrowRight,
} from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { Badge } from '../components/Badge.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { useToast } from '../contexts/ToastContext.jsx'
import Spinner from '../components/Spinner.jsx'

const inputCls = 'w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400'

const TABS = [
  ['suggestions', 'Suggestions'],
  ['documents', 'Documents'],
]

const STATUS_META = {
  candidate: { label: 'À trancher', color: 'yellow' },
  partial: { label: 'Partiellement repris', color: 'orange' },
  synced: { label: 'Déjà repris', color: 'green' },
  ignore: { label: 'Écarté', color: 'gray' },
}

const NATURE_META = {
  donnees: { label: 'Données', color: 'blue' },
  procedure: { label: 'Procédure', color: 'purple' },
  calculatrice: { label: 'Calculatrice', color: 'slate' },
  reference: { label: 'Référence', color: 'teal' },
  vide: { label: 'Vide', color: 'gray' },
}

const FREQUENCY_META = {
  quotidienne: { label: 'Quotidienne', color: 'red' },
  hebdomadaire: { label: 'Hebdomadaire', color: 'orange' },
  mensuelle: { label: 'Mensuelle', color: 'blue' },
  rare: { label: 'Rare', color: 'slate' },
  inactive: { label: 'Inactive', color: 'gray' },
  inconnue: { label: 'Inconnue', color: 'gray' },
}

const DECISIONS = [
  ['', 'À décider'],
  ['import', 'Importer dans l\'ERP'],
  ['keep_drive', 'Garder dans Drive'],
  ['archive', 'Archiver'],
]

const DECISION_COLOR = { import: 'green', keep_drive: 'blue', archive: 'slate' }
const KIND_LABEL = { spreadsheet: 'Classeur', document: 'Document', presentation: 'Présentation', pdf: 'PDF', other: 'Fichier' }

function ago(days) {
  if (days == null) return '—'
  if (days === 0) return "aujourd'hui"
  if (days === 1) return 'hier'
  if (days < 30) return `il y a ${days} j`
  if (days < 365) return `il y a ${Math.round(days / 30)} mois`
  return `il y a ${(days / 365).toFixed(1)} an(s)`
}

function relevanceColor(n) {
  if (n >= 80) return 'red'
  if (n >= 60) return 'orange'
  if (n >= 40) return 'yellow'
  return 'slate'
}

// Sélecteur de décision + note, partagé par les fichiers et les onglets : les
// deux niveaux s'autosauvegardent exactement pareil (select au changement, note
// au blur), sans bouton « Enregistrer ».
function DecisionControls({ row, testPrefix, onPatch, compact = false }) {
  const [note, setNote] = useState(row.decision_note || '')
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()

  useEffect(() => { setNote(row.decision_note || '') }, [row.decision_note])

  const patch = async (body, revert) => {
    setSaving(true)
    try { await onPatch(body) }
    catch (e) { addToast({ message: `Sauvegarde échouée : ${e.message}`, type: 'error' }); revert?.() }
    finally { setSaving(false) }
  }

  return (
    <div className={compact ? 'flex items-center gap-2' : ''}>
      <select
        className={`${inputCls} !w-40`}
        data-testid={`${testPrefix}-${row.id}`}
        value={row.decision || ''}
        onChange={e => patch({ decision: e.target.value || null })}
      >
        {DECISIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <input
        className={`${inputCls} ${compact ? '!w-52' : 'mt-1'}`}
        data-testid={`${testPrefix}-note-${row.id}`}
        value={note}
        onChange={e => setNote(e.target.value)}
        onBlur={() => {
          if ((row.decision_note || '') === note.trim()) return
          patch({ decision_note: note.trim() }, () => setNote(row.decision_note || ''))
        }}
      />
      {!compact && <div className="h-4 mt-0.5 text-xs text-slate-400">{saving ? 'Sauvegarde…' : ''}</div>}
    </div>
  )
}

// ── Volet Suggestions ────────────────────────────────────────────────────────
// La réponse directe à « quoi importer, et depuis quel onglet ». Un onglet par
// carte, avec sa destination dans l'ERP et la raison.
function SuggestionCard({ s, onPatch }) {
  return (
    <div className="border border-slate-200 rounded-xl bg-white p-3.5" data-testid={`suggestion-${s.id}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge color={relevanceColor(s.relevance)} size="xs">{s.relevance}/100</Badge>
            <span className="text-sm font-semibold text-slate-800">Onglet « {s.tab_name} »</span>
            {s.status === 'partial' && <Badge color="orange" size="xs">Partiellement repris</Badge>}
            <Badge color={(NATURE_META[s.nature] || NATURE_META.vide).color} size="xs">
              {(NATURE_META[s.nature] || NATURE_META.vide).label} · {s.rows_count} lignes
            </Badge>
          </div>
          <div className="text-xs text-slate-500 mt-1">
            dans{' '}
            {s.web_view_link ? (
              <a href={s.web_view_link} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline inline-flex items-center gap-1">
                {s.file_name}<ExternalLink className="w-3 h-3 opacity-60" />
              </a>
            ) : <span className="text-slate-700">{s.file_name}</span>}
            {s.parent_folder_name ? ` · ${s.parent_folder_name}` : ''}
            {' · '}{(FREQUENCY_META[s.frequency] || FREQUENCY_META.inconnue).label.toLowerCase()}, modifié {ago(s.days_since_modified)}
          </div>
          {s.target_module && (
            <div className="flex items-center gap-1.5 mt-2 text-xs text-slate-600">
              <ArrowRight className="w-3.5 h-3.5 text-brand-600" />
              <span className="font-medium text-slate-800">{s.target_module}</span>
            </div>
          )}
          <p className="text-sm text-slate-600 mt-1.5">{s.suggestion}</p>
          {(s.header || []).length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {s.header.slice(0, 8).map((h, i) => (
                <Badge key={i} color="slate" size="xs">{h.length > 32 ? `${h.slice(0, 32)}…` : h}</Badge>
              ))}
            </div>
          )}
        </div>
        <div className="shrink-0">
          <DecisionControls row={s} testPrefix="sugg-decision" onPatch={body => onPatch(s.id, body)} />
        </div>
      </div>
    </div>
  )
}

// ── Volet Documents ──────────────────────────────────────────────────────────
function TabRow({ tab, onPatch }) {
  const nature = NATURE_META[tab.nature] || NATURE_META.vide
  const status = STATUS_META[tab.status] || STATUS_META.ignore
  return (
    <tr className="bg-slate-50/50 border-t border-slate-100 align-top" data-testid={`drive-tab-${tab.id}`}>
      <td className="px-3 py-2 pl-8">
        <div className="text-sm text-slate-700">« {tab.tab_name} »</div>
        <div className="text-xs text-slate-400 mt-0.5">
          {tab.rows_count} lignes · {(tab.header || []).slice(0, 4).join(' · ') || 'colonnes non identifiées'}
        </div>
        {(tab.sections || []).length > 1 && (
          <div className="text-xs text-slate-400 mt-0.5">Sections : {tab.sections.join(' / ')}</div>
        )}
      </td>
      <td className="px-3 py-2"><Badge color={nature.color} size="xs">{nature.label}</Badge></td>
      <td className="px-3 py-2">
        <Badge color={status.color} size="xs">{status.label}</Badge>
        {tab.sync_target && <div className="text-xs text-slate-400 mt-0.5 max-w-[16rem]">{tab.sync_target}</div>}
      </td>
      <td className="px-3 py-2">
        {tab.relevance != null && (
          <div className="flex items-center gap-1.5">
            <Badge color={relevanceColor(tab.relevance)} size="xs">{tab.relevance}</Badge>
            <span className="text-xs font-medium text-slate-600">{tab.target_module || '—'}</span>
          </div>
        )}
        {tab.suggestion && <div className="text-xs text-slate-500 mt-1 max-w-[26rem]">{tab.suggestion}</div>}
      </td>
      <td className="px-3 py-2">
        <DecisionControls row={tab} testPrefix="tab-decision" onPatch={body => onPatch(tab.id, body)} />
      </td>
      <td />
    </tr>
  )
}

function ItemRow({ item, expanded, onToggle, onPatchItem, onPatchTab, onDeleted }) {
  const { addToast } = useToast()
  const freq = FREQUENCY_META[item.frequency] || FREQUENCY_META.inconnue
  const status = STATUS_META[item.status] || STATUS_META.ignore
  const details = item.tab_details || []
  const openTabs = details.filter(t => t.status === 'candidate' || t.status === 'partial').length

  return (
    <>
      <tr className="border-t border-slate-100 hover:bg-slate-50/60 align-top" data-item-id={item.id} data-testid={`drive-item-${item.id}`}>
        <td className="px-3 py-2.5">
          <div className="flex items-start gap-1">
            {details.length > 0 && (
              <button onClick={onToggle} data-testid={`expand-${item.id}`} className="mt-0.5 text-slate-400 hover:text-slate-700">
                {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
            )}
            <div className={details.length ? '' : 'ml-5'}>
              {item.web_view_link ? (
                <a href={item.web_view_link} target="_blank" rel="noreferrer"
                  className="text-sm font-medium text-brand-700 hover:underline inline-flex items-center gap-1">
                  {item.name}<ExternalLink className="w-3 h-3 shrink-0 opacity-60" />
                </a>
              ) : (
                <span className="text-sm font-medium text-slate-800">{item.name}</span>
              )}
              <div className="text-xs text-slate-400 mt-0.5">
                {KIND_LABEL[item.kind] || 'Fichier'}
                {item.parent_folder_name ? ` · ${item.parent_folder_name}` : ''}
                {details.length ? ` · ${details.length} onglets${openTabs ? `, ${openTabs} à trancher` : ''}` : ''}
              </div>
            </div>
          </div>
        </td>

        <td className="px-3 py-2.5 text-sm text-slate-600">
          <div className="max-w-[11rem] truncate" title={item.owner_name || item.owner_email || ''}>
            {item.owner_name || item.owner_email || '—'}
          </div>
        </td>

        <td className="px-3 py-2.5 whitespace-nowrap">
          <Badge color={freq.color} size="xs">{freq.label}</Badge>
          <div className="text-xs text-slate-400 mt-0.5">
            {item.edits_per_month ? `${item.edits_per_month} modif./mois · ` : ''}{ago(item.days_since_modified)}
          </div>
        </td>

        <td className="px-3 py-2.5">
          <Badge color={status.color} size="xs">{status.label}</Badge>
          <div className="text-xs text-slate-400 mt-0.5 max-w-[16rem]">{item.sync_target || item.status_reason}</div>
        </td>

        <td className="px-3 py-2.5 whitespace-nowrap">
          <DecisionControls row={item} testPrefix="decision" onPatch={body => onPatchItem(item.id, body)} />
          {item.decision && (
            <Badge color={DECISION_COLOR[item.decision]} size="xs">
              {item.decided_by_name ? `par ${item.decided_by_name}` : 'décidé'}
            </Badge>
          )}
        </td>

        <td className="px-2 py-2.5">
          {item.source === 'manual' && (
            <button
              onClick={async () => {
                try { await api.driveInventory.remove(item.id); onDeleted(item.id) }
                catch (e) { addToast({ message: e.message, type: 'error' }) }
              }}
              className="text-slate-300 hover:text-red-600" title="Retirer de l'inventaire"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </td>
      </tr>
      {expanded && details.map(t => <TabRow key={t.id} tab={t} onPatch={onPatchTab} />)}
    </>
  )
}

// Ajout à la main : un document que le compte Google connecté ne voit pas.
function ManualAddRow({ onAdded }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const { addToast } = useToast()

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} data-testid="manual-add-open"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
        <Plus className="w-4 h-4" />Ajouter un document à la main
      </button>
    )
  }

  // Bouton requis : création d'un enregistrement qui n'a pas encore d'id (autosave impossible).
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input className={`${inputCls} !w-64`} value={name}
        data-testid="manual-name" onChange={e => setName(e.target.value)} autoFocus />
      <input className={`${inputCls} !w-64`} value={link}
        onChange={e => setLink(e.target.value)} />
      <button
        disabled={busy || !name.trim()}
        data-testid="manual-add-submit"
        onClick={async () => {
          setBusy(true)
          try {
            onAdded(await api.driveInventory.create({ name: name.trim(), web_view_link: link.trim() || null }))
            setName(''); setLink(''); setOpen(false)
          } catch (e) { addToast({ message: e.message, type: 'error' }) }
          finally { setBusy(false) }
        }}
        className="px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50"
      >
        {busy ? 'Ajout…' : 'Ajouter'}
      </button>
      <button onClick={() => setOpen(false)} className="px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50 rounded-lg">Annuler</button>
    </div>
  )
}

export default function DriveInventory() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('onglet') || 'suggestions'
  const [data, setData] = useState({ items: [], suggestions: [], stats: {}, state: null, accounts: [], default_account: '' })
  const [loading, setLoading] = useState(true)
  const [account, setAccount] = useState('')
  const [q, setQ] = useState('')
  const [onlyUndecided, setOnlyUndecided] = useState(false)
  const [minRelevance, setMinRelevance] = useState(70)
  const [expanded, setExpanded] = useState(() => new Set())
  const { addToast } = useToast()
  const accountTouched = useRef(false)

  const load = useCallback(async () => {
    try {
      const d = await api.driveInventory.list()
      setData(d)
      if (!accountTouched.current) setAccount(d.state?.last_account || d.default_account || d.accounts?.[0] || '')
    } catch (e) {
      addToast({ message: `Chargement impossible : ${e.message}`, type: 'error' })
    } finally { setLoading(false) }
  }, [addToast])

  useEffect(() => { load() }, [load])

  // Le recensement tourne en arrière-plan (plusieurs minutes) : tant qu'il
  // tourne, la page suit sa progression et se recharge à la fin.
  const running = data.running
  useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(async () => {
      try {
        const s = await api.driveInventory.status()
        setData(d => ({ ...d, running: s.running, state: s.state }))
        if (!s.running) load()
      } catch {}
    }, 3000)
    return () => clearInterval(timer)
  }, [running, load])

  const setTab = t => setParams(p => { const n = new URLSearchParams(p); n.set('onglet', t); return n }, { replace: true })

  const patchItem = useCallback(async (id, body) => {
    const updated = await api.driveInventory.update(id, body)
    setData(d => ({ ...d, items: d.items.map(i => (i.id === id ? { ...i, ...updated } : i)) }))
  }, [])

  // Une décision sur un onglet doit se refléter dans les deux vues (la carte de
  // suggestion et la sous-ligne du classeur) : les deux listes sont mises à jour.
  const patchTab = useCallback(async (id, body) => {
    const updated = await api.driveInventory.updateTab(id, body)
    setData(d => ({
      ...d,
      suggestions: d.suggestions.map(s => (s.id === id ? { ...s, ...updated } : s)),
      items: d.items.map(i => ({
        ...i,
        tab_details: (i.tab_details || []).map(t => (t.id === id ? { ...t, ...updated } : t)),
      })),
    }))
  }, [])

  const needle = q.trim().toLowerCase()

  const suggestions = useMemo(() => (data.suggestions || []).filter(s => {
    if ((s.relevance ?? 0) < minRelevance) return false
    if (onlyUndecided && s.decision) return false
    if (!needle) return true
    return [s.tab_name, s.file_name, s.target_module, s.suggestion, s.parent_folder_name]
      .filter(Boolean).join(' ').toLowerCase().includes(needle)
  }), [data.suggestions, needle, onlyUndecided, minRelevance])

  const items = useMemo(() => (data.items || []).filter(i => {
    if (onlyUndecided && i.decision) return false
    if (!needle) return true
    const tabText = (i.tab_details || []).map(t => `${t.tab_name} ${t.target_module || ''} ${t.suggestion || ''}`).join(' ')
    return [i.name, i.owner_name, i.owner_email, i.parent_folder_name, tabText]
      .filter(Boolean).join(' ').toLowerCase().includes(needle)
  }), [data.items, needle, onlyUndecided])

  const runScan = async () => {
    try {
      await api.driveInventory.scan(account || null)
      setData(d => ({ ...d, running: true }))
      addToast({ message: 'Recensement lancé — la page suit la progression.', type: 'success' })
    } catch (e) {
      addToast({ message: `Analyse impossible : ${e.message}`, type: 'error' })
    }
  }

  const stats = data.stats || {}
  const state = data.state
  const progress = state?.analysis_total ? Math.round((state.analysis_done / state.analysis_total) * 100) : null

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-start justify-between mb-5 gap-4">
          <div>
            <PageTitle>Inventaire Drive</PageTitle>
            <p className="text-xs text-slate-500 mt-0.5 max-w-3xl">
              Ce que la comptabilité tient encore dans Google Drive, examiné <strong>onglet par onglet</strong> :
              un classeur en partie repris par l'ERP peut cacher des onglets entiers qui ne le sont pas.
              L'analyse lit l'en-tête et un échantillon de chaque onglet pour proposer quoi rapatrier et où —
              <strong> aucune donnée n'est importée ici</strong>.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <select className={`${inputCls} !w-52`} value={account} data-testid="scan-account"
              onChange={e => { accountTouched.current = true; setAccount(e.target.value) }}>
              {(data.accounts || []).map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <button onClick={runScan} disabled={running} data-testid="scan-button"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
              <RefreshCw className={`w-4 h-4 ${running ? 'animate-spin' : ''}`} />
              {running ? 'Analyse en cours…' : 'Analyser le Drive'}
            </button>
          </div>
        </div>

        {running && (
          <div className="mb-4 px-3 py-2 rounded-lg border border-brand-200 bg-brand-50 text-sm text-brand-800" data-testid="scan-progress">
            {state?.analysis_phase || 'Recensement'}
            {progress != null ? ` — ${state.analysis_done}/${state.analysis_total} classeurs (${progress} %)` : ' — lecture du Drive…'}
          </div>
        )}
        {!running && state?.analysis_status === 'error' && (
          <div className="mb-4 px-3 py-2 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800">
            Dernière analyse en échec : {state.analysis_error}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 mb-4" data-testid="drive-inventory-stats">
          {[
            ['Onglets à importer', stats.tabs_to_import, 'bg-red-500'],
            ['Onglets examinés', stats.tabs_total, 'bg-slate-300'],
            ['Onglets déjà repris', stats.tabs_synced, 'bg-green-500'],
            ['Classeurs partiellement repris', stats.partial, 'bg-orange-400'],
            ['Décisions prises', (stats.tabs_decided || 0) + (stats.decided || 0), 'bg-blue-500'],
          ].map(([label, value, dot]) => (
            <div key={label} className="px-3 py-2 rounded-lg border border-slate-200 bg-white">
              <div className="flex items-center gap-1.5 text-xs text-slate-500">
                <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />{label}
              </div>
              <div className="text-lg font-semibold text-slate-800">{value ?? 0}</div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 text-xs text-slate-500 mb-4">
          <HardDrive className="w-3.5 h-3.5" />
          {state?.last_scan_at
            ? (
              <span>
                Dernière analyse {fmtDate(state.last_scan_at)} via {state.last_account} — {state.files_seen} fichiers parcourus,
                {' '}{stats.tabs_total || 0} onglets lus dans les classeurs retenus.
                {data.ai_available === false && ' Jugement par règles (clé OpenAI absente).'}
              </span>
            )
            : <span>Aucune analyse encore lancée.</span>}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
            {TABS.map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} data-testid={`tab-${k}`}
                className={`px-3 py-1.5 text-sm rounded-md ${tab === k ? 'bg-white shadow-sm font-medium text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                {label}{k === 'suggestions' && suggestions.length ? ` (${suggestions.length})` : ''}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            {tab === 'suggestions' && (
              <label className="flex items-center gap-1.5 text-sm text-slate-600" title="Masque les onglets sous ce niveau de pertinence">
                Pertinence min.
                <input type="range" min="0" max="95" step="5" value={minRelevance}
                  data-testid="min-relevance"
                  onChange={e => setMinRelevance(Number(e.target.value))} className="w-24" />
                <span className="tabular-nums w-6 text-slate-800">{minRelevance}</span>
              </label>
            )}
            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              <input type="checkbox" checked={onlyUndecided} onChange={e => setOnlyUndecided(e.target.checked)} />
              Sans décision
            </label>
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input className={`${inputCls} !pl-8 !w-64`}
                value={q} onChange={e => setQ(e.target.value)} data-testid="drive-search" />
            </div>
          </div>
        </div>

        {tab === 'suggestions' ? (
          <div className="space-y-2" data-testid="drive-suggestions">
            {loading ? (
              <div className="px-3 py-8 text-center text-sm text-slate-400"><Spinner size="xs" label="Chargement…" /></div>
            ) : suggestions.length === 0 ? (
              <div className="px-3 py-10 text-center text-sm text-slate-400 border border-slate-200 rounded-xl bg-white">
                <Sparkles className="w-5 h-5 mx-auto mb-2 text-slate-300" />
                {data.suggestions?.length
                  ? `Aucune suggestion au-dessus de ${minRelevance}/100 — baissez le seuil de pertinence pour en voir davantage.`
                  : 'Lancez une analyse du Drive pour obtenir les onglets à rapatrier.'}
              </div>
            ) : suggestions.map(s => <SuggestionCard key={s.id} s={s} onPatch={patchTab} />)}
          </div>
        ) : (
          <div className="border border-slate-200 rounded-xl overflow-x-auto bg-white">
            <table className="w-full min-w-[72rem]">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Document / onglet</th>
                  <th className="px-3 py-2 text-left font-medium">Propriétaire</th>
                  <th className="px-3 py-2 text-left font-medium">Fréquence de modification</th>
                  <th className="px-3 py-2 text-left font-medium">Statut</th>
                  <th className="px-3 py-2 text-left font-medium">Décision</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody data-testid="drive-inventory-rows">
                {loading ? (
                  <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-slate-400"><Spinner size="xs" label="Chargement…" /></td></tr>
                ) : items.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-slate-400">
                    {data.items?.length ? 'Aucun document dans cette vue.' : 'Lancez une analyse du Drive pour construire l\'inventaire.'}
                  </td></tr>
                ) : items.map(i => (
                  <ItemRow key={i.id} item={i} expanded={expanded.has(i.id)}
                    onToggle={() => setExpanded(prev => {
                      const n = new Set(prev)
                      if (n.has(i.id)) n.delete(i.id); else n.add(i.id)
                      return n
                    })}
                    onPatchItem={patchItem} onPatchTab={patchTab}
                    onDeleted={id => setData(d => ({ ...d, items: d.items.filter(x => x.id !== id) }))} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <ManualAddRow onAdded={item => setData(d => ({ ...d, items: [item, ...d.items] }))} />
          <div className="flex items-start gap-1.5 text-xs text-slate-400 max-w-xl">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              Le contenu n'est lu que pour les classeurs retenus par le recensement, et seulement l'en-tête
              plus quelques lignes. La note de pertinence est une estimation destinée à ordonner le travail,
              pas un verdict : la décision reste la vôtre.
            </span>
          </div>
        </div>
      </div>
    </Layout>
  )
}
