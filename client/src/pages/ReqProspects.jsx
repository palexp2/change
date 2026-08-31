// Prospects REQ — les entreprises du Registre des entreprises du Québec dont
// l'activité déclarée est la culture en serre ou l'horticulture, encore
// immatriculées, et qui n'ont AUCUNE correspondance dans l'ERP (ni par NEQ lié,
// ni par nom normalisé).
//
// Sens unique et lecture seule côté registre. Le seul geste qui écrit est
// « Créer la compagnie + l'entrée pipeline », ligne par ligne : la page ne crée
// jamais rien toute seule, et une entreprise déjà présente est refusée côté
// serveur même si la liste a vieilli dans l'onglet.
import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Landmark, Search, RefreshCw, UserPlus, Sprout, ExternalLink } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { Badge } from '../components/Badge.jsx'
import EmptyState from '../components/EmptyState.jsx'
import ReqSourceNotice from '../components/ReqSourceNotice.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { useToast } from '../contexts/ToastContext.jsx'

export default function ReqProspects() {
  const { addToast } = useToast()
  const [search, setSearch] = useState('')
  const [region, setRegion] = useState('')
  const [rows, setRows] = useState([])
  const [regions, setRegions] = useState([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(null)
  // Les entreprises créées pendant la session : la ligne reste visible avec son
  // lien vers la fiche plutôt que de disparaître sous le curseur.
  const [created, setCreated] = useState({})
  const timer = useRef(null)

  const load = useCallback((opts = {}) => {
    setLoading(true)
    Promise.all([
      api.req.prospects({ search: opts.search ?? search, region: opts.region ?? region }),
      api.req.status(),
    ])
      .then(([p, s]) => {
        setRows(p.data || [])
        setRegions(p.regions || [])
        setTotal(p.total || 0)
        setStatus(s)
      })
      .catch(e => addToast({ message: e.message || 'Chargement impossible', type: 'error' }))
      .finally(() => setLoading(false))
    // `search`/`region` sont passés explicitement par les appelants qui les
    // changent : les inclure ici relancerait deux fois la même requête.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addToast])

  useEffect(() => { load() }, [load])

  // Recherche : debounce ~400 ms, le filtrage se fait côté serveur (le registre
  // est trop gros pour être filtré dans le navigateur).
  function onSearch(value) {
    setSearch(value)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => load({ search: value }), 400)
  }

  function onRegion(value) {
    setRegion(value)
    load({ region: value })
  }

  async function createProspect(row) {
    setCreating(row.neq)
    try {
      const r = await api.req.createProspects([row.neq])
      const hit = r.created?.[0]
      if (hit) {
        setCreated(c => ({ ...c, [row.neq]: hit }))
        addToast({ message: `${hit.name} créée avec son projet de prospection`, type: 'success' })
      } else {
        addToast({ message: r.skipped?.[0]?.reason || 'Création refusée', type: 'error' })
        load()
      }
    } catch (e) {
      addToast({ message: e.message || 'Création impossible', type: 'error' })
    } finally {
      setCreating(null)
    }
  }

  const regionOptions = [
    { value: '', label: 'Toutes les régions' },
    ...regions.map(r => ({ value: r, label: r })),
  ]

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-start justify-between gap-4 mb-1">
          <PageTitle icon={Landmark}>Prospects REQ</PageTitle>
          <button onClick={() => load()} disabled={loading} className="btn-secondary btn-sm flex-shrink-0" data-testid="req-refresh">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Actualiser
          </button>
        </div>
        <p className="text-sm text-slate-500 mb-4 max-w-3xl">
          Entreprises du Registre des entreprises du Québec dont l'activité déclarée est la culture
          en serre ou l'horticulture, encore immatriculées, et absentes de l'ERP.
          {status?.total ? ` Miroir local : ${status.total.toLocaleString('fr-CA')} entreprise(s)` : ' Le registre n\'a pas encore été importé'}
          {status?.last_import ? `, importé le ${status.last_import.slice(0, 10)}.` : '.'}
        </p>

        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="relative flex-1 min-w-64">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={e => onSearch(e.target.value)}
              placeholder="Nom, NEQ, municipalité ou activité…"
              data-testid="req-prospects-search"
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400"
            />
          </div>
          {/* Le REQ ne publie pas de région administrative : la municipalité est
              la maille géographique la plus fine qui soit fiable. */}
          <div className="w-64">
            <SearchableSelect
              value={region}
              options={regionOptions}
              onChange={onRegion}
              placeholder="Toutes les régions"
              searchPlaceholder="Filtrer les régions…"
              className="input-field text-sm w-full"
              size="sm"
              testId="req-region-select"
            />
          </div>
          <span className="text-xs text-slate-400" data-testid="req-prospects-count">
            {total} prospect{total > 1 ? 's' : ''}
          </span>
        </div>

        {!loading && rows.length === 0 ? (
          <EmptyState
            icon={Sprout}
            title="Aucun prospect à afficher"
            description={status?.total
              ? "Aucune entreprise horticole du registre ne reste sans correspondance dans l'ERP avec ces filtres."
              : "Le registre n'a pas encore été importé — lancer l'automation « Registre des entreprises du Québec »."}
          />
        ) : (
          <div className="card overflow-hidden" data-testid="req-prospects-table">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-2.5">Entreprise (registre)</th>
                  <th className="px-4 py-2.5 w-32">NEQ</th>
                  <th className="px-4 py-2.5 w-44">Municipalité</th>
                  <th className="px-4 py-2.5">Activité déclarée</th>
                  <th className="px-4 py-2.5 w-32">Immatriculée</th>
                  <th className="px-4 py-2.5 w-52" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(r => {
                  const done = created[r.neq]
                  return (
                    <tr key={r.neq} className="hover:bg-slate-50/70 transition-colors" data-testid={`req-prospect-row-${r.neq}`}>
                      <td className="px-4 py-2.5 text-slate-800">{r.nom_legal}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{r.neq}</td>
                      <td className="px-4 py-2.5 text-slate-600">{r.ville || <span className="text-slate-300">—</span>}</td>
                      <td className="px-4 py-2.5 text-slate-600">
                        {[r.code_activite, r.desc_activite].filter(Boolean).join(' — ') || <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-slate-500 text-xs">{r.date_immat || '—'}</td>
                      <td className="px-4 py-2.5 text-right">
                        {done ? (
                          // Règle « champs référence » : le record créé est un
                          // lien vers sa fiche, pas un simple libellé.
                          <span className="inline-flex items-center gap-2">
                            <Badge color="green" size="xs">Créée</Badge>
                            <Link to={`/companies/${done.company_id}`} className="text-brand-600 hover:underline inline-flex items-center gap-1 text-xs">
                              Ouvrir la fiche <ExternalLink size={11} />
                            </Link>
                          </span>
                        ) : (
                          <button
                            onClick={() => createProspect(r)}
                            disabled={creating === r.neq}
                            className="btn-primary btn-sm"
                            data-testid={`req-create-${r.neq}`}
                          >
                            <UserPlus size={13} />
                            {creating === r.neq ? 'Création…' : 'Créer la compagnie + le projet'}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Attribution obligatoire (CC BY) + rappel de la restriction « pas
            d'utilisation commerciale », qui pèse précisément sur cet écran. */}
        <ReqSourceNotice commercial className="mt-4 max-w-3xl" />
      </div>
    </Layout>
  )
}
