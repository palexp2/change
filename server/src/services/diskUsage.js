import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const project = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '')
const within = (child, parent) => child === parent || child.startsWith(`${parent}/`)

// du reports allocated blocks, like df, and counts hard links only once across
// the entire scan. Never follow symlinks or cross onto another filesystem.
export function parseDiskSizes(output) {
  const sizes = new Map()
  for (const line of output.split('\n')) {
    const match = line.match(/^(\d+)\t(.+)$/)
    if (match) sizes.set(match[2], Number(match[1]))
  }
  return sizes
}

export function buildDiskBreakdown(sizes, used, { home = os.homedir(), repo = project } = {}) {
  const claimed = new Map()
  const groups = []
  function take(directory) {
    if ([...claimed.keys()].some(parent => within(directory, parent))) return 0
    const total = sizes.get(directory)
    if (total == null) return 0
    const children = [...claimed].filter(([child]) => within(child, directory))
    const bytes = Math.max(0, total - children.reduce((sum, [, bytes]) => sum + bytes, 0))
    for (const [child] of children) claimed.delete(child)
    claimed.set(directory, total)
    return bytes
  }
  function group(id, label, entries, description) {
    const details = entries.map(([label, directory]) => ({ label, bytes: take(directory) })).filter(item => item.bytes > 0)
    const bytes = details.reduce((sum, item) => sum + item.bytes, 0)
    if (bytes) groups.push({ id, label, bytes, details, ...(description ? { description } : {}) })
  }
  const uploads = `${repo}/server/uploads`
  const data = `${repo}/server/data`
  group('quotes', 'Soumissions archivées', [['Documents importés', `${uploads}/soumissions`]])
  group('calls', "Enregistrements d’appels", [
    ['Appels dans l’ERP', `${uploads}/calls`],
    ['Fichiers conservés sur le FTP', `${home}/ftp-server/uploads`],
  ], 'Le FTP conserve les fichiers sources après leur envoi à l’ERP. Les deux copies occupent de l’espace.')
  group('backups', 'Sauvegardes et archives', [
    ['Sauvegardes du serveur', `${home}/backups`],
    ['Sauvegardes de sécurité', `${data}/security-backups`],
    ['Archives de trésorerie', `${data}/treasury-sheet-backups`],
    ['Archives de base de données', `${uploads}/db-archive`],
    ['Sauvegardes de fichiers', `${uploads}/backups`],
  ])
  group('database', 'Base de données', [['Données et journaux SQLite', data]])
  group('documents', 'Documents et photos ERP', [
    ['Factures', `${uploads}/factures`],
    ['Pièces jointes', `${uploads}/attachments`],
    ['Photos et documents produits', `${uploads}/products`],
    ['Bons de livraison', `${uploads}/bons-livraison`],
    ['Reçus', `${uploads}/receipts`],
    ['Documents générés', `${uploads}/documents`],
    ['Autres fichiers ERP', uploads],
  ])
  const client = `${repo}/client`
  const webVersions = [...sizes.keys()].filter(directory => path.dirname(directory) === client && /^\.?dist(?:$|[.-])/.test(path.basename(directory)))
  group('web', 'Versions du site', webVersions.map(directory => [path.basename(directory) === 'dist' ? 'Version actuelle' : path.basename(directory), directory]))
  group('logs', 'Journaux du serveur', [['Journaux système', '/var/log'], ['Journaux des applications (PM2)', `${home}/.pm2/logs`]])
  group('caches', 'Caches et fichiers temporaires', [
    ['Cache des téléchargements Node', `${home}/.npm`], ['Caches des outils', `${home}/.cache`],
    ['Fichiers temporaires', '/tmp'], ['Fichiers temporaires ERP', `${repo}/server/tmp`], ['Caches système', '/var/cache'],
  ])
  group('tools', 'Outils de développement et IA', ['.claude', '.codex', '.local', '.npm-global', '.nvm'].map(name => [name, `${home}/${name}`]))
  group('erp', 'Application ERP', [
    ['Dépendances du serveur', `${repo}/server/node_modules`], ['Dépendances du site', `${client}/node_modules`],
    ['Historique du code', `${repo}/.git`], ['Code et ressources', repo],
  ])
  // Discover other services rather than silently putting growing directories
  // into a fixed catch-all. Previously claimed children are subtracted.
  group('services', 'Autres applications et fichiers', [...sizes.keys()]
    .filter(directory => path.dirname(directory) === home)
    .map(directory => [path.basename(directory), directory]).concat([['Fichiers du compte serveur', home]]))
  group('system', 'Système Linux', ['/usr', '/var', '/opt', '/boot', '/etc'].map(directory => [directory, directory]))
  const accounted = groups.reduce((sum, item) => sum + item.bytes, 0)
  if (used > accounted) groups.push({
    id: 'unallocated', label: 'Espace non ventilé', bytes: used - accounted, details: [],
    description: 'Dossiers inaccessibles, métadonnées du disque et fichiers supprimés encore ouverts.',
  })
  return groups.sort((a, b) => b.bytes - a.bytes)
}

// Stale-while-revalidate : la page Système doit répondre en quelques ms. `du`
// (0,6 à plusieurs s à froid) ne se fait jamais attendre — on sert la dernière
// mesure et on relance en arrière-plan quand elle a plus d'une minute. Tant
// qu'aucune mesure n'existe (juste après un redémarrage), la ventilation est
// vide et la prochaine actualisation de la page la montre.
let cached
let pending
function refreshDiskUsage() {
  if (pending) return pending
  pending = (async () => {
    const home = os.homedir()
    let output = ''
    let partial = false
    try {
      const result = await execFileAsync('du', ['-x', '-B1', '--max-depth=4', '--', home, '/var', '/usr', '/opt', '/tmp', '/boot', '/etc'], {
        timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' },
      })
      output = result.stdout
    } catch (error) {
      // du exits 1 for unreadable directories, but its readable totals remain useful.
      output = error.stdout || ''
      partial = true
    }
    const disk = await readDf()
    const value = {
      disk,
      diskBreakdown: disk ? buildDiskBreakdown(parseDiskSizes(output), disk.used) : [],
      diskMeasurement: { at: new Date().toISOString(), partial },
    }
    cached = { timestamp: Date.now(), value }
    return value
  })().catch(() => null).finally(() => { pending = null })
  return pending
}

async function readDf() {
  try {
    const { stdout } = await execFileAsync('df', ['-B1', '--output=size,used,avail', '/'], { timeout: 5000 })
    const [total, used, available] = stdout.trim().split('\n').at(-1).trim().split(/\s+/).map(Number)
    if ([total, used, available].every(Number.isFinite)) return { total, used, available }
  } catch { /* Keep other health metrics available when disk measurement fails. */ }
  return null
}

export async function getDiskUsage() {
  if (!cached || Date.now() - cached.timestamp >= 60_000) refreshDiskUsage()
  if (cached) return cached.value
  return { disk: await readDf(), diskBreakdown: [], diskMeasurement: null }
}
