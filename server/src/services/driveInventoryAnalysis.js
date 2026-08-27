// Analyse de pertinence des onglets inventoriés — la passe qui répond à
// « qu'est-ce qui, là-dedans, mérite vraiment d'entrer dans l'ERP, et où ? ».
//
// Le scan dit ce QU'IL Y A (nom, nature, en-tête, échantillon). Cette passe dit
// ce que ÇA VAUT : elle confronte chaque onglet au catalogue des modules réels
// de l'ERP et rend un verdict — importer / garder dans Drive / ignorer — avec le
// module de destination et une phrase de justification.
//
// Le jugement est confié au modèle parce que la question est sémantique : un
// onglet « Abonn. » avec les colonnes Fournisseur | Plan | CAD/USD | Fréquence
// est le jumeau papier du module Abonnements de l'ERP, tandis qu'un onglet
// « Repas » de quatre lignes est une note de règles fiscales. Aucune liste de
// mots-clés ne fait cette différence. Sans clé OpenAI, on retombe sur une
// correspondance par colonnes, plus grossière mais jamais silencieuse (la
// source du jugement est affichée à côté de chaque suggestion).
import db from '../db/database.js'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

// Catalogue des destinations réelles. C'est le contexte qui empêche le modèle
// d'inventer des modules : il doit ranger chaque onglet dans l'un d'eux, ou
// répondre explicitement qu'aucun n'existe encore.
export const ERP_MODULES = [
  ['Achats fournisseurs', 'factures fournisseurs, achats, statuts de paiement, échéances'],
  ['Profils fournisseurs', 'particularités par fournisseur, comptes comptables par défaut, codes de taxe, termes de paiement'],
  ['Abonnements fournisseurs', 'abonnements récurrents : plan, devise, montant, fréquence, date de renouvellement, mode de paiement'],
  ['Reçus de vente / extraction de factures', 'reçus et factures fournisseurs extraits puis publiés dans QuickBooks'],
  ['Trésorerie', 'solde disponible BNC, projection, paiements planifiés, sorties récurrentes'],
  ['Paiements émis', 'virements, chèques et paiements de carte émis, et leur passage à la banque'],
  ['Rapprochement bancaire', 'relevés bancaires importés, appariement avec QuickBooks'],
  ['Stripe Payouts', 'versements Stripe et leur comptabilisation'],
  ['Comptes prépayés', 'soldes prépayés fournisseurs (Twilio…) et cédule des frais payés d\'avance — DÉPENSES payées d\'avance, pas des revenus'],
  ['Revenus reportés', 'revenus perçus d\'avance et leur constatation à l\'expédition (compte 23900)'],
  ['Dettes long terme', 'prêts, cédules de remboursement, intérêts'],
  ['Douanes (ASFC)', 'relevés de douane, appariement aux reçus'],
  ['Budget marketing', 'budget par compte et par mois, comparaison budget / réel'],
  ['Écritures de fin de mois', 'provisions (crédit R&D, subventions), déboursés de pièces, écritures mensuelles récurrentes'],
  ['Paie', 'paies, répartition des salaires par département/projet, déductions, avantages'],
  ['Feuilles de temps / heures R&D', 'heures par personne et par mois, heures RSDE'],
  ['Référentiel fiscal TPS/TVQ', 'correspondance type de transaction → statut fiscal → code de taxe QuickBooks'],
  ['Produits et inventaire', 'produits, pièces, stocks, mouvements d\'inventaire, coût des produits vendus'],
  ['Commandes, envois et projets', 'commandes clients, expéditions, projets, tickets, numéros de série'],
  ['Travaux récurrents', 'listes de tâches périodiques cochées semaine après semaine'],
  ['Clients et contacts', 'entreprises, contacts, soumissions, données de saison client'],
  ['Aucun module existant', 'la matière est pertinente mais l\'ERP n\'a pas encore d\'endroit pour elle (ex. immobilisations)'],
]

