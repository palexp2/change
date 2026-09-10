import { parseDurationToMinutes } from './duration.js'

// Un nombre sans unité représente des heures dans le formulaire hebdomadaire.
export function parseWeekHours(input) {
  const value = String(input ?? '').trim().replace(',', '.')
  const minutes = /^\d+(?:\.\d+)?$/.test(value)
    ? Math.round(Number(value) * 60)
    : parseDurationToMinutes(value)
  return minutes != null && Number.isFinite(minutes) && minutes >= 0 && minutes <= 7 * 24 * 60
    ? minutes
    : null
}
