// Génération IA de courriels de relance pour les entreprises ayant eu un
// qualification call et dont la phase HubSpot est "Quote Sent". Pas de template
// statique : le courriel n'existe que si l'utilisateur a déclenché /regenerate
// (qui appelle OpenAI et persiste un draft dans email_relance_drafts).

import db from '../db/database.js'
import { execFileSync } from 'child_process'
import { existsSync, statSync } from 'fs'
import { join } from 'path'

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseList(v) {
  if (!v) return []
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] }
}

function nonPlaceholder(s) {
  if (!s) return null
  const t = String(s).trim()
  if (!t) return null
  // Les champs Airtable contiennent souvent les libellés du formulaire en guise
  // de placeholder ("Fait un résumé...", "Avons-nous oublié..."). On les filtre.
  const placeholders = [
    /^fait un r[eé]sum[eé]/i,
    /^avons-nous oubli[eé]/i,
    /^r[eé]capitulatif des points/i,
    /^cocher les questions/i,
    /^tick the selected/i,
    /^il va y avoir des questions/i,
    /^n\/?a$/i,
    /^test$/i,
  ]
  for (const re of placeholders) if (re.test(t)) return null
  return t
}

function detectLanguage(text) {
  if (!text) return 'fr'
  const t = text.toLowerCase()
  // Présence d'accents → quasi-certain FR.
  if (/[éèêëàâîïôöûüÿç]/.test(t)) return 'fr'
  // Sinon : compter les marqueurs distinctifs avec word boundaries pour éviter
  // que "humidity" (EN) match "humidit" (FR) en sous-chaîne, par exemple.
  let fr = 0, en = 0
  const frMarkers = /\b(vous|nous|avec|pour|mais|sans|leur|leurs|notre|votre|tres|alors|aussi|deja|chaque|une|une?s|le|la|les|des|du|et|en|au|aux|qui|que|quoi|gestion|serre|serres|maladie|chaleur|humidite|rendement|maraicher|ferme|fermes|biolog|client|projet)\b/g
  const enMarkers = /\b(the|and|of|for|with|is|are|to|in|on|farm|farms|greenhouse|greenhouses|humidity|disease|yield|manual|remote|labor|crop|crops|growing|grower|growers|tomato|tomatoes|temperature|control|environmental|customer|project)\b/g
  fr = (t.match(frMarkers) || []).length
  en = (t.match(enMarkers) || []).length
  return en > fr ? 'en' : 'fr'
}

// Map mots-clés (FR/EN) → angle d'accroche dans le paragraphe d'insight.
// On retient au plus 2 angles différents par email pour ne pas surcharger.
const TOPICS = [
  { keys: ['humidit', 'humidity', 'd[eé]shum'], topic: 'humidity' },
  { keys: ['chaleur', 'heat', 'temperature', 'temp '], topic: 'heat' },
  { keys: ['ventilation', 'roll-?up', 'ridge vent', 'side vent', 'a[eé]rage'], topic: 'ventilation' },
  { keys: ['maladie', 'disease', 'moisi', 'botryt', 'oidium', 'oïdium', 'mildew', 'champignon', 'pathog'], topic: 'disease' },
  { keys: ['remote', '[àa] distance', 'alert', 'alarme', 'monitor', 'surveill'], topic: 'remote' },
  { keys: ['manuel', 'manual', 'm[aà] la main'], topic: 'manual' },
  { keys: ['rendement', 'yield', 'production', 'r[eé]colte'], topic: 'yield' },
  { keys: ['irrig', 'arrosage', 'fertig'], topic: 'irrigation' },
  { keys: ['main.?d.?oeuvre', 'labor', 'employ', 'staff', 'travail'], topic: 'labor' },
  { keys: ['energie', 'énergie', 'energy', 'chauffage', 'heating'], topic: 'energy' },
  { keys: ['ravageur', 'pest', 'insect', 'mouche', 'whiteflies'], topic: 'pests' },
  { keys: ['fleur', 'flower', 'pollin', 'fruit'], topic: 'flowering' },
]

function detectTopics(text) {
  if (!text) return []
  const t = text.toLowerCase()
  const found = []
  for (const { keys, topic } of TOPICS) {
    if (found.includes(topic)) continue
    for (const k of keys) {
      if (new RegExp(k).test(t)) { found.push(topic); break }
    }
  }
  return found.slice(0, 2)
}

function firstName(full) {
  const t = nonPlaceholder(full)
  if (!t) return null
  return t.split(/\s+/)[0]
}

