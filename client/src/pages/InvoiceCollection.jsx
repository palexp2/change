import { useState, useEffect, useCallback, useRef } from 'react'
import { Plus, Play, RefreshCw, Trash2, KeyRound, ShieldAlert, Camera, ChevronDown, ChevronRight, Cookie, Target, Link2, Wand2 } from 'lucide-react'
import api from '../lib/api.js'
import { Modal } from '../components/Modal.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { Link } from 'react-router-dom'
import { useToast } from '../contexts/ToastContext.jsx'
import CopyButton from '../components/CopyButton.jsx'
import { fmtDateTime } from '../lib/formatDate.js'
import { fmtNumber } from '../utils/formatters.js'
import Spinner from '../components/Spinner.jsx'

// Collecte de factures — pour les fournisseurs qui n'envoient rien par courriel
// et n'exposent aucune API (Amazon, Wix), un collecteur va chercher la facture
// derrière le login de leur portail et la dépose dans l'extracteur de données.
//
// Ce que la page doit rendre évident, dans l'ordre :
//   1. un code de vérification est attendu (seule chose qui bloque une tournée) ;
//   2. l'état de chaque compte (dernière tournée, ce qu'elle a rapporté) ;
//   3. le journal + les captures d'écran, pour diagnostiquer un portail qui a
//      changé de gabarit sans relancer à l'aveugle.

const inputCls = 'w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400'
const labelCls = 'block text-xs font-medium text-slate-500 mb-1'

