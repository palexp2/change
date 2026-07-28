import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  Network, ChevronDown, ChevronRight, Search, Server, Database,
  Plug, Layers, ShieldCheck, UserCog, ExternalLink, FileCode, Map,
} from 'lucide-react'
import { Layout } from '../components/Layout.jsx'
import { architectureManifest as M } from '../lib/architectureManifest.js'
import { fmtDate } from '../lib/formatDate.js'

// Page « Architecture » — carte mentale (mind map) du fonctionnement de l'app.
// Données : client/src/lib/architectureManifest.js, généré depuis la structure
// réelle (App.jsx, navItems.js, server/index.js, schema.js) par
// scripts/gen-architecture.mjs au build. Re-builder pour rafraîchir la carte.

function StatCard({ icon: Icon, value, label }) {
  return (
    <div className="flex items-center gap-3 bg-white rounded-xl border border-slate-200 px-4 py-3 shadow-sm">
      <span className="w-9 h-9 rounded-lg bg-brand-50 ring-1 ring-brand-200 flex items-center justify-center flex-shrink-0">
        <Icon size={17} className="text-brand-600" />
      </span>
      <div>
        <div className="text-xl font-bold text-slate-900 leading-none">{value}</div>
        <div className="text-xs text-slate-500 mt-1">{label}</div>
      </div>
    </div>
  )
}

function PermBadge({ adminOnly, hrOnly }) {
  if (adminOnly) return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-rose-50 text-rose-600 ring-1 ring-inset ring-rose-200" title="Réservé aux admins">
      <ShieldCheck size={10} /> admin
    </span>
  )
  if (hrOnly) return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-50 text-violet-600 ring-1 ring-inset ring-violet-200" title="Réservé RH / admin">
      <UserCog size={10} /> RH
    </span>
  )
  return null
}

// Feuille = une page. Affiche label, chemin, composant, mount API deviné, et
// badge de permission. Le label est un lien de navigation vers la page.
function PageLeaf({ page }) {
  return (
    <div className="group flex items-start gap-2 py-1.5 pl-4 relative">
      {/* connecteur en L */}
      <span className="absolute left-0 top-0 bottom-1/2 w-px bg-slate-200" aria-hidden="true" />
      <span className="absolute left-0 top-1/2 w-3 h-px bg-slate-200" aria-hidden="true" />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 ml-3">
        <Link
          to={page.to}
          className="text-sm font-medium text-slate-700 hover:text-brand-700 hover:underline"
        >
          {page.label}
        </Link>
        <code className="text-[11px] text-slate-400 font-mono">{page.to}</code>
        <PermBadge adminOnly={page.adminOnly} hrOnly={page.hrOnly} />
        {page.component && (
          <span className="inline-flex items-center gap-1 text-[10px] text-slate-400" title="Composant React">
            <FileCode size={10} /> {page.component}
          </span>
        )}
        {page.api && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-100 text-slate-500" title="Route API correspondante (estimation)">
            <Server size={10} /> {page.api}
          </span>
        )}
      </div>
    </div>
  )
}

function GroupBranch({ group, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 transition-colors"
      >
        {open ? <ChevronDown size={15} className="text-slate-400" /> : <ChevronRight size={15} className="text-slate-400" />}
        <span className="font-semibold text-slate-800 text-sm">{group.group}</span>
        <span className="ml-auto text-xs text-slate-400">{group.items.length} pages</span>
      </button>
      {open && (
        <div className="ml-5 mt-1 pl-3 border-l border-slate-200">
          {group.items.map(p => <PageLeaf key={p.to} page={p} />)}
        </div>
      )}
    </div>
  )
}

function InventoryList({ icon: Icon, title, items, render, hint }) {
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    if (!q.trim()) return items
    const t = q.toLowerCase()
    return items.filter(it => String(render ? render(it) : it).toLowerCase().includes(t))
  }, [q, items, render])
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
        <Icon size={16} className="text-brand-600" />
        <h3 className="font-semibold text-slate-800 text-sm">{title}</h3>
        <span className="text-xs text-slate-400">{items.length}</span>
      </div>
      {hint && <p className="px-4 pt-2 text-xs text-slate-400">{hint}</p>}
      <div className="px-4 py-2">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Filtrer…"
            className="w-full pl-8 pr-2 py-1.5 text-xs rounded-md border border-slate-200 focus:outline-none focus:ring-1 focus:ring-brand-400"
          />
        </div>
      </div>
      <div className="px-4 pb-4 flex flex-wrap gap-1.5 overflow-y-auto max-h-72">
        {filtered.map((it, i) => (
          <span key={i} className="px-2 py-1 rounded-md text-[11px] font-mono bg-slate-50 text-slate-600 border border-slate-200">
            {render ? render(it) : it}
          </span>
        ))}
        {filtered.length === 0 && <span className="text-xs text-slate-400 py-2">Aucun résultat</span>}
      </div>
    </div>
  )
}

