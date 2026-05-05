// Génère des templates d'email de relance pour les entreprises ayant eu un
// qualification call mais dont aucun projet n'a abouti (statut Perdu).
//
// Pas d'envoi — uniquement génération de subject + body personnalisés selon
// les défis abordés pendant le QC. Le frontend affiche la liste; l'utilisateur
// copie/colle dans son client mail.

import db from '../db/database.js'

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

// Étiquettes courtes pour les sujets de mail (les phrases prose sont trop
// longues quand on les met direct dans un subject line).
const TOPIC_LABELS = {
  fr: {
    humidity: "humidité", heat: "chaleur", ventilation: "aération",
    disease: "maladies", remote: "suivi à distance", manual: "tout-manuel",
    yield: "rendement", irrigation: "irrigation", labor: "heures de gestion",
    energy: "énergie", pests: "ravageurs", flowering: "nouaison",
  },
  en: {
    humidity: "humidity", heat: "heat", ventilation: "venting",
    disease: "disease pressure", remote: "remote monitoring", manual: "manual control",
    yield: "yield", irrigation: "irrigation", labor: "labor hours",
    energy: "energy", pests: "pests", flowering: "fruit set",
  },
}

// Phrases naturelles pour reformuler les défis détectés en prose (vs. liste à puces).
const TOPIC_PHRASES = {
  fr: {
    humidity:    "la gestion de l'humidité",
    heat:        "le contrôle de la chaleur",
    ventilation: "l'aération qui suit pas le réel",
    disease:     "la pression des maladies",
    remote:      "l'envie de pouvoir suivre la serre à distance",
    manual:      "le fait que tout passe par les bras",
    yield:       "le rendement en serre",
    irrigation:  "l'irrigation",
    labor:       "la course aux heures",
    energy:      "le poste énergie",
    pests:       "les ravageurs",
    flowering:   "des soucis de fleurs et de nouaison",
  },
  en: {
    humidity:    "humidity management",
    heat:        "heat control",
    ventilation: "ventilation that doesn't follow what's actually happening",
    disease:     "disease pressure",
    remote:      "wanting to keep an eye on the greenhouse from anywhere",
    manual:      "the fact that everything runs through your hands",
    yield:       "greenhouse yield",
    irrigation:  "irrigation",
    labor:       "the hours pile",
    energy:      "energy use",
    pests:       "pest pressure",
    flowering:   "flowering and fruit set issues",
  },
}

