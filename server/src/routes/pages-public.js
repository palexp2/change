// Pages hébergées avec acceptation — API PUBLIQUE du bloc injecté
// (client/public/page-accept.js). Pas de requireAuth : le jeton du fichier
// (32 hex) est le secret. Chaque visiteur accepte pour lui-même (nom + case) ;
// le client est reconnu par ?contact=<id> (id aléatoire, mis par le modèle de
// courriel) — sans lui, il est traité en nouveau client.

import { Router } from 'express'
import db from '../db/database.js'
import { APP_URL } from '../config/appUrl.js'
import { getPageByToken, pagePublicUrl, archiveAcceptedVersion, pageText, pageVariant, isExistingCustomer } from '../services/hostedPages.js'

const router = Router()

const contactOf = id => (id ? db.prepare('SELECT id, email FROM contacts WHERE id = ? AND deleted_at IS NULL').get(String(id).slice(0, 64)) || null : null)

function view(page, acceptance = null, contact = null) {
  return {
    language: page.config.language,
    existing: isExistingCustomer(contact?.id || acceptance?.contact_id),
    accepted: acceptance ? { id: acceptance.id, name: acceptance.name, at: acceptance.at } : null,
    has_payment: !!acceptance && page.config.hasPayment,
  }
}

// Acceptation déjà faite par ce contact sur la version actuelle : réaffichée.
function findAcceptance(page, contact) {
  if (!contact) return null
  return db.prepare(`SELECT * FROM page_acceptances WHERE public_file_id=? AND contact_id=? AND hash=?
    ORDER BY at DESC LIMIT 1`).get(page.id, contact.id, page.hash) || null
}

// GET /api/public/pages/legacy-contract/:token — ancien lien /contrat/<jeton>
// (outil Contrats retiré) → adresse de la page hébergée qui l'a remplacé.
router.get('/legacy-contract/:token', (req, res) => {
  const row = db.prepare(`SELECT f.token FROM contracts c JOIN public_files f ON f.id = c.moved_to_file_id
    WHERE c.token = ?`).get(String(req.params.token || ''))
  if (!row) return res.status(404).json({ error: 'Contrat introuvable' })
  res.json({ url: pagePublicUrl(row.token) })
})

// GET /api/public/pages/:token?contact=
router.get('/:token', (req, res) => {
  const page = getPageByToken(req.params.token)
  if (!page) return res.status(404).json({ error: 'Page introuvable' })
  const contact = contactOf(req.query.contact)
  res.json(view(page, findAcceptance(page, contact), contact))
})

// POST /api/public/pages/:token/accept — { name, agree, contact }
router.post('/:token/accept', (req, res) => {
  const page = getPageByToken(req.params.token)
  if (!page) return res.status(404).json({ error: 'Page introuvable' })
  const name = String(req.body?.name || '').trim().slice(0, 200)
  if (!name) return res.status(400).json({ error: 'Nom requis' })
  if (!req.body?.agree) return res.status(400).json({ error: 'Consentement requis' })
  // Contact reconnu par l'id du lien : email_verified = client identifié.
  const contact = contactOf(req.body?.contact)
  const email = contact?.email || null
  try { archiveAcceptedVersion(page) } catch (e) { console.error('page archive:', e.message) }
  const r = db.prepare(`INSERT INTO page_acceptances (public_file_id, name, email, email_verified, contact_id, hash, text, ip, user_agent)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(page.id, name, email, contact ? 1 : 0, contact?.id || null, page.hash, pageText(pageVariant(page.html, isExistingCustomer(contact?.id))), req.ip || null, String(req.get('user-agent') || '').slice(0, 400))
  res.json(view(page, db.prepare('SELECT * FROM page_acceptances WHERE id=?').get(r.lastInsertRowid)))
})

// POST /api/public/pages/:token/pay — { acceptance_id } : renvoie l'URL de paiement
router.post('/:token/pay', (req, res) => {
  const page = getPageByToken(req.params.token)
  const a = page && db.prepare('SELECT * FROM page_acceptances WHERE id=? AND public_file_id=?').get(Number(req.body?.acceptance_id) || 0, page.id)
  if (!a || !page.config.hasPayment) return res.status(404).json({ error: 'Paiement indisponible' })
  res.json({ url: `${APP_URL}/erp/pay/page/${encodeURIComponent(page.token)}/${a.id}` })
})

export default router
