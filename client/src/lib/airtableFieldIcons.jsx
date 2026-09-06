import {
  Type, AlignLeft, Pilcrow, Mail, Link, Link2, Phone, Hash, DollarSign, Percent,
  Clock, Star, CheckSquare, CircleChevronDown, Tags, Calendar, CalendarClock,
  CalendarPlus, Paperclip, Barcode, FunctionSquare, Sigma, ListOrdered, ArrowUp01,
  Search, User, Users, UserPlus, UserCheck, MousePointerClick, RefreshCw,
  Sparkles, CircleHelp,
} from 'lucide-react'

// Type de champ Airtable (nom brut de l'API : `singleLineText`, `rollup`…) →
// icône + libellé français. Les listes de mapping affichent l'icône seule : le
// nom du champ Airtable a besoin de toute la largeur de la cellule, et
// « (multipleLookupValues) » collé derrière ne disait rien de plus qu'un
// pictogramme. Le libellé reste dans l'infobulle et sert à la recherche.
//
// Les icônes suivent d'aussi près que possible celles d'Airtable (A pour un
// texte, # pour un nombre, trombone pour une pièce jointe, f(x) pour une
// formule…), dans les limites du jeu lucide-react.
const AIRTABLE_TYPES = {
  singleLineText:       [Type, 'Texte'],
  multilineText:        [AlignLeft, 'Texte long'],
  richText:             [Pilcrow, 'Texte enrichi'],
  email:                [Mail, 'Courriel'],
  url:                  [Link, 'URL'],
  phoneNumber:          [Phone, 'Téléphone'],
  number:               [Hash, 'Nombre'],
  currency:             [DollarSign, 'Devise'],
  percent:              [Percent, 'Pourcentage'],
  duration:             [Clock, 'Durée'],
  rating:               [Star, 'Évaluation'],
  checkbox:             [CheckSquare, 'Case'],
  singleSelect:         [CircleChevronDown, 'Choix unique'],
  multipleSelects:      [Tags, 'Choix multiple'],
  date:                 [Calendar, 'Date'],
  dateTime:             [CalendarClock, 'Date et heure'],
  createdTime:          [CalendarPlus, 'Date de création'],
  lastModifiedTime:     [CalendarClock, 'Date de modification'],
  multipleRecordLinks:  [Link2, 'Lien vers un enregistrement'],
  multipleAttachments:  [Paperclip, 'Pièce jointe'],
  barcode:              [Barcode, 'Code-barres'],
  formula:              [FunctionSquare, 'Formule'],
  rollup:               [Sigma, 'Cumul'],
  count:                [ListOrdered, 'Compte'],
  autoNumber:           [ArrowUp01, 'Numéro auto'],
  lookup:               [Search, 'Recherche'],
  multipleLookupValues: [Search, 'Recherche'],
  singleCollaborator:   [User, 'Collaborateur'],
  multipleCollaborators: [Users, 'Collaborateurs'],
  createdBy:            [UserPlus, 'Créé par'],
  lastModifiedBy:       [UserCheck, 'Modifié par'],
  button:               [MousePointerClick, 'Bouton'],
  externalSyncSource:   [RefreshCw, 'Source synchronisée'],
  aiText:               [Sparkles, 'Texte IA'],
}

// Libellé lisible d'un type Airtable — infobulle et recherche. Un type inconnu
// (Airtable en ajoute) se rend tel quel plutôt que de disparaître.
export function airtableTypeLabel(type) {
  return AIRTABLE_TYPES[type]?.[1] || type || ''
}

export function AirtableTypeIcon({ type, size = 12, className = '' }) {
  const Icon = AIRTABLE_TYPES[type]?.[0] || CircleHelp
  return (
    <Icon
      size={size}
      className={`flex-shrink-0 text-slate-400 ${className}`}
      aria-hidden="true"
    />
  )
}