const TABS = [
  { key: 'map', label: 'Carte des modules', icon: Map },
  { key: 'inventory', label: 'Inventaire technique', icon: Layers },
]

export function ArchitectureContent() {
  const [tab, setTab] = useState('map')

  return (
    <div className="p-6 max-w-6xl mx-auto">
        <div className="flex items-start justify-between gap-3 mb-6 flex-wrap">
          <div className="flex items-start gap-3">
            <span className="w-11 h-11 rounded-xl bg-brand-50 ring-1 ring-brand-200 flex items-center justify-center flex-shrink-0">
              <Network size={22} className="text-brand-600" />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Architecture</h1>
              <p className="text-sm text-slate-500 mt-1">
                Carte du fonctionnement de l'app : pages ↔ routes API ↔ connecteurs ↔ tables.
                Générée depuis le code, le <span className="font-medium">{fmtDate(M.generatedAt)}</span>.
              </p>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
          <StatCard icon={Map}      value={M.stats.pages}      label="Pages" />
          <StatCard icon={Network}  value={M.stats.groups}     label="Domaines" />
          <StatCard icon={Server}   value={M.stats.api}        label="Mounts API" />
          <StatCard icon={Database} value={M.stats.tables}     label="Tables DB" />
          <StatCard icon={Plug}     value={M.stats.connectors} label="Connecteurs" />
          <StatCard icon={Layers}   value={M.stats.routes}     label="Routes" />
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 mb-5 border-b border-slate-200">
          {TABS.map(t => (
            <button
              key={t.key}
              data-testid={`arch-tab-${t.key}`}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors
                ${tab === t.key
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'}`}
            >
              <t.icon size={15} /> {t.label}
            </button>
          ))}
        </div>

        {tab === 'map' && (
          <div className="flex gap-4 items-start" data-testid="arch-map">
            {/* Noeud racine */}
            <div className="hidden md:flex flex-col items-center pt-3 flex-shrink-0">
              <div className="px-4 py-3 rounded-xl bg-brand-600 text-white shadow-md text-center">
                <div className="font-bold text-sm">ERP Orisha</div>
                <div className="text-[10px] text-brand-100">single-tenant</div>
              </div>
              <div className="w-px flex-1 bg-slate-200 mt-1" aria-hidden="true" />
            </div>

            {/* Branches = domaines (groupes du menu) */}
            <div className="flex-1 space-y-2 min-w-0">
              {M.groups.map((g, i) => (
                <GroupBranch key={g.group} group={g} defaultOpen={i === 0} />
              ))}

              {/* Pages à plat (hors groupe) */}
              {M.flat.length > 0 && (
                <div className="relative">
                  <div className="px-3 py-2 rounded-lg bg-slate-50 border border-slate-200">
                    <span className="font-semibold text-slate-800 text-sm">Pages générales</span>
                    <span className="ml-2 text-xs text-slate-400">{M.flat.length}</span>
                  </div>
                  <div className="ml-5 mt-1 pl-3 border-l border-slate-200">
                    {M.flat.map(p => <PageLeaf key={p.to} page={p} />)}
                  </div>
                </div>
              )}

              {/* Liens externes */}
              {M.externals.length > 0 && (
                <div className="pl-3 pt-2">
                  {M.externals.map(e => (
                    <a key={e.href} href={e.href} target="_blank" rel="noopener noreferrer"
                       className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-brand-700">
                      <ExternalLink size={13} /> {e.label}
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'inventory' && (
          <div className="space-y-4" data-testid="arch-inventory">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <InventoryList
                icon={Server} title="Mounts API (Express)" items={M.api}
                hint="Routeurs montés dans server/src/index.js — base /erp/api."
              />
              <InventoryList
                icon={Database} title="Tables (SQLite)" items={M.tables}
                hint="CREATE TABLE de server/src/db/schema.js."
              />
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <InventoryList
                icon={Plug} title="Connecteurs OAuth / externes" items={M.connectors}
                hint="server/src/connectors/ — intégrations transitoires (objectif : ne garder que l'app + Stripe)."
              />
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
                  <FileCode size={16} className="text-brand-600" />
                  <h3 className="font-semibold text-slate-800 text-sm">Pages hors menu</h3>
                  <span className="text-xs text-slate-400">{M.offMenu.length}</span>
                </div>
                <p className="px-4 pt-2 text-xs text-slate-400">
                  Fiches détail, pages admin et redirections — accessibles par navigation, pas dans la sidebar.
                </p>
                <div className="px-4 pb-4 pt-2 space-y-1 overflow-y-auto max-h-72">
                  {M.offMenu.map(p => (
                    <div key={p.to} className="flex flex-wrap items-center gap-2">
                      <code className="text-[11px] text-slate-500 font-mono">{p.to}</code>
                      <span className="text-[11px] text-slate-400">{p.component}</span>
                      <PermBadge adminOnly={p.adminOnly} hrOnly={p.hrOnly} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
  )
}

export default function Architecture() {
  return (
    <Layout>
      <ArchitectureContent />
    </Layout>
  )
}
