/**
 * Internal task adapter for field-rule automations.
 *
 * action_config shape:
 *   {
 *     title: '...',              // required, templated
 *     description: '...',        // optional, templated
 *     assigned_to: '<user-id>',  // optional, defaults to unassigned
 *     priority: 'Haute' | 'Normal' | 'Basse',  // optional, default 'Normal'
 *     due_in_days: 7,            // optional, relative to now
 *     link_company: true,        // optional, default true — copy row.company_id if present
 *   }
 *
 * Anti-loop guard: callers must not use this adapter to write to the same
 * column on the same table that the rule is triggered on. Nothing enforces
 * that here — fieldRuleEngine rejects such configs when they are saved.
 */
import { randomUUID } from 'crypto'
import db from '../../db/database.js'

const VALID_PRIORITY = new Set(['Basse', 'Normal', 'Haute', 'Urgent'])

export async function createTask({ rule, row, rendered }) {
  const ac = rule.action_config || {}
  const title = rendered.title
  if (!title || !String(title).trim()) {
    throw new Error('Template `title` manquant ou vide')
  }
  const description = rendered.description || null
  const assignedTo = ac.assigned_to || null
  const priority = VALID_PRIORITY.has(ac.priority) ? ac.priority : 'Normal'

  let dueDate = null
  if (Number.isFinite(ac.due_in_days) && ac.due_in_days >= 0) {
    const d = new Date()
    d.setDate(d.getDate() + Number(ac.due_in_days))
    dueDate = d.toISOString().slice(0, 10)
  }

  const linkCompany = ac.link_company !== false
  const companyId = linkCompany ? (row.company_id || null) : null
  const contactId = row.contact_id || null

  const id = randomUUID()
  db.prepare(`
    INSERT INTO tasks (
      id, title, description, status, priority, due_date,
      company_id, contact_id, assigned_to,
      created_at, updated_at
    )
    VALUES (?, ?, ?, 'À faire', ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).run(id, title, description, priority, dueDate, companyId, contactId, assignedTo)
}