function fmtMonth(dateStr, lang) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (isNaN(d)) return null
  const months = lang === 'fr'
    ? ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre']
    : ['January','February','March','April','May','June','July','August','September','October','November','December']
  return `${months[d.getMonth()]} ${d.getFullYear()}`
}

// Nombre de mois écoulés depuis dateStr (basé sur année×12 + mois courant).
// Utilisé pour injecter une référence temporelle relative dans le contexte
// envoyé à l'IA : sans ça, le modèle a tendance à écrire "in April" alors que
// l'appel a eu lieu plus d'un an avant, ce qui sonne faux côté destinataire.
function monthsSince(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (isNaN(d)) return null
  const now = new Date()
  const m = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth())
  return m >= 0 ? m : null
}
// ── Régénération via OpenAI ────────────────────────────────────────────────
//
// Reprend la même intention (relance post-qualification d'un projet perdu) mais
// laisse un modèle GPT composer la prose, ce qui permet d'avoir des variantes
// au-delà du template statique. Température réglable côté client pour produire
// plusieurs essais.

const REGEN_MODEL = 'gpt-4o'

// Brief de marque condensé : injecté dans le prompt système. C'est le contrat
// qui garantit que l'IA reste cohérente avec brand.orisha.io même si le texte
// est généré dynamiquement.
const BRAND_BRIEF = `
ORISHA — BRAND VOICE BRIEF (extrait de brand.orisha.io)

Voix : honest, authentic, inspirational, simple, clear, humble, friendly.
Jamais : manipulative, flashy, guilt-tripping, preachy, salesy.

Positionnement : "pressure relief through yield". Le maraîcher est le héros, Orisha est l'outil/guide. "Lead with the life, not the pounds — yield numbers are proof, not the pitch." Cible : maraîchers diversifiés qui sacrifient leur temps en famille pour faire vivre la ferme. Une planche de tomates indéterminées en serre = revenu équivalent à 20-30 planches de betteraves/petits pois en champ.

Elevator pitch FR (Québécois) : "Beaucoup de maraîchers doivent sacrifier leur temps en famille pour que la ferme arrive. On les aide à y arriver en 40h/semaine en augmentant leurs rendements en serre. Comme ça, ils peuvent couper dans le nombre de jardins à gérer sans perdre de revenu."

Histoires-piliers (citations vérifiées de producteurs) :
- Drew, Ghost House Farm (Michigan Upper Peninsula) : "Our first spring in the hoop house was awful. It was miserable." → "We DOUBLED tomato production compared to last year." → "Allison quit her day job and we're both farming full time now."
- Scott, Indian Creek Orchard Gardens (Ontario) : "We were unable to accept a dinner invitation… we had to be around to open or close." → "Our automation freed us from all that stress… game changer."
- Dan, Broadfork Farm (Richmond, Virginie) : "The tunnel will do a better job by itself… disease go down, yield went up dramatically." → "We wish we had done it sooner. I'd do this five years ago."

RÈGLES D'ÉCRITURE STRICTES :
- AUCUN tiret cadratin (em-dash —) ni demi-cadratin (–) comme ponctuation stylistique. Utiliser virgule, point, point-virgule, parenthèses ou "et" à la place.
- Utiliser les contractions ("on", "c'est", "y a", "j'ai", "we're", "you're", "don't").
- Sujet en minuscules, ton texto-d'un-ami, court (≤ 8 mots).
- Histoire concrète, pas d'abstraction. Pas d'exagération chiffrée non sourcée.
- Ne pas mettre de mots dans la bouche du producteur.
- Pas de fausse urgence, pas de "limited time", pas de superlatifs vides.
- Pas de flatterie / sycophantie. Bannis : "That's a smart move", "Great question", "Smart approach", "I love that", "Ça c'est une bonne idée", "Bonne question". Le destinataire n'a pas besoin de validation, juste d'être pris au sérieux.
- "ft²" pour les surfaces (anglais) / "pi²" (français).

RÉFÉRENCE À LA DATE DE L'APPEL :
- Si la date de l'appel est annotée "(il y a N mois)" / "(N months ago)" dans le contexte, ÇA VEUT DIRE que c'est lointain : utilise une formulation relative ("il y a un peu plus d'un an", "last spring", "a while back") plutôt que le mois sec.
- N'écris JAMAIS juste "in April" ou "en avril" sans année quand l'appel a plus de 3 mois — le destinataire perd le fil.
- Si pas d'annotation relative, le mois sec est OK (appel récent, même année).

UTILISATION DE L'HISTORIQUE RÉCENT (priorité haute) :
- Si la section "Historique récent" / "Recent history" est présente, scanne-la et identifie l'interaction la plus récente, quelle qu'elle soit.
- **RÈGLE STRICTE** : s'il existe un courriel SORTANT (de notre côté) dans les 60 derniers jours, tu DOIS le reconnaître au début du courriel — même s'il s'agit d'un message promotionnel, automatique, ou marketing (factures, "rent-to-buy", offres). Sinon le destinataire pense qu'on a oublié qu'on lui a écrit la semaine passée et le relance sonne déconnectée. Exemple : "Je sais que tu as reçu notre courriel sur l'option de location-achat la semaine passée — je voulais quand même prendre 2 minutes pour revenir sur notre échange du printemps dernier…" / "I know our rent-to-buy note landed in your inbox last week — separately, I wanted to circle back on what we discussed last spring…"
- Si un courriel ENTRANT (du prospect) est dans l'historique sans réponse de notre côté, c'est la priorité absolue : réponds-y directement plutôt que de partir sur un nouvel angle.
- Pour tout autre échange concret (appel, courriel personnel), glisse une référence naturelle ("tu m'écrivais en mars que…", "on s'est parlé en septembre quand…") plutôt que de répéter une généralité du QC.
- Ne paraphrase pas le contenu d'un courriel mot pour mot : référence-le brièvement et avance.
- Si l'historique est vide, n'invente rien — reste sur le contenu du QC.

RÈGLES SUR LES PRODUCTEURS CITÉS (strict) :
- N'INVENTE JAMAIS de prénom ni de ferme. Seuls les producteurs présents dans la section "BANQUE DE TÉMOIGNAGES CLIENTS" (plus bas dans ce message) peuvent être cités. Si cette banque est absente, retombe sur Drew (Ghost House Farm), Scott (Indian Creek Orchard Gardens) et Dan (Broadfork Farm) uniquement. Aucun nom hors de ce périmètre.
- Au PREMIER usage du prénom dans le courriel, ajoute toujours un ancrage minimal : prénom + ferme + région tels qu'apparus dans la banque (ex. "Catherine, de la Ferme des Quatre-Temps au Québec" / "Drew, de Ghost House Farm au Michigan"). Jamais le prénom seul, le destinataire ne connaît pas la personne.
- Une seule histoire-pilier par courriel (deux maximum si vraiment pertinent), pas une parade de noms.
- Si aucune histoire de la banque ne colle naturellement au contexte du QC, dis "un producteur qu'on accompagne" / "another grower we work with" sans nom — n'en force pas une.
- Ne cite jamais textuellement plus d'une phrase courte ; reformule plutôt l'idée. Si une entrée de la banque est annotée "Pas l'autorisation de l'utiliser encore" ou équivalent, ne mentionne ni le nom ni la ferme ni le quote correspondant.

QUÉBÉCOIS (si lang=fr) :
- Pas de tournures France ("formidable", "ravi", "Bien à vous", "soit", "passer commande", "vingtaine de minutes").
- OK : "on", "ça", "pas de problème", "Au plaisir", "donnez-moi des nouvelles", "votre bord/côté", "avant la prochaine saison", "trotte en tête", "faire le tour".
- Salutation : "Bonjour {prénom}," ou "Bonjour,". Signature : "Au plaisir," ou "Merci,".

OBJECTIF DE CE COURRIEL :
Relancer un prospect avec qui on a fait un appel de qualification, dont le projet a fini en "Perdu" (statut). Pas une vente directe. Une porte ouverte avant la prochaine saison. Reformuler ce qu'il avait partagé pendant l'appel — sans citer mot pour mot, en intégrant ça dans la prose. Glisser une mini-preuve (Drew/Scott/Dan) si pertinente. Finir sur une invitation de 20 minutes sans pression.

FORMAT DE SORTIE :
JSON strict avec deux clés : "subject" (string) et "body" (string). Termine le body par la salutation finale ("Au plaisir," en FR, "Talk soon," en EN) suivie de la signature (nom + rôle) telle que spécifiée dans les règles supplémentaires de l'utilisateur. Pas de "[Signature]" placeholder : écris la vraie signature.
`.trim()

