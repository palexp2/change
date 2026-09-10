// Illustration associée à chaque question du formulaire de découverte.
// Le formulaire et l’éditeur partagent les mêmes sujets et libellés.

export const FOCUS_LABELS = {
  overview: 'La serre et ses équipements',
  site: 'Le site de production',
  count: 'Plusieurs serres',
  farm: 'La ferme et ses coordonnées',
  shipping: 'La livraison à la ferme',
  network: 'Le contrôleur central et son antenne',
  network_mobile: 'Le contrôleur internet mobile',
  length: 'La longueur de la serre',
  side_vents: 'Les côtés ouvrants',
  vent_height: 'La hauteur des côtés ouvrants',
  side_pipe: 'Le tuyau d’enroulement des côtés',
  guide_pipes: 'Les tuyaux guides',
  furnaces: 'Les fournaises de la serre',
  furnace_wire: 'Le filage de contrôle de la fournaise',
  thermostat: 'Le thermostat de secours',
  irrigation: 'Les zones d’irrigation',
  valves: 'Les valves d’irrigation',
}

// Préfixe d'identifiant du schéma → focus. Ordre significatif : le premier
// préfixe qui correspond gagne, donc du plus précis au plus large.
const BY_PREFIX = [
  ['network.mobile', 'network_mobile'],
  ['network.', 'network'],
  ['order_type.', 'site'],
  ['farm.', 'farm'],
  ['shipping.', 'shipping'],
  ['greenhouses.count', 'count'],
  ['greenhouse.length', 'length'],
  ['greenhouse.side_vent_height', 'vent_height'],
  ['greenhouse.side_vents', 'side_vents'],
  ['greenhouse.side_pipe', 'side_pipe'],
  ['greenhouse.diameter_other', 'side_pipe'],
  ['greenhouse.guide_pipes', 'guide_pipes'],
  ['chief.furnaces', 'furnaces'],
  ['chief.has_furnaces', 'furnaces'],
  ['chief.num_furnaces', 'furnaces'],
  ['chief.irrigation', 'irrigation'],
  ['chief.orisha_valves', 'valves'],
  ['furnace.wire', 'furnace_wire'],
  ['furnace.thermostat', 'thermostat'],
  ['furnace.', 'furnaces'],
]

const BY_SECTION = {
  intro: 'overview',
  order_type: 'site',
  farm_address: 'farm',
  shipping_address: 'shipping',
  network: 'network',
  greenhouse: 'overview',
  greenhouse_chief: 'overview',
  end: 'overview',
}

/** Focus d'un libellé du schéma (`greenhouse.side_vents_label`…). */
export function focusForSchemaItem(id) {
  for (const [prefix, focus] of BY_PREFIX) if (String(id).startsWith(prefix)) return focus
  return 'overview'
}

/** Focus d'une question ajoutée depuis l'éditeur, d'après sa section. */
export function focusForSection(section) {
  return BY_SECTION[section] || 'overview'
}

export const focusLabel = (focus) => FOCUS_LABELS[focus] || FOCUS_LABELS.overview
