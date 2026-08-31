// Collecteur Simplex Wireless (portail client — portal.simplexwireless.com).
//
// Simplex fournit les SIM IoT des contrôleurs ; ses factures n'arrivent pas par
// courriel et n'ont pas d'API publique — elles vivent derrière le portail.
//
// Ce qui a été VÉRIFIÉ sans identifiants (sondage des routes publiques) :
//   • portal.simplexwireless.com est une app .NET dont la seule route serveur
//     est `/Home` (`/Index` = retour OIDC) ; tout le reste répond 404. Aucune
//     page « /Invoices » à deviner : la liste est rendue côté client, il faut
//     donc la CHERCHER dans l'interface une fois connecté.
//   • la connexion passe par Azure AD B2C (tokenmanagement.b2clogin.com,
//     politique `b2c_1_ref_si_sx`) : page unifiée `#localAccountForm` + `#next`.
//
// ⚠️ CODE DE VÉRIFICATION : B2C envoie un code à usage unique par courriel
// (durée de vie courte, ~5 min). On ne le demande donc à l'utilisateur QU'APRÈS
// avoir déclenché son envoi, via `ctx.askOtp` — le champ de saisie apparaît
// alors dans l'ERP (page Collecte de factures) et la tournée reprend dès qu'un
// code est saisi. Un secret TOTP, s'il est renseigné sur le compte, court-
// circuite l'attente humaine.
//
// Comme bell.js/digikey.js, ce collecteur est volontairement bavard tant qu'un
// vrai passage ne l'a pas calibré : il capture les PDF qui redescendent et
// journalise les endpoints JSON de facturation croisés, ce qui a permis de
// trouver l'API interne de Wix.

const PORTAL_URL = 'https://portal.simplexwireless.com/Home'
const ORIGIN = 'https://portal.simplexwireless.com'
// Écran de connexion : hébergé par Azure AD B2C, pas par le portail.
const LOGIN_HOST = /b2clogin\.com|login\.microsoftonline\.com/i

