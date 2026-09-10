import { normalizeQuestionImage, isUploadedQuestionImage, QUESTION_IMAGE_OPTIONS } from '../lib/discoveryQuestionImages.js'
import { focusLabel } from '../lib/greenhouseFocus.js'

const IMAGES = {
  overview: 'site.webp',
  site: 'site.webp',
  count: 'site.webp',
  farm: 'site.webp',
  shipping: 'shipping.webp',
  network: 'network.png',
  network_mobile: 'network_mobile.webp',
  length: 'dimensions.png',
  side_vents: 'side-vents.png',
  vent_height: 'dimensions.png',
  side_pipe: 'side-vents.png',
  guide_pipes: 'guide_pipes.webp',
  furnaces: 'furnaces.webp',
  furnace_wire: 'furnace_wire.webp',
  thermostat: 'thermostat.webp',
  irrigation: 'irrigation.webp',
  valves: 'irrigation.webp',
}

// Les ressources locales restent disponibles sans accès au site de références.
export default function GreenhouseIllustration({ focus = 'overview', height = 128, label, className = '', pipeType, image }) {
  const selected = normalizeQuestionImage(image)
  if (selected === 'none') return null
  const file = selected || (focus === 'side_pipe' && pipeType === 'aluminum_C'
    ? 'pipe-c.png'
    : focus === 'side_pipe' && pipeType === 'steel_O'
      ? 'pipe-o.png'
      : IMAGES[focus] || IMAGES.overview)

  return (
    <img
      src={isUploadedQuestionImage(selected) ? selected : `${import.meta.env.BASE_URL}images/discovery/${file}`}
      alt={selected ? (QUESTION_IMAGE_OPTIONS.find(([id]) => id === selected)?.[1] || label || 'Image de la question') : (label || focusLabel(focus))}
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
