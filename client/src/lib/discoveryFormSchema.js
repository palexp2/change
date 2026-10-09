import { normalizeQuestionImage } from './discoveryQuestionImages.js'
import { EN_TEXTS, translate, normalizeLang } from './discoveryFormI18n.js'
// Schéma éditable du formulaire de découverte technique (System builder).
//
// Le formulaire public (pages/CustomerPostPayment.jsx) ne porte plus ses
// libellés en dur : il les lit ici. L'éditeur (pages/DiscoveryFormEditor.jsx)
// écrit un *calque de surcharges* persisté par /api/discovery-form-schema, que
// la page publique reçoit dans son payload (champ `form_schema`).
//
// Invariant : la valeur (`value`) d'un choix livré par le code — type de
// commande, accès réseau, type de tuyau… — n'est jamais réécrite : le code
// s'appuie dessus, et les réponses déjà enregistrées la portent. En revanche
// un tel choix peut être **retiré** de la liste (marqueur `{ value, removed }`
// dans le calque) et de **nouveaux** choix peuvent être ajoutés (entrées dont
// la valeur n'existe pas dans les defaults, ajoutées après ceux-ci).
// Le calque est fusionné par valeur : une option ajoutée plus tard dans le code
// apparaît même si un calque existe déjà.
//
// Ce que l'utilisateur peut faire sans toucher au code :
//   - réécrire n'importe quel titre, question, aide ou libellé de choix ;
//   - ajouter / retirer des choix de réponse à une question ;
//   - masquer les questions facultatives (marquées `hideable`) ;
//   - ajouter ses propres questions dans n'importe quelle section.

