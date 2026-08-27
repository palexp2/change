import { spawn } from 'child_process'
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

// Rendu FIDÈLE d'une facture reçue dans le corps HTML d'un courriel (Webflow,
// Manychat, Stripe…) : le HTML est imprimé en PDF par un Chromium headless, ce
// qui préserve la mise en page, les tableaux et les images distantes — le PDF
// obtenu est la facture telle que l'utilisateur la voit dans Gmail, et son
// calque texte reste exploitable par pdftotext pour l'extraction.
// Aucun binaire n'est ajouté au projet : on réutilise le Chromium installé par
// Playwright (~/.cache/ms-playwright), surchargé au besoin par CHROMIUM_PATH.
// En l'absence de tout Chromium, l'appelant retombe sur buildEmailBodyPdf
// (rendu texte pdfkit) — le pipeline ne casse jamais.

let cachedChromium

export function findChromium() {
  if (cachedChromium && existsSync(cachedChromium)) return cachedChromium
  const candidates = []
  if (process.env.CHROMIUM_PATH) candidates.push(process.env.CHROMIUM_PATH)
  const playwrightCache = join(process.env.HOME || '/root', '.cache', 'ms-playwright')
  if (existsSync(playwrightCache)) {
    // Tri décroissant : en présence de plusieurs révisions, prendre la plus récente.
    const dirs = readdirSync(playwrightCache).sort().reverse()
    for (const prefix of ['chromium_headless_shell-', 'chromium-']) {
      for (const dir of dirs) {
        if (!dir.startsWith(prefix)) continue
        for (const bin of ['headless_shell', 'chrome']) {
          candidates.push(join(playwrightCache, dir, 'chrome-linux', bin))
        }
      }
    }
  }
  candidates.push('/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome')
  cachedChromium = candidates.find(p => p && existsSync(p)) || null
  return cachedChromium
}

const escapeHtml = s => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Le HTML vient de l'extérieur : on retire tout contenu actif avant de le
// donner à Chromium. Le flag officiel `--blink-settings=scriptEnabled=false`
// fait échouer silencieusement `--print-to-pdf` (aucun fichier produit) et
// `--disable-javascript` n'est pas honoré par le renderer — l'assainissement
// se fait donc côté Node. Pas un sanitizer exhaustif : le modèle de menace est
// un courriel de fournisseur imprimé dans un headless jetable sans session ;
// l'objectif est de ne jamais exécuter de script, pas de résister à du HTML
// adversarial arbitraire.
export function stripActiveContent(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/<\/?(iframe|object|embed)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\b(href|src)\s*=\s*(["']?)\s*javascript:[^"'>\s]*/gi, '$1=$2#')
}

// Bandeau de traçabilité (sujet / expéditeur / date) + garde-fous d'impression :
// les couleurs de fond des gabarits de facture sont conservées et les images
// larges ramenées à la page. Chromium tolère ce préambule même quand `html`
// est déjà un document complet.
function buildPrintableDocument({ subject, from, date, html }) {
  return `<!doctype html><meta charset="utf-8">
<style>
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  img { max-width: 100% !important; }
  .erp-email-meta { font: 9px/1.5 Helvetica, Arial, sans-serif; color: #555;
    border-bottom: 1px solid #ddd; padding: 0 0 6px; margin: 0 0 12px; }
</style>
<div class="erp-email-meta">
  <strong>${escapeHtml(subject || '(sans objet)')}</strong><br>
  ${from ? `De : ${escapeHtml(from)}` : ''}${from && date ? ' — ' : ''}${escapeHtml(date || '')}
</div>
${stripActiveContent(html)}`
}

/**
 * Imprime le corps HTML d'un courriel en PDF via Chromium headless.
 * Rejette si aucun Chromium n'est disponible ou si le rendu échoue/expire —
 * l'appelant doit prévoir le repli texte (buildEmailBodyPdf).
 * @returns {Promise<Buffer>}
 */
export async function renderEmailHtmlPdf({ subject, from, date, html }, { timeoutMs = 45000 } = {}) {
  if (!html) throw new Error('corps HTML vide')
  const chromium = findChromium()
  if (!chromium) throw new Error('aucun binaire Chromium disponible (CHROMIUM_PATH non défini, cache Playwright absent)')

  const stamp = randomUUID()
  const htmlPath = join(tmpdir(), `erp-email-${stamp}.html`)
  const pdfPath = join(tmpdir(), `erp-email-${stamp}.pdf`)
  writeFileSync(htmlPath, buildPrintableDocument({ subject, from, date, html }))

  const args = [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // Horloge virtuelle : laisse le temps aux images distantes (logos, gabarits
    // hébergés chez le fournisseur) de se charger avant l'impression.
    '--virtual-time-budget=15000',
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`,
    `file://${htmlPath}`,
  ]

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(chromium, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', c => { stderr += c })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`Chromium expiré après ${timeoutMs} ms`))
      }, timeoutMs)
      child.on('error', e => { clearTimeout(timer); reject(e) })
      child.on('close', code => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`Chromium code ${code} : ${stderr.slice(0, 300)}`))
      })
    })
    const buffer = readFileSync(pdfPath)
    if (buffer.length < 100 || !buffer.subarray(0, 5).toString().startsWith('%PDF')) {
      throw new Error('sortie Chromium invalide (pas un PDF)')
    }
    return buffer
  } finally {
    for (const p of [htmlPath, pdfPath]) { try { unlinkSync(p) } catch {} }
  }
}