const SYSTEM_PROMPT = `Tu es l'architecte de données d'Orisha, une PME québécoise d'IoT pour serres qui migre sa comptabilité de Google Drive vers son ERP interne.

On te donne les ONGLETS d'un classeur Google Sheets trouvé dans le Drive de la comptabilité : nom du classeur, dossier, puis pour chaque onglet son nom, sa nature détectée, son nombre de lignes, sa ligne d'en-tête et un échantillon de lignes.

Ta tâche : pour CHAQUE onglet, juger s'il vaut la peine d'être rapatrié dans l'ERP, et où.

Modules existants de l'ERP (destinations possibles) :
${ERP_MODULES.map(([m, d]) => `- ${m} : ${d}`).join('\n')}

Certains onglets portent une mention DÉJÀ REPRIS ou PARTIELLEMENT REPRIS : c'est un fait établi par le code de l'ERP, pas une hypothèse.
- DÉJÀ REPRIS : ne propose rien de plus (verdict "garder", relevance basse).
- PARTIELLEMENT REPRIS : juge SEULEMENT la matière restante, et si cette matière restante est un vrai tableau de données, réponds "importer" en nommant la section concernée. C'est le cas le plus important de tout l'exercice : ces onglets passent inaperçus précisément parce que le fichier a l'air déjà branché.

Deux destinations se confondent facilement : un abonnement à un logiciel (Adobe, Airtable…) va dans "Abonnements fournisseurs" ; une sortie d'argent périodique non logicielle (assurance, loyer, commission de garantie) va dans "Trésorerie".

Règles de jugement :
- "importer" = l'onglet contient des DONNÉES structurées et vivantes qui doublonnent ou compléteraient un module de l'ERP, ou qui mériteraient un nouveau module. C'est de la matière qu'un humain ressaisit ou consulte régulièrement.
- "garder" = l'onglet a de la valeur (procédure écrite, règles de calcul, notes de référence) mais ce ne sont pas des données à charger dans des tables ; il peut valoir une page de documentation, pas un import.
- "ignorer" = brouillon, onglet vide, calcul jetable, doublon d'un export, contenu sans intérêt durable.

SOIS SÉLECTIF : "importer" doit rester minoritaire. Dans le doute entre "importer" et "garder", choisis "garder". Un onglet ne mérite "importer" que si tu peux nommer précisément ce qu'il apporterait au module visé.

"relevance" = 0 à 100, l'urgence de rapatrier. Un tableau tenu à la main que quelqu'un ressaisit chaque semaine = 85-100. Une référence stable consultée de loin en loin = 30-50. Un brouillon = 0-15.
"target_module" = le nom EXACT d'un module de la liste ci-dessus, ou "Aucun module existant". Jamais un nom inventé.
"suggestion" = une à deux phrases en français, concrètes : QUOI importer et POUR QUOI faire. Pas de généralité. Quand l'onglet empile plusieurs sections, nomme celle qui est visée.

Réponds UNIQUEMENT par un objet JSON :
{"tabs":[{"tab":"<nom exact de l'onglet>","verdict":"importer|garder|ignorer","relevance":<0-100>,"target_module":"<module>","suggestion":"<1-2 phrases>"}]}`

function tabBlock(t) {
  const lines = [`— Onglet « ${t.tab_name} » (nature détectée : ${t.nature}, ${t.rows_count} lignes non vides)`]
  // Dire ce qui est DÉJÀ repris est décisif : sans ça le modèle rejuge tout
  // l'onglet et conclut « déjà fait », alors que la question est ce qui RESTE.
  if (t.status === 'synced') lines.push(`  DÉJÀ REPRIS PAR L'ERP : ${t.sync_target}`)
  if (t.status === 'partial') lines.push(`  PARTIELLEMENT REPRIS : ${t.sync_target}\n  → juge UNIQUEMENT ce qui n'est pas encore repris.`)
  if ((t.sections || []).length) lines.push(`  Sections du bloc : ${t.sections.join(' / ')}`)
  lines.push((t.header || []).length ? `  En-tête : ${t.header.join(' | ')}` : '  Pas de ligne d\'en-tête identifiée')
  lines.push((t.sample || []).length
    ? `  Échantillon :\n${t.sample.map(r => '    ' + r.join(' | ')).join('\n')}`
    : '  Aucun échantillon')
  return lines.join('\n')
}

export function buildPrompt(item, tabs) {
  return `Classeur : « ${item.name} »\n`
    + `Dossier : ${item.parent_folder_name || 'inconnu'}\n`
    + `Propriétaire : ${item.owner_name || item.owner_email || 'inconnu'}\n`
    + `Rythme de modification : ${item.frequency}${item.days_since_modified != null ? ` (dernière modification il y a ${item.days_since_modified} jours)` : ''}\n\n`
    + `${tabs.length} onglet(s) :\n\n${tabs.map(tabBlock).join('\n\n')}`
}

async function callOpenAI(apiKey, prompt) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
      max_tokens: 2000,
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(err.error?.message || `OpenAI HTTP ${resp.status}`)
  }
  const data = await resp.json()
  const text = data.choices?.[0]?.message?.content?.trim() || '{}'
  return JSON.parse(text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, ''))
}

