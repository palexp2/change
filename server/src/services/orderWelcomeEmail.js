import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { getAutomationFrom, getPostmarkClient } from './postmarkConfig.js'
import { trackEmailHtml } from './emailTracking.js'
import { logSystemRun, isSystemAutomationActive } from './systemAutomations.js'

// Courriel au client d'une commande (fiche commande, section « Courriel au
// client ») : vérification de l'adresse de livraison, plus les instructions
// d'installation si la commande contient un produit Core ou un contrôleur LTE
// marqué « Installation ». Le contenu suit les articles : le cerveau seulement
// avec un contrôleur central, le poteau seulement avec un boîtier météo.
// Envoyé seul à 17 h (heure de l'Est) ou à la main avant (Postmark), jamais
// en copie cachée, et sans délai promis.

export const AUTOMATION_ID = 'sys_order_welcome_email'

const IMG = 'https://orisha.us-east-1.linodeobjects.com'
const HELP_URL = 'https://app.orisha.io/#aide'

const T = {
  fr: {
    subjectInstall: 'Rends ton installation facile et rapide',
    subjectAddress: "Ta commande Orisha : on vérifie l'adresse",
    heading: 'Ta commande Orisha est en préparation',
    address: 'Voici l’<strong>adresse prévue pour la livraison</strong>; fais-nous signe si ce n’est pas la bonne.',
    today: "Quoi faire dès aujourd'hui?",
    todaySub: 'Sauve-toi du temps et pas mal de trouble en préparant ces points:',
    plywood: "Préparer ton <strong>panneau de plywood</strong> d'un minimum de 4'x4'.",
    outlet: 'Assure-toi d’avoir une <strong>prise électrique</strong>&nbsp;disponible d’au moins <strong>5&nbsp;ampères</strong>.',
    brain: lte => 'Choisis <strong>l’emplacement</strong> de ton <strong>cerveau Orisha</strong> (le contrôleur central), là où '
      + (lte ? 'la <strong>connexion internet mobile est stable</strong>' : 'il y a du <strong>Wi-Fi stable</strong>')
      + '. Il doit être à moins de 250 pieds de la serre.',
    pole: "Achète ta <strong>pôle</strong> d'un minimum (1pouce x 6pieds) pour installer ta <strong>station météo</strong>.",
    look: 'Ça devrait ressembler à ça une fois l’installation terminée:',
    tools: 'Prépare aussi ces outils; c’est ce qui risque de te manquer et qui n’est pas dans la boîte.',
    toolsImg: `${IMG}/email_onboarding%2Ffr%2Foutils-side-vent.jpg`,
    help: `<p style="margin-bottom:7px;font-size:16px;color:#333">On est toujours là pour t’aider, soit par <a href="${HELP_URL}">l'app d’aide Orisha</a>,</p><p style="margin-top:0;font-size:16px;color:#333">soit par téléphone 📞 <a href="tel:1-888-267-4742" style="color:#777">1-888-267-4742</a></p>`,
  },
  en: {
    subjectInstall: 'Your installation, quick and easy',
    subjectAddress: 'Your Orisha order: confirming the address',
    heading: 'Your Orisha order is being prepared',
    address: "This is the <strong>shipping address</strong> we have on file, let us know if it isn't accurate.",
    today: 'What can you get out of the way today?',
    todaySub: 'Save yourself some time and a whole lot of trouble by taking care of these:',
    plywood: "Prepare your 4'x4' <strong>plywood panel</strong>.",
    outlet: 'Make sure you have an available <strong>electric outlet</strong>&nbsp;of at least <strong>5&nbsp;amperes</strong>.',
    brain: lte => "Choose the <strong>location</strong> of your <strong>Orisha's brain</strong> (the central controller), where "
      + (lte ? 'the <strong>mobile internet connection is stable</strong>' : 'the <strong>Wi-Fi is stable</strong>')
      + '. It must be within 250 feet of your greenhouse.',
    pole: 'Buy your <strong>pole</strong> of at least (1 inch x 6 feet) to install your <strong>weather station</strong> on.',
    look: 'It should look a little like this once your installation is completed:',
    tools: "Make sure you have these tools on hand: you won't find them in the box.",
    toolsImg: `${IMG}/email_onboarding%2Fen%2Ftools-rollup.jpg`,
    help: `<p style="margin-bottom:7px;font-size:16px;color:#333">We're always here to help, either with <a href="${HELP_URL}">Orisha's assistance app</a>,</p><p style="margin-top:0;font-size:16px;color:#333">or one call away at 📞 <a href="tel:1-888-267-4742" style="color:#777">1-888-267-4742</a></p>`,
  },
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Le « Type de document » fait foi (un remplacement peut être facturé) ;
// le type d'article ne sert que s'il est vide.
const isReplacement = it => (it.cf_type_de_document || it.item_type) === 'Remplacement'
const isController = it => /^contr[ôo]leur central/i.test(it.name || '') && !/remplacement|option/i.test(it.name || '')
const isLte = it => isController(it) && /\bLTE/i.test(it.name || '')
const isWeather = it => /bo[îi]tier m[ée]t[ée]o/i.test(it.name || '')
const isCore = it => it.product_type === 'Orisha - Core' || isLte(it)

// Ce que dit le courriel, à partir des articles { name, product_type, item_type, cf_type_de_document }.
export function welcomeEmailPlan(items) {
  const installed = (items || []).filter(it => !isReplacement(it))
  const install = installed.some(isCore)
  return {
    install,
    controller: install && installed.some(isController),
    lte: install && installed.some(isLte),
    weather: install && installed.some(isWeather),
  }
}

// address = { name, line1, city, province, postal_code, country }
export function buildWelcomeEmail({ lang = 'fr', items = [], address = {} }) {
  const t = T[lang] || T.fr
  const plan = welcomeEmailPlan(items)
  const cityLine = [address.city, [address.province, address.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  const addrHtml = [address.name, address.line1, cityLine, address.country && !/^(ca|canada)$/i.test(address.country) ? address.country : null]
    .filter(Boolean).map(esc).join('<br>')

  let prep = ''
  if (plan.install) {
    const li = [t.plywood, t.outlet]
    if (plan.controller) li.push(t.brain(plan.lte))
    if (plan.weather) li.push(t.pole)
    prep = `<hr><p style="margin-top:40px"><strong>${t.today}</strong></p><p>${t.todaySub}</p><ul>${li.map(x => `<li style="margin-left:15px"><p>${x}</p></li>`).join('')}</ul>
<p>${t.look}</p><img src="${IMG}/email_onboarding%2Fgreenhouse-overview.png" width="473" alt="" style="max-width:100%;height:auto">
<img src="${IMG}/email_onboarding%2Fplywood-overview.jpeg" width="100%" alt="">
<hr style="margin:50px 0"><h3><strong>${t.tools}</strong></h3><img src="${t.toolsImg}" width="100%" alt="">`
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#f4f4f4;font-family:Arial,sans-serif"><table width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f4"><tr><td align="center">
<table width="600" cellspacing="0" cellpadding="0" style="background:#fff;max-width:100%">
<tr><td align="center" style="padding:20px"><img src="${IMG}/logo.png" alt="Orisha" style="max-width:150px;display:block"></td></tr>
<tr><td style="background:#22b14c;height:5px;line-height:5px;font-size:0"></td></tr>
<tr><td style="padding:20px;color:#333"><h1 style="padding-bottom:20px;font-size:1.17em"><strong>${t.heading}</strong></h1><p>${t.address}</p>
<p style="margin:20px 0 40px;font-size:16px"><strong>${addrHtml}</strong></p>${prep}</td></tr>
<tr><td style="padding:20px;text-align:center">${t.help}</td></tr>
<tr><td align="center" style="padding:20px;background:#f4f4f4;font-size:12px;color:#777">Automatisation Orisha Inc. 1535 ch. Ste-Foy Bureau 220 Québec, QC G1S 2P1</td></tr></table></td></tr></table></body></html>`

  return { subject: plan.install ? t.subjectInstall : t.subjectAddress, html, plan }
}

// Tout ce qu'il faut pour l'aperçu et l'envoi. `missing` dit ce qui bloque.
export function loadWelcomeEmailContext(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL').get(orderId)
  if (!order) return { error: { status: 404, message: 'Commande introuvable' } }
  const addr = order.address_id ? db.prepare(`
    SELECT a.*, c.id AS c_id, c.first_name AS c_first, c.last_name AS c_last, c.email AS c_email,
           co.name AS company_name
    FROM adresses a
    LEFT JOIN contacts c ON c.id = a.contact_id
    LEFT JOIN companies co ON co.id = COALESCE(a.company_id, ?)
    WHERE a.id = ?`).get(order.company_id, order.address_id) : null
  const items = db.prepare(`
    SELECT COALESCE(p.name_fr, p.name_en) AS name, p.type AS product_type, oi.item_type, oi.cf_type_de_document
    FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?`).all(orderId)
  const to = (addr?.c_email || addr?.courriel_du_contact || '').trim() || null
  return {
    order,
    items,
    to,
    contact_id: addr?.c_id || null,
    contact_name: [addr?.c_first, addr?.c_last].filter(Boolean).join(' ') || addr?.nom_complet_du_contact || null,
    address: addr ? {
      name: addr.company_name, line1: addr.line1 || addr.adresse_ligne_1, city: addr.city,
      province: addr.province, postal_code: addr.postal_code, country: addr.country,
    } : null,
    missing: !addr ? 'address' : !to ? 'email' : null,
  }
}

// ── Envoi ───────────────────────────────────────────────────────────────────
// Le même chemin sert au bouton « Envoyer » (fiche commande) et à l'envoi
// automatique de 17 h (heure de l'Est, cron dans index.js).

// Garde-fou : l'envoi automatique ne vise que les commandes créées depuis sa
// mise en service (demande de P.-A. Papillon, 2026-10-15) et des 14 derniers
// jours — sinon il partirait à toutes les anciennes commandes jamais écrites.
export const AUTO_SEND_EARLIEST = '2026-10-15T04:00:00.000Z'
const AUTO_SEND_MAX_DAYS = 14

const autoFloor = nowIso => {
  const recent = new Date(Date.parse(nowIso) - AUTO_SEND_MAX_DAYS * 86400e3).toISOString()
  return recent > AUTO_SEND_EARLIEST ? recent : AUTO_SEND_EARLIEST
}

// Une commande partira-t-elle seule à 17 h ? (affiché sur la fiche)
export function isAutoSendCandidate(order, nowIso = new Date().toISOString()) {
  return !!order && !order.deleted_at && order.status !== 'Commande vide' && (order.created_at || '') >= autoFloor(nowIso)
}

// Requête pure — `conn` passé en paramètre pour les tests en mémoire.
export function selectDueWelcomeEmails(conn = db, nowIso = new Date().toISOString()) {
  return conn.prepare(`
    SELECT o.id FROM orders o
    WHERE o.deleted_at IS NULL AND o.address_id IS NOT NULL
      AND o.status <> 'Commande vide'
      AND o.created_at >= ?
      AND NOT EXISTS (SELECT 1 FROM order_welcome_emails w WHERE w.order_id = o.id)
    ORDER BY o.created_at`).all(autoFloor(nowIso)).map(r => r.id)
}

// Envoie et consigne (interaction, courriel suivi, ligne order_welcome_emails).
// Lève une erreur si l'envoi échoue ; c'est l'appelant qui journalise.
export async function sendOrderWelcomeEmail(ctx, { lang, to, cc = null, subject, html, userId = null }) {
  const from = getAutomationFrom(AUTOMATION_ID)
  if (!from) throw new Error('Adresse expéditeur Postmark non configurée')
  const emailId = newRecordId()
  await getPostmarkClient().sendEmail({ From: from, To: to, Cc: cc || undefined, Subject: subject, HtmlBody: trackEmailHtml(html, emailId) })
  const interactionId = newRecordId()
  db.transaction(() => {
    db.prepare(`INSERT INTO interactions (id, contact_id, company_id, user_id, type, direction, timestamp)
      VALUES (?, ?, ?, ?, 'email', 'out', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
      .run(interactionId, ctx.contact_id, ctx.order.company_id || null, userId)
    db.prepare(`INSERT INTO emails (id, interaction_id, subject, body_html, from_address, to_address, cc, automated)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(emailId, interactionId, subject, html, from, to, cc)
    db.prepare(`INSERT INTO order_welcome_emails (order_id, email_id, lang, sent_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).run(ctx.order.id, emailId, lang)
  })()
  return { from, emailId, interactionId }
}

// Passage de 17 h : chaque commande due part avec le courriel tel quel.
// `langOf(order)` = langue du contact (resolveInstallationDocsLang côté route).
export async function sendDueWelcomeEmails({ langOf }) {
  const started = Date.now()
  if (!isSystemAutomationActive(AUTOMATION_ID)) {
    logSystemRun(AUTOMATION_ID, { status: 'skipped', result: 'Envoi de 17 h : automatisation désactivée.', duration_ms: 0 })
    return
  }
  const lines = []
  let sent = 0, errors = 0
  for (const id of selectDueWelcomeEmails()) {
    const ctx = loadWelcomeEmailContext(id)
    const label = `Commande ${ctx.order?.order_number || id}`
    if (ctx.error || ctx.missing) { lines.push(`SKIP — ${label} · ${ctx.missing === 'email' ? 'contact sans courriel' : ctx.error?.message || 'sans adresse'}`); continue }
    const lang = langOf(ctx.order)
    const { subject, html } = buildWelcomeEmail({ lang, items: ctx.items, address: ctx.address })
    try {
      await sendOrderWelcomeEmail(ctx, { lang, to: ctx.to, subject, html })
      sent++; lines.push(`ENVOYÉ — ${label} → ${ctx.to} (${lang})`)
    } catch (e) {
      errors++; lines.push(`ERREUR — ${label} → ${ctx.to} · ${e.message}`)
    }
  }
  if (!lines.length) return
  logSystemRun(AUTOMATION_ID, {
    status: errors ? (sent ? 'partial' : 'error') : 'success',
    result: [`Envoi de 17 h : ${sent} envoyé(s) · ${errors} erreur(s)`, ...lines].join('\n'),
    duration_ms: Date.now() - started,
    triggerData: { sent, errors },
  })
}
