import { readFileSync } from 'fs'
import { spawnSync } from 'child_process'
import db from '../db/database.js'
import { emitEntity } from './realtimeEmitters.js'
import { logSync } from './syncLog.js'
import { buildTransportInvoice } from './transportInvoice.js'

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp']

const SYSTEM_PROMPT = `Tu es un assistant spécialisé dans l'extraction de données de reçus, factures et relevés que NOTRE entreprise a REÇUS de ses fournisseurs/marchands.

CONTEXTE CRITIQUE — qui est qui sur le document :
- NOTRE entreprise (l'ACHETEUR, le destinataire de la facture) s'appelle « Automatisation Orisha Inc » (variantes : « Orisha », « Orisha Inc », « Automatisation Orisha »). C'est NOUS. Notre adresse est « 1535 ch. Sainte-Foy, bureau 220, Québec QC G1S 2P1 ».
- Le champ "company" doit TOUJOURS contenir le nom du FOURNISSEUR / MARCHAND / ÉMETTEUR du document — l'entité à qui nous avons payé, celle qui a émis la facture. Ce n'est JAMAIS « Orisha » ni aucune de ses variantes : Orisha est l'acheteur, pas le vendeur.
- Notre nom (Orisha) apparaît souvent bien en évidence en haut du document parce qu'il est le DESTINATAIRE (sous « Facturé à / Vendu à / Livré à / Bill to / Ship to », ou à côté de l'adresse de Québec ci-dessus). Ne te laisse pas piéger : ce n'est pas l'émetteur.
- Pour trouver le vrai émetteur, cherche : le logo / l'en-tête de marque, le pied de page, les mentions « Émis par / Vendu par / Payable à », le numéro de téléphone de marque, le site web ou le domaine d'un courriel (ex. « bell.ca » → Bell ; « 310-BELL » → Bell), les coordonnées du marchand. Déduis le nom du marchand de ces indices même s'il n'est pas écrit en toutes lettres comme raison sociale.
- Ne mets "company" = null que si, après avoir vraiment cherché, aucun émetteur distinct d'Orisha n'est identifiable.
- Le champ "address" doit être l'adresse du FOURNISSEUR/MARCHAND (l'émetteur), pas notre adresse de Québec.

Extrait toutes les informations disponibles et retourne un JSON valide avec exactement cette structure:
{
  "receipt_date": "YYYY-MM-DD ou null",
  "company": "nom du fournisseur/marchand qui a émis le document — jamais Orisha — ou null",
  "address": "adresse du fournisseur/marchand (l'émetteur) ou null",
  "receipt_number": "numéro de reçu/facture ou null",
  "general_description": "résumé d'UNE seule ligne décrivant l'objet PRINCIPAL du document — ce qui a été acheté, en termes généraux — ou null",
  "items": [{"description": "...", "quantity": 1, "unit_price": 0.00, "total": 0.00}],
  "shipments": [{"carrier": "...", "destination_province": "QC|ON|...|null", "destination_country": "CA|US|...", "total": 0.00, "taxes": [{"label": "TPS|TVQ|TVH|PST|...", "amount": 0.00}]}],
  "subtotal": 0.00,
  "tps": 0.00,
  "tvq": 0.00,
  "other_taxes": 0.00,
  "total": 0.00,
  "payment_method": "méthode de paiement ou null",
  "currency": "CAD",
  "notes": "autres informations pertinentes ou null"
}

RÈGLE — "general_description" (objet principal du document) :
- C'est une SEULE phrase courte qui résume ce qui a été acheté, en termes généraux — la description principale de la facture, PAS la liste des articles. Ex. : « Pièces de plomberie », « Abonnement logiciel mensuel », « Matériel électronique et câblage », « Location d'équipement de chantier ».
- Si le document ne contient qu'un seul article ou un seul type de produit/service, reprends-le tel quel. S'il y a plusieurs articles, donne la catégorie/le thème qui les regroupe — ne les énumère pas.
- N'y mets jamais les montants, les quantités ni le numéro de facture. Reste sous ~80 caractères.

RÈGLES DE COHÉRENCE DES MONTANTS (TRÈS IMPORTANT — vérifie le calcul avant de répondre) :
- "subtotal" est le montant HORS TAXES (HT). L'invariant doit TOUJOURS tenir : subtotal + tps + tvq + other_taxes = total. Refais le calcul et ajuste les montants pour qu'il soit exact (à un cent près).
- Ne mets JAMAIS subtotal = total quand il y a des taxes (tps ou tvq > 0). Si aucun sous-total HT explicite n'est affiché, calcule-le : subtotal = total - tps - tvq - other_taxes.
- FACTURES AMAZON et autres marchands à PRIX TAXES INCLUSES : le prix par article et le sous-total affichés peuvent déjà contenir la taxe. Dans ce cas, ramène "subtotal" au vrai HT (total - taxes) — n'inscris pas le montant taxes-incluses comme sous-total, sinon la taxe est comptée deux fois en comptabilité.
- "items[].total" est le montant HORS TAXES de la ligne ; la somme des items[].total doit égaler subtotal. N'inscris JAMAIS une ligne de taxe (TPS, GST, TVQ, QST, TVH/HST) comme un article : les taxes vont uniquement dans tps / tvq / other_taxes.
- tps = taxe fédérale (TPS/GST, 5 %). tvq = taxe du Québec (TVQ/QST, 9,975 %) ou PST provinciale. other_taxes = toute autre taxe. Une taxe combinée TVH/HST d'une autre province va dans other_taxes.

RÈGLE — FACTURES DE TRANSPORT MULTI-EXPÉDITIONS (NovoXpress / Groupe Alliances et Privilèges, ou toute messagerie listant plusieurs expéditions avec des taxes PAR expédition) :
- Quand le document détaille PLUSIEURS expéditions, chacune avec ses propres frais ET ses propres taxes (TPS/TVQ calculées envoi par envoi, souvent une page par expédition), n'utilise PAS le sommaire de la 1re page pour "items". Remplis plutôt "shipments" : UNE entrée par expédition, avec le transporteur/service, la PROVINCE et le PAYS de DESTINATION (la destination réelle du colis, pas l'expéditeur), le TOTAL de l'expédition, et la liste de SES taxes {label, amount} telles qu'imprimées (TPS, TVQ, TVH/HST, PST…). Le "label" doit refléter le type de taxe affiché.
- Une expédition sans aucune taxe affichée a "taxes": []. Une expédition vers les États-Unis / hors Canada a généralement "taxes": [] (export).
- Dans ce cas, laisse "items" vide ([]) : les lignes seront reconstruites automatiquement par regroupement de taxe. Donne quand même subtotal/tps/tvq/other_taxes/total globaux du document.
- Si le document N'est PAS de ce type (un seul achat, pas de ventilation par expédition), laisse "shipments" absent ou vide ([]) et remplis "items" normalement.

DOCUMENT MULTIPAGE :
- Le document peut comporter PLUSIEURS pages (plusieurs images et/ou plusieurs pages de PDF). Elles forment UN SEUL reçu/facture. Consolide TOUTES les pages en un seul JSON : fusionne les articles de chaque page dans le tableau "items", et prends les totaux (subtotal/tps/tvq/total) du document complet (généralement sur la dernière page). Ne produis pas un objet par page.

Retourne UNIQUEMENT le JSON, sans texte supplémentaire ni balises markdown.
Si une valeur est inconnue, utilise null pour les chaînes et 0 pour les nombres.`