export const DEFAULT_TEXTS = {
  'header.title': 'Formulaire technique',

  'order_type.title': 'Type de commande',
  'order_type.prompt': 'Cette commande est pour :',
  'controller_distance.title': 'Contrôleur central existant',
  'controller_distance.prompt': 'À quelle distance du contrôleur central seront situées la/les serres à automatiser ?',
  'controller_distance.near': 'Aucun nouveau contrôleur central à fournir.',
  'controller_distance.far': 'Un nouveau contrôleur central sera fourni. Vos contrôleurs centraux devront être programmés en mode multi-contrôleurs.',
  'wind_sensor.title': 'Capteur de vent',
  'wind_sensor.prompt': 'Avez-vous besoin d’un capteur de vent ?',

  'farm.title': 'Adresse de la ferme',
  'farm.help': 'Cette adresse sert à pré-programmer le contrôleur central avec les coordonnées géographiques de votre ferme.',

  'shipping.title': 'Adresse de livraison',
  'shipping.prompt_new': "L'adresse de livraison est-elle la même que celle de la ferme ?",
  'shipping.same_yes': 'Oui, même adresse',
  'shipping.same_no': 'Non, différente',
  'shipping.prompt_existing': "Confirmez l'adresse de livraison :",

  'network.title': 'Accès réseau',
  'network.prompt': 'Aurez-vous une connexion Internet stable à moins de 250 pi de la serre, avec une ligne de vue directe ?',
  'network.wifi_prompt': 'Pour pré-programmer le contrôleur central, fournissez les infos Wi-Fi :',
  'network.wifi_ssid_label': 'Nom du Wi-Fi (SSID)',
  'network.wifi_password_label': 'Mot de passe',

  'greenhouses.count_title': 'Serres à automatiser',
  'greenhouses.count_label': 'Combien de serres voulez-vous automatiser avec Orisha ?',

  'greenhouse.length_label': 'Longueur de la serre (pi)',
  'greenhouse.side_vents_count_label': 'Combien de côtés ouvrants à automatiser ?',
  'greenhouse.side_vent_type_label': 'Type de côté ouvrant',
  'greenhouse.motors_label': 'Avez-vous déjà les moteurs ?',
  'greenhouse.side_vent_height_label': 'Hauteur des côtés ouvrants (pi)',
  'greenhouse.side_pipe_type_label': 'Type de tuyau de côté',
  'greenhouse.guide_pipes_label': 'Avez-vous des tuyaux de 1 po à 1 ⁵⁄₁₆ po de diamètre qui peuvent servir de tuyaux guides ?',
  'greenhouse.diameter_other_label': 'Diamètre externe',

  'louvers.title': 'Louvres',
  'roofs.present': 'Est-ce que cette serre a un toit ouvrant ?',
  'roofs.present_count': 'Combien de toits ouvrants possède cette serre ?',
  'roofs.count': 'Nombre de toits ouvrants à automatiser',
  'roofs.voltage': 'Quelle est la tension du moteur du toit ouvrant ?',
  'roofs.inverter': 'Avez-vous déjà votre inverseur pour le toit ouvrant ?',
  'roofs.ridder': 'Est-ce un moteur Ridder RW240, 240 V, 1 phase, 5 fils ?',
  'roofs.inverter_model': 'Quelle est la marque et le modèle de votre inverseur ?',
  'roofs.brand': 'Marque de l’inverseur',
  'roofs.model': 'Modèle de l’inverseur',
  'roofs.supply_possible': 'Orisha peut peut-être fournir l’inverseur pour ce moteur. La disponibilité et la compatibilité seront à confirmer avec notre équipe.',
  'roofs.supply_customer': 'Vous devez fournir l’inverseur pour ce moteur. Orisha peut seulement envisager de le fournir pour un moteur 24 V DC ou un moteur Ridder RW240, 240 V, 1 phase, 5 fils.',
  'screens.present': 'Est-ce que cette serre a une toile thermique ?',
  'screens.present_count': 'Combien de toiles thermiques possède cette serre ?',
  'screens.count': 'Nombre de toiles thermiques à automatiser',
  'screens.voltage': 'Quelle est la tension du moteur de la toile thermique ?',
  'screens.inverter': 'Avez-vous déjà votre inverseur pour la toile thermique ?',
  'screens.ridder': 'Est-ce un moteur Ridder RW240, 240 V, 1 phase, 5 fils ?',
  'screens.inverter_model': 'Quelle est la marque et le modèle de votre inverseur ?',
  'screens.brand': 'Marque de l’inverseur',
  'screens.model': 'Modèle de l’inverseur',
  'screens.supply_possible': 'Orisha peut peut-être fournir l’inverseur pour ce moteur. La disponibilité et la compatibilité seront à confirmer avec notre équipe.',
  'screens.supply_customer': 'Vous devez fournir l’inverseur pour ce moteur. Orisha peut seulement envisager de le fournir pour un moteur 24 V DC ou un moteur Ridder RW240, 240 V, 1 phase, 5 fils.',

  'louvers.present': 'Combien de louvres à automatiser dans cette serre ?',
  'louvers.type': 'Comment cette louvre est-elle commandée ?',
  'louvers.fan': 'Un ventilateur est-il associé à cette louvre ?',
  'louvers.fan_unavailable': 'Orisha ne propose pas de contrôle séparé pour ce ventilateur. Configuration à vérifier.',
  'chief.furnaces_heading': 'Fournaises',
  'chief.has_furnaces_label': 'Cette serre a-t-elle des fournaises à automatiser ?',
  'chief.furnaces_count_label': 'Combien y a-t-il de fournaises à automatiser dans cette serre:',
  'chief.num_furnaces_label': 'Nombre de fournaises dans cette serre',
  'chief.irrigation_heading': 'Irrigation',
  'chief.irrigation_zones_label': "Combien de zones d'irrigation pour cette serre ?",
  'chief.orisha_valves_label': "Souhaitez-vous qu'Orisha fournisse les valves 1 po ?",

  'furnace.dry_contact_label': 'Votre fournaise peut-elle être activée avec un thermostat mural ordinaire ?',
  'furnace.brand_label': 'Marque',
  'furnace.model_label': 'Modèle',
  'furnace.wire_label': 'Filage de contrôle requis ? (pieds)',
  'furnace.wire_help': 'Pensez à inclure les longueurs verticales (monter, traverser une porte, redescendre) — pas seulement la distance horizontale.',
  'furnace.wire_feet_label': 'Nombre de pieds nécessaires',
  'furnace.thermostat_label': 'L’installation d’un thermostat de secours est fortement recommandée et nous pouvons vous en fournir un gratuitement.',

  'submit.label': 'Soumettre',
  'submit.incomplete': 'Complétez les champs obligatoires pour continuer',
  'submitted.title': 'Informations enregistrées',
  'submitted.text': 'Merci, nous avons bien reçu vos informations. Notre équipe va les utiliser pour préparer votre installation.',
  'prepare.title': 'À préparer dès maintenant',
  'prepare.panel': 'Installez un panneau de contreplaqué sur un mur intérieur de la serre pour y fixer les unités Orisha. Prévoyez au moins 4 pi².',
  'prepare.outlet': 'Le système Orisha a besoin de 5 A : prévoyez une prise de courant dans la serre.',
  'prepare.outlet_breaker': 'Le système Orisha a besoin de 5 A : prévoyez une prise de courant dans chaque serre et un disjoncteur double 15 A pour le toit ouvrant avec moteur Ridder RW240, 1 phase, 5 fils.',
  'prepare.pipe': 'Procurez-vous un tuyau de 1 à 1¾ po de diamètre, avec son ancrage.',
  'prepare.pipe_help': 'Il sert à fixer {capteurs}, au moins 2 pi au-dessus du point le plus haut de la serre.',
}

