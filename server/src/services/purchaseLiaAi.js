// Lecture IA de la facture ENTIÈRE pour retrouver le code LIA de chaque ligne.
//
// Le moteur de score (purchaseLiaMatch.js) juge chaque ligne isolément, mot pour mot.
// Or le fournisseur ne nomme presque jamais la pièce comme Orisha : « Official Raspberry
// Pi 4 Model B 2GB » contre « Raspberry Pi 4B », « Mersen TRM4 4A 250V midget » contre
// « Fusible 4A ». Un humain recoupe les INDICES — référence, capacité, tension, marque,
// quantité, ce que les autres lignes de la facture ont déjà pris, le n° de commande
// imprimé, les notes — sans exiger le même libellé. C'est ce que fait cette passe
// (demande de Charles, 2026-10-06 : « regarde toute la facture, pas juste un champ »).
//
// Elle ne fait que PROPOSER : le choix revient à matchLines(), qui garde les garde-fous
// (achats à recevoir du fournisseur seulement, un achat par facture, référence fabricant
// prioritaire). Résultat mémorisé par empreinte (facture + candidats, table
// lia_ai_matches, migration 117) : pas de réinterrogation tant que rien ne change.
import crypto from 'crypto'
import db from '../db/database.js'
import { ask } from './bankAiGuess.js'
import { listCandidatePurchases, learnLineAliases, partKey, hasLiaRef } from './purchaseLiaMatch.js'

const MIN_CONFIDENCE = 0.6
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const qtyText = v => (v == null || v === '' ? '?' : String(Number(v)))

/** Prompt : la facture complète + les achats à recevoir du fournisseur. PUR. */
export function buildLiaPrompt({ receipt = {}, items = [], candidates = [], aliasesByPart = new Map() }) {
  const lines = items.map((it, i) => (hasLiaRef(it?.description) || it?.purchase_id
    ? `#${i} [déjà relié — ${clip(it.lia_ref || it.description, 40)}] ${clip(it.source_description, 160)}`
    : `#${i} « ${clip(it?.description, 200)} » qté ${qtyText(it?.quantity)} · prix unit. ${it?.unit_price ?? '?'} · total ${it?.total ?? '?'}`))
  const purchases = candidates.map(c => {
    const bits = [
      `${c.lia_ref} : ${clip(c.part_name, 80)}${c.part_name_en ? ` / ${clip(c.part_name_en, 80)}` : ''}`,
      `qté commandée ${qtyText(c.qty_ordered)}`,
      c.order_date ? `commandé le ${String(c.order_date).slice(0, 10)}` : null,
      c.part_mpn ? `réf. fabricant ${clip(c.part_mpn, 40)}` : null,
      c.po_part_ref ? `n° distributeur ${clip(c.po_part_ref, 40)}` : null,
      c.part_sku ? `SKU interne ${clip(c.part_sku, 20)}` : null,
      c.po_url ? `lien ${clip(c.po_url, 160)}` : null,
      c.notes ? `notes ${clip(c.notes, 160)}` : null,
    ]
    const aliases = aliasesByPart.get(partKey(c)) || []
    if (aliases.length) bits.push(`déjà facturé par ce fournisseur sous : ${aliases.slice(0, 3).map(a => `« ${clip(a, 80)} »`).join(', ')}`)
    return `- ${bits.filter(Boolean).join(' · ')}`
  })
  return `Tu rapproches les lignes d'une facture fournisseur des ACHATS (codes LIA) qu'Orisha attend encore de ce fournisseur.

FACTURE
Fournisseur : ${clip(receipt.company, 80) || '?'}
N° : ${clip(receipt.receipt_number, 40) || '?'} · date ${receipt.receipt_date || '?'}${receipt.order_date ? ` · commande du ${receipt.order_date}` : ''}
${receipt.general_description ? `Description : ${clip(receipt.general_description, 200)}\n` : ''}${receipt.notes ? `Notes : ${clip(receipt.notes, 400)}\n` : ''}Lignes :
${lines.join('\n')}

ACHATS À RECEVOIR DE CE FOURNISSEUR
${purchases.join('\n')}

Méthode : le fournisseur ne reprend presque jamais le nom de la pièce mot pour mot. Recoupe les INDICES :
référence fabricant ou n° distributeur (même partiel, même dans un lien), marque, modèle, capacité, tension,
puissance, dimensions, couleur, quantité commandée vs facturée, date de commande, libellés déjà vus,
et la facture dans son ensemble (une ligne de transport, de frais ou de service n'est pas une pièce ;
deux lignes ne peuvent pas désigner le même achat).
Ne relie une ligne que si les indices désignent clairement UN achat. Deux achats aussi plausibles
(même pièce, rien pour trancher) → null. Une quantité qui diffère n'exclut pas (facture partielle),
mais elle baisse la confiance.

Réponds en JSON : {"lines":[{"line":<n° de ligne>,"lia":"LIA-xxxx" ou null,"confidence":0..1,"clues":"indices concordants, 8 mots max"}]}
Une entrée par ligne non reliée.`
}

