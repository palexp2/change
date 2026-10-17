// Formatage des durées côté serveur (conversions de type, formules) : pas de
// zéro initial sur les heures. La lecture des saisies vit dans shared/duration.mjs.
export { parseDurationToMinutes, parseDurationToSeconds, DURATION_FORMATS, normalizeDurationFormat } from '../../../shared/duration.mjs'
import { normalizeDurationFormat } from '../../../shared/duration.mjs'

// Format minutes as H:MM (no leading zero on hours, always 2 digits on minutes).
export function formatMinutes(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return '0:00'
  const total = Math.max(0, Math.round(minutes))
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

// Formate un nombre de secondes selon le format ('h:mm' ou 'h:mm:ss'). Pas de
// zéro initial sur les heures ; toujours 2 chiffres sur minutes/secondes.
export function formatDurationSeconds(totalSeconds, format = 'h:mm') {
  const fmt = normalizeDurationFormat(format)
  if (totalSeconds == null || !Number.isFinite(Number(totalSeconds))) {
    return fmt === 'h:mm:ss' ? '0:00:00' : '0:00'
  }
  const total = Math.max(0, Math.round(Number(totalSeconds)))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (fmt === 'h:mm:ss') {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${h}:${String(m).padStart(2, '0')}`
}