export const DEFAULT_CHOICES = {
  'roofs.voltage_options': [
    { value: '110', label: '110 V' },
    { value: '240', label: '240 V' },
    { value: '24_dc', label: '24 V DC' },
  ],
  'roofs.inverter_options': [
    { value: 'harnois_8ze141l', label: 'Harnois 8ZE141L' },
    { value: 'harnois_8ze142l', label: 'Harnois 8ZE142L' },
    { value: 'vre_mc21', label: 'VRE MC21' },
    { value: 'other', label: 'Autre' },
    { value: 'unknown', label: 'Je ne sais pas' },
  ],
  // Une louvre se décrit par une seule question illustrée : les combinaisons
  // offertes (voltage + commande) sont montrées en images, le voltage ne se
  // demande plus à part. Valeurs lues par `LOUVER_COMBOS`.
  'louvers.types': [
    { value: 'spring_110', label: 'Spring loaded 110 V' },
    { value: 'open_close_24', label: 'Piston ou moteur 24 V, signaux ouvrir/fermer' },
    { value: 'other', label: 'Je ne sais pas' },
  ],

  'order_type.options': [
    { value: 'new', label: 'Un nouveau site de production avec Orisha' },
    { value: 'add_to_existing', label: 'Ajouter à un site de production existant qui a déjà Orisha' },
  ],
  // Distance au contrôleur central déjà en place. `coax_350` porte la même
  // rallonge que côté réseau : l'antenne montée en hauteur gagne 100 pi, donc
  // aucun nouveau contrôleur central n'est à fournir jusqu'à 350 pi.
  'controller_distance.options': [
    { value: 'yes', label: '250 pi ou moins' },
    { value: 'coax_350', label: '350 pi — avec câble coaxial', help: 'Nous fournirons un câble coaxial pour monter l’antenne en hauteur (+100 pi de portée).' },
    { value: 'no', label: 'Plus de 350 pi' },
  ],
  'network.options': [
    { value: 'ethernet', label: 'Oui — câble Ethernet à moins de 250 pi' },
    { value: 'wifi_250', label: 'Oui — Wi-Fi à moins de 250 pi avec ligne de vue' },
    { value: 'wifi_350_coax', label: 'Non, mais 350 pi est possible — fournissez le câble coaxial', help: 'Nous fournirons un câble coaxial pour monter l’antenne en hauteur (+100 pi de portée).' },
    { value: 'mobile_controller', label: "Aucune des options ci-dessus — j'ai besoin d'un contrôleur internet mobile", help: "Nous l'ajouterons aux extras à la fin. Nécessite une bonne couverture cellulaire à l'endroit du contrôleur central." },
  ],
  'greenhouse.length_range_options': [
    { value: 'up_to_200', label: '200 pi ou moins' },
    { value: 'over_200', label: 'Plus de 200 pi' },
  ],
  // « Autre » : aucun matériel déduit, Orisha le choisit sur la fiche du système.
  'greenhouse.side_vent_type_options': [
    { value: 'rollup', label: 'Moteurs roll-up' },
    { value: 'other', label: 'Autre' },
  ],
  'greenhouse.motors_options': [
    { value: 'no', label: "J'ai besoin de moteurs" },
    { value: 'yes', label: "J'ai déjà mes moteurs" },
  ],
  'greenhouse.side_vent_height_range_options': [
    { value: 'up_to_6', label: '6 pi et moins' },
    { value: 'over_6', label: 'Plus de 6 pi' },
    { value: 'unknown', label: 'Je ne sais pas' },
  ],
  'greenhouse.side_pipe_type_options': [
    { value: 'steel_O', label: 'Acier (profil rond / O)' },
    { value: 'aluminum_C', label: 'Aluminium extrudé (profil C)' },
    { value: 'unknown', label: 'Je ne sais pas' },
  ],
  'greenhouse.guide_pipes_options': [
    { value: 'present', label: 'Oui' },
    { value: 'needed', label: 'Non' },
    { value: 'unknown', label: 'Je ne sais pas' },
  ],
  'chief.has_furnaces_options': [
    { value: 'yes', label: 'Oui, il y a des fournaises' },
    { value: 'no', label: 'Non, pas de fournaises' },
  ],
  'chief.orisha_valves_options': [
    { value: 'yes', label: 'Oui, fournir les valves 1 po' },
    { value: 'no', label: "Non, j'ai déjà mes valves" },
  ],
  // Le contact sec dit tout ce qu'il faut savoir de la fournaise. Marque et
  // modèle ne se demandent qu'à qui répond « Non » ou ne le sait pas.
  'furnace.dry_contact_options': [
    { value: 'yes', label: 'Oui' },
    { value: 'no', label: 'Non' },
    { value: 'unknown', label: 'Je ne sais pas' },
  ],
  'furnace.brand_options': [
    { value: 'Modine', label: 'Modine' },
    { value: 'Reznor', label: 'Reznor' },
    { value: 'LB White', label: 'LB White' },
    { value: 'Autre', label: 'Autre' },
  ],
  'furnace.wire_options': [
    { value: '25', label: '25 pi' },
    { value: '50', label: '50 pi' },
    { value: '75', label: '75 pi' },
    { value: '100', label: '100 pi' },
    { value: 'over_100', label: 'Plus de 100 pi' },
    { value: 'unknown', label: 'Je ne sais pas' },
  ],
  'furnace.thermostat_options': [
    { value: 'yes', label: 'J’ai besoin d’un thermostat de secours' },
    { value: 'no', label: 'J’ai déjà un thermostat de secours' },
  ],
}

