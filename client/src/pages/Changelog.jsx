import { useEffect, useMemo, useState } from 'react'
import { Sparkles, Plus, ArrowUpCircle, Wrench, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Layout } from '../components/Layout.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { changelogEntries, markChangelogSeen } from '../lib/changelog.js'
import { api } from '../lib/api.js'

// Configuration d'affichage par type de changement.
const TYPE_CONFIG = {
  new:      { label: 'Nouveau',     icon: Plus,          className: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  improved: { label: 'Amélioration', icon: ArrowUpCircle, className: 'bg-blue-50 text-blue-700 ring-blue-200' },
  fixed:    { label: 'Correction',  icon: Wrench,        className: 'bg-amber-50 text-amber-700 ring-amber-200' },
}

function TypeBadge({ type }) {
  const cfg = TYPE_CONFIG[type] || TYPE_CONFIG.improved
  const Icon = cfg.icon
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ring-1 ring-inset ${cfg.className}`}>
      <Icon size={12} />
      {cfg.label}
    </span>
  )
}

function ChangelogEntry({ entry, isLast }) {
  return (
    <li className="relative pl-10 pb-8">
      {/* Ligne verticale de la timeline */}
      {!isLast && <span className="absolute left-[15px] top-2 bottom-0 w-px bg-slate-200" aria-hidden="true" />}
      {/* Pastille */}
      <span className="absolute left-0 top-0.5 w-8 h-8 rounded-full bg-brand-50 ring-1 ring-brand-200 flex items-center justify-center">
        <Sparkles size={15} className="text-brand-600" />
      </span>

      <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-slate-900">{entry.title}</h2>
            <p className="text-xs text-slate-400 mt-0.5">{fmtDate(entry.date)}</p>
          </div>
          {entry.category && (
            <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-slate-100 text-slate-600">
              {entry.category}
            </span>
          )}
        </div>

        <ul className="mt-3 space-y-2">
          {(entry.changes || []).map((change, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <span className="flex-shrink-0 mt-0.5">
                <TypeBadge type={change.type} />
              </span>
              <span className="text-sm text-slate-700 leading-relaxed">{change.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </li>
  )
}

// Garde « toute modification de l'app est décrite ici ». L'état vient de
// GET /api/changelog/status, qui compare le code modifié depuis le dernier
// déploiement aux entrées ajoutées au journal. Tant que la garde est rouge,
// deploy.sh refuse de livrer — la page le dit explicitement.
function GuardStatus() {
  const [st, setSt] = useState(null)

  useEffect(() => {
    let alive = true
    api.changelog
      .status()
      .then((r) => alive && setSt(r))
      .catch(() => alive && setSt({ error: true }))
    return () => {
      alive = false
    }
  }, [])

  // Rien à dire tant qu'on ne sait pas, en cas d'erreur, ou hors contexte git.
  if (!st || st.error || st.skipped) return null

  if (st.ok) {
    return (
      <div
        data-testid="changelog-guard"
        data-state="ok"
        className="mb-6 flex items-start gap-2 rounded-lg bg-emerald-50 ring-1 ring-inset ring-emerald-200 px-3 py-2"
      >
        <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
        <p className="text-sm text-emerald-800">
          Journal à jour —{' '}
          {st.changedCount === 0
            ? 'aucune modification de l’app n’attend d’être décrite.'
            : `les modifications en cours sont décrites ci-dessous (${st.newEntries.length} entrée${st.newEntries.length > 1 ? 's' : ''} ajoutée${st.newEntries.length > 1 ? 's' : ''}).`}
        </p>
      </div>
    )
  }

  return (
    <div
      data-testid="changelog-guard"
      data-state="violation"
      className="mb-6 rounded-lg bg-amber-50 ring-1 ring-inset ring-amber-200 px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-amber-900">
            {st.changedCount} modification{st.changedCount > 1 ? 's' : ''} de l’app ne {st.changedCount > 1 ? 'sont' : 'est'} pas encore décrite
            {st.changedCount > 1 ? 's' : ''} ici.
          </p>
          <p className="text-xs text-amber-800 mt-0.5">
            Le journal des nouveautés est obligatoire : la prochaine livraison est bloquée tant qu’aucune entrée
            ne raconte ces changements.
            {st.invalidCount > 0 && ` ${st.invalidCount} entrée(s) incomplète(s) ne comptent pas (date, titre et au moins un changement requis).`}
          </p>
          {(st.commits.length > 0 || st.changedFiles.length > 0) && (
            <details className="mt-2">
              <summary className="text-xs text-amber-800 cursor-pointer select-none hover:text-amber-900">
                Voir le détail
              </summary>
              <ul className="mt-1.5 space-y-0.5">
                {st.commits.map((c) => (
                  <li key={c.sha} className="text-xs text-amber-800/90 font-mono truncate">
                    {c.sha} {c.subject}
                  </li>
                ))}
                {st.commits.length === 0 &&
                  st.changedFiles.map((f) => (
                    <li key={f} className="text-xs text-amber-800/90 font-mono truncate">
                      {f}
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </div>
  )
}

export default function Changelog() {
  const entries = useMemo(() => changelogEntries, [])

  // Marquer le journal comme lu dès l'ouverture de la page : la pastille
  // « nouveautés » de la sidebar disparaît.
  useEffect(() => {
    markChangelogSeen()
  }, [])

  return (
    <Layout>
      <div className="p-6 max-w-3xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Sparkles size={22} className="text-brand-600" /> Nouveautés
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Les évolutions de l'ERP, livraison après livraison.
          </p>
        </div>

        <GuardStatus />

        {entries.length === 0 ? (
          <div className="text-center text-slate-400 py-16">
            <Sparkles size={32} className="mx-auto mb-3 text-slate-300" />
            <p className="text-sm">Aucune nouveauté pour le moment.</p>
          </div>
        ) : (
          <ul>
            {entries.map((entry, i) => (
              <ChangelogEntry
                key={`${entry.date}-${i}`}
                entry={entry}
                isLast={i === entries.length - 1}
              />
            ))}
          </ul>
        )}
      </div>
    </Layout>
  )
}
