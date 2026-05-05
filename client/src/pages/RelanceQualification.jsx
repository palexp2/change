import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Copy, Check, Mail, ExternalLink, Search, Filter, Sparkles, RotateCcw, Pencil } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { fmtDate } from '../lib/formatDate.js'

// ── Petits composants utilitaires ─────────────────────────────────────────

function CopyButton({ value, label }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }
  return (
    <button
      onClick={copy}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-slate-200 hover:bg-slate-50 text-slate-600"
      title={`Copier ${label.toLowerCase()}`}
    >
      {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
      {copied ? 'Copié' : label}
    </button>
  )
}

// Textarea qui auto-grandit selon son contenu (jusqu'à un max).
function AutoTextarea({ value, onChange, onBlur, placeholder, className = '', minRows = 2, maxRows = 30, ...rest }) {
  const ref = useRef(null)
  function resize() {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const lineH = parseFloat(getComputedStyle(el).lineHeight) || 20
    const max = lineH * maxRows
    el.style.height = Math.min(el.scrollHeight, max) + 'px'
  }
  useEffect(() => { resize() }, [value])
  return (
    <textarea
      ref={ref}
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      rows={minRows}
      className={`w-full text-sm border border-slate-200 rounded-lg p-2 focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 resize-none ${className}`}
      {...rest}
    />
  )
}

// Petit indicateur "sauvegardé / en cours / erreur" pour autosave.
function SaveIndicator({ state }) {
  if (state === 'saving') return <span className="text-xs text-slate-400">enregistrement…</span>
  if (state === 'saved') return <span className="text-xs text-emerald-600 inline-flex items-center gap-1"><Check size={11} /> enregistré</span>
  if (state === 'error') return <span className="text-xs text-red-600">échec d'enregistrement</span>
  return null
}

// Hook : autosave-on-blur (les changements rapides ne déclenchent pas de save tant
// que le champ n'a pas perdu le focus — évite les écritures excessives).
function useBlurSave(saveFn) {
  const [state, setState] = useState('idle')
  async function flush(value) {
    setState('saving')
    try {
      await saveFn(value)
      setState('saved')
      setTimeout(() => setState(s => s === 'saved' ? 'idle' : s), 1500)
    } catch {
      setState('error')
    }
  }
  return { state, flush }
}

// ── Contrôles de régénération IA ──────────────────────────────────────────

function RegenerateControls({ disabled, currentTemp, onTempChange, onRegenerate, regenCount, loading }) {
  return (
    <div className="flex items-center gap-2">
      <label className="inline-flex items-center gap-1.5 text-xs text-slate-500">
        <span>Température</span>
        <input
          type="number"
          step="0.1"
          min="0"
          max="1.5"
          value={currentTemp}
          onChange={e => onTempChange(parseFloat(e.target.value))}
          disabled={loading || disabled}
          className="w-14 px-1.5 py-0.5 text-xs text-slate-700 border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500"
          title="0 = constant, 1+ = créatif"
        />
      </label>
      <button
        onClick={onRegenerate}
        disabled={loading || disabled}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-brand-600 hover:bg-brand-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white"
        title="Régénérer le courriel via OpenAI avec le contexte du qualification call et les instructions IA"
      >
        {loading ? (
          <span className="h-3 w-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
        ) : (
          <Sparkles size={12} />
        )}
        {loading ? 'Génération…' : (regenCount > 0 ? 'Régénérer' : 'Régénérer (IA)')}
      </button>
    </div>
  )
}

// ── Carte d'un courriel ───────────────────────────────────────────────────