// Limites de l'historique injecté dans le prompt IA. 12 / 18 mois = ~1000 tokens
// dans le pire cas (12 courriels longs), reste sous le budget contexte raisonnable.
const HISTORY_MAX_ITEMS = 12
const HISTORY_MAX_MONTHS = 18
const HISTORY_BODY_CHARS = 400

// Récupère les dernières interactions (emails + calls) de la company sur l'horizon
// défini, et les formate en bloc lisible pour le prompt système. Le but : permettre
// à l'IA de référencer un échange précis ("suite à ton courriel de la semaine
// passée") au lieu de rester générique. On garde le sortant automatique (relances
// précédentes, factures) — l'IA voit ainsi qu'on a déjà écrit et évite de
// reproduire le même angle.
function buildHistoryBlock(companyId, lang) {
  if (!companyId) return null

  const rows = db.prepare(`
    SELECT i.id, i.type, i.direction, i.timestamp,
           e.subject AS email_subject, e.body_text AS email_body,
           c.summary AS call_summary, c.duration_seconds AS call_duration,
           c.transcript_formatted AS call_transcript
    FROM interactions i
    LEFT JOIN emails e ON e.interaction_id = i.id
    LEFT JOIN calls c ON c.interaction_id = i.id
    WHERE i.company_id = ?
      AND i.type IN ('email', 'call')
      AND i.timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${HISTORY_MAX_MONTHS} months')
    ORDER BY i.timestamp DESC
    LIMIT ?
  `).all(companyId, HISTORY_MAX_ITEMS)

  if (rows.length === 0) return null

  // Inverse pour ordre chronologique (plus vieux → plus récent) — lecture naturelle.
  const items = rows.reverse().map(r => {
    const date = r.timestamp ? r.timestamp.slice(0, 10) : '?'
    const dir = r.direction === 'in' ? (lang === 'fr' ? 'entrant' : 'inbound')
              : r.direction === 'out' ? (lang === 'fr' ? 'sortant' : 'outbound')
              : ''
    if (r.type === 'email') {
      const subj = (r.email_subject || '(sans sujet)').trim()
      const body = (r.email_body || '').replace(/\s+/g, ' ').trim().slice(0, HISTORY_BODY_CHARS)
      const ellipsis = (r.email_body || '').length > HISTORY_BODY_CHARS ? '…' : ''
      return `- ${date} [courriel ${dir}] "${subj}" — ${body}${ellipsis}`
    }
    // call
    const mins = r.call_duration ? `${Math.round(r.call_duration / 60)} min` : 'durée inconnue'
    const content = r.call_summary
      || (r.call_transcript ? r.call_transcript.replace(/\s+/g, ' ').slice(0, HISTORY_BODY_CHARS) + '…' : (lang === 'fr' ? 'pas de résumé disponible' : 'no summary available'))
    return `- ${date} [appel ${dir}, ${mins}] ${content}`
  })

  const header = lang === 'fr'
    ? `Historique récent (${rows.length} interaction(s), ordre chronologique, ${HISTORY_MAX_MONTHS} derniers mois) :`
    : `Recent history (${rows.length} interaction(s), chronological, last ${HISTORY_MAX_MONTHS} months):`

  return `${header}\n${items.join('\n')}`
}