/** Réponse IA → Map(index de ligne → { lia_ref, confidence, clues }). PUR. */
export function parseLiaAnswer(text, { items = [], candidates = [] } = {}) {
  const out = new Map()
  let j
  try { j = JSON.parse(String(text || '').replace(/^```(?:json)?|```$/g, '').trim()) } catch { return out }
  const known = new Set(candidates.map(c => c.lia_ref))
  const used = new Set()
  const rows = (Array.isArray(j?.lines) ? j.lines : [])
    .map(r => ({ index: Number(r?.line), lia_ref: String(r?.lia || '').trim().toUpperCase(), confidence: Number(r?.confidence) || 0, clues: clip(r?.clues, 120) }))
    .filter(r => Number.isInteger(r.index) && r.index >= 0 && r.index < items.length && known.has(r.lia_ref) && r.confidence >= MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence)
  for (const r of rows) {
    // Un achat par facture, une proposition par ligne : la plus sûre l'emporte.
    if (used.has(r.lia_ref) || out.has(r.index)) continue
    used.add(r.lia_ref)
    out.set(r.index, { lia_ref: r.lia_ref, confidence: Math.min(1, Math.round(r.confidence * 100) / 100), clues: r.clues })
  }
  return out
}

const inflight = new Map()

/**
 * Propositions IA pour un reçu. Best effort : sans clé, sans achat à recevoir ou en cas
 * d'erreur, renvoie une Map vide (le moteur de score reste seul).
 */
export async function aiLiaPicks({ receipt = {}, items = [], fetchImpl = fetch } = {}) {
  try {
    const open = items.map((it, i) => i).filter(i => !items[i]?.purchase_id && !hasLiaRef(items[i]?.description))
    if (!open.length) return new Map()
    const candidates = listCandidatePurchases({ company: receipt.company, vendorProfileId: receipt.vendor_profile_id, excludeReceiptId: receipt.id })
      .filter(c => !c.other_vendor && !c.consumed)
    if (!candidates.length) return new Map()
    let aliasesByPart = new Map()
    try { aliasesByPart = learnLineAliases({ candidates, excludeReceiptId: receipt.id }) } catch { /* pas bloquant */ }
    const prompt = buildLiaPrompt({ receipt, items, candidates, aliasesByPart })
    const key = crypto.createHash('sha1').update(prompt).digest('hex')
    const row = db.prepare('SELECT result FROM lia_ai_matches WHERE key = ?').get(key)
    if (row) return parseLiaAnswer(row.result, { items, candidates })
    if (!inflight.has(key)) {
      inflight.set(key, (async () => {
        const text = await ask(prompt, fetchImpl)
        db.prepare(`INSERT INTO lia_ai_matches (key, result) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET result = excluded.result, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(key, String(text || ''))
        return text
      })().finally(() => inflight.delete(key)))
    }
    return parseLiaAnswer(await inflight.get(key), { items, candidates })
  } catch (e) {
    console.warn(`Lecture IA des codes LIA indisponible: ${e.message}`)
    return new Map()
  }
}
