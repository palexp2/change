/**
 * Automatisation en blocs (page Automatisations, façon Airtable) : une suite
 * d'actions exécutées dans l'ordre sur l'enregistrement déclencheur.
 *
 * action_config shape:
 *   { steps: [ { type: 'task'|'slack'|'email'|'update'|'find'|'hubspot'|'qb'|'script', config: {...} } ] }
 *
 * Jetons dans les textes : {{colonne}} = champ de l'enregistrement déclencheur,
 * {{etape2.champ}} = sortie d'une étape précédente (ex. {{etape1.nombre}},
 * {{etape1.email}} = champ du premier enregistrement trouvé).
 * Une étape qui échoue arrête la suite (erreur « Étape N (type) : … »).
 */
import db from '../../db/database.js'
import { createTask } from './task.js'
import { sendEmail } from './email.js'
import { runScriptSandboxed, READABLE_TABLES, WRITABLE_TABLES } from '../scriptSandbox.js'
import { buildConditionsPredicate } from '../fieldRuleEngine.js'

export const STEP_TYPES = ['task', 'slack', 'email', 'update', 'find', 'hubspot', 'qb', 'script']

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\}\}/g

function lookup(path, row, outputs) {
  const parts = path.split('.')
  const m = /^etape(\d+)$/.exec(parts[0])
  let v = m ? outputs[Number(m[1]) - 1] : row?.[parts[0]]
  for (const p of parts.slice(1)) v = v == null ? undefined : v[p]
  return v
}

export function renderTemplate(tpl, row, outputs = []) {
  if (typeof tpl !== 'string') return tpl
  if (/<script/i.test(tpl)) throw new Error('Texte refusé : balise <script> interdite')
  return tpl.replace(TOKEN_RE, (_m, path) => {
    const v = lookup(path, row, outputs)
    return v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v))
  })
}

