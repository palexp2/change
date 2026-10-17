// Réglages d'une automatisation système, éditables dans /automations :
// `defaults` donne les clés connues et leur valeur par défaut, la base
// (`automations.action_config`) les écrase quand elle porte une valeur non
// vide. Tout est rendu en chaîne nettoyée — c'est le format qu'écrit l'écran.
import db from '../db/database.js'

export function loadAutomationConfig(automationId, defaults) {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(automationId)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...defaults }
  for (const k of Object.keys(defaults)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}
