// Collecteur FedEx (portail FedEx Billing Online — fedex.com/fedexbillingonline).
//
// FedEx facture le transport à la semaine et ne joint pas le PDF au courriel
// d'avis : celui-ci ne porte qu'un lien vers FedEx Billing Online (FBO), où la
// facture vit derrière le login. C'est exactement le cas que la collecte
// automatique existe pour couvrir, et ces factures-là comptent double : ce sont
// elles qui portent la ventilation du transport par région
// ([[reference_transport_invoice_multiregion_extraction]]).
//
// Ce collecteur est posé sans avoir pu explorer le portail authentifié (pas
// d'identifiants au moment de l'écriture). Comme bell.js / digikey.js /
// simplex.js, il est donc volontairement bavard tant qu'une vraie tournée ne
// l'a pas calibré : il capture tous les PDF qui redescendent et journalise les
// endpoints JSON de facturation croisés — la démarche qui a permis de trouver
// l'API interne de Wix.
//
// Ce qui structure quand même le module :
//   • FBO est une application JSF (`*.xhtml`) : les URL de page sont stables,
//     mais les téléchargements passent par un formulaire POST, pas par un
//     `href` vers le PDF. D'où les deux voies de `fetch` (lien direct, sinon
//     clic sur la ligne + interception du téléchargement).
//   • le numéro de facture FedEx est un nombre à 9 chiffres : c'est le seul
//     identifiant stable d'une tournée à l'autre, et il sert aussi de clé de
//     dédup côté `scraper_documents`.
//   • la connexion est celle de fedex.com (SSO commun à l'expédition et à la
//     facturation) et peut poser un code de vérification par courriel/SMS.

const FBO_URL = 'https://www.fedex.com/fedexbillingonline/'
const SUMMARY_URL = 'https://www.fedex.com/fedexbillingonline/pages/accountsummary/accountSummaryFBO.xhtml'
const ORIGIN = 'https://www.fedex.com'
// Écran de connexion : SSO fedex.com, pas un sous-domaine dédié.
const LOGIN_HOST = /fedex\.com\/(login|secure\/authentication|.*signin)|login\.fedex\.com/i

// Montant collé à un « $ ». Le garde en tête empêche la fin d'une date d'être
// avalée comme des milliers (cf. simplex.js : « 2026-07-31 128,74 $ »).
const MONEY = /(?<![\d\-/.,])(?:\$\s*(\d[\d\s.,]*)|(\d[\d\s.,]*?)\s*\$)/
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/
const NUM_DATE = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/
const MONTHS = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
}

