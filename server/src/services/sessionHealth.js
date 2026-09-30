// Santé des sessions de connecteurs (Instagram, et demain ManyChat).
//
// POURQUOI CE MODULE EXISTE : le 12 septembre 2026 on a découvert que la
// lecture des commentaires Instagram ne ramenait plus rien depuis le 24 août.
// Le cookie de session était mort, mais rien ne le disait : le fil des
// publications répond encore sans session valide, seul le fil des COMMENTAIRES
// renvoie vers la page de connexion. La tournée se terminait donc en annonçant
// « 0 commentaire », statut succès — une semaine vide indistinguable d'une
// semaine sans activité. Trois semaines de prospects perdues en silence.
//
// La règle qu'on en tire, valable pour tout connecteur qui emprunte une
// session de navigateur plutôt qu'une API officielle :
//   1. une redirection vers une page de connexion n'est JAMAIS un résultat
//      vide, c'est une panne de session — elle doit lever, pas se taire ;
//   2. l'état de chaque session est écrit en base après chaque passage, avec
//      la date du dernier succès, pour qu'un écran puisse le montrer ;
//   3. une vérification quotidienne interroge la session même quand aucune
//      tournée n'est prévue — on apprend qu'elle est morte le lendemain, pas
//      trois semaines plus tard en cherchant pourquoi la liste est vide.
import db from '../db/database.js'

/** Chemins de connexion reconnus dans une redirection (tous connecteurs). */
const LOGIN_PATH_RE = /\/(accounts\/login|login|signin|sign_in|auth\/login)\b/i

/**
 * La réponse est-elle un renvoi vers une page de connexion ?
 *
 * À appeler avec `redirect: 'manual'` : sans ça, fetch suit la redirection et
 * on récupère soit une page HTML de login avec un statut 200, soit une erreur
 * « redirect count exceeded » impossible à distinguer d'une panne réseau.
 */
export function isLoginRedirect(res) {
  if (!res) return false
  // Toute redirection depuis une route JSON est suspecte : une API ne renvoie
  // pas ailleurs quand elle est contente. On distingue quand même le renvoi
  // explicite vers une page de connexion, pour le message.
  return res.status >= 300 && res.status < 400
}

/** Le renvoi pointe-t-il explicitement vers une page de connexion ? */
export function redirectsToLoginPage(res) {
  return isLoginRedirect(res) && LOGIN_PATH_RE.test(res.headers?.get?.('location') || '')
}

/**
 * Réponse 200 qui rend une page de connexion au lieu du JSON attendu : l'autre
 * façon dont un site dit « tu n'es plus connecté » sans le dire.
 */
export function looksLikeLoginPage(res, bodyText) {
  const ct = res?.headers?.get?.('content-type') || ''
  if (ct.includes('application/json')) return false
  const t = String(bodyText || '').slice(0, 4000).toLowerCase()
  return /<html/.test(t) && /(log in|se connecter|connexion|password|mot de passe)/.test(t)
}

const STATUSES = new Set(['ok', 'expired', 'error'])

