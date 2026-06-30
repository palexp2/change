#!/usr/bin/env node
// Génère client/src/lib/architectureManifest.js à partir de la structure réelle
// du code : routes de App.jsx, menu de navItems.js, mounts API de server/index.js,
// tables de schema.js, connecteurs. Re-lancer pour garder la carte à jour :
//   node scripts/gen-architecture.mjs   (lancé automatiquement en `prebuild`)
//
// Le script est volontairement tolérant : toute section qui échoue est ignorée
// (tableau vide) plutôt que de faire planter le build.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(__dirname, '..')
const ROOT = join(CLIENT, '..')
const SERVER = join(ROOT, 'server')

function read(path) {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

function safe(label, fn) {
  try { return fn() } catch (err) {
    console.warn(`[gen-architecture] section "${label}" ignorée : ${err.message}`)
    return []
  }
}

// ── 1. Routes (App.jsx) ──────────────────────────────────────────────────────
// Capture chaque <Route path="..." element={...}> : composant rendu, flags de
// permission, et redirections <Navigate to="...">.
function parseRoutes() {
  const src = read(join(CLIENT, 'src/App.jsx'))
  const re = /<Route\s+path="([^"]+)"\s+element=\{([\s\S]*?)\}\s*\/>/g
  const routes = []
  let m
  while ((m = re.exec(src))) {
    const path = m[1]
    const el = m[2]
    const redirect = el.match(/<Navigate\s+to="([^"]+)"/)
    if (redirect) {
      routes.push({ path, redirectTo: redirect[1] })
      continue
    }
    const comp = el.match(/<([A-Z]\w+)\s*\/>/)
    routes.push({
      path,
      component: comp ? comp[1] : null,
      adminOnly: /adminOnly/.test(el),
      hrOnly: /hrOnly/.test(el),
    })
  }
  return routes
}

// ── 2. Menu (navItems.js) ────────────────────────────────────────────────────
// Reconstruit la hiérarchie du menu de gauche : groupes → items {to,label,hrOnly}
// + items à plat + liens externes. Parsing ligne à ligne (le fichier est formaté
// un item par ligne).
function parseNav() {
  const src = read(join(CLIENT, 'src/lib/navItems.js'))
  const lines = src.split('\n')
  const groups = []
  const flat = []
  const externals = []
  let current = null
  for (const line of lines) {
    const gOpen = line.match(/group:\s*'([^']+)'.*items:\s*\[/)
    if (gOpen) { current = { group: gOpen[1], items: [] }; groups.push(current); continue }
    if (/^\s*\]\}/.test(line)) { current = null; continue }
    const ext = line.match(/external:\s*true.*href:\s*'([^']+)'.*label:\s*'([^']+)'/)
    if (ext) { externals.push({ href: ext[1], label: ext[2] }); continue }
    const item = line.match(/to:\s*'([^']+)'/)
    if (item) {
      const label = line.match(/label:\s*'([^']+)'/)
      const entry = { to: item[1], label: label ? label[1] : item[1], hrOnly: /hrOnly:\s*true/.test(line) }
      if (current) current.items.push(entry)
      else flat.push(entry)
    }
  }
  return { groups, flat, externals }
}

// ── 3. Mounts API (server/index.js) ──────────────────────────────────────────
function parseApi() {
  const src = read(join(SERVER, 'src/index.js'))
  const re = /app\.use\(\s*'(\/api\/[^']+)'/g
  const seen = new Set()
  const mounts = []
  let m
  while ((m = re.exec(src))) {
    if (seen.has(m[1])) continue
    seen.add(m[1])
    mounts.push(m[1])
  }
  return mounts.sort()
}

// ── 4. Tables (schema.js) ────────────────────────────────────────────────────
function parseTables() {
  const src = read(join(SERVER, 'src/db/schema.js'))
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)/g
  const tables = new Set()
  let m
  while ((m = re.exec(src))) tables.add(m[1])
  return [...tables].sort()
}

// ── 5. Connecteurs ───────────────────────────────────────────────────────────
function parseConnectors() {
  return readdirSync(join(SERVER, 'src/connectors'))
    .filter(f => f.endsWith('.js'))
    .map(f => f.replace(/\.js$/, ''))
    .sort()
}

// ── Assemblage du manifeste ──────────────────────────────────────────────────
const routes = safe('routes', parseRoutes)
const nav = safe('nav', parseNav) || { groups: [], flat: [], externals: [] }
const api = safe('api', parseApi)
const tables = safe('tables', parseTables)
const connectors = safe('connectors', parseConnectors)

const apiSet = new Set(api)
const routeByPath = new Map(routes.map(r => [r.path, r]))

// Pour un chemin de page, devine le mount API correspondant (best-effort) :
// premier segment du chemin → /api/<segment> s'il existe.
function guessApi(to) {
  const seg = to.replace(/^\//, '').split('/')[0]
  const candidate = `/api/${seg}`
  return apiSet.has(candidate) ? candidate : null
}

function enrich(item) {
  const route = routeByPath.get(item.to) || {}
  return {
    to: item.to,
    label: item.label,
    component: route.component || null,
    adminOnly: !!route.adminOnly,
    hrOnly: !!route.hrOnly || !!item.hrOnly,
    api: guessApi(item.to),
  }
}

const groups = (nav.groups || []).map(g => ({
  group: g.group,
  items: g.items.map(enrich),
}))
const flat = (nav.flat || []).map(enrich)

// Pages présentes dans le routeur mais absentes du menu (fiches détail, pages
// admin, redirections) — listées à part pour exhaustivité.
const navPaths = new Set([
  ...groups.flatMap(g => g.items.map(i => i.to)),
  ...flat.map(i => i.to),
])
const offMenu = routes
  .filter(r => r.component && !navPaths.has(r.path))
  .map(r => ({
    to: r.path,
    label: r.component,
    component: r.component,
    adminOnly: !!r.adminOnly,
    hrOnly: !!r.hrOnly,
    api: guessApi(r.path),
  }))

const manifest = {
  // Date figée à la génération — pas de Date.now() pour rester déterministe en CI.
  generatedAt: new Date().toISOString(),
  stats: {
    routes: routes.length,
    pages: navPaths.size + offMenu.length,
    groups: groups.length,
    api: api.length,
    tables: tables.length,
    connectors: connectors.length,
  },
  groups,
  flat,
  externals: nav.externals || [],
  offMenu,
  api,
  tables,
  connectors,
}

const out = `// ⚠️ FICHIER GÉNÉRÉ — ne pas éditer à la main.
// Source : client/scripts/gen-architecture.mjs (lancé en \`prebuild\`).
// Régénérer : cd client && node scripts/gen-architecture.mjs
export const architectureManifest = ${JSON.stringify(manifest, null, 2)}
`

writeFileSync(join(CLIENT, 'src/lib/architectureManifest.js'), out)
console.log(`[gen-architecture] OK — ${manifest.stats.pages} pages, ${api.length} mounts API, ${tables.length} tables, ${connectors.length} connecteurs`)