function renderAll(config, row, outputs) {
  const out = {}
  for (const [k, v] of Object.entries(config || {})) {
    out[k] = Array.isArray(v)
      ? v.map(x => (x && typeof x === 'object' ? renderAll(x, row, outputs) : renderTemplate(x, row, outputs)))
      : renderTemplate(v, row, outputs)
  }
  return out
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/i
const num = v => { const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : null }

const ADAPTERS = {
  async task({ rule, row, c, r }) {
    const due = num(c.due_in_days)
    return createTask({
      rule: { ...rule, action_config: { assigned_to: c.assigned_to || null, priority: c.priority, due_in_days: due, link_company: true } },
      row, rendered: { title: r.title, description: r.description },
    })
  },

  async slack({ r }) {
    if (!r.channel) throw new Error('Canal requis')
    if (!String(r.text || '').trim()) throw new Error('Message vide')
    const { postSlackChat } = await import('../slack.js')
    await postSlackChat(r.channel.trim(), r.text)
    return { canal: r.channel }
  },

  async email({ rule, r }) {
    await sendEmail({ rule: { ...rule, action_config: { to: r.to } }, rendered: { subject: r.subject, bodyText: r.body } })
    return { a: r.to }
  },

  // Modifie l'enregistrement déclencheur (ou un autre par son id).
  async update({ rule, row, r }) {
    const table = r.table || rule.trigger_config?.erp_table
    if (!WRITABLE_TABLES.has(table)) throw new Error(`Table non modifiable : ${table}`)
    const id = r.record_id || row?.id
    if (!id) throw new Error('Enregistrement à modifier introuvable')
    const patch = {}
    for (const f of r.fields || []) {
      if (!IDENT_RE.test(f.column || '')) throw new Error(`Champ invalide : ${f.column}`)
      patch[f.column] = f.value
    }
    if (!Object.keys(patch).length) throw new Error('Aucun champ à modifier')
    await runScriptSandboxed('update(params.table, params.id, params.patch)', {
      row, params: { table, id, patch }, enableWrite: true, writableTables: new Set([table]),
    })
    return { id, ...patch }
  },

  // Cherche des enregistrements ; sortie = nombre, liste et champs du premier.
  async find({ r }) {
    if (!READABLE_TABLES.has(r.table)) throw new Error(`Table non lisible : ${r.table}`)
    const rules = (r.conditions || []).filter(x => x.column)
    const { predicate, params } = rules.length ? buildConditionsPredicate({ conjunction: 'AND', rules }) : { predicate: '1=1', params: [] }
    const limit = Math.min(Math.max(num(r.limit) || 50, 1), 200)
    const rows = db.prepare(`SELECT t.* FROM ${r.table} t WHERE ${predicate} LIMIT ${limit}`).all(...params)
    const label = x => x.name || x.title || x.email || x.id
    return { ...(rows[0] || {}), nombre: rows.length, liste: rows.map(label).join(', '), ids: rows.map(x => x.id).join(',') }
  },

  // Met à jour une propriété d'un contact / d'une entreprise HubSpot.
  async hubspot({ r }) {
    const object = r.object === 'companies' ? 'companies' : 'contacts'
    const key = String(r.record || '').trim()
    if (!key) throw new Error('Contact HubSpot requis (id ou courriel)')
    if (!IDENT_RE.test(r.property || '')) throw new Error('Propriété HubSpot invalide')
    const { hsFetch } = await import('../../connectors/hubspot.js')
    const byEmail = key.includes('@')
    await hsFetch(`/crm/v3/objects/${object}/${encodeURIComponent(key)}${byEmail ? '?idProperty=email' : ''}`, {
      method: 'PATCH', body: { properties: { [r.property]: r.value ?? '' } },
    })
    return { hubspot: key }
  },

  // Écriture de journal QuickBooks (débit / crédit par numéro de compte).
  async qb({ r }) {
    const amount = num(r.amount)
    if (!amount || amount <= 0) throw new Error(`Montant invalide : ${r.amount}`)
    const { resolveAccountByAcctNum } = await import('../quickbooks.js')
    const { qbPost } = await import('../../connectors/quickbooks.js')
    const line = async (type, acct) => {
      const id = await resolveAccountByAcctNum(String(acct || '').trim())
      if (!id) throw new Error(`Compte QuickBooks introuvable : ${acct}`)
      return { DetailType: 'JournalEntryLineDetail', Amount: Math.round(amount * 100) / 100, Description: r.memo || undefined,
        JournalEntryLineDetail: { PostingType: type, AccountRef: { value: id } } }
    }
    const je = { TxnDate: /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : new Date().toISOString().slice(0, 10),
      PrivateNote: r.memo || undefined, Line: [await line('Debit', r.debit), await line('Credit', r.credit)] }
    const created = await qbPost('/journalentry', je)
    return { qb_id: created.JournalEntry?.Id || created.Id || null }
  },

  async script({ rule, row, c, outputs }) {
    if (!String(c.code || '').trim()) throw new Error('Script vide')
    await runScriptSandboxed(c.code, {
      row, trigger: { rule_id: rule.id, table: rule.trigger_config?.erp_table, etapes: outputs }, enableWrite: true,
    })
    return {}
  },
}

const short = (v, n = 300) => { const t = String(v ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t }
const asDate = v => (/^\d{13}$/.test(String(v)) ? ` (${new Date(Number(v)).toISOString().replace('T', ' ').slice(0, 16)} UTC)` : '')

// Ce que l'étape a réellement fait, valeurs comprises, pour l'historique.
const DESCRIBE = {
  task: (r, o) => `Tâche créée « ${short(r.title)} »${o.id ? ` (${o.id})` : ''}`,
  slack: r => `Slack → ${r.channel} : « ${short(r.text)} »`,
  email: r => `Courriel → ${r.to} : « ${short(r.subject)} »`,
  update: (r, o) => `Modifié ${o.id} : ${Object.entries(o).filter(([k]) => k !== 'id').map(([k, v]) => `${k} = ${short(v, 80)}`).join(', ')}`,
  find: (r, o) => `Recherche ${r.table} : ${o.nombre} trouvé(s)${o.liste ? ` — ${short(o.liste, 200)}` : ''}`,
  hubspot: r => `HubSpot ${r.object === 'companies' ? 'entreprise' : 'contact'} ${r.record} : ${r.property} = ${r.value ?? ''}${asDate(r.value)}`,
  qb: (r, o) => `QuickBooks écriture ${o.qb_id || ''} : ${r.amount} $ débit ${r.debit} / crédit ${r.credit}${r.memo ? ` « ${short(r.memo, 80)} »` : ''}`,
  script: () => 'Script exécuté',
}

/** Journal détaillé d'une exécution réussie (une ligne par étape). */
export const stepsLog = outputs => (outputs?.log || []).join('\n')

export async function runSteps({ rule, row }) {
  const steps = Array.isArray(rule.action_config?.steps) ? rule.action_config.steps : []
  if (!steps.length) throw new Error('Aucune action')
  const outputs = []
  const log = []
  for (const [i, s] of steps.entries()) {
    const adapter = ADAPTERS[s.type]
    let r = {}
    try {
      if (!adapter) throw new Error('type inconnu')
      // Le code d'un script n'est pas un gabarit : il lit row / trigger.etapes.
      r = s.type === 'script' ? {} : renderAll(s.config, row, outputs)
      const out = (await adapter({ rule, row, c: s.config || {}, r, outputs })) || {}
      outputs.push(out)
      let d = ''
      try { d = DESCRIBE[s.type]?.(r, out) || '' } catch { /* détail facultatif */ }
      log.push(`✓ Étape ${i + 1} (${s.type}) ${d}`.trim())
    } catch (e) {
      // Les étapes déjà réussies restent visibles dans l'historique : un échec
      // en fin de chaîne ne doit pas laisser croire que rien n'est parti.
      throw new Error([...log, `✗ Étape ${i + 1} (${s.type}) : ${e.message}`].join('\n'))
    }
  }
  Object.defineProperty(outputs, 'log', { value: log })
  return outputs
}