// Sections où l'utilisateur peut déposer ses propres questions.
// `greenhouse` se répète sur chaque carte de serre, `greenhouse_chief` seulement
// sur les cartes Chef de culture.
export const CUSTOM_SECTIONS = [
  { id: 'intro', label: 'Tout en haut' },
  { id: 'order_type', label: 'Type de commande' },
  { id: 'farm_address', label: 'Adresse de la ferme' },
  { id: 'shipping_address', label: 'Adresse de livraison' },
  { id: 'network', label: 'Accès réseau' },
  { id: 'greenhouse', label: 'Chaque serre' },
  { id: 'greenhouse_chief', label: 'Serres Chef de culture seulement' },
  { id: 'end', label: 'Avant le bouton Soumettre' },
]

// Réponses du formulaire qui peuvent piloter l'affichage d'une question.
// `scope` dit où lire la réponse : racine du formulaire, ou carte de serre.
export const CONDITION_SOURCES = [
  { field: 'is_new_site', scope: 'form', label: 'Type de commande', choices: 'order_type.options' },
  { field: 'within_central_controller_range', scope: 'form', label: 'Serres à portée du contrôleur central', bool: true },
  { field: 'central_controller_distance', scope: 'form', label: 'Distance du contrôleur central', choices: 'controller_distance.options' },
  { field: 'needs_wind_sensor', scope: 'form', label: 'Besoin d’un capteur de vent', bool: true },
  { field: 'shipping_same_as_farm', scope: 'form', label: 'Livraison = ferme', bool: true },
  { field: 'network_access', scope: 'form', label: 'Accès réseau', choices: 'network.options' },
  { field: 'num_greenhouses', scope: 'form', label: 'Nombre de serres', number: true },
  { field: 'length', scope: 'greenhouse', label: 'Longueur de la serre', number: true },
  { field: 'has_side_vents', scope: 'greenhouse', label: 'Côtés ouvrants', bool: true },
  { field: 'side_vent_type', scope: 'greenhouse', label: 'Type de côté ouvrant', choices: 'greenhouse.side_vent_type_options' },
  { field: 'side_pipe_type', scope: 'greenhouse', label: 'Type de tuyau de côté', choices: 'greenhouse.side_pipe_type_options' },
  { field: 'guide_pipes_state', scope: 'greenhouse', label: 'Tuyaux guides', choices: 'greenhouse.guide_pipes_options' },
  { field: 'has_furnaces', scope: 'greenhouse', label: 'Fournaises', bool: true },
  { field: 'num_furnaces', scope: 'greenhouse', label: 'Nombre de fournaises', number: true },
  { field: 'irrigation_zones', scope: 'greenhouse', label: 'Zones d’irrigation', number: true },
  { field: 'needs_orisha_valves', scope: 'greenhouse', label: 'Valves Orisha', bool: true },
]

export const CONDITION_OPS = [
  { value: 'eq', label: 'est' },
  { value: 'ne', label: 'n’est pas' },
  { value: 'filled', label: 'est rempli', noValue: true },
  { value: 'empty', label: 'est vide', noValue: true },
  { value: 'gt', label: '>', numeric: true },
  { value: 'lt', label: '<', numeric: true },
]

export const CUSTOM_TYPES = [
  { value: 'text', label: 'Texte court' },
  { value: 'textarea', label: 'Texte long' },
  { value: 'number', label: 'Nombre' },
  { value: 'select', label: 'Liste de choix' },
  { value: 'radio', label: 'Boutons radio' },
  { value: 'yesno', label: 'Oui / Non' },
  { value: 'checkbox', label: 'Case à cocher' },
]

