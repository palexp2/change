import { hasRole } from '../../../shared/roles.mjs'
export const HR_TABLES = new Set(['employees', 'vacations', 'paies', 'paie_items', 'timesheets', 'timesheet_days', 'timesheet_entries', 'timesheet_weeks', 'rd_month_hours'])
export function isHR(user) { return hasRole(user, 'rh') }
export function filterCachedSpecs(specs, user) {
  return Object.fromEntries(Object.entries(specs).filter(([table]) => isHR(user) || !HR_TABLES.has(table)))
}
const HR_CHANNELS = new Set(['employee', 'employees', 'vacation', 'vacations', 'paie', 'paies', 'paie_item', 'paie_items', 'timesheet', 'timesheets', 'timesheet_week', 'timesheet_weeks'])
export function canReceiveChannel(user, channel) {
  const prefix = String(channel).split(':')[0]
  if (String(channel).startsWith('comments:employee:')) return isHR(user)
  if (HR_CHANNELS.has(prefix)) return isHR(user)
  if (['agent', 'work_prompt', 'work_prompts', 'automation', 'automations'].includes(prefix)) return hasRole(user, 'admin')
  return true
}