// Montant collé à un « $ ». Le garde en tête (`(?<![\d\-/.,])`) est ce qui
// empêche la fin d'une date d'être avalée comme des milliers : dans
// « 2026-07-31 128,74 $ », sans lui, le montant lu serait 31 128,74 $.
const MONEY = /(?<![\d\-/.,])(?:\$\s*(\d[\d\s.,]*)|(\d[\d\s.,]*?)\s*\$)/
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/
const NUM_DATE = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/
const MONTHS = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
}
// Numéro de facture quand le portail en affiche un : c'est le seul identifiant
// vraiment stable d'une tournée à l'autre (la date, elle, peut être formatée
// autrement selon la locale du compte).
// Le `(?![-/\d])` final évite de prendre l'année d'une date qui suit le mot
// « Facture » (« Facture 2026-06-30 » n'est pas la facture n° 2026).
const INVOICE_NO = /\b(?:facture|invoice|inv)[\s:#-]*(?:no\.?|n[°o])?[\s:#-]*([A-Z]{0,4}-?\d{3,12})(?![-/\d])/i

const deaccent = v => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function parseSimplexDate(text) {
  const iso = String(text || '').match(ISO_DATE)
  if (iso) return iso[0]
  const t = deaccent(text)
  let m = t.match(/(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})/)
  if (m && MONTHS[m[2]]) return `${m[3]}-${String(MONTHS[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`
  m = t.match(/([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (m && MONTHS[m[1]]) return `${m[3]}-${String(MONTHS[m[1]]).padStart(2, '0')}-${m[2].padStart(2, '0')}`
  m = String(text || '').match(NUM_DATE)
  if (m) {
    // Portail bilingue : jj/mm/aaaa comme mm/jj/aaaa circulent. Un nombre > 12
    // ne peut être qu'un jour et tranche l'ordre ; à égalité, on garde jj/mm,
    // l'écriture du compte (Canada, interface en français).
    const [, a, b, year] = m
    const dayFirst = Number(b) <= 12
    const day = dayFirst ? a : b
    const month = dayFirst ? b : a
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  return null
}

export function parseSimplexAmount(text) {
  const m = String(text || '').match(MONEY)
  if (!m) return null
  const raw = (m[1] || m[2] || '').replace(/[\s ]/g, '').replace(/,(\d{2})\b/, '.$1').replace(/,/g, '')
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * Transforme les candidats relevés dans la page en documents listables.
 * Pure (aucun accès au navigateur) pour rester testable : c'est ici que se
 * décide ce qui est une ligne de facture et sous quel identifiant elle est
 * dédupliquée d'une tournée à l'autre.
 * @param {{index:number, href?:string, text?:string, row?:string}[]} rows
 */
export function parseSimplexRows(rows) {
  const seen = new Set()
  const out = []
  for (const r of rows || []) {
    const haystack = `${r.row || ''} ${r.text || ''}`
    const date = parseSimplexDate(r.row) || parseSimplexDate(r.text)
    const amount = parseSimplexAmount(r.row) ?? parseSimplexAmount(r.text)
    // Ni date ni montant : ce n'est pas une ligne de facture (menu, en-tête…).
    if (!date && amount == null) continue

    const no = haystack.match(INVOICE_NO)?.[1]
    // Identité = les chiffres du numéro : « INV-9912 » et « Invoice 9912 »
    // désignent la même facture, et le préfixe littéral varie selon l'endroit
    // du portail où le numéro est écrit. Une année n'est pas un numéro.
    const digits = no && !/^(19|20)\d{2}$/.test(no) ? no.replace(/\D/g, '') : null
    const key = digits || date || (amount != null ? amount.toFixed(2) : null)
    if (!key) continue
    const externalId = `simplex:${key}`
    if (seen.has(externalId)) continue
    seen.add(externalId)

    out.push({
      externalId,
      date,
      amount,
      currency: 'CAD',
      filename: `Simplex-${no || date || key}.pdf`,
      href: r.href || null,
      index: r.index,
    })
  }
  return out
}

// Le formulaire B2C est une page rendue par script : les champs n'existent pas
// au premier paint. On attend le champ, pas le chargement.
async function fillIfPresent(locator, value) {
  if (!(await locator.count())) return false
  await locator.fill(value)
  return true
}

// Défi « code de vérification » de B2C. Deux gabarits circulent : la
// vérification de courriel (bouton « Envoyer le code » puis `#email_ver_input`)
// et l'authentification forte (`#verificationCode`). On couvre les deux.
async function answerVerificationCode(ctx) {
  const { page, log } = ctx

  const send = page.locator(
    '#emailVerificationControl_but_send_code, button:has-text("Envoyer le code"), button:has-text("Send verification code")'
  ).first()
  if (await send.count()) {
    await send.click({ timeout: 10_000 }).catch(() => {})
    // Le code part maintenant : c'est seulement à partir d'ici qu'on peut le
    // réclamer à l'utilisateur sans qu'il expire pendant l'attente.
    await page.waitForTimeout(1500)
  }

  const input = page.locator(
    '#email_ver_input, #verificationCode, input[autocomplete="one-time-code"]:visible, input[name*="code" i]:visible'
  ).first()
  if (!(await input.count())) return false

  log('code de vérification demandé par Simplex')
  const code = ctx.totp() || await ctx.askOtp('Code de vérification Simplex Wireless (envoyé par courriel)')
  await input.fill(code)

  const verify = page.locator(
    '#email_ver_but_verify, #verifyCode, button:has-text("Vérifier"), button:has-text("Verify")'
  ).first()
  if (await verify.count()) await verify.click({ timeout: 10_000 }).catch(() => {})
  else await input.press('Enter').catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})

  // B2C fait suivre la vérification d'un « Continuer » sur certains gabarits.
  const cont = page.locator('#continue, button:has-text("Continuer"):visible').first()
  if (await cont.count()) await cont.click({ timeout: 10_000 }).catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})

  // Un code périmé ou erroné laisse la page en place avec son message : le dire
  // clairement vaut mieux que d'échouer plus loin sur « pas de facture ».
  const err = await page.locator('.error:visible, [role="alert"]:visible').first()
    .innerText().catch(() => '')
  if (/incorrect|invalide|expir/i.test(err)) {
    await ctx.snapshot('simplex-code-refuse')
    throw new Error(`Code de vérification refusé par Simplex (${err.trim().slice(0, 80)}) — relancer la tournée pour en recevoir un nouveau`)
  }
  return true
}

async function signIn(ctx) {
  const { page, log, credentials } = ctx
  log('connexion au portail Simplex (Azure AD B2C)…')

  const user = page.locator('#signInName, #email, input[name="signInName"], input[name="email"], input[type="email"]:visible').first()
  await user.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
  if (!(await user.count())) {
    await ctx.snapshot('simplex-login-inattendu')
    throw new Error("L'écran de connexion Simplex n'a pas présenté de champ courriel — voir la capture de la tournée")
  }
  await user.fill(credentials.username)

  // Page unifiée : le mot de passe est déjà là. Sur le gabarit en deux temps,
  // il n'apparaît qu'après « Suivant ».
  let pwd = page.locator('#password, input[type="password"]:visible').first()
  if (!(await pwd.count())) {
    await page.locator('#next, button[type="submit"]:visible').first().click({ timeout: 10_000 }).catch(() => {})
    pwd = page.locator('#password, input[type="password"]:visible').first()
    await pwd.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  }
  if (!await fillIfPresent(pwd, credentials.password)) {
    await ctx.snapshot('simplex-etape-mot-de-passe')
    throw new Error("Simplex n'a pas présenté de champ mot de passe — identifiant refusé ou écran inattendu, voir la capture")
  }
  await page.locator('#next, button[type="submit"]:visible').first().click({ timeout: 10_000 })
    .catch(() => pwd.press('Enter').catch(() => {}))
  await page.waitForLoadState('networkidle').catch(() => {})

  await answerVerificationCode(ctx)
  await page.waitForURL(url => !LOGIN_HOST.test(url.toString()), { timeout: 60_000 }).catch(() => {})

  if (LOGIN_HOST.test(page.url())) {
    await ctx.snapshot('simplex-login-echec')
    throw new Error('Connexion au portail Simplex refusée — voir la capture de la tournée, ou importer une session ouverte à la main')
  }
  log('connecté')
}

// La liste des factures est rendue côté client : aucune URL à deviner, on
// cherche l'entrée de menu qui y mène (le portail est bilingue).
async function openBillingSection(ctx) {
  const { page, log } = ctx
  const entry = page.locator(
    'a:has-text("Facture"), a:has-text("Invoice"), a:has-text("Billing"), a:has-text("Facturation"), '
    + 'button:has-text("Facture"), button:has-text("Invoice"), button:has-text("Billing"), '
    + '[role="menuitem"]:has-text("Invoice"), [role="tab"]:has-text("Invoice"), [href*="invoice" i], [href*="billing" i]'
  ).first()
  if (!(await entry.count())) {
    log('⚠️ aucune entrée « Factures » dans le menu — recherche sur la page courante')
    return false
  }
  await entry.click({ timeout: 15_000 }).catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})
  // Grille rendue après l'appel réseau : laisser le temps aux lignes d'arriver.
  await page.waitForTimeout(2000)
  return true
}