const MIME_MAP = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }

// Extraction IA d'un document pouvant comporter PLUSIEURS pages.
// `pages` : tableau [{ filePath, fileExt }] dans l'ordre des pages. Les images sont
// envoyées comme image_url (vision), les PDF sont convertis en texte (pdftotext) et
// concaténés. Tout est regroupé dans un seul message → un seul JSON consolidé.
export async function extractWithOpenAI(pages) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY non configuré')

  const list = Array.isArray(pages) ? pages : [pages]
  if (!list.length) throw new Error('Aucune page à extraire')

  const content = [
    { type: 'text', text: `Voici un document (reçu, facture ou relevé) que nous avons reçu d'un fournisseur, comportant ${list.length} page${list.length > 1 ? 's' : ''}. Extrait toutes les données disponibles en consolidant l'ensemble des pages en UN SEUL reçu. Le champ "company" est le fournisseur/marchand émetteur, jamais Orisha (qui est notre entreprise, le destinataire).` },
  ]
  const pdfTexts = []
  list.forEach((p, idx) => {
    if (IMAGE_EXT.includes(p.fileExt)) {
      const base64 = readFileSync(p.filePath).toString('base64')
      const mime = MIME_MAP[p.fileExt] || 'image/jpeg'
      content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } })
    } else {
      const result = spawnSync('pdftotext', ['-layout', p.filePath, '-'], { encoding: 'utf8', timeout: 30000 })
      const t = result.stdout?.trim() || ''
      if (t) pdfTexts.push(`[Page ${idx + 1}]\n${t}`)
    }
  })

  const hasImage = content.some(c => c.type === 'image_url')
  if (pdfTexts.length) {
    content.push({ type: 'text', text: `Contenu textuel des pages PDF :\n\n${pdfTexts.join('\n\n').slice(0, 12000)}` })
  }
  if (!hasImage && !pdfTexts.length) throw new Error('Impossible d\'extraire le contenu du document')

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content },
  ]

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages, max_tokens: 2000, temperature: 0 }),
  })

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(err.error?.message || `OpenAI HTTP ${resp.status}`)
  }

  const data = await resp.json()
  const replyText = data.choices?.[0]?.message?.content?.trim() || ''
  const cleaned = replyText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  return JSON.parse(cleaned)
}

