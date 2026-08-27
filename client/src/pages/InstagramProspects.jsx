// Prospects Instagram — la liste de travail hebdomadaire.
//
// Une semaine = une section. Dans chaque section, une ligne par personne qui a
// commenté avec le mot-clé, et UNE case à cocher : « contacté ». C'est tout ce
// que la page demande de faire, donc c'est tout ce qu'elle met en avant.
//
// La case est le même champ que la colonne « Contacté » de la table Airtable
// « Prospects Instagram » : cocher ici ou là-bas revient au même (cf.
// syncInstagramProspects). Cocher est réversible → aucun dialogue de
// confirmation, la ligne se grise au clic et l'enregistrement suit derrière.
import { useState, useEffect, useCallback, useMemo } from 'react'
import { RefreshCw, ExternalLink, Instagram, Search, ChevronDown, ChevronRight, Trash2, Check, Circle } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { useAuth } from '../lib/auth.jsx'

// '2026-W34' → 'Semaine 34 — 17 au 23 août 2026'. La date parle davantage que
// le numéro ISO : personne ne sait de tête à quoi correspond W34.
function weekLabel(key) {
  const m = /^(\d{4})-W(\d{2})$/.exec(key || '')
  if (!m) return 'Semaine inconnue'
  const [, year, week] = m
  // Lundi de la semaine ISO : on part du 4 janvier (toujours en semaine 1).
  const jan4 = new Date(Date.UTC(Number(year), 0, 4))
  const monday = new Date(jan4)
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (Number(week) - 1) * 7)
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  const fmt = (d, withYear) => new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'UTC', day: 'numeric', month: 'long', ...(withYear ? { year: 'numeric' } : {}),
  }).format(d)
  return `Semaine ${Number(week)} — ${fmt(monday, false)} au ${fmt(sunday, true)}`
}

// 'orisha_auto, growingformarketmagazine' → '@orisha_auto + @growingformarketmagazine'
function accountLabel(accounts) {
  return String(accounts || '')
    .split(',').map(a => a.trim().replace(/^@+/, '')).filter(Boolean)
    .map(a => `@${a}`).join(' + ')
}

// Précise COMMENT on sait que la personne est contactée — une case cochée
// seule ne le dit pas, et ça change quoi faire ensuite (rien à faire de plus
// vs. vérifier qu'on lui a bien parlé).
const CONTACTED_SOURCE_LABEL = {
  dm_history: 'Contacté (DM Instagram)',
  public_reply: 'Contacté (réponse publique)',
  manual: 'Contacté',
}

