// One-pager autonome : sert UN fichier de « Fichiers publics » (/public-files)
// sur son propre port, hors du processus erp-server, pour qu'un nom de domaine
// pointe dessus (nginx → ce port).
//
// Le fichier est relu en direct depuis l'ERP (ligne public_files, DB en lecture
// seule) : « Remplacer » dans l'ERP met donc le site à jour sans redémarrage.
//
// Variables : PUBLIC_FILE_ID (id de la ligne public_files), PORT.
import http from 'node:http'
import { createRequire } from 'node:module'
import { readFileSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '../../server')
const Database = createRequire(join(serverDir, 'package.json'))('better-sqlite3')

const FILE_ID = process.env.PUBLIC_FILE_ID
const PORT = Number(process.env.PORT) || 3010
const UPLOADS = join(serverDir, process.env.UPLOADS_PATH || 'uploads', 'public')
if (!FILE_ID) throw new Error('PUBLIC_FILE_ID manquant')

const db = new Database(join(serverDir, 'data/erp.db'), { readonly: true, fileMustExist: true })
const lookup = db.prepare('SELECT stored_name, mime_type FROM public_files WHERE id = ?')

// Cache du contenu (brut + gzip), invalidé quand le fichier change sur disque.
let cache = null
function load() {
  const row = lookup.get(FILE_ID)
  if (!row) return null
  const path = join(UPLOADS, row.stored_name)
  const { mtimeMs, size } = statSync(path)
  const key = `${row.stored_name}:${mtimeMs}:${size}`
  if (cache?.key !== key) {
    const raw = readFileSync(path)
    cache = { key, raw, gz: gzipSync(raw), type: row.mime_type || 'text/html; charset=utf-8', etag: `"${size.toString(36)}-${Math.round(mtimeMs).toString(36)}"` }
  }
  return cache
}

http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return }
  const path = req.url.split('?')[0]
  if (path === '/healthz') { res.writeHead(200).end('ok'); return }
  if (path !== '/' && path !== '/index.html') { res.writeHead(302, { Location: '/' }).end(); return }

  let page
  try { page = load() } catch (e) { console.error(e); page = null }
  if (!page) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Page introuvable'); return }

  const headers = { 'Content-Type': page.type, ETag: page.etag, 'Cache-Control': 'public, max-age=300', Vary: 'Accept-Encoding' }
  if (req.headers['if-none-match'] === page.etag) { res.writeHead(304, headers).end(); return }
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '')
  const body = gzip ? page.gz : page.raw
  if (gzip) headers['Content-Encoding'] = 'gzip'
  headers['Content-Length'] = body.length
  res.writeHead(200, headers)
  res.end(req.method === 'HEAD' ? undefined : body)
}).listen(PORT, () => console.log(`one-pager ${FILE_ID} → :${PORT}`))