// ── Repli sans modèle ────────────────────────────────────────────────────────
// Correspondance par colonnes : moins fine que le modèle (elle ne distingue pas
// une procédure d'un tableau de même vocabulaire), mais elle range quand même
// l'onglet dans un module plutôt que de rendre un verdict vide.
const FALLBACK_RULES = [
  [/abonn|plan.?forfait|renouvell/i, 'Abonnements fournisseurs'],
  [/r[ée]current|versement|fr[ée]quence de versement/i, 'Trésorerie'],
  [/paie|salaire|d[ée]duction|ass\.? coll/i, 'Paie'],
  [/heures|rsde|feuille de temps/i, 'Feuilles de temps / heures R&D'],
  [/immobilis|amortissement/i, 'Aucun module existant'],
  [/pr[ée]pay|twilio/i, 'Comptes prépayés'],
  [/douane|asfc|carm/i, 'Douanes (ASFC)'],
  [/budget|marketing/i, 'Budget marketing'],
  [/tps|tvq|tvh|taxe|statut fiscal/i, 'Référentiel fiscal TPS/TVQ'],
  [/stock|pi[eè]ce|inventaire|co[uû]t des produits/i, 'Produits et inventaire'],
  [/fournisseur|facture|achat/i, 'Achats fournisseurs'],
  [/paiement|virement|ch[eè]que/i, 'Paiements émis'],
  [/provision|cr[ée]dit r&d|subvention|fin de mois/i, 'Écritures de fin de mois'],
  [/client|soumission|contact/i, 'Clients et contacts'],
]

export function fallbackJudgement(tab) {
  const hay = `${tab.tab_name} ${(tab.header || []).join(' ')}`
  const target = FALLBACK_RULES.find(([re]) => re.test(hay))?.[1] || 'Aucun module existant'
  if (tab.nature === 'donnees') {
    return {
      verdict: 'importer',
      relevance: Math.min(90, 45 + Math.min(30, Math.round((tab.rows_count || 0) / 2)) + ((tab.header || []).length >= 5 ? 10 : 0)),
      target_module: target,
      suggestion: `Tableau de ${tab.rows_count} lignes (${(tab.header || []).slice(0, 5).join(', ') || 'colonnes non identifiées'}) — à rapprocher du module « ${target} ».`,
    }
  }
  if (tab.nature === 'vide') return { verdict: 'ignorer', relevance: 0, target_module: null, suggestion: 'Onglet vide.' }
  return {
    verdict: 'garder', relevance: 25, target_module: target,
    suggestion: `Contenu non tabulaire (${tab.nature}) — de la connaissance à conserver, pas des données à charger.`,
  }
}

// ── Passage ──────────────────────────────────────────────────────────────────
const VERDICTS = ['importer', 'garder', 'ignorer']

export function normalizeJudgement(raw, tab) {
  const verdict = VERDICTS.includes(raw?.verdict) ? raw.verdict : null
  if (!verdict) return null
  const known = ERP_MODULES.map(([m]) => m)
  const target = known.includes(raw.target_module) ? raw.target_module : (raw.target_module ? 'Aucun module existant' : null)
  let relevance = Number(raw.relevance)
  if (!Number.isFinite(relevance)) relevance = verdict === 'importer' ? 70 : verdict === 'garder' ? 30 : 5
  const score = Math.max(0, Math.min(100, Math.round(relevance)))
  return {
    // Cohérence : un « importer » assorti d'une note basse est une hésitation,
    // pas une recommandation — le modèle le dit lui-même en chiffrant. On le
    // range alors en « garder » plutôt que de gonfler la liste des suggestions.
    verdict: verdict === 'importer' && score < 50 ? 'garder' : verdict,
    relevance: score,
    target_module: target,
    suggestion: String(raw.suggestion || '').slice(0, 600) || null,
    tab_name: tab.tab_name,
  }
}

// Un verdict « importer » remet dans la course un onglet que le scan avait
// écarté sur sa seule nature ; un « ignorer » retire du bruit. Les onglets déjà
// couverts par un sync gardent leur statut : ce n'est pas au modèle de décider
// qu'un onglet est synchronisé, c'est un fait du code.
export function statusAfterJudgement(current, verdict) {
  if (current === 'synced' || current === 'partial') return current
  if (verdict === 'importer') return 'candidate'
  if (verdict === 'ignorer') return 'ignore'
  return current === 'candidate' ? 'candidate' : 'ignore'
}

function tabsOfItem(itemId) {
  return db.prepare(`
    SELECT * FROM drive_inventory_tabs WHERE item_id=? AND deleted_at IS NULL ORDER BY tab_index
  `).all(itemId).map(t => ({
    ...t,
    header: JSON.parse(t.header_json || '[]'),
    sample: JSON.parse(t.sample_json || '[]'),
    sections: JSON.parse(t.sections_json || '[]'),
  }))
}

