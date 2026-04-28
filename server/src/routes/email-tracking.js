import { Router } from 'express'
import db from '../db/database.js'

const router = Router()

// 1×1 transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64')

// GET /api/email-tracking/:emailId.gif — public (no auth) endpoint hit by recipients'
// email clients to load the open-tracking pixel. Increments emails.open_count.
router.get('/:emailId.gif', (req, res) => {
  const { emailId } = req.params
  try {
    db.prepare(
      "UPDATE emails SET open_count = COALESCE(open_count, 0) + 1 WHERE id=?"
    ).run(emailId)
  } catch {} // never fail the request — return the pixel regardless
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Content-Length': String(PIXEL.length),
  })
  res.end(PIXEL)
})

export default router
