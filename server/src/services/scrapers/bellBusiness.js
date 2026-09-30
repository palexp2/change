// Collecteur Bell Affaires (Libre-service — business.bell.ca/Self-Serve).
//
// Distinct de bell.js : MyBell est le portail grand public (Auth0), le
// Libre-service Affaires est une application SiteMinder avec son propre
// compte et ses propres factures d'entreprise. Les deux peuvent coexister.
//
// Vérifié sans session (2026-09-29) : toute page `/Self-Serve/*` répond 302
// vers `/self-serve/secure/login?...REALMOID=...`, et ce formulaire poste sur
// lui-même avec les champs `USER` / `PASSWORD`. Un bloc captcha (`#loginCaptcha`,
// `#loginv2Captcha`) existe dans la page et se déclenche selon le contexte : il
// n'est pas franchissable sans humain, d'où l'arrêt net avec le geste à faire.
//
// Les pages de facturation du Libre-service n'ont pas pu être explorées (pas
// d'identifiants à l'écriture) : le collecteur ne devine aucun chemin de PDF,
// il part de la section facturation et suit les liens plausibles, en
// journalisant les PDF et les appels de facturation croisés pour calibrer au
// premier vrai passage — même démarche que bell.js et digikey.js.

const ORIGIN = 'https://business.bell.ca'
const HOME_URL = `${ORIGIN}/Self-Serve/`
const BILLING_URLS = [`${ORIGIN}/Self-Serve/Billing`, `${ORIGIN}/Self-Serve/`]
const LOGIN_MARKER = /\/self-serve\/secure\/login/i

const NEEDS_SESSION =
  "Le Libre-service Bell Affaires demande une vérification « je ne suis pas un robot » — se connecter à la main dans un navigateur, puis envoyer la session à l'ERP depuis le module de navigateur."