const saveJudgement = () => db.prepare(`
  UPDATE drive_inventory_tabs
  SET verdict=?, relevance=?, target_module=?, suggestion=?, status=?, analysis_source=?, analysis_at=${NOW}, updated_at=${NOW}
  WHERE id=?
`)

// Analyse un classeur : un seul appel au modèle pour tous ses onglets (ils
// s'éclairent mutuellement — un onglet « Sommaire » se comprend mieux à côté de
// ses voisins).
export async function analyzeItem(item, { apiKey = process.env.OPENAI_API_KEY } = {}) {
  const tabs = tabsOfItem(item.id)
  if (!tabs.length) return { tabs: 0, source: null }

  let judgements = []
  let source = 'regles'
  if (apiKey) {
    try {
      const out = await callOpenAI(apiKey, buildPrompt(item, tabs))
      const byName = new Map((out?.tabs || []).map(j => [String(j.tab || '').trim(), j]))
      judgements = tabs.map(t => normalizeJudgement(byName.get(t.tab_name), t)).filter(Boolean)
      if (judgements.length) source = 'ia'
    } catch (e) {
      // Un refus du modèle ne doit pas arrêter l'inventaire : on juge aux règles
      // et la source affichée le dit.
      console.error(`[driveInventory] analyse IA « ${item.name} » :`, e.message)
    }
  }
  const judged = new Map(judgements.map(j => [j.tab_name, j]))

  const stmt = saveJudgement()
  const run = db.transaction(() => {
    for (const t of tabs) {
      const j = judged.get(t.tab_name) || { ...fallbackJudgement(t), tab_name: t.tab_name }
      const src = judged.has(t.tab_name) ? 'ia' : 'regles'
      stmt.run(j.verdict, j.relevance, j.target_module, j.suggestion,
        statusAfterJudgement(t.status, j.verdict), src, t.id)
    }
  })
  run()
  return { tabs: tabs.length, source }
}

// Tous les classeurs dont on a lu les onglets. Quatre en parallèle : assez pour
// que l'attente reste raisonnable sur ~150 classeurs, assez peu pour ne pas se
// faire limiter par l'API.
const CONCURRENCY = 4

export async function analyzeInventory({ onProgress = null, apiKey = process.env.OPENAI_API_KEY } = {}) {
  const items = db.prepare(`
    SELECT i.* FROM drive_inventory_items i
    WHERE i.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM drive_inventory_tabs t WHERE t.item_id = i.id AND t.deleted_at IS NULL)
    ORDER BY CASE i.status WHEN 'partial' THEN 0 WHEN 'candidate' THEN 1 WHEN 'synced' THEN 2 ELSE 3 END,
             COALESCE(i.modified_time, '') DESC
  `).all()

  let done = 0
  let aiCount = 0
  const total = items.length
  onProgress?.(0, total, 'Analyse de pertinence')

  const queue = [...items]
  const worker = async () => {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      try {
        const r = await analyzeItem(item, { apiKey })
        if (r.source === 'ia') aiCount++
      } catch (e) {
        console.error(`[driveInventory] analyse « ${item.name} » :`, e.message)
      }
      done++
      onProgress?.(done, total, 'Analyse de pertinence')
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, total)) }, worker))

  // Le statut du fichier suit celui de ses onglets : un classeur dont plus aucun
  // onglet n'est retenu retombe en « à ignorer », un classeur partiellement
  // couvert le reste.
  db.exec(`
    UPDATE drive_inventory_items SET status = (
      SELECT CASE
        WHEN SUM(CASE WHEN t.status IN ('candidate','partial') THEN 1 ELSE 0 END) > 0
             AND SUM(CASE WHEN t.status IN ('synced','partial') THEN 1 ELSE 0 END) > 0 THEN 'partial'
        WHEN SUM(CASE WHEN t.status = 'candidate' THEN 1 ELSE 0 END) > 0 THEN 'candidate'
        WHEN SUM(CASE WHEN t.status = 'synced' THEN 1 ELSE 0 END) > 0 THEN 'synced'
        ELSE 'ignore' END
      FROM drive_inventory_tabs t WHERE t.item_id = drive_inventory_items.id AND t.deleted_at IS NULL
    ), updated_at = ${NOW}
    WHERE deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM drive_inventory_tabs t WHERE t.item_id = drive_inventory_items.id AND t.deleted_at IS NULL)
  `)

  return { items: total, analyzed_by_ai: aiCount, source: aiCount ? 'ia' : 'regles' }
}
