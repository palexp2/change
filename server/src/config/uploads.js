import path from 'node:path'
import fs from 'node:fs'

export function uploadsPath(...segments) {
  return path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads', ...segments)
}

export function ensureUploadsDir(...segments) {
  const dir = uploadsPath(...segments)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
