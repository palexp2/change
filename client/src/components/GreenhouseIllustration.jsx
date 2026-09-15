import { normalizeQuestionImage, isUploadedQuestionImage, QUESTION_IMAGE_OPTIONS } from '../lib/discoveryQuestionImages.js'
import { focusLabel } from '../lib/greenhouseFocus.js'
import { FurnaceIllustration } from './FurnaceCountChoice.jsx'

const IMAGES = {
  overview: 'site.webp',
  site: 'site.webp',
  site_new: 'site-new.svg',
  site_existing: 'site-existing.svg',
  count: 'site.webp',
  farm: 'small-farm.webp',
  shipping: 'shipping.webp',
  network: 'network.png',
  network_ethernet: 'network-ethernet.svg',
  network_wifi: 'network-wifi.svg',
  network_coax: 'network-coax.svg',
  network_mobile_choice: 'network-mobile.svg',
  network_mobile: 'network_mobile.webp',
  length: 'dimensions-iso.svg',
  length_up_to_200: 'length-200-or-less.svg',
  length_over_200: 'length-over-200.svg',
  side_vents: 'side-vents.png',
  motors_existing: 'motors-existing.svg',
  motors_needed: 'motors-needed.svg',
  vent_height: 'dimensions-iso.svg',
  vent_height_up_to_6: 'vent-height-6-or-less.svg',
  vent_height_over_6: 'vent-height-over-6.svg',
  side_pipe: 'side-vents.png',
  diameter_standard: 'diameter-2in.svg',
  diameter_other: 'diameter-other.svg',
  diameter_unknown: 'diameter-unknown.svg',
  guide_pipes: 'guide_pipes.webp',
  fans_two: 'fans-two.svg',
  furnaces: 'furnaces.webp',
  furnace_wire: 'furnace_wire.webp',
  thermostat: 'thermostat.webp',
  irrigation: 'irrigation.webp',
  valves: 'irrigation.webp',
}

// Les ressources locales restent disponibles sans accès au site de références.
export default function GreenhouseIllustration({ focus = 'overview', height = 128, label, className = '', pipeType, image, variant }) {
  const selected = normalizeQuestionImage(image)
  if (selected === 'none') return null
  if (variant === 'furnace-choice' && (!selected || selected === 'furnaces.webp')) {
    return <FurnaceIllustration label={label || focusLabel('furnaces')} className={`shrink-0 rounded-lg bg-white ${className}`}
      style={{ width: Math.max(180, height * 2.2), maxWidth: '100%', height: Math.max(112, height) }} />
  }
  const diameterRange = variant === 'diameter-range' && selected === 'diameter-1-5-16.svg'
  const diameterOver = variant === 'diameter-over-1-5-16' && (!selected || selected === 'diameter-other.svg')
  const file = diameterOver ? 'diameter-over-1-5-16.svg' : diameterRange ? 'diameter-range-half-to-1-5-16.svg' : selected || (focus === 'side_pipe' && pipeType === 'aluminum_C'
    ? 'pipe-c.png'
    : focus === 'side_pipe' && pipeType === 'steel_O'
      ? 'pipe-o.png'
      : IMAGES[focus] || IMAGES.overview)

  return (
    <img
      src={isUploadedQuestionImage(selected) ? selected : `${import.meta.env.BASE_URL}images/discovery/${file}`}
      alt={diameterOver ? 'Tuyau rond de diamètre extérieur supérieur à 1 5/16 po' : diameterRange ? 'Tuyaux de diamètres croissants, de 1/2 po à 1 5/16 po' : selected ? (QUESTION_IMAGE_OPTIONS.find(([id]) => id === selected)?.[1] || label || 'Image de la question') : (label || focusLabel(focus))}
      width={260}
      height={160}
      loading="lazy"
      decoding="async"
      draggable={false}
      style={{ width: Math.max(180, height * 2.2), maxWidth: '100%', height: Math.max(112, height) }}
      className={`shrink-0 object-contain rounded-lg bg-white ${className}`}
    />
  )
}