// Consolidation « article LIA unique » : quand un reçu contient EXACTEMENT UN article
// dont la description commence par un code LIA (« LIA-1968 … »), les autres lignes
// (transport, frais de carte, etc.) sont des frais rattachés à cet article — on les
// fusionne dans la ligne LIA : un seul item, au montant TOTAL des lignes, qui garde la
// description LIA verbatim. Les libellés des lignes de frais sont jetés.
//
// On ne touche à RIEN dès qu'il y a PLUSIEURS articles LIA (plusieurs codes/produits) :
// chaque ligne reste alors distincte. Idem s'il n'y a aucun article LIA ou une seule ligne.
const LIA_REF = /^\s*lia-\d+/i

// Alias de fournisseurs : nom imprimé sur le document → nom canonique à enregistrer.
// « Groupe Alliances et Privilèges » facture sous la marque NovoXpress — on enregistre
// donc NovoXpress (affichage + rapprochement du fournisseur QB à la publication).
const VENDOR_ALIASES = [
  { match: /alliances?\s+et\s+privil/i, name: 'NovoXpress' },
]

export function canonicalVendorName(name) {
  if (!name) return name
  for (const a of VENDOR_ALIASES) if (a.match.test(name)) return a.name
  return name
}

export function consolidateSoleLiaItem(items) {
  const list = Array.isArray(items) ? items : []
  if (list.length <= 1) return list
  const liaItems = list.filter(it => LIA_REF.test(it?.description || ''))
  if (liaItems.length !== 1) return list
  const lineAmount = it => Number(it?.total) || (Number(it?.unit_price) * Number(it?.quantity)) || 0
  const total = Math.round(list.reduce((s, it) => s + lineAmount(it), 0) * 100) / 100
  return [{ description: liaItems[0].description, quantity: null, unit_price: null, total }]
}

function fetchSaleReceiptRow(id) {
  const row = db.prepare('SELECT * FROM sale_receipts WHERE id=?').get(id)
  if (!row) return null
  return { ...row, items: JSON.parse(row.items || '[]') }
}