function EmailCard({ it, generalRules, savedSpecific, onSavedSpecificChange }) {
  const qcId = it.qualification_call.id

  const [specific, setSpecific] = useState(savedSpecific || '')
  const [showInstructions, setShowInstructions] = useState(Boolean(savedSpecific))
  const specSave = useBlurSave(async (value) => {
    await api.emailRelance.saveQc(qcId, value)
    onSavedSpecificChange?.(qcId, value)
  })

  const [temp, setTemp] = useState(0.7)
  const [override, setOverride] = useState(null)   // { subject, body, language, model, temperature }
  const [regenCount, setRegenCount] = useState(0)
  const [regenLoading, setRegenLoading] = useState(false)
  const [regenError, setRegenError] = useState(null)

  // État éditable du sujet/corps. Les éditions utilisateur sont conservées
  // localement; une régénération les écrase (et le bouton "Restaurer" replace
  // au template d'origine en effaçant override + edits).
  const [editSubject, setEditSubject] = useState(null)   // null = pas d'édition utilisateur
  const [editBody, setEditBody] = useState(null)

  const baseEmail = override || it.email
  const displaySubject = editSubject !== null ? editSubject : baseEmail.subject
  const displayBody = editBody !== null ? editBody : baseEmail.body
  const userEdited = editSubject !== null || editBody !== null

  async function regenerate() {
    setRegenLoading(true)
    setRegenError(null)
    try {
      const out = await api.emailRelance.regenerate(qcId, temp, generalRules, specific)
      setOverride(out)
      setEditSubject(null)
      setEditBody(null)
      setRegenCount(c => c + 1)
    } catch (e) {
      setRegenError(e.message || 'Erreur de génération')
    } finally {
      setRegenLoading(false)
    }
  }

  function restoreTemplate() {
    setOverride(null)
    setEditSubject(null)
    setEditBody(null)
    setRegenCount(0)
  }

  return (
    <article className="card overflow-hidden">
      <header className="flex items-start justify-between gap-3 px-4 py-3 border-b border-slate-100 bg-slate-50">
        <div className="min-w-0">
          <Link
            to={`/companies/${it.company.id}`}
            className="text-sm font-semibold text-slate-900 hover:text-brand-700 inline-flex items-center gap-1"
          >
            {it.company.name}
            <ExternalLink size={12} className="text-slate-400" />
          </Link>
          <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
            {it.company.lifecycle_phase && <span>{it.company.lifecycle_phase}</span>}
            {it.qualification_call.call_date && <span>QC du {fmtDate(it.qualification_call.call_date)}</span>}
            {it.project && (
              <span>
                Projet perdu : <span className="font-mono">{it.project.project_number}</span>
                {it.project.close_date ? ` · ${fmtDate(it.project.close_date)}` : ''}
                {it.project.value_cad ? ` · ${new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(it.project.value_cad)}` : ''}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <RegenerateControls
            currentTemp={temp}
            regenCount={regenCount}
            onTempChange={setTemp}
            onRegenerate={regenerate}
            loading={regenLoading}
          />
          <span className={`inline-flex text-xs font-medium px-2 py-0.5 rounded-full ${
            baseEmail.language === 'fr' ? 'bg-blue-100 text-blue-700' : 'bg-violet-100 text-violet-700'
          }`}>{baseEmail.language.toUpperCase()}</span>
        </div>
      </header>

      {/* Bandeaux d'état (régénération / édition) */}
      {(override || userEdited || regenError) && (
        <div className="px-4 py-2 border-b border-slate-100 text-xs flex items-center justify-between gap-3 bg-slate-50">
          <div className="inline-flex items-center gap-2">
            {override && (
              <span className="inline-flex items-center gap-1.5 text-violet-700">
                <Sparkles size={12} />
                Généré par IA · {override.model} · temp {override.temperature}
                {regenCount > 1 && <span className="text-violet-500">· essai n°{regenCount}</span>}
              </span>
            )}
            {userEdited && (
              <span className="inline-flex items-center gap-1.5 text-amber-700">
                <Pencil size={11} /> édité manuellement
              </span>
            )}
            {regenError && (
              <span className="text-red-600 truncate max-w-[260px]" title={regenError}>{regenError}</span>
            )}
          </div>
          {(override || userEdited) && (
            <button
              onClick={restoreTemplate}
              className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900"
            >
              <RotateCcw size={11} /> Restaurer le template
            </button>
          )}
        </div>
      )}

      {/* Instructions IA spécifiques à cette entreprise */}
      <div className="px-4 pt-3">
        {!showInstructions && !specific ? (
          <button
            onClick={() => setShowInstructions(true)}
            className="text-xs text-slate-500 hover:text-brand-700 inline-flex items-center gap-1"
          >
            <Sparkles size={11} /> Ajouter des instructions IA pour ce courriel
          </button>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-slate-400 uppercase tracking-wide inline-flex items-center gap-1.5">
                <Sparkles size={11} /> Instructions IA pour cette entreprise
              </span>
              <SaveIndicator state={specSave.state} />
            </div>
            <AutoTextarea
              value={specific}
              onChange={setSpecific}
              onBlur={() => specSave.flush(specific)}
              placeholder={`Ex. : Mentionner qu'on les a vus à l'expo Saint-Hyacinthe en novembre. Ne pas parler de tomates, ils font des fines herbes. Le décideur s'appelle Marie-Pier.`}
              minRows={2}
              maxRows={8}
            />
          </div>
        )}
      </div>

      <div className="p-4 space-y-3">
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">Sujet</span>
            <CopyButton value={displaySubject} label="Copier sujet" />
          </div>
          <input
            type="text"
            value={displaySubject}
            onChange={e => setEditSubject(e.target.value)}
            className="w-full text-sm font-medium text-slate-900 bg-white border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">Corps</span>
            <div className="flex gap-1.5">
              <CopyButton value={displayBody} label="Copier corps" />
              <CopyButton value={`${displaySubject}\n\n${displayBody}`} label="Copier tout" />
            </div>
          </div>
          <AutoTextarea
            value={displayBody}
            onChange={setEditBody}
            className="bg-slate-50 font-sans text-slate-700"
            minRows={8}
            maxRows={40}
          />
        </div>

        {(it.qualification_call.challenges || it.qualification_call.farm_description) && (
          <details className="text-xs">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-700">Données source de la personnalisation</summary>
            <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-slate-100">
              {it.qualification_call.challenges && (
                <div>
                  <div className="text-slate-400 mb-0.5">Défis</div>
                  <div className="text-slate-600 whitespace-pre-wrap">{it.qualification_call.challenges}</div>
                </div>
              )}
              {it.qualification_call.farm_description && (
                <div>
                  <div className="text-slate-400 mb-0.5">Description ferme</div>
                  <div className="text-slate-600 whitespace-pre-wrap">{it.qualification_call.farm_description}</div>
                </div>
              )}
              {it.qualification_call.short_term_goals && (
                <div>
                  <div className="text-slate-400 mb-0.5">Objectifs court terme</div>
                  <div className="text-slate-600 whitespace-pre-wrap">{it.qualification_call.short_term_goals}</div>
                </div>
              )}
              {it.qualification_call.business_models?.length > 0 && (
                <div>
                  <div className="text-slate-400 mb-0.5">Modèles d'affaires</div>
                  <div className="text-slate-600">{it.qualification_call.business_models.join(', ')}</div>
                </div>
              )}
            </div>
          </details>
        )}
      </div>
    </article>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function RelanceQualification() {
  const [items, setItems] = useState(null)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [langFilter, setLangFilter] = useState('all')

  // Règles générales (partagées entre tous les emails) + savedSpecific (par qc)
  const [generalRules, setGeneralRules] = useState('')
  const [savedSpecific, setSavedSpecific] = useState({})  // { [qcId]: instructions }
  const generalSave = useBlurSave(async (value) => {
    await api.emailRelance.saveGlobal(value)
  })

  useEffect(() => {
    Promise.all([
      api.emailRelance.qualificationCalls(),
      api.emailRelance.settings(),
    ]).then(([list, settings]) => {
      setItems(list.data || [])
      setGeneralRules(settings.general || '')
      setSavedSpecific(settings.perQc || {})
    }).catch(e => setError(e.message || 'Erreur de chargement'))
  }, [])

  const filtered = useMemo(() => {
    if (!items) return []
    const q = search.trim().toLowerCase()
    return items.filter(it => {
      if (langFilter !== 'all' && it.email.language !== langFilter) return false
      if (!q) return true
      return it.company.name.toLowerCase().includes(q)
        || (it.qualification_call.challenges || '').toLowerCase().includes(q)
        || (it.email.subject || '').toLowerCase().includes(q)
    })
  }, [items, search, langFilter])

  const counts = useMemo(() => {
    if (!items) return { total: 0, fr: 0, en: 0 }
    return {
      total: items.length,
      fr: items.filter(i => i.email.language === 'fr').length,
      en: items.filter(i => i.email.language === 'en').length,
    }
  }, [items])

  if (items === null && !error) {
    return <Layout><div className="p-6 flex items-center justify-center h-64"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600" /></div></Layout>
  }
  if (error) {
    return <Layout><div className="p-6 text-red-600">Erreur : {error}</div></Layout>
  }

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Mail size={22} className="text-brand-600" />
            Relances qualification
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Templates d'emails personnalisés pour les entreprises ayant eu un appel de qualification
            et au moins un projet perdu. Personnalise les règles de gauche pour orienter l'IA, ou édite
            directement chaque courriel.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6 items-start">
          {/* Sidebar gauche : règles générales (sticky sur desktop) */}
          <aside className="lg:sticky lg:top-6 space-y-4">
            <div className="card p-4">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-slate-900 inline-flex items-center gap-1.5">
                  <Sparkles size={14} className="text-brand-600" /> Règles générales
                </h2>
                <SaveIndicator state={generalSave.state} />
              </div>
              <p className="text-xs text-slate-500 mb-2">
                Ces consignes s'ajoutent au prompt système pour <strong>tous</strong> les courriels régénérés
                par l'IA. Modifie-les pour orienter le ton, ajouter ta signature, exclure certains sujets, etc.
              </p>
              <AutoTextarea
                value={generalRules}
                onChange={setGeneralRules}
                onBlur={() => generalSave.flush(generalRules)}
                placeholder={`Ex. :\n- Signature : Pierre-Alex, fondateur\n- On tutoie quand le prénom finit en -y, sinon on vouvoie\n- Mentionner qu'on est basés à Saint-Hyacinthe si pertinent\n- Ne pas chiffrer les rendements promis avant un appel`}
                minRows={6}
                maxRows={20}
              />
            </div>
          </aside>

          {/* Colonne principale : filtres + liste */}
          <div>
            <div className="flex flex-wrap items-center gap-3 mb-4">
              <div className="relative flex-1 min-w-[240px]">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Rechercher par entreprise, défi…"
                  className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
                />
              </div>
              <div className="inline-flex items-center gap-1 text-xs">
                <Filter size={14} className="text-slate-400" />
                {[
                  { v: 'all', label: `Tous (${counts.total})` },
                  { v: 'fr', label: `FR (${counts.fr})` },
                  { v: 'en', label: `EN (${counts.en})` },
                ].map(opt => (
                  <button
                    key={opt.v}
                    onClick={() => setLangFilter(opt.v)}
                    className={`px-2.5 py-1 rounded-md font-medium ${
                      langFilter === opt.v
                        ? 'bg-brand-50 text-brand-700 border border-brand-200'
                        : 'text-slate-500 hover:bg-slate-100 border border-transparent'
                    }`}
                  >{opt.label}</button>
                ))}
              </div>
            </div>

            {filtered.length === 0 ? (
              <div className="card p-10 text-center text-slate-400">Aucun email à afficher.</div>
            ) : (
              <div className="space-y-4">
                {filtered.map(it => (
                  <EmailCard
                    key={it.company.id}
                    it={it}
                    generalRules={generalRules}
                    savedSpecific={savedSpecific[it.qualification_call.id]}
                    onSavedSpecificChange={(qcId, value) =>
                      setSavedSpecific(prev => ({ ...prev, [qcId]: value }))
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  )
}
