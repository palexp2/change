// Collecteur Bell Mobilité (portail MyBell — mybell.bell.ca).
//
// Bell ne publie aucune API client et n'envoie pas la facture par courriel :
// elle n'existe que sur le portail, avec un délai (la fiche fournisseur note
// que la facture est datée du mois précédent et que le prélèvement passe le
// mois suivant — la collecte doit donc chercher large dans le passé).
//
// ⚠️ 2FA À CHAQUE CONNEXION : Bell envoie un code de validation à Mike. Tant
// qu'une session valide est en place (storage_state), la tournée passe sans
// rien demander ; dès qu'elle expire, la tournée s'arrête sur « code attendu »
// et quelqu'un doit saisir le code dans l'ERP. Prévoir soit l'import d'une
// session depuis un navigateur, soit une présence humaine à la relance.
//
// Ce collecteur est posé sans avoir pu explorer le portail (pas d'identifiants
// au moment de l'écriture). Il est donc volontairement bavard : il journalise
// tous les endpoints JSON de facturation croisés et capture la page, exactement
// la démarche qui a permis de trouver l'API interne de Wix. La première tournée
// réelle sert à calibrer.

const BILLS_URL = 'https://mybell.bell.ca/Bills'
// Auth0 : l'écran de connexion vit sur identification.bell.ca, pas sur mybell.
const LOGIN_HOST = /login|signin|authentication|identification\.bell\.ca/i