// Descripteurs pour l'éditeur : quoi montrer, dans quel ordre, sous quel titre
// (`short` : libellé de la barre de sections).
// `kind` : text | textarea | choices | group. `fixedValues` : les
// valeurs des choix sont portées par le code (renommer/retirer/ajouter, jamais
// renuméroter). `hideable` (kind group) : le bloc peut être retiré du
// formulaire sans casser la validation ; les items qui suivent jusqu'au
// prochain changement de sujet lui appartiennent, `under` étend ce lien.
export const SCHEMA_GROUPS = [
  {
    id: 'header', title: 'En-tête', short: 'En-tête', section: 'intro',
    items: [
      { id: 'header.title', kind: 'text', label: 'Titre' },
    ],
  },
  {
    id: 'order_type', title: 'Type de commande', short: 'Commande', section: 'order_type',
    items: [
      { id: 'order_type.title', kind: 'text', label: 'Titre' },
      { id: 'order_type.prompt', kind: 'text', label: 'Question' },
      { id: 'order_type.options', kind: 'choices', label: 'Choix', fixedValues: true },
      { id: 'controller_distance.title', kind: 'text', label: 'Titre (contrôleur existant)' },
      { id: 'controller_distance.prompt', kind: 'text', label: 'Question (distance du contrôleur)' },
      { id: 'controller_distance.options', kind: 'choices', label: 'Choix (distance du contrôleur)', fixedValues: true },
      { id: 'controller_distance.near', kind: 'text', label: 'Réponse à 250 pi ou moins' },
      { id: 'controller_distance.far', kind: 'textarea', label: 'Réponse au-delà de 250 pi' },
      { id: 'wind_sensor.title', kind: 'text', label: 'Titre (capteur de vent)' },
      { id: 'wind_sensor.prompt', kind: 'text', label: 'Question (capteur de vent)' },
    ],
  },
  {
    id: 'farm', title: 'Adresse de la ferme', short: 'Ferme', section: 'farm_address',
    items: [
      { id: 'farm.title', kind: 'text', label: 'Titre' },
      { id: 'farm.help', kind: 'textarea', label: 'Aide' },
    ],
  },
  {
    id: 'shipping', title: 'Adresse de livraison', short: 'Livraison', section: 'shipping_address',
    items: [
      { id: 'shipping.title', kind: 'text', label: 'Titre' },
      { id: 'shipping.prompt_new', kind: 'text', label: 'Question (nouveau site)' },
      { id: 'shipping.same_yes', kind: 'text', label: 'Choix « même »' },
      { id: 'shipping.same_no', kind: 'text', label: 'Choix « différente »' },
      { id: 'shipping.prompt_existing', kind: 'text', label: 'Question (site existant)' },
    ],
  },
  {
    id: 'network', title: 'Accès réseau', short: 'Réseau', section: 'network',
    items: [
      { id: 'network.title', kind: 'text', label: 'Titre' },
      { id: 'network.prompt', kind: 'text', label: 'Question' },
      { id: 'network.options', kind: 'choices', label: 'Choix', fixedValues: true },
      { id: 'network.wifi', kind: 'group', label: 'Bloc identifiants Wi-Fi', hideable: true },
      { id: 'network.wifi_prompt', kind: 'text', label: 'Intro Wi-Fi' },
      { id: 'network.wifi_ssid_label', kind: 'text', label: 'Libellé SSID' },
      { id: 'network.wifi_password_label', kind: 'text', label: 'Libellé mot de passe' },
    ],
  },
  {
    id: 'greenhouses', title: 'Serres', short: 'Serres', section: 'greenhouse',
    items: [
      { id: 'greenhouses.count_title', kind: 'text', label: 'Titre (nombre de serres)' },
      { id: 'greenhouses.count_label', kind: 'text', label: 'Question (nombre de serres)' },
      { id: 'greenhouse.length', kind: 'group', label: 'Question longueur', hideable: true },
      { id: 'greenhouse.length_label', kind: 'text', label: 'Libellé longueur' },
      { id: 'greenhouse.length_range_options', kind: 'choices', label: 'Choix longueur', fixedValues: true },
      { id: 'greenhouse.side_vents', kind: 'group', label: 'Bloc côtés ouvrants', hideable: true },
      // Les trois réponses (0, 1, 2 côtés) sont des images dessinées par le code.
      { id: 'greenhouse.side_vents_count_label', kind: 'text', label: 'Question côtés ouvrants' },
      { id: 'greenhouse.side_vent_type_label', kind: 'text', label: 'Question type de côté', under: 'greenhouse.side_vents' },
      { id: 'greenhouse.side_vent_type_options', kind: 'choices', label: 'Choix type de côté', fixedValues: true, under: 'greenhouse.side_vents' },
      // `under` : ces questions ne paraissent que si le bloc masquable nommé est
      // affiché (l'éditeur les atténue quand il est masqué).
      // Les deux réponses (moteurs déjà là, moteurs à fournir) sont des images.
      { id: 'greenhouse.motors_label', kind: 'text', label: 'Question moteurs', under: 'greenhouse.side_vents' },
      { id: 'greenhouse.motors_options', kind: 'choices', label: 'Choix moteurs', fixedValues: true, under: 'greenhouse.side_vents' },
      // Les deux réponses (6 pi et moins, plus de 6 pi) sont des images.
      { id: 'greenhouse.side_vent_height_label', kind: 'text', label: 'Libellé hauteur', under: 'greenhouse.side_vents' },
      { id: 'greenhouse.side_vent_height_range_options', kind: 'choices', label: 'Choix hauteur', fixedValues: true, under: 'greenhouse.side_vents' },
      { id: 'greenhouse.side_pipe_type_label', kind: 'text', label: 'Libellé type de tuyau', under: 'greenhouse.side_vents' },
      { id: 'greenhouse.side_pipe_type_options', kind: 'choices', label: 'Choix type de tuyau', fixedValues: true, under: 'greenhouse.side_vents' },
      { id: 'greenhouse.guide_pipes_label', kind: 'text', label: 'Libellé tuyaux guides', under: 'greenhouse.side_vents' },
      { id: 'greenhouse.guide_pipes_options', kind: 'choices', label: 'Choix tuyaux guides', fixedValues: true, under: 'greenhouse.side_vents' },
      { id: 'greenhouse.diameter_other_label', kind: 'text', label: 'Libellé diamètre externe', under: 'greenhouse.side_vents' },
    ],
  },
  {
    id: 'roofs', title: 'Toits ouvrants', short: 'Toits', section: null,
    items: [
      ...['present', 'count', 'inverter', 'voltage', 'ridder', 'inverter_model', 'brand', 'model', 'supply_possible', 'supply_customer'].map(key => ({ id: `roofs.${key}`, kind: 'text', label: DEFAULT_TEXTS[`roofs.${key}`] })),
      { id: 'roofs.voltage_options', kind: 'choices', label: 'Tensions', fixedValues: true },
      { id: 'roofs.inverter_options', kind: 'choices', label: 'Inverseurs', fixedValues: true },
    ],
  },
  // Toiles thermiques : mêmes questions, mêmes choix que les toits ouvrants.
  {
    id: 'screens', title: 'Toiles thermiques', short: 'Toiles', section: null,
    items: ['present', 'count', 'inverter', 'voltage', 'ridder', 'inverter_model', 'brand', 'model', 'supply_possible', 'supply_customer'].map(key => ({ id: `screens.${key}`, kind: 'text', label: DEFAULT_TEXTS[`screens.${key}`] })),
  },
  {
    id: 'louvers', title: 'Louvres et ventilateurs', short: 'Louvres', section: null,
    // Les réponses (0, 1, 2 louvres ; combinaisons de commande) sont des images
    // dessinées par le code.
    items: ['title', 'present', 'type', 'fan', 'fan_unavailable'].map(key => ({ id: `louvers.${key}`, kind: key === 'fan_unavailable' ? 'textarea' : 'text', label: { title: 'Titre', present: 'Question louvres', type: 'Question type de louvre', fan: 'Ventilateur associé', fan_unavailable: 'Ventilateur non pris en charge' }[key] })),
  },
  {
    id: 'chief', title: 'Serres Chef de culture', short: 'Chef de culture', section: 'greenhouse_chief',
    items: [
      { id: 'chief.furnaces', kind: 'group', label: 'Bloc fournaises', hideable: true },
      { id: 'chief.furnaces_heading', kind: 'text', label: 'Sous-titre fournaises' },
      { id: 'chief.furnaces_count_label', kind: 'text', label: 'Question nombre de fournaises' },
      { id: 'chief.irrigation_heading', kind: 'text', label: 'Sous-titre irrigation' },
      { id: 'chief.irrigation_zones_label', kind: 'text', label: 'Question zones' },
      { id: 'chief.orisha_valves_label', kind: 'text', label: 'Question valves' },
      { id: 'chief.orisha_valves_options', kind: 'choices', label: 'Choix valves', fixedValues: true },
    ],
  },
  {
    id: 'furnace', title: 'Fournaise', short: 'Fournaise', section: null,
    items: [
      { id: 'furnace.dry_contact_label', kind: 'text', label: 'Question thermostat mural' },
      { id: 'furnace.dry_contact_options', kind: 'choices', label: 'Choix thermostat mural', fixedValues: true },
      { id: 'furnace.brand_label', kind: 'text', label: 'Libellé marque' },
      { id: 'furnace.brand_options', kind: 'choices', label: 'Choix marque', fixedValues: true },
      { id: 'furnace.model_label', kind: 'text', label: 'Libellé modèle' },
      { id: 'furnace.wire_label', kind: 'text', label: 'Libellé filage' },
      { id: 'furnace.wire_options', kind: 'choices', label: 'Choix filage', fixedValues: true },
      { id: 'furnace.wire_help', kind: 'textarea', label: 'Aide filage' },
      { id: 'furnace.wire_feet_label', kind: 'text', label: 'Libellé nombre de pieds' },
      { id: 'furnace.thermostat_label', kind: 'text', label: 'Libellé thermostat' },
      { id: 'furnace.thermostat_options', kind: 'choices', label: 'Choix thermostat', fixedValues: true },
    ],
  },
  {
    id: 'submit', title: 'Fin du formulaire', short: 'Fin', section: 'end',
    items: [
      { id: 'submit.label', kind: 'text', label: 'Bouton' },
      { id: 'submit.incomplete', kind: 'text', label: 'Message « incomplet »' },
      { id: 'submitted.title', kind: 'text', label: 'Titre après envoi' },
      { id: 'submitted.text', kind: 'textarea', label: 'Texte après envoi' },
      { id: 'prepare.title', kind: 'text', label: 'Titre « à préparer »' },
      { id: 'prepare.panel', kind: 'textarea', label: 'Panneau de contreplaqué' },
      { id: 'prepare.outlet', kind: 'textarea', label: 'Prise de courant' },
      { id: 'prepare.outlet_breaker', kind: 'textarea', label: 'Prise + disjoncteur (toit 240 V)' },
      { id: 'prepare.pipe', kind: 'textarea', label: 'Tuyau des capteurs extérieurs' },
      { id: 'prepare.pipe_help', kind: 'textarea', label: 'Aide tuyau ({capteurs} = capteurs achetés)' },
    ],
  },
]