const MONEY = /(?:\$\s*([\d.,\s]+))|(?:([\d.,\s]+)\s*\$)/
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/
const MONTHS = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
}
const deaccent = v => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function parseBellBusinessDate(text) {
  const direct = String(text || '').match(ISO_DATE)
  if (direct) return direct[0]
  const t = deaccent(text)
  let m = t.match(/(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})/)
  if (m && MONTHS[m[2]]) return `${m[3]}-${String(MONTHS[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`
  m = t.match(/([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (m && MONTHS[m[1]]) return `${m[3]}-${String(MONTHS[m[1]]).padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return null
}

export function parseBellBusinessAmount(text) {
  const m = String(text || '').match(MONEY)
  if (!m) return null
  const raw = (m[1] || m[2] || '').replace(/\s/g, '').replace(/,(\d{2})\b/, '.$1').replace(/,/g, '')
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : null
}

export async function captchaPresent(page) {
  const visible = await page.locator('#loginCaptcha, #loginv2Captcha, .g-recaptcha, iframe[src*="recaptcha"]')
    .first().isVisible({ timeout: 1500 }).catch(() => false)
  return !!visible
}

async function signIn(ctx) {
  const { page, log, credentials } = ctx
  log('connexion au Libre-service Bell Affaires…')
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})

  const cookies = page.locator('#onetrust-accept-btn-handler').first()
  await cookies.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  if (await cookies.count()) {
    await cookies.click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(500)
  }

  const user = page.locator('#USER, input[name="USER"]').first()
  await user.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  if (!(await user.count())) {
    await ctx.snapshot('bell-affaires-login-introuvable')
    if (await captchaPresent(page)) throw new Error(NEEDS_SESSION)
    throw new Error("Le formulaire du Libre-service Bell Affaires n'a pas été trouvé — voir la capture de la tournée")
  }
  await user.fill(credentials.username)

  const pwd = page.locator('#PASSWORD, input[name="PASSWORD"], input[type="password"]:visible').first()
  await pwd.waitFor({ state: 'visible', timeout: 20_000 })
  await pwd.fill(credentials.password)

  if (await captchaPresent(page)) {
    await ctx.snapshot('bell-affaires-captcha')
    throw new Error(NEEDS_SESSION)
  }

  await pwd.press('Enter').catch(() => {})
  await page.locator('#loginForm button[type="submit"], #loginForm input[type="submit"], button:has-text("Ouvrir une session"), button:has-text("Sign in")')
    .first().click({ timeout: 5000 }).catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})

  const otp = page.locator('input[autocomplete="one-time-code"]:visible, input[name*="code" i]:visible, input[inputmode="numeric"]:visible').first()
  if (await otp.count()) {
    const code = ctx.totp() || await ctx.askOtp('Code de validation Bell Affaires')
    await otp.fill(code)
    await otp.press('Enter').catch(() => {})
    await page.waitForLoadState('networkidle').catch(() => {})
  }

  if (LOGIN_MARKER.test(page.url())) {
    if (await captchaPresent(page)) {
      await ctx.snapshot('bell-affaires-captcha-apres-envoi')
      throw new Error(NEEDS_SESSION)
    }
    const alert = await page.locator('#divLoginValidationMessages, #divLoginEmptyMessages, [role="alert"]').first()
      .innerText().then(t => t.trim().slice(0, 160)).catch(() => '')
    await ctx.snapshot('bell-affaires-login-echec')
    throw new Error(alert
      ? `Connexion Bell Affaires refusée — ${alert}`
      : 'Connexion Bell Affaires refusée — identifiants à vérifier, ou envoyer une session ouverte à la main')
  }
  log('connecté')
}

export default {
  label: 'Bell Affaires',
  fields: { username: 'Identifiant du Libre-service Bell Affaires', password: 'Mot de passe', totp: 'Secret 2FA (optionnel)' },

  async list(ctx) {
    const { page, context, log } = ctx

    const captured = new Map()
    page.on('response', async (res) => {
      try {
        const type = (res.headers()['content-type'] || '').toLowerCase()
        const url = res.url()
        if (type.includes('pdf') || /\.pdf(\?|$)/i.test(url)) {
          if (!captured.has(url)) captured.set(url, Buffer.from(await res.body()))
          log(`📄 PDF capturé : ${url.slice(0, 120)}`)
        } else if (type.includes('json') && /bill|invoice|factur|statement/i.test(url)) {
          log(`↪︎ API vue : ${url.slice(0, 160)}`)
        }
      } catch { /* corps déjà consommé ou réponse annulée */ }
    })

    await page.goto(BILLING_URLS[0], { waitUntil: 'domcontentloaded' })
    if (LOGIN_MARKER.test(page.url()) || await page.locator('input[name="PASSWORD"]').count()) {
      await signIn(ctx)
      await page.goto(BILLING_URLS[0], { waitUntil: 'domcontentloaded' }).catch(() => {})
    } else {
      log('session déjà valide')
    }
    await page.waitForLoadState('networkidle').catch(() => {})

    if (LOGIN_MARKER.test(page.url())) {
      await ctx.snapshot('bell-affaires-refuse')
      throw new Error('Le Libre-service Bell Affaires reste inaccessible après connexion — voir la capture')
    }

    // La section « Factures » n'a pas d'URL connue d'avance : si la page de
    // facturation n'existe pas telle quelle, on la cherche depuis l'accueil.
    const hasLinks = async () => await page.locator(
      'a[href*="bill" i], a[href*="invoice" i], a[href*="factur" i], a[href$=".pdf"], a[download]'
    ).count()

    if (!(await hasLinks())) {
      await page.goto(BILLING_URLS[1], { waitUntil: 'networkidle' }).catch(() => {})
      const entry = page.locator('a:has-text("Factur"), a:has-text("Bill"), a:has-text("Invoice")').first()
      if (await entry.count()) {
        await entry.click({ timeout: 10_000 }).catch(() => {})
        await page.waitForLoadState('networkidle').catch(() => {})
      }
    }
    await ctx.snapshot('bell-affaires-factures')

    const rows = await page.$$eval(
      'a[href*="bill" i], a[href*="invoice" i], a[href*="factur" i], a[href$=".pdf"], a[download]',
      els => els.map((el) => {
        let node = el
        let row = ''
        for (let i = 0; i < 10 && node; i++) {
          const text = node.innerText || ''
          if (/\d/.test(text) && text.length > 12) { row = text; break }
          node = node.parentElement
        }
        return { href: el.getAttribute('href') || '', text: (el.innerText || '').trim(), row }
      }),
    ).catch(() => [])
    log(`${rows.length} lien(s) de facture détecté(s)`)
    if (rows.length === 0) {
      await ctx.snapshot('bell-affaires-aucun-lien')
      throw new Error("Aucun lien de facture au Libre-service Bell Affaires — gabarit à calibrer à partir de la capture et des « API vue » du journal")
    }

    const seen = new Set()
    const out = []
    for (const r of rows) {
      const date = parseBellBusinessDate(r.row) || parseBellBusinessDate(r.text)
      const amount = parseBellBusinessAmount(r.row)
      if (!date && amount == null) continue
      const externalId = `bell-affaires:${date || r.href.slice(-24)}`
      if (seen.has(externalId)) continue
      seen.add(externalId)

      const url = r.href.startsWith('http') ? r.href : `${ORIGIN}${r.href.startsWith('/') ? '' : '/'}${r.href}`
      out.push({
        externalId,
        date,
        amount,
        currency: 'CAD',
        filename: `Bell-Affaires-${date || externalId}.pdf`,
        url,
        fetch: async () => {
          const res = await context.request.get(url, { timeout: 60_000 })
          const buffer = res.ok() ? await res.body() : null
          if (buffer && buffer.slice(0, 5).toString() === '%PDF-') return buffer
          // Lien qui ouvre une visionneuse : on récupère le PDF passé au filet.
          await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {})
          const late = [...captured.values()].pop()
          if (late) return late
          throw new Error(`réponse non-PDF (HTTP ${res.status()})`)
        },
      })
    }
    return out
  },
}
