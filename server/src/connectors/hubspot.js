import db from '../db/database.js'

const BASE = 'https://api.hubapi.com'

export function getAccessToken() {
  const row = db.prepare(
    "SELECT value FROM connector_config WHERE connector='hubspot' AND key='access_token'"
  ).get()
  if (!row || !row.value) throw new Error('HubSpot non configuré — saisis le token Private App dans Connecteurs')
  return row.value
}

export function isHubSpotConfigured() {
  const row = db.prepare(
    "SELECT value FROM connector_config WHERE connector='hubspot' AND key='access_token'"
  ).get()
  return !!(row && row.value)
}

async function hsFetch(path, { method = 'GET', body, retries = 3 } = {}) {
  const token = getAccessToken()
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (resp.status === 429) {
      const wait = Number(resp.headers.get('Retry-After') || attempt + 1) * 1000
      await new Promise(r => setTimeout(r, wait))
      continue
    }
    if (resp.status === 404 && method === 'GET') return null
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`HubSpot ${method} ${path} ${resp.status}: ${text}`)
    }
    if (resp.status === 204) return null
    return resp.json()
  }
  throw new Error(`HubSpot rate limit persistant sur ${path}`)
}

const TASK_PROPERTIES = [
  'hs_task_subject', 'hs_task_body', 'hs_task_status', 'hs_task_priority',
  'hs_timestamp', 'hubspot_owner_id', 'hs_lastmodifieddate', 'hs_createdate',
]

export async function createTask(properties) {
  return hsFetch('/crm/v3/objects/tasks', { method: 'POST', body: { properties } })
}

export async function updateTask(id, properties) {
  return hsFetch(`/crm/v3/objects/tasks/${id}`, { method: 'PATCH', body: { properties } })
}

export async function deleteTask(id) {
  return hsFetch(`/crm/v3/objects/tasks/${id}`, { method: 'DELETE' })
}

export async function getTask(id) {
  const params = new URLSearchParams({ properties: TASK_PROPERTIES.join(',') })
  return hsFetch(`/crm/v3/objects/tasks/${id}?${params}`)
}

/** Liste tous les owners (utilisateurs) du portail. */
export async function listOwners() {
  const out = []
  let after = null
  do {
    const qs = new URLSearchParams({ limit: '100' })
    if (after) qs.set('after', after)
    const data = await hsFetch(`/crm/v3/owners?${qs}`)
    if (!data) break
    out.push(...(data.results || []))
    after = data.paging?.next?.after || null
  } while (after)
  return out
}

// ── Contacts & Lists ───────────────────────────────────────────────────
// Utilisés pour pousser une liste statique HubSpot à partir d'un set
// d'emails ERP (segment marketing). On ne crée pas de contacts — si un
// email n'existe pas dans HubSpot il est rapporté dans `not_found`.

/**
 * Résout des emails en contact IDs HubSpot (batch). Les emails inconnus
 * sont absents du résultat. Limite HubSpot : 100 par appel, donc on
 * chunk. Retourne Map<email_lowercase, contactId>.
 */
export async function lookupContactsByEmail(emails) {
  const out = new Map()
  const unique = [...new Set(emails.map(e => String(e || '').trim().toLowerCase()).filter(Boolean))]
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100)
    const body = {
      idProperty: 'email',
      properties: ['email'],
      inputs: chunk.map(email => ({ id: email })),
    }
    const data = await hsFetch('/crm/v3/objects/contacts/batch/read', { method: 'POST', body })
    for (const result of data?.results || []) {
      const email = result.properties?.email
      if (email) out.set(email.toLowerCase(), result.id)
    }
  }
  return out
}

/**
 * Crée une liste statique de contacts dans HubSpot. `objectTypeId` 0-1
 * = contacts. `processingType: MANUAL` = liste statique (par opposition
 * à DYNAMIC qui se peuple via critères HubSpot).
 */
export async function createStaticContactList(name) {
  const body = { name, objectTypeId: '0-1', processingType: 'MANUAL' }
  const data = await hsFetch('/crm/v3/lists/', { method: 'POST', body })
  return data?.list?.listId || data?.listId
}

/**
 * Ajoute des contacts (par recordIds = vids) à une liste statique.
 * HubSpot accepte jusqu'à 100 par appel donc on chunk.
 */
export async function addContactsToList(listId, contactIds) {
  let added = 0
  for (let i = 0; i < contactIds.length; i += 100) {
    const chunk = contactIds.slice(i, i + 100)
    const data = await hsFetch(`/crm/v3/lists/${listId}/memberships/add`, {
      method: 'PUT',
      body: chunk,
    })
    added += (data?.recordIdsAdded?.length ?? chunk.length)
  }
  return added
}

/**
 * Retourne l'ID du portail HubSpot (utilisé pour construire l'URL de la
 * liste dans l'UI HubSpot).
 */
export async function getPortalId() {
  const data = await hsFetch('/account-info/v3/details')
  return data?.portalId
}

/**
 * Recherche les tâches modifiées après `sinceIso`. Pagine entièrement.
 * `sinceIso` peut être null pour un premier sync complet.
 */
export async function searchTasksModifiedSince(sinceIso) {
  const out = []
  let after = null
  // Backfill (no cursor) restricts to non-completed tasks; deltas pull everything
  // modified since the cursor (including transitions to COMPLETED).
  const filters = sinceIso
    ? [{ propertyName: 'hs_lastmodifieddate', operator: 'GT', value: new Date(sinceIso).getTime() }]
    : [{ propertyName: 'hs_task_status', operator: 'NEQ', value: 'COMPLETED' }]
  const filterGroups = [{ filters }]
  for (;;) {
    const body = {
      filterGroups,
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
      properties: TASK_PROPERTIES,
      limit: 100,
    }
    if (after) body.after = after
    const data = await hsFetch('/crm/v3/objects/tasks/search', { method: 'POST', body })
    if (!data) break
    out.push(...(data.results || []))
    after = data.paging?.next?.after || null
    if (!after) break
  }
  return out
}
