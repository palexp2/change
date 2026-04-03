import { Router } from 'express'
import db from '../db/database.js'

const router = Router()

// 1x1 transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

// GET /api/track/email/:emailId.gif — public, no auth
router.get('/email/:emailId.gif', (req, res) => {
  const emailId = req.params.emailId
  try {
    db.prepare('UPDATE emails SET open_count = open_count + 1 WHERE id = ?').run(emailId)
  } catch { /* silently ignore */ }

  res.setHeader('Content-Type', 'image/gif')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  res.setHeader('Pragma', 'no-cache')
  res.end(PIXEL)
})

export default router
