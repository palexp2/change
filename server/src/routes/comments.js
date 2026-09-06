// Fil de commentaires + @mentions attaché à n'importe quel enregistrement.
//
// Contrairement à InteractionTimeline (historique en lecture seule des
// appels/emails/notes), `record_comments` est un vrai fil collaboratif : un
// utilisateur peut commenter une fiche (commande, entreprise, contact, ticket…)
// et mentionner un collègue avec @. Chaque @mention crée une notification
// in-app (service notifications.js) pointant vers la fiche, et le fil se met à
// jour en temps réel sur le canal `comments:<type>:<id>`.

import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { emit } from '../services/realtime.js'
import { createNotification } from '../services/notifications.js'

const router = Router()
router.use(requireAuth)

// record_type -> URL de la fiche détail. Sert à la fois de whitelist (un type
// absent est refusé) et de cible des deep-links de notification.
const RECORD_ROUTES = {
  order: id => `/orders/${id}`,
  company: id => `/companies/${id}`,
  contact: id => `/contacts/${id}`,
  ticket: id => `/tickets/${id}`,
  project: id => `/projects/${id}`,
  product: id => `/products/${id}`,
  facture: id => `/factures/${id}`,
  soumission: id => `/soumissions/${id}`,
  envoi: id => `/envois/${id}`,
  retour: id => `/retours/${id}`,
  serial: id => `/serials/${id}`,
  abonnement: id => `/abonnements/${id}`,
  sale_receipt: id => `/sale-receipts/${id}`,
  employee: id => `/employees/${id}`,
}

const TYPE_LABELS = {
  order: 'la commande', company: "l'entreprise", contact: 'le contact',
  ticket: 'le ticket', project: 'le projet', product: 'le produit',
  facture: 'la facture', soumission: 'la soumission', envoi: "l'envoi",
  retour: 'le retour', serial: 'le numéro de série', abonnement: "l'abonnement",
  sale_receipt: 'le reçu de vente', employee: "l'employé",
}

const channelFor = (type, id) => `comments:${type}:${id}`

// Résout les ids de mentions en {id, name} pour l'affichage côté client.
function serialize(row) {
  let ids = []
  try { ids = JSON.parse(row.mentions || '[]') } catch {}
  let mention_users = []
  if (ids.length) {
    const ph = ids.map(() => '?').join(',')
    mention_users = db.prepare(`SELECT id, name FROM users WHERE id IN (${ph})`).all(...ids)
  }
  return { ...row, mentions: ids, mention_users }
}

function fetchRow(id) {
  return serialize(db.prepare(
    `SELECT c.*, u.name AS author_name
     FROM record_comments c LEFT JOIN users u ON c.author_id = u.id
     WHERE c.id = ?`
  ).get(id))
}

// Filtre une liste d'ids de mentions : ne garde que les utilisateurs actifs.
function validateMentions(raw) {
  const ids = [...new Set((Array.isArray(raw) ? raw : []).filter(Boolean).map(String))]
  if (!ids.length) return []
  const ph = ids.map(() => '?').join(',')
  return db.prepare(`SELECT id FROM users WHERE id IN (${ph}) AND active = 1`).all(...ids).map(r => r.id)
}

// GET /api/comments?record_type=&record_id= — fil chronologique d'une fiche.
router.get('/', (req, res) => {
  const { record_type, record_id } = req.query
  if (!record_type || !record_id) {
    return res.status(400).json({ error: 'record_type et record_id requis' })
  }
  const rows = db.prepare(
    `SELECT c.*, u.name AS author_name
     FROM record_comments c LEFT JOIN users u ON c.author_id = u.id
     WHERE c.record_type = ? AND c.record_id = ? AND c.deleted_at IS NULL
     ORDER BY c.created_at ASC, c.id ASC`
  ).all(String(record_type), String(record_id))
  res.json({ data: rows.map(serialize) })
})

// POST /api/comments — ajoute un commentaire et notifie les @mentions.
router.post('/', (req, res) => {
  const { record_type, record_id, body } = req.body || {}
  if (!record_type || !record_id) {
    return res.status(400).json({ error: 'record_type et record_id requis' })
  }
  if (!RECORD_ROUTES[record_type]) {
    return res.status(400).json({ error: `record_type inconnu : ${record_type}` })
  }
  if (!body || !String(body).trim()) {
    return res.status(400).json({ error: 'Commentaire vide' })
  }

  const mentions = validateMentions(req.body.mentions)
  const id = newRecordId()
  db.prepare(
    `INSERT INTO record_comments (id, record_type, record_id, author_id, body, mentions)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, String(record_type), String(record_id), req.user.id, String(body).trim(), JSON.stringify(mentions))

  const row = fetchRow(id)
  try {
    emit([channelFor(record_type, record_id)], {
      type: 'comment:created', payload: row, actorUserId: req.user.id, ts: Date.now(),
    })
  } catch {}

  // Une notification in-app par utilisateur mentionné (createNotification
  // ignore l'auto-mention : actorUserId === userId).
  const link = RECORD_ROUTES[record_type](record_id)
  const label = TYPE_LABELS[record_type] || record_type
  for (const uid of mentions) {
    createNotification({
      userId: uid,
      type: 'comment:mention',
      title: `${req.user.name} vous a mentionné sur ${label}`,
      body: String(body).trim().slice(0, 160),
      link,
      actorUserId: req.user.id,
    })
  }

  res.status(201).json(row)
})

// PATCH /api/comments/:id — édition du corps (auteur uniquement).
router.patch('/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM record_comments WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!c) return res.status(404).json({ error: 'Commentaire introuvable' })
  if (c.author_id !== req.user.id) return res.status(403).json({ error: 'Seul l\'auteur peut modifier ce commentaire' })

  const { body } = req.body || {}
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Commentaire vide' })

  const mentions = req.body.mentions !== undefined ? validateMentions(req.body.mentions) : JSON.parse(c.mentions || '[]')
  db.prepare(
    `UPDATE record_comments
     SET body = ?, mentions = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`
  ).run(String(body).trim(), JSON.stringify(mentions), c.id)

  const row = fetchRow(c.id)
  try {
    emit([channelFor(c.record_type, c.record_id)], {
      type: 'comment:updated', payload: row, actorUserId: req.user.id, ts: Date.now(),
    })
  } catch {}
  res.json(row)
})

// DELETE /api/comments/:id — soft delete (auteur ou admin).
router.delete('/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM record_comments WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!c) return res.status(404).json({ error: 'Commentaire introuvable' })
  if (c.author_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Suppression réservée à l\'auteur ou à un admin' })
  }
  db.prepare(
    `UPDATE record_comments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
  ).run(c.id)
  try {
    emit([channelFor(c.record_type, c.record_id)], {
      type: 'comment:deleted', payload: { id: c.id }, actorUserId: req.user.id, ts: Date.now(),
    })
  } catch {}
  res.json({ deleted: c.id })
})

export default router