const STATUS = {
  running: { label: 'En cours', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  needs_otp: { label: 'Code attendu', cls: 'bg-amber-50 text-amber-800 border-amber-300' },
  success: { label: 'Réussie', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  error: { label: 'Échec', cls: 'bg-red-50 text-red-700 border-red-200' },
  cancelled: { label: 'Annulée', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
}

function Badge({ status }) {
  const s = STATUS[status] || { label: status || '—', cls: 'bg-slate-100 text-slate-600 border-slate-200' }
  return <span className={`px-1.5 py-0.5 text-[11px] font-medium rounded border ${s.cls}`}>{s.label}</span>
}

// Statuts d'un besoin — « cette transaction bancaire attend sa facture ».
const NEED_META = {
  en_attente: { label: 'À chercher', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  trouvee: { label: 'Facture liée', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  introuvable: { label: 'Introuvable', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  ambigue: { label: 'Ambiguë', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  devise_differente: { label: 'Autre devise', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  sans_collecteur: { label: 'Pas de collecteur', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
}

const money = (v, cur) => `${fmtNumber(Math.abs(Number(v) || 0), { decimals: 2 })} ${cur || ''}`.trim()

// Résumé d'un message d'erreur : les collecteurs journalisent un contexte
// détaillé (voir la capture / le journal) mais l'écran ne doit montrer qu'une
// ligne — le détail complet reste à un clic, pas imposé.
const shortError = (text) => {
  const s = String(text || '').trim()
  const cut = s.search(/ — | \(voir | \? /)
  const head = cut > 10 ? s.slice(0, cut) : s
  return head.length > 90 ? `${head.slice(0, 90)}…` : head
}

function ErrorLine({ text, className = '' }) {
  const [open, setOpen] = useState(false)
  const summary = shortError(text)
  const hasMore = summary !== text.trim()
  return (
    <div className={className}>
      <button onClick={() => setOpen(o => !o)} className="text-left hover:underline decoration-dotted disabled:no-underline" disabled={!hasMore}>
        {summary}{hasMore && <span className="text-red-400"> {open ? '▲' : '▾'}</span>}
      </button>
      {open && <div className="mt-1 text-[11px] text-red-600/80 whitespace-pre-wrap">{text}</div>}
    </div>
  )
}

function NeedRow({ need }) {
  const meta = NEED_META[need.status] || NEED_META.en_attente
  return (
    <div className="flex items-center gap-3 px-3 py-1.5 text-xs border-b border-slate-100 last:border-0">
      <span className="text-slate-500 tabular-nums w-20 shrink-0">{need.txn_date}</span>
      <span className="tabular-nums w-24 shrink-0 text-slate-800 font-medium">{money(need.amount, need.currency)}</span>
      <span className={`px-1.5 py-0.5 rounded border shrink-0 ${meta.cls}`}>{meta.label}</span>
      <span className="text-slate-600 truncate flex-1" title={need.label}>{need.label}</span>
      {need.sale_receipt_id && (
        <Link to={`/sale-receipts/${need.sale_receipt_id}`} className="text-brand-600 hover:underline shrink-0 inline-flex items-center gap-1">
          <Link2 size={12} /> reçu
        </Link>
      )}
      {need.note && <span className="text-slate-400 truncate max-w-[16rem] shrink-0" title={need.note}>{need.note}</span>}
    </div>
  )
}

// Ce que la collecte doit aller chercher, et ce qu'elle n'a pas trouvé. Les
// fournisseurs reconnus mais sans collecteur sont la file de priorisation pour
// brancher le prochain portail.
// Demande à l'agent d'écrire le collecteur d'un fournisseur détecté sans
// portail branché — une carte dans la file de travaux (/travaux) plutôt qu'un
// message à composer soi-même.
function RequestScraperButton({ vendor }) {
  const { addToast } = useToast()
  const [state, setState] = useState('idle') // idle | sending | done
  if (state === 'done') return <span className="text-[11px] text-emerald-600 shrink-0">Demandé ✓</span>
  return (
    <button
      disabled={state === 'sending'}
      onClick={async () => {
        setState('sending')
        try {
          await api.travaux.createPrompt({
            title: `Collecte de factures — ${vendor}`,
            prompt: `Ajouter ${vendor} à la collecte automatique de factures (/collecte-factures) : écrire un collecteur Playwright (services/scrapers/${vendor.toLowerCase().replace(/\W+/g, '')}.js) sur le modèle des collecteurs existants (amazon.js, wix.js, bell.js, digikey.js), l'enregistrer dans services/scrapers/index.js, et suivre les règles du CLAUDE.md (changelog, rebuild, redémarrage).`,
            mode: 'implement',
            space: 'finance',
          })
          setState('done')
          addToast({ message: `${vendor} ajouté à la file de travaux`, type: 'success' })
        } catch (e) {
          setState('idle')
          addToast({ message: e.message, type: 'error' })
        }
      }}
      title="Demander à l'agent d'écrire ce collecteur"
      className="shrink-0 p-0.5 text-slate-400 hover:text-brand-600 disabled:opacity-40"
    >
      <Wand2 size={12} />
    </button>
  )
}

function NeedsPanel({ needs, accounts }) {
  const [open, setOpen] = useState(true)
  if (!needs) return null

  const active = needs.filter(n => n.status !== 'trouvee')
  const byVendor = new Map()
  for (const n of active) {
    const key = n.vendor_name || 'Fournisseur inconnu'
    if (!byVendor.has(key)) byVendor.set(key, [])
    byVendor.get(key).push(n)
  }
  const covered = [...byVendor.entries()].filter(([, list]) => list.some(n => n.scraper_account_id))
  const uncovered = [...byVendor.entries()].filter(([, list]) => !list.some(n => n.scraper_account_id))
  const linked = needs.filter(n => n.status === 'trouvee').length

  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-white">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-3 py-2.5 text-left">
        {open ? <ChevronDown size={15} className="text-slate-400" /> : <ChevronRight size={15} className="text-slate-400" />}
        <Target size={15} className="text-brand-600" />
        <span className="text-sm font-medium text-slate-800">
          {active.length} transaction{active.length > 1 ? 's' : ''} attend{active.length > 1 ? 'ent' : ''} sa facture
        </span>
        {linked > 0 && <span className="text-xs text-emerald-700">· {linked} déjà liée{linked > 1 ? 's' : ''}</span>}
        {accounts?.some(a => a.collect_mode === 'fenetre') && (
          <span className="text-[11px] text-slate-400">· un compte est en mode fenêtre</span>
        )}
      </button>

      {open && (
        <div className="border-t border-slate-100">
          {active.length === 0 && (
            <p className="px-3 py-3 text-xs text-slate-400">
              Aucune transaction non comptabilisée n'attend de facture. Rien à collecter.
            </p>
          )}
          {covered.map(([vendor, list]) => (
            <div key={vendor}>
              <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-slate-500 uppercase tracking-wide">{vendor}</div>
              {list.map(n => <NeedRow key={n.id} need={n} />)}
            </div>
          ))}
          {uncovered.length > 0 && (
            <div className="border-t border-slate-100 bg-slate-50/60">
              <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-slate-500">
                Fournisseurs reconnus, sans collecteur — les prochains portails à brancher
              </div>
              <div className="px-3 pb-3 flex flex-wrap gap-1.5">
                {uncovered.map(([vendor, list]) => (
                  <span key={vendor} className="flex items-center gap-1.5 px-2 py-1 text-[11px] rounded-lg border border-slate-200 bg-white text-slate-600">
                    {vendor} · {list.length} · {money(list.reduce((t, n) => t + Math.abs(n.amount || 0), 0), list[0]?.currency)}
                    <RequestScraperButton vendor={vendor} />
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}


function NewAccountModal({ vendors, vendorProfiles, onClose, onCreated }) {
  const { addToast } = useToast()
  const [form, setForm] = useState({ vendor: vendors[0]?.key || '', username: '', password: '', totp_secret: '', lookback_days: 60, vendor_profile_id: '', collect_mode: 'ciblee' })
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const vendor = vendors.find(v => v.key === form.vendor)

  // Exception à l'autosave : création d'un enregistrement qui n'a pas encore
  // d'id, et dont le mot de passe ne doit partir qu'une fois, complet.
  const submit = async () => {
    if (!form.username || !form.password) return
    setSaving(true)
    try {
      onCreated(await api.scrapers.create(form))
      onClose()
    } catch (e) {
      addToast({ message: `Création échouée : ${e.message}`, type: 'error' })
    } finally { setSaving(false) }
  }

  return (
    <Modal isOpen onClose={onClose} title="Nouveau compte de collecte">
      <div className="space-y-3">
        <div>
          <label className={labelCls}>Fournisseur</label>
          <select className={inputCls} value={form.vendor} onChange={e => set('vendor', e.target.value)}>
            {vendors.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>{vendor?.fields?.username || 'Courriel'}</label>
          <input className={inputCls} autoComplete="off" value={form.username} onChange={e => set('username', e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>{vendor?.fields?.password || 'Mot de passe'}</label>
          <input className={inputCls} type="password" autoComplete="new-password" value={form.password} onChange={e => set('password', e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Secret 2FA (optionnel)</label>
          <input className={inputCls} value={form.totp_secret} onChange={e => set('totp_secret', e.target.value)} />
          <p className="text-[11px] text-slate-400 mt-1">
            Le secret d'une application d'authentification. Sans lui, une tournée qui tombe sur
            un code par SMS ou courriel s'arrête et attend qu'on le saisisse ici.
          </p>
        </div>
        <div>
          <label className={labelCls}>Fournisseur de l'ERP</label>
          <SearchableSelect
            value={form.vendor_profile_id}
            options={(vendorProfiles || []).map(v => ({ value: v.id, label: v.name }))}
            onChange={v => set('vendor_profile_id', v || '')}
          />
          <p className="text-[11px] text-slate-400 mt-1">
            C'est ce lien qui permet de partir d'une transaction bancaire et de savoir
            quel portail interroger.
          </p>
        </div>
        <div>
          <label className={labelCls}>Fenêtre de collecte (jours)</label>
          <input className={inputCls} type="number" min={1} max={730} value={form.lookback_days}
            onChange={e => set('lookback_days', Number(e.target.value))} />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 rounded-lg">Annuler</button>
          <button onClick={submit} disabled={saving || !form.username || !form.password}
            className="px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-40">
            {saving ? 'Création…' : 'Créer'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// Saisie du code 2FA : le collecteur en attente sonde la base toutes les 3 s.
function OtpPrompt({ account, onSent }) {
  const { addToast } = useToast()
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const send = async () => {
    setSending(true)
    try {
      await api.scrapers.otp(account.id, code)
      setCode('')
      addToast({ message: 'Code transmis — la tournée reprend', type: 'success' })
      onSent()
    } catch (e) {
      addToast({ message: `Code refusé : ${e.message}`, type: 'error' })
    } finally { setSending(false) }
  }
  return (
    <div className="flex items-center gap-2 p-3 rounded-xl border border-amber-300 bg-amber-50">
      <ShieldAlert size={16} className="text-amber-600 shrink-0" />
      <span className="text-sm text-amber-900 flex-1">
        <strong>{account.label}</strong> attend un code de vérification.
      </span>
      <input className="w-28 px-2 py-1 text-sm border border-amber-300 rounded-lg bg-white tabular-nums" value={code} inputMode="numeric"
        onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
        onKeyDown={e => { if (e.key === 'Enter' && code.length >= 4) send() }} />
      <button onClick={send} disabled={sending || code.length < 4}
        className="px-3 py-1.5 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-lg disabled:opacity-40">
        Envoyer
      </button>
    </div>
  )
}

// Import d'une session ouverte à la main : seule voie quand le portail protège
// sa page de connexion par un captcha (Wix) ou impose une connexion Google.
function ImportSessionModal({ account, onClose, onDone }) {
  const { addToast } = useToast()
  const [payload, setPayload] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    setSaving(true)
    try {
      const r = await api.scrapers.importSession(account.id, payload)
      addToast({ message: `Session importée — ${r.cookies} cookie(s)`, type: 'success' })
      onDone()
      onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally { setSaving(false) }
  }

  return (
    <Modal isOpen onClose={onClose} title="Importer une session" size="lg">
      <div className="space-y-3">
        <ol className="text-sm text-slate-600 space-y-1 list-decimal pl-5">
          <li>Se connecter au portail dans son propre navigateur (Google, captcha — peu importe).</li>
          <li>Ouvrir l'extension <strong>Cookie-Editor</strong> sur l'onglet du portail, puis « Export → JSON ».</li>
          <li>Coller le résultat ci-dessous.</li>
        </ol>
        <textarea
          className="w-full h-56 px-2.5 py-2 text-xs font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30"
          value={payload} onChange={e => setPayload(e.target.value)} />
        <p className="text-[11px] text-slate-400">
          Un storageState Playwright est accepté tel quel. La session remplace celle en place ;
          quand elle expirera, le collecteur le dira et il suffira de refaire l'opération.
        </p>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 rounded-lg">Annuler</button>
          <button onClick={submit} disabled={saving || !payload.trim()}
            className="px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-40">
            {saving ? 'Import…' : 'Importer'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function RunRow({ run }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-b border-slate-100 last:border-0">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50">
        {open ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
        <span className="text-xs text-slate-500 tabular-nums w-36">{fmtDateTime(run.started_at)}</span>
        <Badge status={run.status} />
        <span className="text-xs text-slate-600 flex-1">
          {run.status === 'running' ? 'en cours…'
            : run.status === 'needs_otp' ? 'en attente du code'
            : run.status === 'cancelled' ? 'interrompue'
            : run.status === 'error' ? (run.imported > 0 ? `${run.imported} importée(s) avant l'échec` : 'échouée avant toute facture')
            : run.imported > 0 ? `${run.imported} facture(s) importée(s)` : 'aucune nouvelle facture'}
          {run.skipped > 0 ? ` · ${run.skipped} ignorée(s)` : ''}
        </span>
        {run.duration_ms != null && <span className="text-[11px] text-slate-400 tabular-nums">{Math.round(run.duration_ms / 1000)} s</span>}
      </button>
      {open && (
        <div className="px-9 pb-3 space-y-2">
          {run.error && (
            <div className="relative bg-red-50 border border-red-200 rounded-lg p-2 pr-16" data-run-error>
              <CopyButton text={run.error} label="Copier" title="Copier le message d'erreur"
                className="absolute top-1.5 right-1.5 border-red-200 text-red-600 hover:text-red-800 hover:bg-red-100" />
              <ErrorLine text={run.error} className="text-xs text-red-700" />
            </div>
          )}
          {run.artifacts?.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {run.artifacts.map(a => (
                <a key={a} href={api.scrapers.artifactUrl(run.id, a)} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border border-slate-200 rounded-lg hover:bg-slate-50">
                  <Camera size={12} /> {a}
                </a>
              ))}
            </div>
          )}
          <div className="relative">
            <CopyButton text={() => [run.error, (run.log || []).join('\n')].filter(Boolean).join('\n\n')}
              label="Copier le journal" title="Copier le journal (et l'erreur) de cette tournée" testId="copy-run-log"
              className="absolute top-1.5 right-1.5 z-10" />
            <pre className="text-[11px] leading-relaxed text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-2 pr-32 overflow-auto max-h-64 whitespace-pre-wrap break-words" data-run-log>
              {(run.log || []).join('\n') || '(journal vide)'}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

function AccountCard({ account, onChanged }) {
  const { addToast } = useToast()
  const [runs, setRuns] = useState(null)
  const [showRuns, setShowRuns] = useState(false)
  const [importing, setImporting] = useState(false)

  const loadRuns = useCallback(async () => {
    try { setRuns(await api.scrapers.runs(account.id)) } catch { /* affichage best-effort */ }
  }, [account.id])

  useEffect(() => { if (showRuns) loadRuns() }, [showRuns, loadRuns, account.last_run_at])

  const act = async (fn, msg) => {
    try { await fn(); addToast({ message: msg, type: 'success' }); onChanged() }
    catch (e) { addToast({ message: e.message, type: 'error' }) }
  }

  // Autosave : un changement de réglage part au blur, sans bouton Enregistrer.
  const patch = async (field, value) => {
    if ((account[field] ?? '') === (value ?? '')) return
    try { await api.scrapers.update(account.id, { [field]: value }); onChanged() }
    catch (e) { addToast({ message: `Sauvegarde échouée : ${e.message}`, type: 'error' }) }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center gap-3 p-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm text-slate-800 truncate">{account.label}</span>
            {account.running ? <Badge status="running" /> : account.last_status && <Badge status={account.last_status} />}
            {!account.enabled && <span className="text-[11px] text-slate-400">désactivé</span>}
          </div>
          <div className="text-xs text-slate-500 mt-0.5 truncate">
            {account.username}
            {account.vendor_profile_name && ` · ${account.vendor_profile_name}`}
            {account.last_run_at && ` · dernière tournée ${fmtDateTime(account.last_run_at)}`}
            {account.last_imported > 0 && ` · ${account.last_imported} importée(s)`}
          </div>
          {account.last_status === 'error' && account.last_error && (
            <div className="flex items-start gap-1.5 mt-1">
              <ErrorLine text={account.last_error} className="text-xs text-red-700 min-w-0 flex-1" />
              <CopyButton text={account.last_error} title="Copier le message d'erreur"
                className="shrink-0 border-red-200 text-red-600 hover:text-red-800 hover:bg-red-50" />
            </div>
          )}
        </div>

        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          <input type="checkbox" checked={!!account.enabled}
            onChange={e => patch('enabled', e.target.checked)} />
          Actif
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          Fenêtre
          <input type="number" min={1} max={730} defaultValue={account.lookback_days}
            onBlur={e => patch('lookback_days', Number(e.target.value))}
            className="w-16 px-1.5 py-1 text-xs border border-slate-200 rounded-lg tabular-nums" />
          j
        </label>
        <select value={account.collect_mode || 'ciblee'} onChange={e => patch('collect_mode', e.target.value)}
          title="Ciblée : ne descend que les factures réclamées par une transaction non comptabilisée. Fenêtre : tout ce que le portail expose."
          className="px-1.5 py-1 text-xs border border-slate-200 rounded-lg text-slate-600">
          <option value="ciblee">Ciblée</option>
          <option value="fenetre">Fenêtre</option>
        </select>

        <button onClick={() => act(() => api.scrapers.run(account.id), 'Tournée lancée')}
          disabled={account.running}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-40">
          <Play size={14} /> Collecter
        </button>
        <button onClick={() => setImporting(true)}
          title="Importer une session ouverte à la main (portail protégé par un captcha ou connexion Google)"
          className={`p-1.5 rounded-lg hover:bg-slate-100 ${account.has_session ? 'text-emerald-600' : 'text-slate-400 hover:text-slate-700'}`}>
          <Cookie size={15} />
        </button>
        <button onClick={() => act(() => api.scrapers.forgetSession(account.id), 'Session oubliée')}
          title="Oublier la session enregistrée (force une reconnexion complète)"
          className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg">
          <KeyRound size={15} />
        </button>
        <button onClick={() => act(() => api.scrapers.remove(account.id), 'Compte supprimé')}
          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg">
          <Trash2 size={15} />
        </button>
      </div>

      <button onClick={() => setShowRuns(s => !s)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700 border-t border-slate-100">
        {showRuns ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Historique des tournées
      </button>
      {importing && <ImportSessionModal account={account} onClose={() => setImporting(false)} onDone={onChanged} />}

      {showRuns && (
        <div className="border-t border-slate-100">
          {runs === null && <div className="px-3 py-2 text-xs text-slate-400"><Spinner size="xs" label="Chargement…" /></div>}
          {runs?.length === 0 && <div className="px-3 py-2 text-xs text-slate-400">Aucune tournée pour l'instant.</div>}
          {runs?.map(r => <RunRow key={r.id} run={r} />)}
        </div>
      )}
    </div>
  )
}

// Contenu de la page, sans <Layout> : monté tel quel dans l'onglet « Collecte
// de factures » d'Extraction de données (voir SaleReceipts.jsx). L'accès
// direct par le menu de gauche pointe vers ce même onglet — plus de route
// séparée à maintenir en double.
export function InvoiceCollectionPanel() {
  const { addToast } = useToast()
  const [data, setData] = useState(null)
  const [needs, setNeeds] = useState(null)
  const [creating, setCreating] = useState(false)
  const timer = useRef(null)

  const load = useCallback(async () => {
    try { setData(await api.scrapers.list()) }
    catch (e) { addToast({ message: `Chargement échoué : ${e.message}`, type: 'error' }) }
    // Les besoins sont recalculés côté serveur à chaque lecture : ils suivent le
    // relevé sans qu'on ait à les rafraîchir à la main.
    try { setNeeds(await api.scrapers.needs()) }
    catch { /* le panneau se contente de ne pas s'afficher */ }
  }, [addToast])

  useEffect(() => { load() }, [load])

  // Une tournée vit côté serveur : tant qu'il y en a une en cours ou en attente
  // de code, on rafraîchit pour que l'écran suive sans que l'utilisateur clique.
  useEffect(() => {
    const active = data?.accounts?.some(a => a.running) || data?.pending_otp?.length > 0
    clearInterval(timer.current)
    if (active) timer.current = setInterval(load, 4000)
    return () => clearInterval(timer.current)
  }, [data, load])

  const pendingAccounts = (data?.pending_otp || [])
    .map(p => data.accounts.find(a => a.id === p.account_id))
    .filter(Boolean)

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-slate-500">
          Pour les fournisseurs qui n'envoient pas leurs factures par courriel et n'offrent pas d'API.
        </p>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg">
            <RefreshCw size={15} />
          </button>
          <button onClick={() => api.scrapers.runAll().then(() => addToast({ message: 'Tournée lancée sur tous les comptes actifs', type: 'success' })).then(load)}
            className="px-3 py-2 text-sm text-slate-600 border border-slate-200 hover:bg-slate-50 rounded-lg">
            Tout collecter
          </button>
          <button onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg">
            <Plus size={15} /> Nouveau compte
          </button>
        </div>
      </div>

      {data?.chromium === false && (
        <div className="mb-4 p-3 rounded-xl border border-red-200 bg-red-50 text-sm text-red-800">
          Chromium est introuvable sur le serveur — aucune collecte ne peut démarrer.
        </div>
      )}

      <NeedsPanel needs={needs} accounts={data?.accounts} />

      {pendingAccounts.length > 0 && (
        <div className="space-y-2 mb-4">
          {pendingAccounts.map(a => <OtpPrompt key={a.id} account={a} onSent={load} />)}
        </div>
      )}

      <div className="space-y-2">
        {data === null && <div className="text-sm text-slate-400 p-3"><Spinner size="xs" label="Chargement…" /></div>}
        {data?.accounts?.length === 0 && (
          <div className="text-sm text-slate-400 p-6 text-center border border-dashed border-slate-200 rounded-xl">
            Aucun compte de collecte. En ajouter un pour qu'Amazon ou Wix soit ramassé automatiquement chaque nuit.
          </div>
        )}
        {data?.accounts?.map(a => <AccountCard key={a.id} account={a} onChanged={load} />)}
      </div>

      {creating && (
        <NewAccountModal vendors={data?.vendors || []} vendorProfiles={data?.vendor_profiles || []}
          onClose={() => setCreating(false)} onCreated={load} />
      )}
    </div>
  )
}
