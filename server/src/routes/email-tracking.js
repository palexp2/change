import { Router } from 'express'
import { recordEmailOpen } from '../services/emailOpen.js'
import { isSelfHit } from '../services/emailTracking.js'

const router = Router()

// 1×1 transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64')

// GET /api/email-tracking/:emailId.gif — public (no auth) endpoint hit by recipients'
// email clients to load the open-tracking pixel. Increments emails.open_count.
router.get('/:emailId.gif', (req, res) => {
  if (!isSelfHit(req)) recordEmailOpen(req.params.emailId) // never throws — the pixel is always returned
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Content-Length': String(PIXEL.length),
  })
  res.end(PIXEL)
})

export default router