// Petite ligne taillée par sujet, glissée dans le paragraphe d'insight quand il
// y a un topic dominant. Pas de tirets (règle de marque), ton humble.
const TOPIC_LINES = {
  fr: {
    humidity:    "L'humidité pilotée par seuils, c'est souvent ce qui débloque le reste.",
    heat:        "Quand la chaleur suit la température réelle plutôt qu'une horloge, on récupère 1 ou 2 °C sans toucher au chauffage.",
    ventilation: "Quand les ouvertures suivent la température au lieu d'un horaire fixe, ça change beaucoup la stabilité de la journée.",
    disease:     "Plusieurs producteurs nous disent qu'avec un suivi humidité continu ils ont coupé leurs traitements de moitié.",
    remote:      "Pouvoir vérifier la serre du téléphone, sans angle mort, c'est ce qui change le plus le quotidien.",
    manual:      "Quitter le manuel, même partiellement, ça enlève les nuits où il faut sortir vérifier une porte.",
    yield:       "Sur les fermes qu'on accompagne, les gains viennent surtout de la stabilité jour/nuit, pas d'une nouvelle variété.",
    irrigation:  "L'irrigation pilotée par capteurs au lieu d'une minuterie, c'est typiquement moins d'eau pour un meilleur résultat.",
    labor:       "L'objectif, c'est jamais de remplacer du monde. C'est de pas avoir à envoyer quelqu'un à la serre à 22h pour une porte.",
    energy:      "Sur l'énergie, l'optimisation horaire et les ouvertures progressives donnent un retour rapide, même sur du chauffage existant.",
    pests:       "Un suivi continu attrape la première hausse de population avant qu'elle soit visible. C'est là que les traitements coûtent le moins.",
    flowering:   "Stabiliser l'humidité et la chaleur aux bons moments de la journée règle souvent les problèmes de nouaison.",
  },
  en: {
    humidity:    "Driving humidity off setpoints is usually what unlocks the rest.",
    heat:        "When heat tracks actual temperature instead of a clock, you tend to pick up 1 to 2 °C without touching heating.",
    ventilation: "When the openings follow the temperature instead of a fixed schedule, it really changes how stable the day is.",
    disease:     "Several growers tell us that continuous humidity tracking lets them cut treatments in half.",
    remote:      "Being able to check the greenhouse from your phone, with no blind spot, is what changes daily life the most.",
    manual:      "Even partially leaving manual behind takes out the nights where someone has to drive over to check a door.",
    yield:       "On the farms we work with, the gains come mostly from day/night stability, not from a new variety.",
    irrigation:  "Sensor-driven irrigation instead of a timer typically means less water for a better crop response.",
    labor:       "It's never about replacing people. It's about not having to send someone out at 10 pm for a door.",
    energy:      "On the energy side, peak/off-peak timing and staged openings pay back quickly, even on existing heating.",
    pests:       "Continuous tracking catches the first jump in population before it's visible. That's when treatments cost the least.",
    flowering:   "Stabilizing humidity and heat at the right time of day usually clears up fruit set issues.",
  },
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
// Élision FR : "en avril" reste "en avril", mais "de avril" → "d'avril".
function enPrep(month, lang) {
  if (lang !== 'fr') return month
  return /^[aeiouhâéèêëîïôöûüÿ]/i.test(month) ? `en ${month}` : `en ${month}`
}

// Compose une liste FR ou EN à partir de fragments : "X, Y et Z" / "X, Y and Z".
function joinList(items, lang) {
  const arr = items.filter(Boolean)
  if (arr.length === 0) return null
  if (arr.length === 1) return arr[0]
  const sep = lang === 'fr' ? ' et ' : ' and '
  return arr.slice(0, -1).join(', ') + sep + arr[arr.length - 1]
}

// ── Templates ──────────────────────────────────────────────────────────────

function buildEmail({ qc, lostProject, lang }) {
  const challenges = nonPlaceholder(qc.challenges)
  const farmDesc = nonPlaceholder(qc.farm_description)
  const summary = nonPlaceholder(qc.summary)
  const goals = nonPlaceholder(qc.short_term_goals)
  const motivation = nonPlaceholder(qc.motivation_today) || nonPlaceholder(qc.motivation_why_now)
  const decisionName = firstName(qc.decision_maker_name)
  const callMonth = fmtMonth(qc.call_date, lang)
  const lostMonth = fmtMonth(lostProject?.close_date, lang)

  const allText = [challenges, farmDesc, summary, goals, motivation].filter(Boolean).join(' ')
  const topics = detectTopics(allText)
  const phrases = topics.map(t => TOPIC_PHRASES[lang][t]).filter(Boolean)
  const topicList = joinList(phrases, lang)
  const topicLine = topics.length ? TOPIC_LINES[lang][topics[0]] : null

  if (lang === 'fr') {
    // Salutation Québécois professionnelle.
    const greeting = decisionName ? `Bonjour ${decisionName},` : 'Bonjour,'

    // Référence à l'appel : « notre échange en X » (neutre Québécois).
    const callRef = callMonth ? `notre échange ${enPrep(callMonth, 'fr')}` : 'notre échange au téléphone'

    // Reformulation prose des défis (vs. liste à puces verbatim).
    let challengeSentence
    if (topicList) {
      challengeSentence = `Ce qui revenait surtout, c'était ${topicList}.`
    } else if (challenges) {
      challengeSentence = "On avait fait le tour de votre saison et de ce qui pesait le plus sur votre temps."
    } else {
      challengeSentence = "On avait pris le temps de regarder votre saison ensemble."
    }

    // Paragraphe positionnement : pression libérée par le rendement, vie de
    // famille reprise, histoire concrète d'un producteur (Drew). Aligné brand.
    const positioning =
      "Plusieurs fermes avec qui on travaille étaient au même point. " +
      (topicLine ? topicLine + ' ' : '') +
      "Drew, un producteur qu'on accompagne, a doublé sa production de tomates l'année passée. Sa conjointe a pu lâcher sa job à l'extérieur pour revenir travailler à la ferme à temps plein."

    // CTA léger, ton Québécois, pas de pression.
    const lostRef = lostMonth ? ` On s'était laissés ${enPrep(lostMonth, 'fr')} sans aller plus loin.` : ''
    const closing =
`Si jamais l'idée vous trotte encore en tête pour la prochaine saison, on prend 20 minutes ensemble?${lostRef} Pas de pression, juste pour faire le tour.

Au plaisir,
[Signature]`

    // Sujet : minuscule, ton texto, sans tiret. Étiquette compacte du sujet.
    const subjectLabel = topics[0] ? TOPIC_LABELS.fr[topics[0]] : null
    let subject
    if (subjectLabel) {
      subject = `${subjectLabel}, ça a bougé de votre bord?`
    } else if (callMonth) {
      subject = `petite pensée avant la prochaine saison`
    } else {
      subject = `on se reprend avant la prochaine saison?`
    }

    const body =
`${greeting}

Je repense à ${callRef}. ${challengeSentence}

${positioning}

${closing}`

    return { subject, body, language: 'fr' }
  }

  // ── EN ─────────────────────────────────────────────────────────────
  const greeting = decisionName ? `Hi ${decisionName},` : 'Hi,'
  const callRef = callMonth ? `our chat in ${callMonth}` : 'our call'

  let challengeSentence
  if (topicList) {
    challengeSentence = `What kept coming up was ${topicList}.`
  } else if (challenges) {
    challengeSentence = "We'd walked through your season and what was eating the most of your time."
  } else {
    challengeSentence = "We'd taken time to look at your season together."
  }

  const positioning =
    "A lot of the farms we work with were in the same place. " +
    (topicLine ? topicLine + ' ' : '') +
    "Drew, a grower we work with, doubled his tomato production last year. His wife was able to leave her off-farm job and come back to the farm full time."

  const lostRef = lostMonth ? ` We'd left things in ${lostMonth} without taking it further.` : ''
  const closing =
`If the idea is still in the back of your mind for next season, want to grab 20 minutes?${lostRef} No pressure, just a check in.

Talk soon,
[Signature]`

  const subjectLabel = topics[0] ? TOPIC_LABELS.en[topics[0]] : null
  let subject
  if (subjectLabel) {
    subject = `${subjectLabel}, any movement on your end?`
  } else if (callMonth) {
    subject = `thinking ahead to next season`
  } else {
    subject = `want to pick up where we left off?`
  }

  const body =
`${greeting}

I was thinking back to ${callRef}. ${challengeSentence}

${positioning}

${closing}`

  return { subject, body, language: 'en' }
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
- Drew : "Our first spring in the hoop house was awful. It was miserable." → "We DOUBLED tomato production compared to last year." → "Allison quit her day job and we're both farming full time now."
- Scott : "We were unable to accept a dinner invitation… we had to be around to open or close." → "Our automation freed us from all that stress… game changer."
- Dan : "The tunnel will do a better job by itself… disease go down, yield went up dramatically." → "We wish we had done it sooner. I'd do this five years ago."

RÈGLES D'ÉCRITURE STRICTES :
- AUCUN tiret cadratin (em-dash —) ni demi-cadratin (–) comme ponctuation stylistique. Utiliser virgule, point, point-virgule, parenthèses ou "et" à la place.
- Utiliser les contractions ("on", "c'est", "y a", "j'ai", "we're", "you're", "don't").
- Sujet en minuscules, ton texto-d'un-ami, court (≤ 8 mots).
- Histoire concrète, pas d'abstraction. Pas d'exagération chiffrée non sourcée.
- Ne pas mettre de mots dans la bouche du producteur.
- Pas de fausse urgence, pas de "limited time", pas de superlatifs vides.
- "ft²" pour les surfaces (anglais) / "pi²" (français).

QUÉBÉCOIS (si lang=fr) :
- Pas de tournures France ("formidable", "ravi", "Bien à vous", "soit", "passer commande", "vingtaine de minutes").
- OK : "on", "ça", "pas de problème", "Au plaisir", "donnez-moi des nouvelles", "votre bord/côté", "avant la prochaine saison", "trotte en tête", "faire le tour".
- Salutation : "Bonjour {prénom}," ou "Bonjour,". Signature : "Au plaisir," ou "Merci,".

OBJECTIF DE CE COURRIEL :
Relancer un prospect avec qui on a fait un appel de qualification, dont le projet a fini en "Perdu" (statut). Pas une vente directe. Une porte ouverte avant la prochaine saison. Reformuler ce qu'il avait partagé pendant l'appel — sans citer mot pour mot, en intégrant ça dans la prose. Glisser une mini-preuve (Drew/Scott/Dan) si pertinente. Finir sur une invitation de 20 minutes sans pression.

FORMAT DE SORTIE :
JSON strict avec deux clés : "subject" (string) et "body" (string, signature incluse mais nom remplacé par "[Signature]").
`.trim()

function buildRegenContext({ qc, company, lostProject, lang }) {
  const challenges = nonPlaceholder(qc.challenges)
  const farmDesc = nonPlaceholder(qc.farm_description)
  const summary = nonPlaceholder(qc.summary)
  const goals = nonPlaceholder(qc.short_term_goals)
  const motivation = nonPlaceholder(qc.motivation_today) || nonPlaceholder(qc.motivation_why_now)
  const decisionName = firstName(qc.decision_maker_name)
  const businessModels = parseList(qc.business_models)
  const callMonth = fmtMonth(qc.call_date, lang)
  const lostMonth = fmtMonth(lostProject?.close_date, lang)
  const allText = [challenges, farmDesc, summary, goals, motivation].filter(Boolean).join(' ')
  const topics = detectTopics(allText)

  // Bloc structuré (pas un dump JSON brut) que le modèle peut lire facilement.
  const lines = []
  lines.push(`Langue de sortie : ${lang === 'fr' ? 'français québécois' : 'English'}`)
  lines.push(`Entreprise : ${company.name}${company.lifecycle_phase ? ` (phase: ${company.lifecycle_phase})` : ''}`)
  if (decisionName) lines.push(`Prénom du décideur : ${decisionName}`)
  if (callMonth) lines.push(`Date de l'appel de qualification : ${callMonth}`)
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

  return lines.join('\n\n')
}

export async function regenerateEmail({ qcId, temperature = 0.7, generalRules, specificInstructions }) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY non configuré')

  const qc = db.prepare('SELECT * FROM qualification_calls WHERE id = ?').get(qcId)
  if (!qc) throw new Error('Qualification call introuvable')
  if (!qc.company_id) throw new Error('Ce qualification call n\'est lié à aucune company')

  const company = db.prepare('SELECT id, name, lifecycle_phase FROM companies WHERE id = ?').get(qc.company_id)
  if (!company) throw new Error('Company introuvable')

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

  const context = buildRegenContext({ qc, company, lostProject, lang })

  const t = Math.max(0, Math.min(1.5, Number(temperature) || 0))

  // System prompt = brief de marque + règles générales utilisateur (si présentes).
  // Ces dernières s'ajoutent après le brief pour pouvoir le nuancer sans le contredire.
  const general = (generalRules || '').trim()
  const systemMessage = general
    ? `${BRAND_BRIEF}\n\nRÈGLES SUPPLÉMENTAIRES (définies par l'utilisateur, à respecter) :\n${general}`
    : BRAND_BRIEF

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

// ── Public API ─────────────────────────────────────────────────────────────

export function buildRelanceList() {
  // Companies avec QC + au moins un projet Perdu. Pour chaque company :
  //   - QC le plus récent (qui a le plus de signal)
  //   - projet Perdu le plus récent (pour la date de référence)
  const companies = db.prepare(`
    SELECT DISTINCT c.id, c.name, c.lifecycle_phase
    FROM qualification_calls q
    JOIN companies c ON c.id = q.company_id
    JOIN projects p ON p.company_id = c.id
    WHERE q.company_id IS NOT NULL AND p.status = 'Perdu'
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

  const out = []
  for (const c of companies) {
    const qc = qcStmt.get(c.id)
    if (!qc) continue
    const lostProject = projStmt.get(c.id)
    // Important : on filtre les placeholders avant de détecter la langue,
    // sinon les libellés FR du formulaire ("Avons-nous oublié…", "Fait un résumé…")
    // forcent FR sur des QC dont le contenu réel est en anglais.
    const allText = [qc.challenges, qc.farm_description, qc.summary, qc.short_term_goals,
                     qc.motivation_today, qc.motivation_why_now]
      .map(nonPlaceholder).filter(Boolean).join(' ')
    const lang = detectLanguage(allText)
    const email = buildEmail({ company: c, qc, lostProject, lang })

    out.push({
      company: { id: c.id, name: c.name, lifecycle_phase: c.lifecycle_phase },
      project: lostProject || null,
      qualification_call: {
        id: qc.id,
        call_date: qc.call_date,
        challenges: qc.challenges,
        farm_description: qc.farm_description,
        business_models: parseList(qc.business_models),
        timeline: qc.timeline,
        decision_maker_name: qc.decision_maker_name,
        short_term_goals: qc.short_term_goals,
      },
      email,
    })
  }
  return out
}
