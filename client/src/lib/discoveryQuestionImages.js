// Catalogue partagé par l’éditeur, le formulaire public et la validation serveur.
export const QUESTION_IMAGE_OPTIONS = [
  ['site.webp', 'Ferme et serres'],
  ['shipping.webp', 'Livraison'],
  ['network.png', 'Réseau et contrôleur central'],
  ['network_mobile.webp', 'Internet mobile'],
  ['dimensions.png', 'Dimensions de la serre'],
  ['diameter.png', 'Diamètre des tuyaux'],
  ['side-vents.png', 'Côtés ouvrants'],
  ['pipe-c.png', 'Tuyau aluminium — profil C'],
  ['pipe-o.png', 'Tuyau acier — profil O'],
  ['guide_pipes.webp', 'Tuyaux guides'],
  ['furnaces.webp', 'Fournaise'],
  ['furnace_wire.webp', 'Filage de la fournaise'],
  ['thermostat.webp', 'Thermostat de secours'],
  ['irrigation.webp', 'Irrigation et valves'],
]

// Une entrée par illustration affichée, même si plusieurs champs partagent un bloc.
export const QUESTION_IMAGES = [
  ['order_type', 'order_type.prompt', 'site'],
  ['farm', 'farm.title', 'farm'],
  ['shipping', 'shipping.prompt_new', 'shipping'],
  ['shipping', 'shipping.prompt_existing', 'shipping'],
  ['network', 'network.prompt', 'network'],
  ['network', 'network.mobile_title', 'network_mobile'],
  ['greenhouses', 'greenhouses.count_label', 'count'],
  ['greenhouses', 'greenhouse.length_label', 'length'],
  ['greenhouses', 'greenhouse.side_vents_label', 'side_vents'],
  ['greenhouses', 'greenhouse.side_vent_height_label', 'vent_height'],
  ['greenhouses', 'greenhouse.side_pipe_type_label', 'side_pipe'],
  ['greenhouses', 'greenhouse.guide_pipes_label', 'guide_pipes'],
  ['greenhouses', 'greenhouse.motors', 'side_vents', 'Moteurs des côtés ouvrants'],
  ['louvers', 'greenhouse.fans', 'overview', 'Ventilateurs de bout de serre'],
  ['chief', 'chief.has_furnaces_label', 'furnaces'],
  ['chief', 'chief.irrigation_zones_label', 'irrigation'],
  ['chief', 'chief.orisha_valves_label', 'valves'],
  ['furnace', 'furnace.brand_label', 'furnaces', 'Marque et modèle de fournaise'],
  ['furnace', 'furnace.wire_label', 'furnace_wire'],
  ['furnace', 'furnace.thermostat_label', 'thermostat'],
]

export const QUESTION_IMAGE_UPLOAD_PREFIX = '/erp/api/discovery-form-schema/images/'
export function isUploadedQuestionImage(value) {
  return typeof value === 'string' && /^\/erp\/api\/discovery-form-schema\/images\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.webp$/.test(value)
}

export function normalizeQuestionImage(value) {
  return isUploadedQuestionImage(value) || value === 'none' || QUESTION_IMAGE_OPTIONS.some(([id]) => id === value) ? value : ''
}