/** Écrit l'état d'une session. `ok` conserve la date du dernier succès. */
export function recordSessionStatus(connector, { status, detail = null } = {}) {
  if (!STATUSES.has(status)) throw new Error(`statut de session inconnu : ${status}`)
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO connector_sessions (connector, status, detail, checked_at, last_ok_at)
    VALUES (?, ?, ?, ?, CASE WHEN ? = 'ok' THEN ? ELSE NULL END)
    ON CONFLICT(connector) DO UPDATE SET
      status = excluded.status,
      detail = excluded.detail,
      checked_at = excluded.checked_at,
      last_ok_at = CASE WHEN excluded.status = 'ok' THEN excluded.checked_at ELSE connector_sessions.last_ok_at END
  `).run(connector, status, detail, now, status, now)
  return { connector, status, detail, checked_at: now }
}

export function getSessionStatus(connector = null) {
  return connector
    ? db.prepare('SELECT * FROM connector_sessions WHERE connector = ?').get(connector) || null
    : db.prepare('SELECT * FROM connector_sessions ORDER BY connector').all()
}

/**
 * Sonde la session Instagram : un appel qui EXIGE d'être connecté (le fil
 * public, lui, répond même avec un cookie mort — c'est le piège qui nous a
 * coûté trois semaines).
 */
export async function probeInstagram() {
  const { getSessionCookie } = await import('./instagramCommentScrape.js')
  const { sessionid, dsUserId } = getSessionCookie()
  if (!sessionid) {
    return recordSessionStatus('instagram', {
      status: 'error',
      detail: 'Aucun cookie de session — le coller dans Connecteurs → Instagram.',
    })
  }
  let res, body = ''
  try {
    // Pourquoi la boîte de messages et pas « compte courant » : cette dernière
    // exige l'identité d'un navigateur mobile et répond « useragent mismatch »
    // (400) à un vrai cookie valide — une fausse alerte de déconnexion. La
    // boîte de messages, elle, exige d'être connecté et accepte notre identité.
    res = await fetch('https://www.instagram.com/api/v1/direct_v2/inbox/?limit=1', {
      headers: {
        'x-ig-app-id': '936619743392459',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        cookie: [`sessionid=${sessionid}`, dsUserId ? `ds_user_id=${dsUserId}` : null].filter(Boolean).join('; '),
        accept: '*/*',
        referer: 'https://www.instagram.com/',
        'x-requested-with': 'XMLHttpRequest',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    })
    body = await res.text()
  } catch (e) {
    // Panne réseau : ne PAS crier à la session morte, l'utilisateur recollerait
    // un cookie pour rien. On journalise et on garde l'état précédent visible.
    return recordSessionStatus('instagram', { status: 'error', detail: `Instagram injoignable : ${e.message}` })
  }
  if (isLoginRedirect(res) || looksLikeLoginPage(res, body) || res.status === 401 || res.status === 403) {
    return recordSessionStatus('instagram', {
      status: 'expired',
      detail: 'Instagram renvoie vers sa page de connexion — recoller un « sessionid » frais dans Connecteurs → Instagram.',
    })
  }
  if (!res.ok) {
    // 400/429 = Instagram chipote (identité de navigateur, cadence), pas une
    // déconnexion : on n'envoie personne recoller un cookie pour ça.
    return recordSessionStatus('instagram', {
      status: 'error',
      detail: `Instagram a répondu ${res.status} — vérification non concluante, la session n'est pas forcément en cause`,
    })
  }
  let username = null
  try {
    const j = JSON.parse(body)
    username = j?.user?.username || j?.viewer?.username || j?.viewer?.pk || null
  } catch {}
  return recordSessionStatus('instagram', { status: 'ok', detail: username ? `connecté (compte ${username})` : 'session valide' })
}

/**
 * Sondes par connecteur. Ajouter ManyChat ici le jour où on s'y branche : le
 * reste (écriture de l'état, vérification quotidienne, alerte, affichage) est
 * déjà générique.
 */
export const SESSION_PROBES = {
  instagram: probeInstagram,
  manychat: async () => {
    const { probeManychat } = await import('./manychat.js')
    return probeManychat()
  },
  // Venn n'emprunte pas une session de navigateur (c'est une clé d'API), mais
  // le symptôme est le même : une clé révoquée rend une liste vide, pas une
  // erreur. Elle se surveille donc ici, avec les autres.
  venn: async () => {
    const { probeVenn } = await import('./venn.js')
    return probeVenn()
  },
}

export const SESSION_HEALTH_AUTOMATION_ID = 'sys_connector_session_health'

export const SESSION_HEALTH_DEFAULT_CONFIG = {
  connectors: 'instagram,manychat', // sessions à vérifier (virgules)
  // Destinataire de l'alerte : Antoine, en message privé (résolu par courriel
  // via le bot Slack). Aucun webhook à créer.
  slack_channel: 'antoine.lambert96@gmail.com',
  recipient: 'Antoine Lambert',
  slack_webhook_url: '',
  slack_webhook_env: 'SLACK_WEBHOOK_PHILIPPE',
}

function loadHealthConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(SESSION_HEALTH_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...SESSION_HEALTH_DEFAULT_CONFIG }
  for (const k of Object.keys(SESSION_HEALTH_DEFAULT_CONFIG)) {
    const v = String(cfg[k] ?? '').trim()
    if (v) merged[k] = v
  }
  return merged
}

/**
 * Vérification quotidienne de toutes les sessions configurées.
 *
 * L'alerte part au PREMIER jour de panne puis une fois par jour tant que ce
 * n'est pas réparé (`notified_at`) : assez pour qu'on ne l'oublie pas, pas
 * assez pour qu'on apprenne à l'ignorer.
 */
export async function runSessionHealthCheck({ force = false, trigger = 'schedule' } = {}) {
  const { isSystemAutomationActive, logSystemRun } = await import('./systemAutomations.js')
  const t0 = Date.now()
  if (!force && !isSystemAutomationActive(SESSION_HEALTH_AUTOMATION_ID)) return { skipped: 'inactive' }

  const cfg = loadHealthConfig()
  const names = cfg.connectors.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const results = []
  for (const name of names) {
    const probe = SESSION_PROBES[name]
    if (!probe) { results.push({ connector: name, status: 'error', detail: 'aucune sonde pour ce connecteur' }); continue }
    try { results.push(await probe()) } catch (e) {
      results.push(recordSessionStatus(name, { status: 'error', detail: e.message }))
    }
  }

  const broken = results.filter(r => r.status !== 'ok')
  const today = new Date().toISOString().slice(0, 10)
  const toNotify = broken.filter(r => {
    const row = db.prepare('SELECT notified_at FROM connector_sessions WHERE connector=?').get(r.connector)
    return String(row?.notified_at || '').slice(0, 10) !== today
  })

  if (toNotify.length) {
    try {
      const { sendSlack } = await import('./slack.js')
      await sendSlack({
        channel: cfg.slack_channel,
        url: cfg.slack_webhook_url,
        envName: cfg.slack_webhook_env,
        text: ':warning: *Connexion à réparer dans l\'ERP*\n' +
          toNotify.map(r => `• *${r.connector}* — ${r.detail}`).join('\n') +
          '\nTant que ce n\'est pas fait, rien n\'est récolté de ce côté.',
        fallbackNote: 'Session de connecteur expirée',
      })
    } catch (e) { console.error('session health slack:', e.message) }
    const mark = db.prepare('UPDATE connector_sessions SET notified_at=? WHERE connector=?')
    for (const r of toNotify) mark.run(new Date().toISOString(), r.connector)
  }

  const summary = results.map(r => `${r.connector} : ${r.status}${r.detail ? ` (${r.detail})` : ''}`).join(' · ')
  logSystemRun(SESSION_HEALTH_AUTOMATION_ID, {
    status: broken.length ? 'error' : 'success',
    duration_ms: Date.now() - t0,
    triggerData: { trigger, connectors: names },
    result: summary,
    error: broken.length ? new Error(summary) : undefined,
  })
  return { ok: !broken.length, results, summary, alerted: toNotify.map(r => r.connector) }
}

/** Aperçu (« Simuler ») : l'état connu, sans rien appeler. */
export function previewSessionHealth() {
  const cfg = loadHealthConfig()
  const rows = getSessionStatus()
  return {
    connecteurs_verifies: cfg.connectors,
    alerte: `${cfg.recipient || 'personne'} (${cfg.slack_channel || cfg.slack_webhook_env}) — uniquement en cas de panne, jamais quand tout va bien`,
    etat: rows.length
      ? rows.map(r => `${r.connector} : ${r.status}${r.last_ok_at ? ` · dernier succès ${r.last_ok_at.slice(0, 16).replace('T', ' ')}` : ' · jamais vérifiée avec succès'}`)
      : 'aucune vérification encore faite',
  }
}