function buildRegenContext({ qc, company, contact, lostProject, lang }) {
  const challenges = nonPlaceholder(qc.challenges)
  const farmDesc = nonPlaceholder(qc.farm_description)
  const summary = nonPlaceholder(qc.summary)
  const goals = nonPlaceholder(qc.short_term_goals)
  const motivation = nonPlaceholder(qc.motivation_today) || nonPlaceholder(qc.motivation_why_now)
  // Prénom : le contact de l'entreprise est prioritaire (record CRM propre),
  // fallback sur decision_maker_name (champ texte libre).
  const decisionName = nonPlaceholder(contact?.first_name) || firstName(qc.decision_maker_name)
  const businessModels = parseList(qc.business_models)
  const callMonth = fmtMonth(qc.call_date, lang)
  const callMonthsAgo = monthsSince(qc.call_date)
  const lostMonth = fmtMonth(lostProject?.close_date, lang)
  const allText = [challenges, farmDesc, summary, goals, motivation].filter(Boolean).join(' ')
  const topics = detectTopics(allText)

  // Bloc structuré (pas un dump JSON brut) que le modèle peut lire facilement.
  const lines = []
  lines.push(`Langue de sortie : ${lang === 'fr' ? 'français québécois' : 'English'}`)
  lines.push(`Entreprise : ${company.name}${company.lifecycle_phase ? ` (phase: ${company.lifecycle_phase})` : ''}`)
  if (contact) {
    const fullName = [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim()
    if (fullName) lines.push(`Contact principal : ${fullName}${contact.email ? ` (${contact.email})` : ''}`)
  }
  if (decisionName) lines.push(`Prénom à utiliser dans la salutation : ${decisionName}`)
  if (callMonth) {
    // On annote la date avec le nombre de mois écoulés pour que l'IA puisse
    // formuler une référence relative naturelle ("il y a un peu plus d'un an"
    // plutôt que "en avril" tout sec, qui sonne faux quand l'appel a >1 an).
    const rel = callMonthsAgo != null && callMonthsAgo >= 3
      ? (lang === 'fr' ? ` (il y a ${callMonthsAgo} mois)` : ` (${callMonthsAgo} months ago)`)
      : ''
    lines.push(`Date de l'appel de qualification : ${callMonth}${rel}`)
  }
  if (lostProject) {
    const parts = [lostProject.project_number]
    if (lostMonth) parts.push(`fermé en ${lostMonth}`)
    if (lostProject.value_cad) parts.push(`valeur estimée ${lostProject.value_cad} CAD`)
    if (lostProject.refusal_reason) parts.push(`raison: ${lostProject.refusal_reason}`)
    lines.push(`Projet perdu : ${parts.join(', ')}`)
  }
  if (businessModels.length) lines.push(`Modèles d'affaires : ${businessModels.join(', ')}`)
  if (farmDesc) lines.push(`Description de la ferme (verbatim, ne pas copier-coller) :\n${farmDesc}`)
  if (challenges) lines.push(`Défis abordés (verbatim, à reformuler) :\n${challenges}`)
  if (goals) lines.push(`Objectifs court terme (verbatim) :\n${goals}`)
  if (motivation) lines.push(`Motivation exprimée (verbatim, peut être un long extrait de transcription) :\n${motivation}`)
  if (summary) lines.push(`Résumé (verbatim) :\n${summary}`)
  if (topics.length) lines.push(`Thèmes détectés (à privilégier dans la prose) : ${topics.join(', ')}`)

  const history = buildHistoryBlock(company.id, lang)
  if (history) lines.push(history)

  return lines.join('\n\n')
}

// ── Banque de témoignages clients (PDF public) ────────────────────────────
//
// Le PDF "Feedbacks positifs.pdf" est uploadé dans la zone "Fichiers publics"
// de l'app et référencé ici par son token. À chaque régénération, on lit le
// fichier depuis uploads/public/, on en extrait le texte via pdftotext, et on
// l'injecte comme bloc séparé dans le system prompt. Le cache module-level
// évite de relancer pdftotext à chaque appel ; il s'invalide automatiquement
// si le stored_name ou la mtime change.
//
// Pour swapper le PDF : uploader un nouveau fichier dans la page "Fichiers
// publics", récupérer le nouveau token (segment final de l'URL /erp/p/<token>),
// puis remplacer la constante ci-dessous. Le token actuel pointe sur
// /erp/p/9f4b6a8de21508239eb6ee64e68bfbe8.
const TESTIMONIALS_PUBLIC_TOKEN = '9f4b6a8de21508239eb6ee64e68bfbe8'

const PUBLIC_UPLOADS_DIR = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'public')

