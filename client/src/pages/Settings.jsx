import { useState } from 'react'
import { Link } from 'react-router-dom'
import { SlidersHorizontal, FolderOpen, ExternalLink, Check, Search, BookOpen } from 'lucide-react'
import { Layout } from '../components/Layout.jsx'
import { useAuth } from '../lib/auth.jsx'
import { useNavPrefs } from '../lib/navPrefs.jsx'
import { defaultNavItems } from '../lib/navItems.js'
import QuickBooksAccountCard from '../components/QuickBooksAccountCard.jsx'

// Sections de la page Paramètres perso. Shell extensible : ajouter une entrée
// ici + un bloc de rendu dans <SettingsContent>.
const SECTIONS = [
  { key: 'menu',    label: 'Menu de gauche', icon: SlidersHorizontal },
  { key: 'quickbooks', label: 'QuickBooks',  icon: BookOpen },
  { key: 'fichiers', label: 'Fichiers',       icon: FolderOpen },
]

// Checkbox « visible » : cochée = item affiché dans la sidebar.
function VisibilityCheckbox({ checked, disabled, label, Icon, onChange, indent, testid }) {
  return (
    <label
      data-testid={testid}
      className={`flex items-center gap-2.5 py-1.5 rounded-md cursor-pointer select-none
        ${indent ? 'pl-7 pr-2' : 'px-2'}
        ${disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-slate-50'}`}
    >
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span
        className={`w-4 h-4 flex-shrink-0 rounded border flex items-center justify-center transition-colors
          ${checked ? 'bg-brand-600 border-brand-600 text-white' : 'bg-white border-slate-300'}`}
      >
        {checked && <Check size={12} strokeWidth={3} />}
      </span>
      {Icon && <Icon size={15} className="flex-shrink-0 text-slate-500" />}
      <span className="text-sm text-slate-700">{label}</span>
    </label>
  )
}

function MenuSection() {
  const { user } = useAuth()
  const { isHidden, toggle } = useNavPrefs()
  const isHR = ['admin', 'rh'].includes(user?.role)
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const matches = (label) => label.toLowerCase().includes(q)

  // On ne propose que ce que l'utilisateur peut voir (filtrage de rôle d'abord),
  // puis on applique la recherche : un item correspond si son label matche ; un
  // groupe est conservé si son nom matche (tous ses items) ou si au moins un de
  // ses items matche (seulement ceux-ci).
  const sections = defaultNavItems
    .map((item) => {
      if (!item.group) {
        if (q && !matches(item.label)) return null
        return item
      }
      const visible = item.items.filter((i) => !i.hrOnly || isHR)
      if (visible.length === 0) return null
      if (!q || matches(item.group)) return { ...item, items: visible }
      const items = visible.filter((i) => matches(i.label))
      if (items.length === 0) return null
      return { ...item, items }
    })
    .filter(Boolean)

  return (
    <div>
      <h2 className="text-lg font-semibold text-slate-900">Menu de gauche</h2>
      <p className="text-sm text-slate-500 mt-1 mb-4">
        Choisis ce qui s'affiche dans ta barre de navigation. Décocher un élément le retire
        du menu — la page reste accessible par la recherche (⌘K) ou son lien direct.
      </p>

      <div className="max-w-md">
        <div className="relative mb-3">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher un élément…"
            data-testid="nav-search"
            className="w-full pl-8 pr-3 py-2 rounded-md border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500"
          />
        </div>

        {sections.length === 0 && (
          <p className="text-sm text-slate-400 py-4 text-center" data-testid="nav-search-empty">
            Aucun élément ne correspond à « {query} ».
          </p>
        )}

        <div className="space-y-1">
        {sections.map((item) => {
          if (!item.group) {
            const key = item.to
            return (
              <VisibilityCheckbox
                key={key}
                checked={!isHidden(key)}
                Icon={item.icon}
                label={item.label}
                onChange={() => toggle(key)}
                testid={`nav-toggle-${key}`}
              />
            )
          }

          const groupKey = `group:${item.group}`
          const groupHidden = isHidden(groupKey)
          return (
            <div key={groupKey} className="pt-2">
              <VisibilityCheckbox
                checked={!groupHidden}
                Icon={item.icon}
                label={item.group}
                onChange={() => toggle(groupKey)}
                testid={`nav-toggle-${groupKey}`}
              />
              <div className="mt-0.5 border-l border-slate-100 ml-3">
                {item.items.map((sub) => (
                  <VisibilityCheckbox
                    key={sub.to}
                    indent
                    checked={!groupHidden && !isHidden(sub.to)}
                    disabled={groupHidden}
                    Icon={sub.icon}
                    label={sub.label}
                    onChange={() => toggle(sub.to)}
                    testid={`nav-toggle-${sub.to}`}
                  />
                ))}
              </div>
            </div>
          )
        })}
        </div>
      </div>
    </div>
  )
}

function QuickBooksSection() {
  return (
    <div>
      <h2 className="text-lg font-semibold text-slate-900">Mon compte QuickBooks</h2>
      <p className="text-sm text-slate-500 mt-1 mb-5 max-w-xl">
        Connectez votre propre compte QuickBooks pour que les écritures, factures et
        dépôts que vous publiez depuis l'ERP soient attribués à <strong>votre nom</strong> dans
        l'« Historique de vérification » de QuickBooks (Plus → Historique de vérification),
        au lieu du compte principal. Vous serez redirigé vers QuickBooks pour vous
        connecter avec vos identifiants — choisissez bien la même entreprise (Orisha).
      </p>
      <div className="max-w-xl">
        <QuickBooksAccountCard />
      </div>
    </div>
  )
}

function FichiersSection() {
  return (
    <div>
      <h2 className="text-lg font-semibold text-slate-900">Fichiers</h2>
      <p className="text-sm text-slate-500 mt-1 mb-5">
        Gère les fichiers publics partageables (liens courts).
      </p>
      <Link
        to="/public-files"
        data-testid="settings-public-files-link"
        className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 transition-colors"
      >
        <FolderOpen size={16} />
        Ouvrir les fichiers publics
        <ExternalLink size={14} className="opacity-70" />
      </Link>
    </div>
  )
}

export default function Settings() {
  const [section, setSection] = useState('menu')

  return (
    <Layout>
      <div className="flex h-full overflow-hidden">
        {/* Sections */}
        <div className="w-60 flex-shrink-0 bg-white border-r border-slate-200 flex flex-col overflow-hidden">
          <div className="px-4 pt-5 pb-3 border-b border-slate-100">
            <h1 className="text-base font-bold text-slate-900">Paramètres</h1>
            <p className="text-xs text-slate-400 mt-0.5">Préférences de ton compte</p>
          </div>
          <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setSection(s.key)}
                data-testid={`settings-section-${s.key}`}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm transition-colors
                  ${section === s.key
                    ? 'bg-brand-50 text-brand-700 font-medium'
                    : 'text-slate-600 hover:bg-slate-50'}`}
              >
                <s.icon size={15} className="flex-shrink-0" />
                {s.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Contenu */}
        <div className="flex-1 overflow-y-auto bg-slate-50">
          <div className="max-w-3xl mx-auto px-8 py-8">
            {section === 'menu' && <MenuSection />}
            {section === 'quickbooks' && <QuickBooksSection />}
            {section === 'fichiers' && <FichiersSection />}
          </div>
        </div>
      </div>
    </Layout>
  )
}
