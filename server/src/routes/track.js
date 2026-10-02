import { Router } from 'express'
import { recordEmailOpen } from '../services/emailOpen.js'
import { recordEmailClick, isSelfHit } from '../services/emailTracking.js'

const router = Router()

// 1x1 transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

// GET /api/track/email/:emailId.gif — public, no auth
router.get('/email/:emailId.gif', (req, res) => {
  if (!isSelfHit(req)) recordEmailOpen(req.params.emailId)

  res.setHeader('Content-Type', 'image/gif')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  res.setHeader('Pragma', 'no-cache')
  res.end(PIXEL)
})

// GET /api/track/click/:linkId — public, no auth. Lien suivi d'un courriel :
// compte le clic puis renvoie vers l'adresse d'origine.
router.get('/click/:linkId', (req, res) => {
  const url = recordEmailClick(req.params.linkId, { count: !isSelfHit(req) })
  if (!url) return res.status(404).type('text/plain').send('Lien introuvable')
  res.setHeader('Cache-Control', 'no-store')
  res.redirect(302, url)
})

export default router
