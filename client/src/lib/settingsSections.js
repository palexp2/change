import {
  SlidersHorizontal, MapPin, BookOpen,
  Server, Users, Plug, Activity, Network, Trash2, Mail,
} from 'lucide-react'

// Sections de la page Paramètres (/parametres) — source unique de vérité. Elles
// ne s'affichent que DANS la page : le menu de gauche n'en montre rien, il faut
// cliquer la roue dentée pour les voir.
//
// `adminOnly` : la section n'existe que pour un admin — ni dans la colonne de
// gauche de la page, ni comme URL directe.
// `full` : la section occupe toute la largeur disponible (tableaux à colonnes
// nombreuses) au lieu d'être centrée dans une colonne bornée.
export const SETTINGS_ROUTE = '/parametres'

export const SETTINGS_SECTIONS = [
  { key: 'menu',        label: 'Menu de gauche', icon: SlidersHorizontal, group: 'Mon compte' },
  { key: 'adresses',    label: 'Adresses',       icon: MapPin,            group: 'Mon compte' },
  { key: 'gmail',       label: 'Gmail',          icon: Mail,              group: 'Mon compte' },
  { key: 'quickbooks',  label: 'QuickBooks',     icon: BookOpen,          group: 'Mon compte' },
  { key: 'systeme',     label: 'Système',        icon: Server,   group: 'Administration', adminOnly: true },
  { key: 'utilisateurs', label: 'Utilisateurs',  icon: Users,    group: 'Administration', adminOnly: true, full: true },
  { key: 'connecteurs', label: 'Connecteurs',    icon: Plug,     group: 'Administration', adminOnly: true },
  { key: 'activite',    label: 'Activité',       icon: Activity, group: 'Administration', adminOnly: true },
  { key: 'architecture', label: 'Architecture',  icon: Network,  group: 'Administration', adminOnly: true },
  { key: 'corbeille',   label: 'Corbeille',      icon: Trash2,   group: 'Administration', adminOnly: true },
]

export function settingsSectionsFor(isAdmin) {
  return SETTINGS_SECTIONS.filter(s => !s.adminOnly || isAdmin)
}