const FIXED_CHOICE_IDS = new Set([
  'louvers.types',
  ...SCHEMA_GROUPS.flatMap(g => g.items.filter(i => i.kind === 'choices' && i.fixedValues).map(i => i.id)),
])

export const HIDEABLE_IDS = SCHEMA_GROUPS.flatMap(g => g.items.filter(i => i.hideable).map(i => i.id))

function mergeChoiceList(id, defaults, override) {
  if (!Array.isArray(override) || override.length === 0) return defaults
  const entries = override.filter(o => o && o.value != null && String(o.value) !== '')
  if (!FIXED_CHOICE_IDS.has(id)) return entries.filter(o => !o.removed && o.label)
  // Liste pilotée par le code : on garde les valeurs et l'ordre des defaults,
  // on n'emprunte au calque que le libellé et l'aide. Le calque peut en retirer
  // (`removed`) et en ajouter (valeurs inconnues des defaults, mises à la suite).
  const byValue = new Map(entries.map(o => [String(o.value), o]))
  const kept = defaults
    .filter(d => !byValue.get(d.value)?.removed)
    .map(d => {
      const ov = byValue.get(d.value)
      if (!ov) return d
      return { value: d.value, label: ov.label || d.label, help: ov.help ?? d.help }
    })
  const known = new Set(defaults.map(d => d.value))
  const added = entries
    .filter(o => !o.removed && o.label && !known.has(String(o.value)))
    .map(o => ({ value: String(o.value), label: String(o.label), ...(o.help ? { help: String(o.help) } : {}) }))
  const merged = [...kept, ...added]
  // Une liste vidée de tout choix bloquerait la question : on retombe alors
  // sur les defaults plutôt que d'afficher une question sans réponse possible.
  return merged.length ? merged : defaults
}

