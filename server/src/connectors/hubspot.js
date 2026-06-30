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
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    let resp
    try {
      resp = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      // Erreur réseau transitoire (DNS, reset, timeout) — backoff et retry
      lastError = err
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, Math.min(2 ** attempt, 30) * 1000))
        continue
      }
      throw new Error(`HubSpot ${method} ${path} échec réseau après ${retries + 1} tentatives: ${err.message}`)
    }
    if (resp.status === 429) {
      // Rate limit — respecte Retry-After si présent, sinon backoff exponentiel
      const retryAfter = Number(resp.headers.get('Retry-After'))
      const wait = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Math.min(2 ** attempt, 30)) * 1000
      lastError = new Error(`HubSpot ${method} ${path} 429 rate limit`)
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, wait))
        continue
      }
      throw new Error(`HubSpot rate limit persistant sur ${path} après ${retries + 1} tentatives`)
    }
    if (resp.status >= 500 && resp.status <= 599) {
      // Erreur serveur transitoire (500/502/503/504) — backoff exponentiel et retry
      const text = await resp.text()
      lastError = new Error(`HubSpot ${method} ${path} ${resp.status}: ${text}`)
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, Math.min(2 ** attempt, 30) * 1000))
        continue
      }
      throw new Error(`HubSpot ${method} ${path} ${resp.status} persistant après ${retries + 1} tentatives: ${text}`)
    }
    if (resp.status === 404 && method === 'GET') return null
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`HubSpot ${method} ${path} ${resp.status}: ${text}`)
    }
    if (resp.status === 204) return null
    return resp.json()
  }
  throw lastError || new Error(`HubSpot ${method} ${path} : échec après ${retries + 1} tentatives`)
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

// Largeur de la tranche temporelle pour les deltas. L'API search HubSpot
// renvoie des 500 sur de très gros result sets (et plafonne la pagination
// profonde à 10 000 résultats) ; borner chaque requête par une fenêtre
// [from, to] garde le volume par appel petit même si le curseur est ancré
// loin dans le passé.
const TASK_SEARCH_WINDOW_MS = 7 * 24 * 3600 * 1000

/**
 * Pagine entièrement une recherche de tâches pour un ensemble de filtres donné.
 *
 * Si une page échoue (typiquement un 500 persistant côté HubSpot après les
 * retries de hsFetch), l'erreur est enrichie avec `hubspotSearch` : le curseur
 * `after` au moment de l'échec et le nombre de résultats déjà récupérés dans
 * cette fenêtre. Sans ce contexte, sync_log ne montrait qu'une erreur générique
 * impossible à diagnostiquer ou reprendre.
 */
async function searchTasksPaged(filters) {
  const out = []
  let after = null
  for (;;) {
    const body = {
      filterGroups: [{ filters }],
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
      properties: TASK_PROPERTIES,
      limit: 100,
    }
    if (after) body.after = after
    let data
    try {
      data = await hsFetch('/crm/v3/objects/tasks/search', { method: 'POST', body })
    } catch (e) {
      e.hubspotSearch = {
        ...(e.hubspotSearch || {}),
        after: after || null,
        fetchedInWindow: out.length,
      }
      throw e
    }
    if (!data) break
    out.push(...(data.results || []))
    after = data.paging?.next?.after || null
    if (!after) break
  }
  return out
}

/**
 * Recherche les tâches modifiées après `sinceIso`. Pagine entièrement.
 * `sinceIso` peut être null pour un premier sync complet.
 *
 * Pour les deltas, la fenêtre [since, now] est découpée en tranches de
 * `TASK_SEARCH_WINDOW_MS` afin de borner le volume de chaque requête search
 * (évite les 500 d'HubSpot sur gros result sets et le plafond de pagination
 * profonde à 10 000). Les bornes GT(from)/LTE(to) sont disjointes d'une
 * tranche à l'autre : aucun doublon, aucun trou.
 */
export async function searchTasksModifiedSince(sinceIso, onWindow = null) {
  // Backfill (no cursor) restricts to non-completed tasks; deltas pull everything
  // modified since the cursor (including transitions to COMPLETED).
  if (!sinceIso) {
    const results = await searchTasksPaged([{ propertyName: 'hs_task_status', operator: 'NEQ', value: 'COMPLETED' }])
    if (onWindow) { await onWindow(results, { from: null, to: null }); return undefined }
    return results
  }
  const out = onWindow ? null : []
  const now = Date.now()
  let from = new Date(sinceIso).getTime()
  while (from < now) {
    const to = Math.min(from + TASK_SEARCH_WINDOW_MS, now)
    const filters = [
      { propertyName: 'hs_lastmodifieddate', operator: 'GT', value: from },
      { propertyName: 'hs_lastmodifieddate', operator: 'LTE', value: to },
    ]
    let results
    try {
      results = await searchTasksPaged(filters)
    } catch (e) {
      // Précise la fenêtre temporelle demandée — combinée au curseur `after` déjà
      // posé par searchTasksPaged, elle permet de localiser le batch fautif.
      e.hubspotSearch = {
        ...(e.hubspotSearch || {}),
        windowFrom: new Date(from).toISOString(),
        windowTo: new Date(to).toISOString(),
      }
      throw e
    }
    // Traitement incrémental fenêtre par fenêtre : ainsi un échec sur une fenêtre
    // ultérieure ne perd pas le travail (ni la progression du curseur) des
    // fenêtres déjà appliquées par l'appelant.
    if (onWindow) await onWindow(results, { from, to })
    else out.push(...results)
    from = to
  }
  return out
}
