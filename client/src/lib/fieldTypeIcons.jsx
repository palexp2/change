import {
  Type, AlignLeft, Hash, DollarSign, Timer, Calendar, CalendarClock, Clock,
  Link2, Table2, Phone, CheckSquare, CircleChevronDown, Tags, Search, Sigma,
  SquareFunction, MousePointerClick, User, UserCog, Paperclip,
} from 'lucide-react'

// Icônes des types de champ — un pictogramme par type, partagé partout où un
// type de champ est nommé (page /champs/:table, modale de champ). Le but est de
// reconnaître un type d'un coup d'œil sans lire son libellé, comme le fait
// Airtable dans son en-tête de colonne.
//
// Le vocabulaire est celui unifié des champs (custom_fields) : `type` pour les
// champs « donnée », `kind` pour les champs virtuels (formule, lookup, rollup,
// bouton, auto). fieldIconKey() ci-dessous ramène n'importe quelle définition de
// champ à UNE clé de cette table.

const ICONS = {
  // Champs « donnée »
  text:               Type,
  long_text:          AlignLeft,
  number:             Hash,
  currency:           DollarSign,
  duration:           Timer,
  date:               Calendar,
  datetime:           CalendarClock,
  // 'boolean' = même chose que 'checkbox' sous l'ancien nom (cf. normalizeFieldType).
  checkbox:           CheckSquare,
  boolean:            CheckSquare,
  url:                Link2,
  phone:              Phone,
  single_select:      CircleChevronDown,
  multi_select:       Tags,
  attachment:         Paperclip,
  user:               User,
  // Lien vers une autre table (champ perso kind='link', type Airtable 'link').
  link:               Table2,
  // Champ lien importé d'Airtable : même pictogramme, c'est le même objet vu
  // par l'utilisateur (la colonne porte l'id du record lié).
  airtable_link:      Table2,
  // Champs virtuels
  formula:            SquareFunction,
  lookup:             Search,
  rollup:             Sigma,
  button:             MousePointerClick,
  // Champs auto-remplis. 'auto' / 'data' sont les familles de champ proposées à
  // la création (kind), pas des types de valeur : leur icône est celle de leur
  // cas le plus courant.
  auto:               Clock,
  data:               Type,
  created_time:       Clock,
  last_modified_time: Clock,
  created_by:         UserCog,
  last_modified_by:   UserCog,
}

// Clé d'icône d'une définition de champ. Un champ virtuel est reconnu à son
// `kind` (une formule qui rend une date reste une formule) ; un champ « donnée »
// à son `type`. Accepte aussi une simple chaîne de type.
export function fieldIconKey(field) {
  if (!field) return 'text'
  // `link:<table>` — champ natif affiché en lien vers la fiche d'une autre
  // table (cf. linkTargetOfType, fieldOverrides.jsx) : même icône que 'link'.
  if (typeof field === 'string' && field.startsWith('link:')) return 'link'
  if (typeof field === 'string') return ICONS[field] ? field : 'text'
  const kind = field.kind
  if (kind && kind !== 'data' && ICONS[kind]) return kind
  const type = field.type
  return ICONS[type] ? type : 'text'
}

// Composant d'icône d'un type de champ. `type` accepte une clé de type, un
// `kind`, ou une définition de champ complète ({ kind, type }).
// Décoratif par défaut (aria-hidden) : le libellé du type l'accompagne toujours.
export function FieldTypeIcon({ type, size = 13, className = '', ...rest }) {
  const key = fieldIconKey(type)
  const Icon = ICONS[key] || Type
  return (
    <Icon
      size={size}
      aria-hidden={rest.title ? undefined : 'true'}
      data-field-type={key}
      className={`flex-shrink-0 ${className}`}
      {...rest}
    />
  )
}