// ─── Affichage conditionnel ───────────────────────────────────────────────
//
// Une question ajoutée peut ne s'afficher que si d'autres réponses remplissent
// une condition : `visibleIf = { match: 'all'|'any', rules: [{field, op, value}] }`.
// `field` est soit le nom d'une réponse du formulaire (CONDITION_SOURCES), soit
// `custom:<id>` pour une autre question ajoutée. L'évaluation n'est pas
// récursive : on lit la réponse brute du champ pilote, jamais sa visibilité —
// deux questions qui se pointent l'une l'autre ne bouclent donc pas.

function normalizeVisibleIf(v) {
  const rules = (Array.isArray(v?.rules) ? v.rules : [])
    .filter(r => r && typeof r.field === 'string' && r.field.trim() !== '')
    .map(r => ({
      field: String(r.field),
      op: CONDITION_OPS.some(o => o.value === r.op) ? r.op : 'eq',
      value: r.value == null ? '' : String(r.value),
    }))
  if (!rules.length) return null
  return { match: v.match === 'any' ? 'any' : 'all', rules }
}

function normAnswer(v) {
  if (v === true) return 'yes'
  if (v === false) return 'no'
  if (v == null) return ''
  return String(v).trim()
}

function sameAnswer(a, b) {
  const alias = { true: 'yes', false: 'no', oui: 'yes', non: 'no' }
  const na = normAnswer(a), nb = normAnswer(b)
  return (alias[na.toLowerCase()] || na) === (alias[nb.toLowerCase()] || nb)
}

function isFilledAnswer(v) {
  if (v === false) return true
  return normAnswer(v) !== ''
}

// `ctx` : { record, custom } au niveau de la question, plus { root, rootCustom }
// quand la question vit dans une serre et pointe une réponse du formulaire.
function readConditionField(field, ctx) {
  if (field.startsWith('custom:')) {
    const id = field.slice(7)
    const own = ctx.custom || {}
    if (id in own) return own[id]
    return (ctx.rootCustom || {})[id]
  }
  const src = CONDITION_SOURCES.find(s => s.field === field)
  if (src?.scope === 'form' && ctx.root) return ctx.root[field]
  return (ctx.record || {})[field]
}

/** `true` si la question doit s'afficher, d'après les réponses de `ctx`. */
export function isQuestionVisible(q, ctx) {
  const cond = q?.visibleIf
  if (!cond?.rules?.length) return true
  const c = ctx || {}
  const test = (r) => {
    const raw = readConditionField(r.field, c)
    switch (r.op) {
      case 'filled': return isFilledAnswer(raw)
      case 'empty': return !isFilledAnswer(raw)
      case 'gt': return Number(raw) > Number(r.value)
      case 'lt': return Number(raw) < Number(r.value)
      case 'ne': return !sameAnswer(raw, r.value)
      default: return sameAnswer(raw, r.value)
    }
  }
  return cond.match === 'any' ? cond.rules.some(test) : cond.rules.every(test)
}

/**
 * Choix courant de la distance au contrôleur central. Les réponses d'avant le
 * choix « 350 pi » ne portent que le booléen : il donne encore la réponse.
 */
