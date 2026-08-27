import { chromium } from 'playwright-core'
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

// Chromium : on réutilise celui que Playwright a déjà installé pour les tests
// E2E (~/.cache/ms-playwright). Contrairement à emailHtmlPdf.js — qui imprime
// une page statique et se contente du `headless_shell` — un collecteur navigue,
// se connecte et télécharge : il lui faut le binaire complet.
let cached
export function findChromium() {
  if (cached && existsSync(cached)) return cached
  const candidates = []
  if (process.env.SCRAPER_CHROMIUM_PATH) candidates.push(process.env.SCRAPER_CHROMIUM_PATH)
  const cache = join(process.env.HOME || '/root', '.cache', 'ms-playwright')
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache).sort().reverse()) {
      if (!dir.startsWith('chromium-')) continue
      candidates.push(join(cache, dir, 'chrome-linux', 'chrome'))
    }
  }
  candidates.push('/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome')
  cached = candidates.find(p => p && existsSync(p)) || null
  return cached
}

// Un headless « nu » se fait repérer (navigator.webdriver, UA HeadlessChrome,
// pas de plugins). Ces portails sont les nôtres et on s'y connecte avec nos
// propres identifiants — l'objectif n'est pas de contourner une protection mais
// d'éviter les faux positifs anti-bot qui bloqueraient un accès légitime.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

const STEALTH = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  Object.defineProperty(navigator, 'languages', { get: () => ['fr-CA', 'fr', 'en-US'] })
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
  window.chrome = window.chrome || { runtime: {} }
`

export function chromiumAvailable() {
  return !!findChromium()
}

/**
 * Ouvre un navigateur + contexte prêts à naviguer sur un portail fournisseur.
 * @param {object|null} storageState session Playwright persistée (cookies)
 */
export async function launchContext({ storageState = null, downloadsDir = null } = {}) {
  const executablePath = findChromium()
  if (!executablePath) throw new Error('Chromium introuvable — installer Playwright ou définir SCRAPER_CHROMIUM_PATH')
  if (downloadsDir && !existsSync(downloadsDir)) mkdirSync(downloadsDir, { recursive: true })

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  })
  const context = await browser.newContext({
    storageState: storageState || undefined,
    acceptDownloads: true,
    locale: 'fr-CA',
    timezoneId: 'America/Toronto',
    viewport: { width: 1440, height: 900 },
    userAgent: UA,
  })
  await context.addInitScript(STEALTH)
  context.setDefaultTimeout(30_000)
  context.setDefaultNavigationTimeout(45_000)
  return { browser, context }
}

/**
 * Capture d'écran + HTML de la page courante, écrits dans le dossier de la
 * tournée. C'est ce qui rend un sélecteur cassé diagnosticable sans relancer
 * le collecteur à l'aveugle.
 */
export async function snapshot(page, dir, name) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const png = join(dir, `${name}.png`)
    await page.screenshot({ path: png, fullPage: true })
    writeFileSync(join(dir, `${name}.html`), await page.content())
    return `${name}.png`
  } catch {
    return null
  }
}