export default {
  label: 'Simplex Wireless',
  fields: { username: 'Courriel du compte Simplex', password: 'Mot de passe', totp: 'Secret 2FA (optionnel)' },

  async list(ctx) {
    const { page, context, log } = ctx

    // Filet de diagnostic : tout PDF qui redescend est gardé (c'est souvent la
    // seule façon d'attraper un téléchargement déclenché en JavaScript), et les
    // endpoints JSON de facturation sont journalisés pour pouvoir les appeler
    // directement à la prochaine itération.
    const captured = new Map()
    page.on('response', async res => {
      try {
        const type = (res.headers()['content-type'] || '').toLowerCase()
        const url = res.url()
        if (type.includes('pdf') || /\.pdf(\?|$)/i.test(url)) {
          if (!captured.has(url)) captured.set(url, Buffer.from(await res.body()))
          log(`📄 PDF capturé : ${url.slice(0, 120)}`)
        } else if (type.includes('json') && /invoice|billing|factur|statement|payment/i.test(url)) {
          log(`↪︎ API vue : ${url.slice(0, 160)}`)
        }
      } catch { /* corps déjà consommé ou réponse annulée */ }
    })

    await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle').catch(() => {})
    if (LOGIN_HOST.test(page.url()) || await page.locator('#localAccountForm').count()) {
      await signIn(ctx)
      await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle').catch(() => {})
    } else {
      log('session déjà valide')
    }
    await ctx.snapshot('simplex-accueil')

    await openBillingSection(ctx)
    await ctx.snapshot('simplex-factures')

    // Deux gabarits possibles : des liens (href direct vers le PDF) et des
    // lignes de tableau dont le téléchargement est un bouton. On relève les
    // deux, la mise en forme du portail décidera lequel porte les factures.
    const links = await page.$$eval('a[href]', els => els
      .filter(a => /invoice|factur|\.pdf(\?|$)|download/i.test(`${a.getAttribute('href')} ${a.innerText}`))
      .map(a => {
        let node = a
        let row = ''
        for (let i = 0; i < 10 && node; i++) {
          const text = node.innerText || ''
          if (/\d/.test(text) && text.length > 12) { row = text; break }
          node = node.parentElement
        }
        return { href: a.getAttribute('href') || '', text: (a.innerText || '').trim(), row }
      })).catch(() => [])

    // Lignes de grille : seulement celles qui portent un montant — sinon
    // l'en-tête et les lignes de résumé remonteraient aussi. Celles qui
    // contiennent déjà un lien sont couvertes par le relevé précédent.
    const gridRows = await page.$$eval('table tr, [role="row"]', els => els
      .filter(tr => /\$/.test(tr.innerText || '') && !tr.querySelector('a[href]'))
      .map(tr => ({ href: '', text: '', row: tr.innerText || '' }))).catch(() => [])

    const raw = [...links, ...gridRows].map((r, index) => ({ ...r, index }))
    const docs = parseSimplexRows(raw)
    log(`${raw.length} candidat(s) dans la page, ${docs.length} facture(s) retenue(s)`)
    if (docs.length === 0) {
      await ctx.snapshot('simplex-aucune-facture')
      throw new Error("Aucune facture trouvée sur le portail Simplex — gabarit à calibrer à partir de la capture et des « API vue » du journal")
    }

    // Les lignes sans lien se téléchargent en cliquant leur bouton : on retrouve
    // la ligne par son texte (l'ordre de la grille peut changer entre deux
    // rendus, pas son contenu).
    const rowTextOf = i => raw.find(r => r.index === i)?.row || ''

    return docs.map(d => ({
      externalId: d.externalId,
      date: d.date,
      amount: d.amount,
      currency: d.currency,
      filename: d.filename,
      url: d.href ? (d.href.startsWith('http') ? d.href : `${ORIGIN}${d.href}`) : null,
      fetch: async () => {
        if (d.href) {
          const url = d.href.startsWith('http') ? d.href : `${ORIGIN}${d.href}`
          const res = await context.request.get(url, { timeout: 60_000 })
          const buffer = res.ok() ? await res.body() : null
          if (buffer && buffer.slice(0, 5).toString() === '%PDF-') return buffer
          // Le lien ouvre une visionneuse plutôt que le fichier : on navigue et
          // on récupère ce que le filet réseau a attrapé.
          await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {})
          const late = [...captured.values()].pop()
          if (late) return late
          throw new Error(`réponse non-PDF (HTTP ${res.status()})`)
        }

        const marker = rowTextOf(d.index).split('\n').find(l => l.trim().length > 3) || ''
        const row = page.locator('table tr, [role="row"]').filter({ hasText: marker.trim() }).first()
        if (!(await row.count())) throw new Error('ligne de facture introuvable au moment du téléchargement')
        const control = row.locator('button, a, [role="button"], svg, i').first()
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 30_000 }).catch(() => null),
          control.click({ timeout: 15_000 }).catch(() => {}),
        ])
        if (download) {
          const { readFile } = await import('fs/promises')
          return await readFile(await download.path())
        }
        await page.waitForTimeout(3000)
        const late = [...captured.values()].pop()
        if (late) return late
        throw new Error('le clic sur la ligne n\'a produit aucun PDF')
      },
    }))
  },
}