function ProspectRow({ p, onToggle, onDelete }) {
  const comment = p.first_comment_text || p.last_comment_text
  const contactedLabel = p.contacted ? (CONTACTED_SOURCE_LABEL[p.contacted_source] || 'Contacté') : 'À contacter'
  return (
    <div
      data-prospect-id={p.id}
      className={`group flex items-start gap-3 px-4 py-2.5 border-b last:border-b-0 transition-colors
        ${p.contacted ? 'bg-green-50/50 border-green-100' : 'bg-amber-50/40 border-amber-100 hover:bg-amber-50/70'}`}
    >
      {/* Un clic = fait. Pas de bouton « Enregistrer », pas de confirmation. */}
      <input
        type="checkbox"
        checked={!!p.contacted}
        onChange={() => onToggle(p)}
        title={p.contacted
          ? `Contacté${p.contacted_at ? ` le ${fmtDate(p.contacted_at)}` : ''} — décocher pour le remettre à faire`
          : 'Marquer comme contacté'}
        className="mt-1 w-4 h-4 shrink-0 rounded border-slate-300 text-brand-600 focus:ring-brand-400/40 cursor-pointer"
      />

      {/* Statut écrit en toutes lettres : la personne qui travaille cette liste
          n'est pas forcément celle qui a construit la page — une case cochée
          seule ne suffit pas, il faut que ce soit lisible d'un coup d'œil. */}
      <button
        onClick={() => onToggle(p)}
        title={p.contacted ? 'Décocher pour remettre à faire' : 'Marquer comme contacté'}
        className={`mt-0.5 shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold
          transition-colors ${p.contacted
            ? 'bg-green-100 text-green-700 hover:bg-green-200'
            : 'bg-amber-100 text-amber-800 hover:bg-amber-200'}`}
      >
        {p.contacted ? <Check size={11} /> : <Circle size={11} />}
        {contactedLabel}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={p.profile_url || `https://instagram.com/${p.ig_username}`}
            target="_blank" rel="noreferrer"
            className={`font-medium hover:underline ${p.contacted ? 'text-slate-400' : 'text-slate-800'}`}
          >
            @{p.ig_username || 'inconnu'}
          </a>
          {p.full_name && <span className="text-xs text-slate-400 truncate">{p.full_name}</span>}
          {/* SQLite renvoie 0/1, pas des booléens : `0 && <X/>` s'évalue à 0, et
              React affiche un 0 littéral (contrairement à false/null). D'où le
              `!!` sur chaque champ avant le &&. */}
          {!!p.has_keyword && !!p.keyword && <Badge color="indigo" size="xs">{p.keyword}</Badge>}
          {!!p.replied && <Badge color="green" size="xs">a répondu</Badge>}
          {!!p.dm_sent && <Badge color="blue" size="xs">DM auto</Badge>}
          {p.comment_count > 1 && <span className="text-[11px] text-slate-400">{p.comment_count} commentaires</span>}
        </div>
        {comment && (
          <p className={`mt-0.5 text-sm truncate ${p.contacted ? 'text-slate-400' : 'text-slate-600'}`} title={comment}>
            « {comment} »
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0 text-xs text-slate-400 whitespace-nowrap">
        <span>{fmtDate(p.first_comment_at)}</span>
        {(p.last_post_url || p.first_post_url) && (
          <a href={p.last_post_url || p.first_post_url} target="_blank" rel="noreferrer"
            title="Ouvrir la publication commentée" className="hover:text-brand-600">
            <ExternalLink size={13} />
          </a>
        )}
        {/* Écarter un bot ou un hors-sujet. Soft delete : la fiche reste en base. */}
        <button onClick={() => onDelete(p)} title="Écarter de la liste (spam, bot, hors sujet)"
          className="opacity-0 group-hover:opacity-100 hover:text-red-500 transition-opacity">
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}

function WeekSection({ week, openByDefault, onToggle, onDelete }) {
  const [open, setOpen] = useState(openByDefault)
  // Repliée par défaut : ceux déjà réglés n'ont pas à encombrer la vue, mais
  // restent à un clic si on veut vérifier une fiche précise.
  const [showContacted, setShowContacted] = useState(false)
  const remaining = week.total - week.contacted
  const done = remaining === 0
  const pending = week.prospects.filter(p => !p.contacted)
  const contactedList = week.prospects.filter(p => p.contacted)

  return (
    <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
      >
        {open ? <ChevronDown size={15} className="text-slate-400" /> : <ChevronRight size={15} className="text-slate-400" />}
        <span className="font-medium text-slate-800">{weekLabel(week.week)}</span>
        <span className="text-sm text-slate-400">{week.total} prospect{week.total > 1 ? 's' : ''}</span>
        <span className="ml-auto">
          {done
            ? <Badge color="green" size="xs">tous contactés</Badge>
            : <Badge color="orange" size="xs">{remaining} à contacter</Badge>}
        </span>
      </button>
      {open && (
        <div className="border-t border-slate-100">
          {pending.length === 0 && contactedList.length > 0 && (
            <p className="px-4 py-3 text-sm text-slate-400">Rien à contacter cette semaine.</p>
          )}
          {pending.map(p => (
            <ProspectRow key={p.id} p={p} onToggle={onToggle} onDelete={onDelete} />
          ))}
          {contactedList.length > 0 && (
            <div className="border-t border-slate-100">
              <button
                onClick={() => setShowContacted(s => !s)}
                className="w-full flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors"
              >
                {showContacted ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {contactedList.length} déjà contacté{contactedList.length > 1 ? 's' : ''}
              </button>
              {showContacted && contactedList.map(p => (
                <ProspectRow key={p.id} p={p} onToggle={onToggle} onDelete={onDelete} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export default function InstagramProspects() {
  const { addToast } = useToast()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [data, setData] = useState(null)
  const [q, setQ] = useState('')
  const [pendingOnly, setPendingOnly] = useState(false)
  const [scraping, setScraping] = useState(false)

  const load = useCallback(async () => {
    const params = {}
    if (q.trim()) params.q = q.trim()
    if (pendingOnly) params.pending = '1'
    setData(await api.instagram.weeks(params))
  }, [q, pendingOnly])

  useEffect(() => {
    // Debounce de la recherche : la frappe ne doit pas déclencher une requête
    // par caractère.
    const t = setTimeout(() => { load().catch(e => addToast({ message: e.message, type: 'error' })) }, q ? 300 : 0)
    return () => clearTimeout(t)
  }, [load, addToast, q])

  // Coche appliquée LOCALEMENT d'abord : la ligne réagit au clic sans attendre
  // le réseau, et on remet l'état d'avant si l'appel échoue.
  async function toggleContacted(p) {
    const next = p.contacted ? 0 : 1
    const snapshot = data
    setData(d => d && ({
      ...d,
      pending: (d.pending ?? 0) + (next ? -1 : 1),
      weeks: d.weeks.map(w => ({
        ...w,
        contacted: w.contacted + (w.prospects.some(x => x.id === p.id) ? (next ? 1 : -1) : 0),
        prospects: w.prospects.map(x => (x.id === p.id
          ? { ...x, contacted: next, contacted_at: next ? new Date().toISOString() : null }
          : x)),
      })),
    }))
    try {
      await api.instagram.update(p.id, { contacted: next })
    } catch (e) {
      setData(snapshot)
      addToast({ message: `Sauvegarde échouée : ${e.message}`, type: 'error' })
    }
  }

  async function removeProspect(p) {
    const snapshot = data
    setData(d => d && ({
      ...d,
      weeks: d.weeks
        .map(w => ({ ...w, prospects: w.prospects.filter(x => x.id !== p.id) }))
        .filter(w => w.prospects.length)
        .map(w => ({ ...w, total: w.prospects.length, contacted: w.prospects.filter(x => x.contacted).length })),
    }))
    try {
      await api.instagram.remove(p.id)
    } catch (e) {
      setData(snapshot)
      addToast({ message: `Suppression échouée : ${e.message}`, type: 'error' })
    }
  }

  async function runScrape() {
    setScraping(true)
    try {
      const out = await api.instagram.scrape()
      addToast({ message: out.summary || 'Lecture terminée', type: 'success' })
      await load()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setScraping(false)
    }
  }

  const cfg = data?.config
  // La semaine la plus récente est celle sur laquelle on travaille : dépliée
  // d'office, les précédentes repliées.
  const firstWeek = data?.weeks?.[0]?.week
  const empty = useMemo(() => data && data.weeks.length === 0, [data])

  return (
    <Layout>
      <div className="max-w-4xl mx-auto p-6 space-y-4">
        <header className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2">
              <Instagram size={20} className="text-slate-400" /> Prospects Instagram
            </h1>
            <p className="mt-0.5 text-sm text-slate-500">
              {data
                ? <>{data.pending} personne{data.pending > 1 ? 's' : ''} à contacter · {data.total} au total</>
                : 'Chargement…'}
              {cfg && <> · commentaires de <span className="font-medium">{accountLabel(cfg.accounts)}</span>
                {cfg.keywords ? <> contenant « {cfg.keywords} »</> : <> (tous)</>}</>}
            </p>
          </div>
          {isAdmin && (
            <button
              onClick={runScrape}
              disabled={scraping}
              title={`Relire maintenant les commentaires des ${cfg?.lookback_days || 10} derniers jours`}
              className="px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50
                rounded-md transition-colors inline-flex items-center gap-1.5"
            >
              <RefreshCw size={14} className={scraping ? 'animate-spin' : ''} />
              {scraping ? 'Lecture en cours…' : 'Relire Instagram'}
            </button>
          )}
        </header>

        {/* Le cookie expire ~1 fois par an : quand il manque, la page le dit au
            lieu de laisser croire qu'il n'y a simplement aucun commentaire. */}
        {cfg && !cfg.session_ok && (
          <div className="px-4 py-2.5 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg">
            Aucun cookie de session Instagram — la lecture automatique des commentaires ne peut pas tourner.
            Le coller dans <span className="font-medium">Connecteurs → Instagram</span> (DevTools → Application → Cookies → instagram.com → <code>sessionid</code>).
          </div>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Rechercher un nom d'usager, un nom, un commentaire…"
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-white border border-slate-200 rounded-md
                focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-400/30"
            />
          </div>
          <label className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer select-none">
            <input type="checkbox" checked={pendingOnly} onChange={e => setPendingOnly(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-brand-600 focus:ring-brand-400/40" />
            À contacter seulement
          </label>
        </div>

        {empty && (
          <div className="px-4 py-10 text-center text-sm text-slate-500 bg-white border border-slate-200 rounded-lg">
            {q || pendingOnly
              ? 'Aucun prospect ne correspond à ce filtre.'
              : "Aucun prospect pour l'instant. La lecture des commentaires tourne le dimanche soir ; le bouton « Relire Instagram » la déclenche tout de suite."}
          </div>
        )}

        {data?.weeks.map(w => (
          <WeekSection
            key={w.week}
            week={w}
            openByDefault={w.week === firstWeek}
            onToggle={toggleContacted}
            onDelete={removeProspect}
          />
        ))}

        {data && data.weeks.length > 0 && (
          <p className="text-xs text-slate-400">
            La case « contacté » est partagée avec la colonne du même nom dans la table Airtable
            « Prospects Instagram » — cocher d'un côté ou de l'autre revient au même.
          </p>
        )}
      </div>
    </Layout>
  )
}