let testimonialsCache = { storedName: null, mtimeMs: 0, text: null }

function loadTestimonialsContext() {
  if (!TESTIMONIALS_PUBLIC_TOKEN) return null
  const row = db.prepare(
    'SELECT stored_name, mime_type FROM public_files WHERE token = ?'
  ).get(TESTIMONIALS_PUBLIC_TOKEN)
  if (!row) return null

  const filePath = join(PUBLIC_UPLOADS_DIR, row.stored_name)
  if (!existsSync(filePath)) return null

  const mtimeMs = statSync(filePath).mtimeMs
  if (
    testimonialsCache.storedName === row.stored_name &&
    testimonialsCache.mtimeMs === mtimeMs &&
    testimonialsCache.text
  ) {
    return testimonialsCache.text
  }

  let text = null
  try {
    if ((row.mime_type || '').toLowerCase().includes('pdf')) {
      text = execFileSync('pdftotext', ['-layout', filePath, '-'], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      })
    } else {
      // Fallback texte brut si quelqu'un upload un .txt à la place du PDF.
      text = execFileSync('cat', [filePath], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
    }
  } catch (e) {
    console.error('[relanceEmail] Échec extraction banque de témoignages :', e.message)
    return null
  }

  text = (text || '').trim()
  if (!text) return null
  testimonialsCache = { storedName: row.stored_name, mtimeMs, text }
  return text
}

