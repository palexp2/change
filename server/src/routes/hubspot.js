import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import {
  isHubSpotConfigured,
  lookupContactsByEmail,
  createContacts,
  createStaticContactList,
  addContactsToList,
  getPortalId,
} from '../connectors/hubspot.js'

const router = Router()
router.use(requireAuth)

// POST /api/hubspot/contact-segment
// Body : { name: string, emails: string[], createMissing?: boolean }
// Crée une liste statique HubSpot avec les contacts dont l'email matche
// un contact existant. Si createMissing est vrai, les emails sans contact
// existant sont créés dans HubSpot avant d'être ajoutés à la liste.
// Retourne les statistiques de matching/création et l'URL de la liste.
router.post('/contact-segment', async (req, res) => {
  if (!isHubSpotConfigured()) {
    return res.status(400).json({ error: 'HubSpot non configuré' })
  }
  const { name, emails, createMissing } = req.body || {}
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name requis' })
  }
  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'emails requis (non vide)' })
  }
  const requested = [...new Set(emails.map(e => String(e || '').trim().toLowerCase()).filter(Boolean))]
  if (requested.length === 0) {
    return res.status(400).json({ error: 'Aucun email valide après normalisation' })
  }

  try {
    const vidByEmail = await lookupContactsByEmail(requested)
    let notFound = requested.filter(e => !vidByEmail.has(e))

    let createdCount = 0
    if (createMissing && notFound.length > 0) {
      const createdMap = await createContacts(notFound)
      for (const [email, id] of createdMap) vidByEmail.set(email, id)
      createdCount = createdMap.size
      notFound = requested.filter(e => !vidByEmail.has(e))
    }

    const matchedEmails = requested.filter(e => vidByEmail.has(e))
    const vids = matchedEmails.map(e => vidByEmail.get(e))

    if (vids.length === 0) {
      return res.status(422).json({
        error: 'Aucun email ne matche un contact HubSpot existant',
        requested: requested.length,
        matched: 0,
        created: 0,
        not_found: notFound.length,
        not_found_sample: notFound.slice(0, 20),
      })
    }

    const listId = await createStaticContactList(name)
    if (!listId) {
      return res.status(502).json({ error: 'HubSpot n\'a pas retourné de listId' })
    }
    const added = await addContactsToList(listId, vids)

    let listUrl = null
    try {
      const portalId = await getPortalId()
      if (portalId) listUrl = `https://app.hubspot.com/contacts/${portalId}/objectLists/${listId}`
    } catch { /* portal lookup optionnel */ }

    res.json({
      listId,
      listUrl,
      requested: requested.length,
      matched: matchedEmails.length - createdCount,
      created: createdCount,
      not_found: notFound.length,
      not_found_sample: notFound.slice(0, 20),
      added,
    })
  } catch (e) {
    // Détecte les erreurs de scope HubSpot pour donner un message actionnable
    const msg = String(e.message || '')
    if (/MISSING_SCOPES/i.test(msg) || /granted all required scopes/i.test(msg)) {
      // Extrait les scopes requis du payload si possible
      const scopeMatch = msg.match(/"requiredGranularScopes":\s*\[([^\]]+)\]/)
      const scopes = scopeMatch ? scopeMatch[1].replace(/"/g, '').split(',').map(s => s.trim()) : []
      return res.status(403).json({
        error: 'Scope HubSpot manquant',
        missing_scopes: scopes,
        hint: 'Ajoute le scope manquant à ta Private App HubSpot (Settings → Integrations → Private Apps → ta app → Scopes), puis Update. Si le token change, mets-le à jour dans Connecteurs.',
      })
    }
    res.status(500).json({ error: msg })
  }
})

export default router
