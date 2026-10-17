// Lecture des saisies (minutes / secondes) : shared/duration.mjs. Ici le
// formatage à l'écran — heures toujours sur 2 chiffres.
export { parseDurationToMinutes, parseDurationToSeconds, DURATION_FORMATS, normalizeDurationFormat } from '../../../shared/duration.mjs'
import { normalizeDurationFormat } from '../../../shared/duration.mjs'

// "01:30" (hh:mm) format from minutes.
export function formatMinutes(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return '00:00'
  const total = Math.max(0, Math.round(minutes))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

// Formate un nombre de secondes selon le format ('h:mm' ou 'h:mm:ss'). Les
// heures sont toujours sur 2 chiffres à l'écran : « 08:30 », « 01:30:00 ».
export function formatDurationSeconds(totalSeconds, format = 'h:mm') {
  const fmt = normalizeDurationFormat(format)
  if (totalSeconds == null || !Number.isFinite(Number(totalSeconds))) {
    return fmt === 'h:mm:ss' ? '00:00:00' : '00:00'
  }
  const total = Math.max(0, Math.round(Number(totalSeconds)))
  const h = String(Math.floor(total / 3600)).padStart(2, '0')
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (fmt === 'h:mm:ss') return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${h}:${String(m).padStart(2, '0')}`
}

// Durée courte en SECONDES pour l'affichage : « 3m 20s » / « 45s ».
// Retourne null pour 0/absent (l'appelant décide du fallback).
export function fmtDurationSeconds(s) {
  if (!s) return null
  const m = Math.floor(s / 60), sec = s % 60
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`
}