export async function regenerateEmail({ qcId, temperature = 0.7, generalRules, specificInstructions }) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY non configuré')

  const qc = db.prepare('SELECT * FROM qualification_calls WHERE id = ?').get(qcId)
  if (!qc) throw new Error('Qualification call introuvable')
  if (!qc.company_id) throw new Error('Ce qualification call n\'est lié à aucune company')

  const company = db.prepare('SELECT id, name, lifecycle_phase FROM companies WHERE id = ?').get(qc.company_id)
  if (!company) throw new Error('Company introuvable')

  // Premier contact de l'entreprise (par ordre de création). Si plusieurs
  // contacts existent, on prend le plus ancien — cf. CLAUDE.md / demande user.
  const contact = db.prepare(`
    SELECT id, first_name, last_name, email
    FROM contacts
    WHERE company_id = ?
    ORDER BY created_at ASC
    LIMIT 1
  `).get(qc.company_id)

  const lostProject = db.prepare(`
    SELECT id, name AS project_number, status, close_date, value_cad, refusal_reason
    FROM projects
    WHERE company_id = ? AND status = 'Perdu'
    ORDER BY COALESCE(close_date, created_at) DESC
    LIMIT 1
  `).get(qc.company_id)

  const allText = [qc.challenges, qc.farm_description, qc.summary, qc.short_term_goals,
                   qc.motivation_today, qc.motivation_why_now]
    .map(nonPlaceholder).filter(Boolean).join(' ')
  const lang = detectLanguage(allText)

  const context = buildRegenContext({ qc, company, contact, lostProject, lang })

  const t = Math.max(0, Math.min(1.5, Number(temperature) || 0))

  // System prompt = brief de marque + règles générales utilisateur (si présentes)
  // + banque de témoignages clients extraite du PDF public (si dispo).
  // Les règles utilisateur s'ajoutent après le brief pour pouvoir le nuancer
  // sans le contredire. La banque est appendée en dernier : elle ne contient
  // que des données factuelles (citations, fermes), pas des règles d'écriture.
  const general = (generalRules || '').trim()
  const baseSystem = general
    ? `${BRAND_BRIEF}\n\nRÈGLES SUPPLÉMENTAIRES (définies par l'utilisateur, à respecter) :\n${general}`
    : BRAND_BRIEF
  const testimonials = loadTestimonialsContext()
  const systemMessage = testimonials
    ? `${baseSystem}\n\nBANQUE DE TÉMOIGNAGES CLIENTS (extrait du document "Feedbacks positifs") :\n${testimonials}`
    : baseSystem

  // User message = contexte + instructions spécifiques à ce prospect.
  const specific = (specificInstructions || '').trim()
  const specificBlock = specific
    ? `\n\nINSTRUCTIONS SPÉCIFIQUES POUR CE COURRIEL (priorité haute) :\n${specific}`
    : ''
  const userMessage = `Contexte du prospect :\n\n${context}${specificBlock}\n\nGénère un courriel de relance qui suit toutes les règles ci-dessus. JSON strict avec "subject" et "body".`

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: REGEN_MODEL,
      response_format: { type: 'json_object' },
      temperature: t,
      max_tokens: 900,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage },
      ],
    }),
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(err.error?.message || `OpenAI HTTP ${resp.status}`)
  }
  const data = await resp.json()
  const raw = data.choices?.[0]?.message?.content
  if (!raw) throw new Error('Réponse OpenAI vide')

  let parsed
  try { parsed = JSON.parse(raw) } catch { throw new Error('Réponse OpenAI non-JSON') }

  const subject = typeof parsed.subject === 'string' ? parsed.subject.trim() : null
  const body = typeof parsed.body === 'string' ? parsed.body.trim() : null
  if (!subject || !body) throw new Error('Réponse OpenAI incomplète (subject/body manquant)')

  // Persistance : on stocke la régénération comme draft pour ce QC. Survit
  // aux reloads ; "Restaurer le template" supprime cette ligne (DELETE route).
  saveAiDraft(qcId, { subject, body, language: lang, model: REGEN_MODEL, temperature: t })

  return {
    subject,
    body,
    language: lang,
    model: REGEN_MODEL,
    temperature: t,
    generated_by: 'openai',
  }
}

