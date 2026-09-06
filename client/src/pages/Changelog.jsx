import { useCallback, useEffect, useMemo, useState } from 'react'
import { Sparkles, Plus, ArrowUpCircle, Wrench, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { changelogEntries } from '../lib/changelog.js'
import { api } from '../lib/api.js'

// Configuration d'affichage par type de changement.
const TYPE_CONFIG = {
  new:      { label: 'Nouveauté',    icon: Plus,          className: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  improved: { label: 'Amélioration', icon: ArrowUpCircle, className: 'bg-blue-50 text-blue-700 ring-blue-200' },
  fixed:    { label: 'Correction',   icon: Wrench,        className: 'bg-amber-50 text-amber-700 ring-amber-200' },
}
// Nature dominante d'une entrée : une nouveauté prime sur une amélioration,
// qui prime sur une correction. C'est ce que porte la colonne « Nature ».
const TYPE_RANK = ['new', 'improved', 'fixed']

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
  // Demandeurs : le champ `requester` de l'entrée s'il existe, sinon le
  // rapprochement serveur avec la demande d'origine. Absent = « — ».
  const [requesters, setRequesters] = useState({})

  useEffect(() => {
    let alive = true
    api.changelog
      .requesters()
      .then((r) => alive && setRequesters(r || {}))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const rows = useMemo(
    () =>
      changelogEntries.map((entry, i) => {
        const changes = entry.changes || []
        const types = [...new Set(changes.map((c) => c.type || 'improved'))]
        const who = requesters[`${entry.date}|${entry.title}`]
        const dominantType = TYPE_RANK.find((t) => types.includes(t)) || 'improved'
        return {
          id: `${entry.date}-${i}`,
          date: entry.date,
          title: entry.title,
          category: entry.category || '',
          dominantType,
          type: TYPE_CONFIG[dominantType].label,
          requester: who?.name || '',
          requesterSource: who?.source || '',
          requestTitle: who?.requestTitle || '',
          requestDate: who?.requestDate || '',
          summary: changes.map((c) => c.text).join(' • '),
          types,
          changes,
        }
      }),
    [requesters]
  )

  const columns = useMemo(() => {
    const renders = {
      date: (row) => <span className="text-slate-500">{fmtDate(row.date)}</span>,
      title: (row) => <span className="font-medium text-slate-800">{row.title}</span>,
      category: (row) =>
        row.category ? (
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-slate-100 text-slate-600">
            {row.category}
          </span>
        ) : null,
      // Une seule pastille : la nature dominante, celle sur laquelle porte le
      // filtre. Le détail par changement s'affiche en dépliant la ligne.
      type: (row) => <TypeBadge type={row.dominantType} />,
      requester: (row) =>
        row.requester ? (
          <span
            className={row.requesterSource === 'match' ? 'text-slate-500 italic' : 'font-medium text-slate-800'}
            title={
              row.requesterSource === 'match'
                ? `Rapproché de la demande « ${row.requestTitle} »${row.requestDate ? ` (${fmtDate(row.requestDate)})` : ''}`
                : undefined
            }
          >
            {row.requester}
          </span>
        ) : (
          <span className="text-slate-300">—</span>
        ),
      summary: (row) => <span className="text-slate-600">{row.summary}</span>,
    }
    return TABLE_COLUMN_META.changelog.map((meta) => ({ ...meta, render: renders[meta.id] }))
  }, [])

  const renderExpanded = useCallback(
    (row) => (
      <ul className="px-4 py-3 space-y-2">
        {row.changes.map((change, i) => (
          <li key={i} className="flex items-start gap-2.5">
            <span className="flex-shrink-0 mt-0.5">
              <TypeBadge type={change.type} />
            </span>
            <span className="text-sm text-slate-700 leading-relaxed">{change.text}</span>
          </li>
        ))}
      </ul>
    ),
    []
  )

  return (
    <ListPage
      title="Nouveautés"
      icon={Sparkles}
      subtitle={<p className="text-xs text-slate-400 mt-0.5">Ce qui change dans l'ERP, et qui l'a demandé</p>}
      banner={<GuardStatus />}
    >
      <DataTable
        table="changelog"
        columns={columns}
        data={rows}
        renderExpanded={renderExpanded}
        searchFields={['title', 'category', 'requester', 'summary']}
        emptyState={{
          icon: Sparkles,
          title: 'Aucune nouveauté',
          description: "Les évolutions de l'ERP s'afficheront ici.",
        }}
      />
    </ListPage>
  )
}