// Montant d'une ligne de facture : « 196,83 $ » ou « $196.83 ».
const MONEY = /(?:\$\s*([\d.,\s]+))|(?:([\d.,\s]+)\s*\$)/
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/
const FR_MONTHS = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
}
const deaccent = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function parseBellDate(text) {
  const iso = String(text || '').match(ISO_DATE)
  if (iso) return iso[0]
  const t = deaccent(text)
  let m = t.match(/(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})/)
  if (m && FR_MONTHS[m[2]]) return `${m[3]}-${String(FR_MONTHS[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`
  m = t.match(/([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (m && FR_MONTHS[m[1]]) return `${m[3]}-${String(FR_MONTHS[m[1]]).padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return null
}

export function parseBellAmount(text) {
  const m = String(text || '').match(MONEY)
  if (!m) return null
  const raw = (m[1] || m[2] || '').replace(/\s/g, '').replace(/,(\d{2})\b/, '.$1').replace(/,/g, '')
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : null
}

// Soumet le formulaire qui contient ce champ, sans passer par un clic ni par la
// touche Entrée : sur Auth0 les deux échouent — un label flottant intercepte
// les clics, et le bandeau de témoins avale la touche Entrée. `requestSubmit()`
// déclenche la validation HTML comme un vrai envoi (contrairement à submit()).
async function submitOwnForm(field) {
  const ok = await field.evaluate((el) => {
    const form = el.form
    if (!form) return false
    if (form.requestSubmit) form.requestSubmit()
    else form.submit()
    return true
  }).catch(() => false)
  if (!ok) await field.press('Enter').catch(() => {})
}

async function signIn(ctx) {
  const { page, log, credentials } = ctx
  log('connexion à MyBell…')
  // `networkidle` : /Login redirige vers Auth0 (identification.bell.ca) et c'est
  // seulement là que le formulaire — et le bandeau de témoins — existent.
  await page.goto('https://mybell.bell.ca/Login', { waitUntil: 'networkidle' })

  // Bandeau OneTrust : chargé tardivement, il recouvre le bas de la page. On
  // essaie de le fermer, sans en dépendre — il arrive après le premier passage
  // et la soumission ci-dessous fonctionne de toute façon avec lui à l'écran.
  const cookies = page.locator('#onetrust-accept-btn-handler')
  await cookies.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  if (await cookies.count()) {
    await cookies.click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(500)
  }

  // ⚠️ Deux pièges de cet écran, tous deux vérifiés en direct :
  //  1. un champ mot de passe MASQUÉ (`<input hidden class="hide">`) traîne sur
  //     l'écran d'identifiant — leurre anti-robot. Un `input[type="password"]`
  //     non qualifié le trouve et attend 20 s qu'il devienne visible. D'où
  //     `:visible` partout.
  //  2. un `<label for="username">` flottant INTERCEPTE les clics : cliquer le
  //     champ ou le bouton « Poursuivre » expire au bout de 10 s. Et tant que
  //     le bandeau de témoins est à l'écran, la touche Entrée ne soumet pas non
  //     plus. On remplit donc sans cliquer, puis on soumet le formulaire
  //     lui-même — seule voie qui ignore label flottant et recouvrement.
  const user = page.locator('#username, input[name="username"]').first()
  await user.waitFor({ state: 'visible', timeout: 20_000 })
  await user.fill(credentials.username)
  await submitOwnForm(user)
  await page.waitForURL(/\/u\/login\/password|mybell\.bell\.ca/i, { timeout: 20_000 }).catch(() => {})

  const pwd = page.locator('input[type="password"]:visible').first()
  await pwd.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  if (!(await pwd.count())) {
    await ctx.snapshot('bell-etape-mot-de-passe')
    throw new Error("MyBell n'a pas présenté de champ mot de passe — identifiant refusé ou écran inattendu, voir la capture")
  }
  await pwd.fill(credentials.password)
  await submitOwnForm(pwd)
  await page.waitForLoadState('networkidle').catch(() => {})

  // Code de validation envoyé par Bell (SMS ou courriel à Mike). Un secret TOTP
  // couvrirait le cas si Bell le proposait ; sinon la saisie est humaine.
  const otp = page.locator('input[autocomplete="one-time-code"]:visible, input[name*="code" i]:visible, input[inputmode="numeric"]:visible').first()
  if (await otp.count()) {
    const code = ctx.totp() || await ctx.askOtp('Code de validation Bell (envoyé à Mike)')
    await otp.fill(code)
    await submitOwnForm(otp)
    await page.waitForLoadState('networkidle').catch(() => {})
  }

  if (LOGIN_HOST.test(page.url())) {
    await ctx.snapshot('bell-login-echec')
    throw new Error('Connexion MyBell refusée — voir la capture de la tournée, ou importer une session ouverte à la main')
  }
  log('connecté')
}

export default {
  label: 'Bell Mobilité',
  fields: { username: 'Identifiant MyBell', password: 'Mot de passe', totp: 'Secret 2FA (optionnel)' },

  async list(ctx) {
    const { page, context, log } = ctx

    // Filet de diagnostic : tout PDF qui redescend est capturé, et les endpoints
    // JSON de facturation sont journalisés pour pouvoir les appeler directement
    // à la prochaine itération (c'est ainsi qu'on a trouvé l'API de Wix).
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

    await page.goto(BILLS_URL, { waitUntil: 'domcontentloaded' })
    if (LOGIN_HOST.test(page.url()) || await page.locator('input[type="password"]').count()) {
      await signIn(ctx)
      await page.goto(BILLS_URL, { waitUntil: 'domcontentloaded' })
    } else {
      log('session déjà valide')
    }
    await page.waitForLoadState('networkidle').catch(() => {})
    await ctx.snapshot('bell-factures')

    // Liens de facture de la page. Chaque ligne porte normalement une date et un
    // montant ; on remonte du lien jusqu'à l'ancêtre qui contient les deux.
    const rows = await page.$$eval(
      'a[href*="bill" i], a[href*="factur" i], a[href$=".pdf"], a[download], [data-testid*="bill" i] a',
      (els) => els.map((el) => {
        let node = el
        let row = ''
        for (let i = 0; i < 10 && node; i++) {
          const text = node.innerText || ''
          if (/\d/.test(text) && text.length > 12) { row = text; break }
          node = node.parentElement
        }
        return { href: el.getAttribute('href') || '', text: (el.innerText || '').trim(), row }
      }),
    )
    log(`${rows.length} lien(s) de facture détecté(s)`)
    if (rows.length === 0) {
      await ctx.snapshot('bell-aucun-lien')
      throw new Error("Aucun lien de facture sur MyBell — gabarit à calibrer à partir de la capture et des « API vue » du journal")
    }

    const seen = new Set()
    const out = []
    for (const r of rows) {
      const date = parseBellDate(r.row) || parseBellDate(r.text)
      const amount = parseBellAmount(r.row)
      // Sans date ni montant, ce lien n'est pas une ligne de facture.
      if (!date && amount == null) continue
      const externalId = `bell:${date || r.href.slice(-24)}`
      if (seen.has(externalId)) continue
      seen.add(externalId)

      const url = r.href.startsWith('http') ? r.href : `https://mybell.bell.ca${r.href}`
      out.push({
        externalId,
        date,
        amount,
        currency: 'CAD',
        filename: `Bell-${date || externalId}.pdf`,
        url,
        fetch: async () => {
          const res = await context.request.get(url, { timeout: 60_000 })
          const buffer = res.ok() ? await res.body() : null
          if (buffer && buffer.slice(0, 5).toString() === '%PDF-') return buffer
          // Le lien ouvre une visionneuse plutôt que le fichier : on retombe sur
          // le PDF que le filet réseau a capturé en naviguant dessus.
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