// `pages` (optionnel) : tableau [{ filePath, fileExt }] pour un document multipage.
// Rétrocompat : si `pages` est absent, on retombe sur le couple { filePath, fileExt }
// (page unique) utilisé par les ingestions email/Amazon.
//
// `trigger` : origine de l'extraction pour le sync_log ('manual' = upload/re-extract
// déclenché par un opérateur ; 'scheduled' = ingestion automatique Gmail/Amazon).
// L'appel reste fire-and-forget côté appelants : on trace ici (succès comme échec)
// pour que tout coût OpenAI et toute mise en status='error' soit visible dans sync_log.
export async function runExtractionAndUpdate({ saleReceiptId, filePath, fileExt, pages, userId = null, trigger = 'manual' }) {
  const startedAt = Date.now()
  try {
    // Si la ligne a été supprimée pendant que l'extraction tournait, on s'arrête
    // proprement : évite un appel OpenAI inutile et un UPDATE sur une ligne masquée.
    const existing = db.prepare('SELECT deleted_at FROM sale_receipts WHERE id=?').get(saleReceiptId)
    if (!existing || existing.deleted_at) return
    const pageList = Array.isArray(pages) && pages.length ? pages : [{ filePath, fileExt }]
    const extracted = await extractWithOpenAI(pageList)

    // Facture de transport multi-expéditions : on reconstruit les lignes par code de
    // taxe (récupérable seulement, PST non récupérable repliée dans la dépense) et on
    // recompose subtotal/taxes/total à partir des expéditions — voir transportInvoice.js.
    const shipments = Array.isArray(extracted.shipments)
      ? extracted.shipments.filter(s => s && Number(s.total))
      : []
    let items, amounts = null
    if (shipments.length) {
      const built = buildTransportInvoice(shipments)
      // Pré-remplit le code de taxe QB par ligne (résolution par nom). QB injoignable ou
      // nom absent → tax_code_id null (l'opérateur choisit ; le regroupement reste fait).
      // Le sentinel « aucune taxe » (NO_TAX_CODE) n'est pas un nom QB à résoudre : il est
      // stocké tel quel pour forcer une ligne sans code de taxe à la publication.
      const NO_TAX_CODE = '__none__'
      let nameToId = new Map()
      try {
        const { resolveTaxCodeIdsByName } = await import('./quickbooks.js')
        const realNames = built.items.map(it => it.tax_code_name).filter(n => n && n !== NO_TAX_CODE)
        nameToId = await resolveTaxCodeIdsByName(realNames)
      } catch (e) {
        console.warn(`Transport extraction ${saleReceiptId}: résolution codes QB indisponible (${e.message}) — codes laissés vides`)
      }
      items = built.items.map(it => ({
        description: it.description,
        quantity: null,
        unit_price: null,
        total: it.total,
        tax_code_id: it.tax_code_name === NO_TAX_CODE
          ? NO_TAX_CODE
          : (it.tax_code_name ? (nameToId.get(it.tax_code_name) || null) : null),
      }))
      amounts = { subtotal: built.subtotal, tps: built.tps, tvq: built.tvq, other_taxes: built.other_taxes, total: built.total }
    } else {
      // Fusionne les frais dans la ligne LIA quand il n'y a qu'un seul article LIA.
      items = consolidateSoleLiaItem(extracted.items || [])
    }
    db.prepare(`
      UPDATE sale_receipts SET
        status='done',
        receipt_date=?, company=?, address=?, receipt_number=?, general_description=?,
        subtotal=?, tps=?, tvq=?, other_taxes=?, total=?,
        payment_method=?, currency=?, items=?, raw_data=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id=? AND deleted_at IS NULL
    `).run(
      extracted.receipt_date || null,
      canonicalVendorName(extracted.company) || null,
      extracted.address || null,
      extracted.receipt_number || null,
      extracted.general_description || null,
      amounts ? amounts.subtotal : (extracted.subtotal || 0),
      amounts ? amounts.tps : (extracted.tps || 0),
      amounts ? amounts.tvq : (extracted.tvq || 0),
      amounts ? amounts.other_taxes : (extracted.other_taxes || 0),
      amounts ? amounts.total : (extracted.total || 0),
      extracted.payment_method || null,
      extracted.currency || 'CAD',
      JSON.stringify(items),
      JSON.stringify(extracted),
      saleReceiptId,
    )
    const updated = fetchSaleReceiptRow(saleReceiptId)
    if (updated) emitEntity('sale_receipt', 'updated', saleReceiptId, updated, userId)
    logSync('sale_receipt_extraction', trigger, { status: 'success', modified: 1, durationMs: Date.now() - startedAt })
  } catch (err) {
    console.error('Receipt extraction error:', err.message)
    db.prepare(`UPDATE sale_receipts SET status='error', error_message=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=? AND deleted_at IS NULL`)
      .run(err.message, saleReceiptId)
    const errored = fetchSaleReceiptRow(saleReceiptId)
    if (errored && !errored.deleted_at) emitEntity('sale_receipt', 'updated', saleReceiptId, errored, userId)
    logSync('sale_receipt_extraction', trigger, { status: 'error', error: `${saleReceiptId}: ${err.message}`, durationMs: Date.now() - startedAt })
  }
}