// ── Overrides (règles générales + instructions spécifiques par QC) ────────

// Filet de sécurité au cas où le serveur tourne sur une DB pas encore migrée.
db.exec(`
  CREATE TABLE IF NOT EXISTS email_relance_overrides (
    scope TEXT PRIMARY KEY,
    instructions TEXT,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`)

// Drafts persistés par QC : la régénération IA ET les éditions manuelles sont
// stockées ici pour survivre aux reloads de la page. Colonnes ai_* gardent la
// trace de la dernière baseline IA — permet de détecter "édité manuellement"
// (subject ≠ ai_subject) et de réafficher le badge "Généré par IA · model · temp".
// "Restaurer le template" = DELETE de la ligne (cf. routes).
db.exec(`
  CREATE TABLE IF NOT EXISTS email_relance_drafts (
    qc_id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    ai_subject TEXT,
    ai_body TEXT,
    ai_language TEXT,
    ai_model TEXT,
    ai_temperature REAL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`)
// Suivi des envois — additif, idempotent. Ne pas DELETE le draft à l'envoi :
// on garde la trace pour afficher "Envoyé le X" et permettre une réédition/renvoi.
try { db.exec('ALTER TABLE email_relance_drafts ADD COLUMN sent_at TEXT') } catch {}
try { db.exec('ALTER TABLE email_relance_drafts ADD COLUMN sent_to TEXT') } catch {}
try { db.exec('ALTER TABLE email_relance_drafts ADD COLUMN sent_from TEXT') } catch {}
try { db.exec('ALTER TABLE email_relance_drafts ADD COLUMN sent_message_id TEXT') } catch {}

const GLOBAL_SCOPE = 'global'

export function getOverride(scope) {
  const row = db.prepare('SELECT instructions FROM email_relance_overrides WHERE scope = ?').get(scope)
  return row?.instructions || null
}

export function setOverride(scope, instructions) {
  const value = (instructions || '').trim() || null
  if (value === null) {
    db.prepare('DELETE FROM email_relance_overrides WHERE scope = ?').run(scope)
    return null
  }
  db.prepare(`
    INSERT INTO email_relance_overrides (scope, instructions, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(scope) DO UPDATE SET
      instructions = excluded.instructions,
      updated_at = excluded.updated_at
  `).run(scope, value)
  return value
}

export function getAllOverrides() {
  const rows = db.prepare('SELECT scope, instructions FROM email_relance_overrides').all()
  const general = rows.find(r => r.scope === GLOBAL_SCOPE)?.instructions || ''
  const perQc = {}
  for (const r of rows) if (r.scope !== GLOBAL_SCOPE) perQc[r.scope] = r.instructions
  return { general, perQc }
}

export { GLOBAL_SCOPE }

// ── Drafts persistés (par QC) ────────────────────────────────────────────

export function getDraft(qcId) {
  return db.prepare(`
    SELECT qc_id, subject, body, ai_subject, ai_body, ai_language, ai_model, ai_temperature,
           sent_at, sent_to, sent_from, sent_message_id
    FROM email_relance_drafts WHERE qc_id = ?
  `).get(qcId) || null
}