export function controllerDistanceValue(response) {
  if (response?.central_controller_distance) return String(response.central_controller_distance)
  if (typeof response?.within_central_controller_range === 'boolean') return response.within_central_controller_range ? 'yes' : 'no'
  return ''
}

/**
 * Puissance combinée des deux ventilateurs de bout : la réponse est une plage,
 * c'est tout ce dont le calcul d'équipement a besoin. Les réponses d'avant ne
 * portent que le nombre exact de HP : il donne encore la plage.
 */
export const FANS_HP_RANGE_OPTIONS = [
  { value: 'up_to_1', label: '1 HP et moins' },
  { value: 'over_1', label: 'Plus de 1 HP' },
]

export function fansHpRangeValue(greenhouse) {
  if (greenhouse?.fans_hp_range) return String(greenhouse.fans_hp_range)
  const hp = greenhouse?.fans_combined_hp
  if (hp === 'Je ne sais pas') return hp
  return Number(hp) > 0 ? (Number(hp) > 1 ? 'over_1' : 'up_to_1') : ''
}

/**
 * Fusionne un calque de surcharges avec les valeurs par défaut et renvoie
 * l'accesseur utilisé par le formulaire public.
 */
// `lang` = 'en' : version anglaise. Les textes réécrits dans l'éditeur sont en
// français, ils cèdent la place à la traduction des défauts ; les choix retirés
// ou ajoutés et les questions ajoutées restent (ces dernières, telles qu'écrites).
export function buildForm(overrides, lang = 'fr') {
  const o = overrides && typeof overrides === 'object' ? overrides : {}
  const en = normalizeLang(lang) === 'en'
  const texts = { ...DEFAULT_TEXTS, ...(en ? EN_TEXTS : {}) }
  if (!en) for (const [k, v] of Object.entries(o.texts || {})) {
    if (k in DEFAULT_TEXTS && typeof v === 'string' && v.trim() !== '') texts[k] = v
  }
  const choices = {}
  for (const [k, def] of Object.entries(DEFAULT_CHOICES)) {
    const merged = mergeChoiceList(k, def, o.choices?.[k])
    choices[k] = en
      ? merged.map(c => {
        const d = def.find(x => x.value === c.value)
        const label = translate('en', d ? d.label : c.label)
        const help = d?.help ?? c.help
        return { ...c, label, ...(help ? { help: translate('en', help) } : {}) }
      })
      : merged
  }
  const hidden = {}
  for (const id of HIDEABLE_IDS) if (o.hidden?.[id]) hidden[id] = true
  const custom = (Array.isArray(o.custom) ? o.custom : [])
    .filter(q => q && q.id && q.label)
    .map(q => ({
      id: String(q.id),
      section: CUSTOM_SECTIONS.some(s => s.id === q.section) ? q.section : 'end',
      type: CUSTOM_TYPES.some(t => t.value === q.type) ? q.type : 'text',
      label: String(q.label),
      help: q.help ? String(q.help) : '',
      required: !!q.required,
      options: Array.isArray(q.options) ? q.options.filter(x => x && x.label).map(x => ({ value: String(x.value ?? x.label), label: String(x.label) })) : [],
      visibleIf: normalizeVisibleIf(q.visibleIf),
      image: normalizeQuestionImage(q.image),
    }))

  return {
    lang: en ? 'en' : 'fr',
    tr: (fr) => translate(en ? 'en' : 'fr', fr),
    t: (id) => texts[id] ?? '',
    image: (id) => normalizeQuestionImage(o.images?.[id]),
    opts: (id) => choices[id] || [],
    isHidden: (id) => !!hidden[id],
    // Sans `ctx`, toutes les questions de la section (fiche interne, éditeur) ;
    // avec, seules celles que les réponses courantes rendent visibles.
    custom: (section, ctx) => custom.filter(q => q.section === section && (ctx === undefined || isQuestionVisible(q, ctx))),
    allCustom: custom,
  }
}

/** Calque vide — point de départ de l'éditeur. */
export function emptyOverrides() {
  return { images: {}, texts: {}, choices: {}, hidden: {}, custom: [], equipment: { products: {} } }
}

// Une serre de niveau Helper n'automatise que ses côtés ouvrants : ventilateurs,
// louvres et conservation de l'humidité ne lui sont ni demandés, ni dimensionnés
// (miroir de la même règle côté serveur, services/discoveryEquipment.js).
export function sideVentsOnly(permission) {
  return permission === 'helper'
}

// Côté ouvrant « Autre » : les questions roll-up (moteurs, hauteur, tuyaux) ne
// s'appliquent pas et aucun matériel n'est déduit (même règle côté serveur).
// Sans réponse (formulaires d'avant la question) : roll-up.
export function sideVentOther(greenhouse) {
  return greenhouse?.has_side_vents === true && greenhouse?.side_vent_type === 'other'
}

/** `true` si la réponse à une question personnalisée est considérée remplie. */
export function customAnswered(q, value) {
  if (q.type === 'checkbox') return value === true
  if (q.type === 'yesno') return value === true || value === false
  return value != null && String(value).trim() !== ''
}