// Numéro annoncé par son étiquette, dans les deux langues du portail.
const LABELLED_NO = /\b(?:invoice|facture)\s*(?:number|no\.?|n[°o]|#)?\s*[:#-]?\s*(\d{6,12})\b/i
// À défaut d'étiquette : le gabarit du numéro FedEx, 9 chiffres isolés. Assez
// spécifique pour ne pas confondre avec un montant (qui porte un « $ ») ni avec
// un numéro de suivi (12 chiffres).
const BARE_NO = /\b(\d{9})\b/

const deaccent = v => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

// FBO abrège les mois (« Sep 12, 2026 ») : on résout par préfixe, et seulement
// si un seul mois répond — « jui » (juin/juillet) reste ambigu et est refusé.
function monthNum(word) {
  const w = deaccent(word).replace(/\.$/, '')
  if (MONTHS[w]) return MONTHS[w]
  if (w.length < 3) return null
  const hits = new Set(Object.entries(MONTHS).filter(([k]) => k.startsWith(w)).map(([, v]) => v))
  return hits.size === 1 ? [...hits][0] : null
}

export function parseFedexDate(text) {
  const iso = String(text || '').match(ISO_DATE)
  if (iso) return iso[0]
  const t = deaccent(text)
  let m = t.match(/(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})/)
  let month = m && monthNum(m[2])
  if (month) return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`
  m = t.match(/([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/)
  month = m && monthNum(m[1])
  if (month) return `${m[3]}-${String(month).padStart(2, '0')}-${m[2].padStart(2, '0')}`
  m = String(text || '').match(NUM_DATE)
  if (m) {
    // FBO est américain : en anglais il écrit mm/jj/aaaa. Un nombre > 12 ne
    // peut être qu'un jour et tranche ; à égalité on garde mm/jj — l'inverse du
    // choix fait pour Simplex, qui est un portail canadien francophone.
    const [, a, b, year] = m
    const monthFirst = Number(a) <= 12
    const month = monthFirst ? a : b
    const day = monthFirst ? b : a
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  return null
}

export function parseFedexAmount(text) {
  const m = String(text || '').match(MONEY)
  if (!m) return null
  const raw = (m[1] || m[2] || '').replace(/\s/g, '').replace(/,(\d{2})\b/, '.$1').replace(/,/g, '')
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
export function parseFedexRows(rows) {
  const seen = new Set()
  const out = []
  for (const r of rows || []) {
    const haystack = `${r.row || ''} ${r.text || ''}`
    const date = parseFedexDate(r.row) || parseFedexDate(r.text)
    const amount = parseFedexAmount(r.row) ?? parseFedexAmount(r.text)
    // Ni date ni montant : ce n'est pas une ligne de facture (menu, en-tête…).
    if (!date && amount == null) continue

    // Le numéro est cherché SANS la date : « 09/12/2026 » contient des suites
    // de chiffres qui ressembleraient à un numéro une fois la barre oblique
    // ignorée.
    const scrubbed = haystack.replace(ISO_DATE, ' ').replace(NUM_DATE, ' ')
    const no = scrubbed.match(LABELLED_NO)?.[1] || scrubbed.match(BARE_NO)?.[1] || null
    const key = no || date || (amount != null ? amount.toFixed(2) : null)
    if (!key) continue
    const externalId = `fedex:${key}`
    if (seen.has(externalId)) continue
    seen.add(externalId)

    out.push({
      externalId,
      number: no,
      date,
      amount,
      // FBO affiche la devise du compte de facturation ; le nôtre est canadien.
      currency: 'CAD',
      filename: `FedEx-${no || date || key}.pdf`,
      href: r.href || null,
      index: r.index,
    })
  }
  return out
}

async function signIn(ctx) {
  const { page, log, credentials } = ctx
  log('connexion à FedEx Billing Online…')

  // Bandeau de témoins : il recouvre le bas de page et avale les clics.
  const cookies = page.locator('#onetrust-accept-btn-handler, button:has-text("Accepter tout"), button:has-text("Accept All")').first()
  await cookies.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  if (await cookies.count()) {
    await cookies.click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(500)
  }

  const user = page.locator('#userId, input[name="userId"], input[name*="user" i]:visible, input[type="email"]:visible').first()
  await user.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
  if (!(await user.count())) {
    await ctx.snapshot('fedex-login-inattendu')
    throw new Error("L'écran de connexion FedEx n'a pas présenté de champ identifiant — voir la capture de la tournée")
  }
  await user.fill(credentials.username)

  // Gabarit en une page (identifiant + mot de passe ensemble) ou en deux temps.
  let pwd = page.locator('#password, input[type="password"]:visible').first()
  if (!(await pwd.count())) {
    await page.locator('button[type="submit"]:visible, button:has-text("Continue"), button:has-text("Continuer")').first()
      .click({ timeout: 10_000 }).catch(() => {})
    pwd = page.locator('#password, input[type="password"]:visible').first()
    await pwd.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  }
  if (!(await pwd.count())) {
    await ctx.snapshot('fedex-etape-mot-de-passe')
    throw new Error("FedEx n'a pas présenté de champ mot de passe — identifiant refusé ou écran inattendu, voir la capture")
  }
  await pwd.fill(credentials.password)
  await page.locator('button[type="submit"]:visible, #login, button:has-text("Se connecter"), button:has-text("Log in")').first()
    .click({ timeout: 10_000 }).catch(() => pwd.press('Enter').catch(() => {}))
  await page.waitForLoadState('networkidle').catch(() => {})

  // Code de vérification (courriel ou SMS). Le secret TOTP, s'il est renseigné
  // sur le compte, court-circuite l'attente humaine ; sinon la tournée se met
  // en pause et quelqu'un saisit le code dans l'ERP.
  const otp = page.locator('input[autocomplete="one-time-code"]:visible, input[name*="code" i]:visible, input[inputmode="numeric"]:visible').first()
  if (await otp.count()) {
    const code = ctx.totp() || await ctx.askOtp('Code de vérification FedEx (envoyé par courriel ou SMS)')
    await otp.fill(code)
    await page.locator('button[type="submit"]:visible, button:has-text("Vérifier"), button:has-text("Verify"), button:has-text("Continue")').first()
      .click({ timeout: 10_000 }).catch(() => otp.press('Enter').catch(() => {}))
    await page.waitForLoadState('networkidle').catch(() => {})
  }

  await page.waitForURL(url => !LOGIN_HOST.test(url.toString()), { timeout: 60_000 }).catch(() => {})
  if (LOGIN_HOST.test(page.url())) {
    await ctx.snapshot('fedex-login-echec')
    throw new Error('Connexion FedEx refusée — voir la capture de la tournée, ou importer une session ouverte à la main')
  }
  log('connecté')
}

// FBO ouvre sur un tableau de bord ; la liste des factures est derrière l'onglet
// « Account summary » / « Sommaire du compte ». L'URL directe est tentée
// d'abord (elle est stable), l'entrée de menu sert de repli si le portail a
// bougé son chemin.
async function openInvoiceList(ctx) {
  const { page, log } = ctx
  await page.goto(SUMMARY_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})
  if (/accountsummary/i.test(page.url())) return true

  const entry = page.locator(
    'a:has-text("Account summary"), a:has-text("Sommaire du compte"), a:has-text("Invoice"), a:has-text("Facture"), '
    + '[role="tab"]:has-text("Invoice"), [role="tab"]:has-text("Facture"), [href*="accountsummary" i], [href*="invoice" i]'
  ).first()
  if (!(await entry.count())) {
    log('⚠️ ni page « Sommaire du compte » ni entrée de menu — recherche sur la page courante')
    return false
  }
  await entry.click({ timeout: 15_000 }).catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})
  // Grille JSF rendue après l'appel réseau : laisser les lignes arriver.
  await page.waitForTimeout(2000)
  return true
}

export default {
  label: 'FedEx',
  fields: { username: 'Identifiant fedex.com', password: 'Mot de passe', totp: 'Secret 2FA (optionnel)' },

  async list(ctx) {
    const { page, context, log } = ctx

    // Filet de diagnostic : tout PDF qui redescend est gardé (souvent la seule
    // façon d'attraper un téléchargement déclenché en JavaScript), et les
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
        } else if (type.includes('json') && /invoice|billing|factur|statement|account/i.test(url)) {
          log(`↪︎ API vue : ${url.slice(0, 160)}`)
        }
      } catch { /* corps déjà consommé ou réponse annulée */ }
    })

    await page.goto(FBO_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle').catch(() => {})
    if (LOGIN_HOST.test(page.url()) || await page.locator('input[type="password"]').count()) {
      await signIn(ctx)
    } else {
      log('session déjà valide')
    }

    await openInvoiceList(ctx)
    await ctx.snapshot('fedex-factures')

    // Deux gabarits possibles : des liens (href direct vers le PDF) et des
    // lignes de tableau dont le téléchargement est un bouton — sur FBO c'est
    // plutôt le second, l'application étant en JSF.
    const links = await page.$$eval('a[href]', els => els
      .filter(a => /invoice|factur|\.pdf(\?|$)|download|telecharger/i.test(`${a.getAttribute('href')} ${a.innerText}`))
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
    // l'en-tête et les lignes de total remonteraient aussi. Celles qui
    // contiennent déjà un lien sont couvertes par le relevé précédent.
    const gridRows = await page.$$eval('table tr, [role="row"]', els => els
      .filter(tr => /\$/.test(tr.innerText || '') && !tr.querySelector('a[href]'))
      .map(tr => ({ href: '', text: '', row: tr.innerText || '' }))).catch(() => [])

    const raw = [...links, ...gridRows].map((r, index) => ({ ...r, index }))
    const docs = parseFedexRows(raw)
    log(`${raw.length} candidat(s) dans la page, ${docs.length} facture(s) retenue(s)`)
    if (docs.length === 0) {
      await ctx.snapshot('fedex-aucune-facture')
      throw new Error("Aucune facture trouvée sur FedEx Billing Online — gabarit à calibrer à partir de la capture et des « API vue » du journal")
    }

    // Les lignes sans lien se téléchargent en cliquant leur commande : on
    // retrouve la ligne par son texte (l'ordre de la grille peut changer entre
    // deux rendus, pas son contenu).
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

        // Ligne de grille : on cible d'abord la commande de téléchargement, en
        // se rabattant sur le premier contrôle de la ligne. FBO produit parfois
        // le PDF en différé (le fichier arrive après un aller-retour serveur) :
        // d'où l'attente du téléchargement PUIS le repli sur le filet réseau.
        const marker = (d.number || rowTextOf(d.index).split('\n').find(l => l.trim().length > 3) || '').trim()
        if (!marker) throw new Error('ligne de facture non repérable au moment du téléchargement')
        const row = page.locator('table tr, [role="row"]').filter({ hasText: marker }).first()
        if (!(await row.count())) throw new Error('ligne de facture introuvable au moment du téléchargement')
        const control = row.locator(
          'a:has-text("PDF"), button:has-text("PDF"), a:has-text("Download"), button:has-text("Download"), '
          + 'a:has-text("Télécharger"), button:has-text("Télécharger"), button, a, [role="button"]'
        ).first()
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 60_000 }).catch(() => null),
          control.click({ timeout: 15_000 }).catch(() => {}),
        ])
        if (download) {
          const { readFile } = await import('fs/promises')
          return await readFile(await download.path())
        }
        await page.waitForTimeout(5000)
        const late = [...captured.values()].pop()
        if (late) return late
        throw new Error("le clic sur la ligne n'a produit aucun PDF")
      },
    }))
  },
}