// Marque un draft comme envoyé. Si le draft n'existe pas encore (cas où l'on
// envoie directement le template sans édition préalable), on l'upsert avec le
// contenu envoyé pour pouvoir afficher "Envoyé" et conserver l'historique.
export function markDraftSent(qcId, { subject, body, to, from, messageId }) {
  const existing = db.prepare('SELECT 1 FROM email_relance_drafts WHERE qc_id = ?').get(qcId)
  const now = new Date().toISOString()
  if (existing) {
    db.prepare(`
      UPDATE email_relance_drafts
      SET sent_at = ?, sent_to = ?, sent_from = ?, sent_message_id = ?, updated_at = ?
      WHERE qc_id = ?
    `).run(now, to, from, messageId, now, qcId)
  } else {
    db.prepare(`
      INSERT INTO email_relance_drafts
        (qc_id, subject, body, sent_at, sent_to, sent_from, sent_message_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(qcId, subject, body, now, to, from, messageId, now, now)
  }
}

// Upsert d'une régénération IA : on positionne ai_* ET subject/body sur la même
// sortie IA (l'utilisateur n'a pas encore édité par-dessus).
export function saveAiDraft(qcId, { subject, body, language, model, temperature }) {
  db.prepare(`
    INSERT INTO email_relance_drafts (qc_id, subject, body, ai_subject, ai_body, ai_language, ai_model, ai_temperature, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(qc_id) DO UPDATE SET
      subject = excluded.subject,
      body = excluded.body,
      ai_subject = excluded.ai_subject,
      ai_body = excluded.ai_body,
      ai_language = excluded.ai_language,
      ai_model = excluded.ai_model,
      ai_temperature = excluded.ai_temperature,
      updated_at = excluded.updated_at
  `).run(qcId, subject, body, subject, body, language || null, model || null, temperature ?? null)
}

// Upsert d'une édition manuelle : on met à jour subject/body sans toucher aux
// ai_* (s'il y en a). Premier save sans IA → ai_* restent null.
export function saveUserDraft(qcId, { subject, body }) {
  const existing = db.prepare('SELECT 1 FROM email_relance_drafts WHERE qc_id = ?').get(qcId)
  if (existing) {
    db.prepare(`
      UPDATE email_relance_drafts
      SET subject = ?, body = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE qc_id = ?
    `).run(subject, body, qcId)
  } else {
    db.prepare(`
      INSERT INTO email_relance_drafts (qc_id, subject, body)
      VALUES (?, ?, ?)
    `).run(qcId, subject, body)
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function buildRelanceList() {
  // Companies avec QC + lifecycle_phase = 'Quote Sent' (HubSpot). Pour chaque company :
  //   - QC le plus récent (qui a le plus de signal)
  //   - projet Perdu le plus récent s'il existe (optionnel — pour la date de
  //     référence dans le template ; pas un filtre)
  const companies = db.prepare(`
    SELECT DISTINCT c.id, c.name, c.lifecycle_phase
    FROM qualification_calls q
    JOIN companies c ON c.id = q.company_id
    WHERE q.company_id IS NOT NULL AND c.lifecycle_phase = 'Quote Sent'
    ORDER BY c.name
  `).all()

  const qcStmt = db.prepare(`
    SELECT * FROM qualification_calls
    WHERE company_id = ?
    ORDER BY COALESCE(call_date, airtable_created_at) DESC
    LIMIT 1
  `)
  const projStmt = db.prepare(`
    SELECT id, name AS project_number, status, close_date, value_cad, refusal_reason
    FROM projects
    WHERE company_id = ? AND status = 'Perdu'
    ORDER BY COALESCE(close_date, created_at) DESC
    LIMIT 1
  `)
  // Premier contact de l'entreprise (par ordre de création) — utilisé comme
  // prénom de personnalisation du courriel, prioritaire sur decision_maker_name.
  const contactStmt = db.prepare(`
    SELECT id, first_name, last_name, email
    FROM contacts
    WHERE company_id = ?
    ORDER BY created_at ASC
    LIMIT 1
  `)

  const out = []
  for (const c of companies) {
    const qc = qcStmt.get(c.id)
    if (!qc) continue
    const lostProject = projStmt.get(c.id)
    const contact = contactStmt.get(c.id)
    const draft = getDraft(qc.id)

    // email = le draft IA persisté, ou null si pas encore généré. La carte
    // frontend affiche un état vide avec bouton 'Générer avec l'IA' quand null.
    const email = draft
      ? {
          subject: draft.subject,
          body: draft.body,
          language: draft.ai_language || 'fr',
          model: draft.ai_model,
          temperature: draft.ai_temperature,
          // userEdited = l'utilisateur a édité par-dessus la sortie IA d'origine.
          userEdited: !!(draft.ai_subject && (draft.subject !== draft.ai_subject || draft.body !== draft.ai_body)),
        }
      : null

    const sent = draft?.sent_at
      ? { at: draft.sent_at, to: draft.sent_to, from: draft.sent_from, messageId: draft.sent_message_id }
      : null

    out.push({
      company: { id: c.id, name: c.name, lifecycle_phase: c.lifecycle_phase },
      contact: contact || null,
      project: lostProject || null,
      sent,
      qualification_call: {
        id: qc.id,
        call_date: qc.call_date,
        challenges: qc.challenges,
        farm_description: qc.farm_description,
        business_models: parseList(qc.business_models),
        timeline: qc.timeline,
        decision_maker_name: qc.decision_maker_name,
        short_term_goals: qc.short_term_goals,
        motivation_today: qc.motivation_today,
        motivation_why_now: qc.motivation_why_now,
      },
      email,
    })
  }
  return out
}
