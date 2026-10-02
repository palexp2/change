// Illustration associée à chaque question du formulaire de découverte.
// Le formulaire et l’éditeur partagent les mêmes sujets et libellés.

export const FOCUS_LABELS = {
  overview: 'La serre et ses équipements',
  site: 'Le site de production',
  site_new: 'Un nouveau site de production',
  site_existing: 'Un site existant avec contrôleur central',
  count: 'Plusieurs serres',
  farm: 'La ferme et ses coordonnées',
  shipping: 'La livraison à la ferme',
  network: 'Le contrôleur central et son antenne',
  network_ethernet: 'Un câble Ethernet jusqu’à la serre',
  network_wifi: 'Le Wi-Fi de la maison jusqu’à la serre',
  network_wifi_credentials: 'Le nom et le mot de passe du Wi-Fi',
  network_coax: 'Une antenne montée en hauteur avec câble coaxial',
  network_mobile_choice: 'Le contrôleur internet mobile et la tour cellulaire',
  network_mobile: 'Le contrôleur internet mobile',
  length: 'La longueur de la serre',
  length_up_to_200: 'Une serre de 200 pi ou moins',
  length_over_200: 'Une serre de plus de 200 pi',
  side_vents: 'Les côtés ouvrants',
  motors_existing: 'Des moteurs déjà montés sur les tuyaux',
  motors_needed: 'La place du moteur, encore vide',
  vent_height: 'La hauteur des côtés ouvrants',
  vent_height_up_to_6: 'Un côté ouvrant de 6 pi ou moins',
  vent_height_over_6: 'Un côté ouvrant de plus de 6 pi',
  side_pipe: 'Le tuyau d’enroulement des côtés',
  diameter_standard: 'Le diamètre standard du tuyau',
  diameter_other: 'Un autre diamètre, à mesurer',
  diameter_unknown: 'Un diamètre inconnu',
  guide_pipes: 'Les tuyaux guides',
  fans_two: 'Les deux ventilateurs de bout de serre',
  roof_vents: 'Le toit ouvrant',
  thermal_screens: 'La toile thermique',
  furnaces: 'Les fournaises de la serre',
  furnace_dry_contact: 'Un thermostat mural ordinaire',
  furnace_wire: 'Le filage de contrôle de la fournaise',
  thermostat: 'Le thermostat de secours',
  irrigation: 'Les zones d’irrigation',
  valves: 'Les valves d’irrigation',
}

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

/** Focus d'une question ajoutée depuis l'éditeur, d'après sa section. */
export function focusForSection(section) {
  return BY_SECTION[section] || 'overview'
}

export const focusLabel = (focus) => FOCUS_LABELS[focus] || FOCUS_LABELS.overview
