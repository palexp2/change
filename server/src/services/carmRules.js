// Classification des lignes du relevé ASFC (portail CARM/GCRA).
//
// Le relevé porte deux colonnes qui disent tout :
//   • « Description détaillée » → CE QUE c'est : « Recettes TPS sur importation »
//     (100 % TPS, CTI récupérable), « Droit à l'importation » / « Surtaxes »
//     (100 % droits, coût du bien), « Intérêts », « Encaissement »…
//   • « Fournisseur » → QUI paie : « Automatisation Orisha Inc. » = nos fonds
//     (carte / paiement électronique) ; « Federal Express Canada », « United
//     Parcells », « AXXESS INTERNAtional » = le courtier a payé l'ASFC et nous
//     refacture ensuite — la dépense et la TPS arrivent alors par SA facture,
//     donc rien ne doit être comptabilisé du côté ASFC.
//
// Module volontairement PUR (aucun accès DB) : testable sans base, et réutilisé
// à l'import comme au backfill. Les enveloppes DB vivent dans carmPosting.js.
import { carmCategory } from './carmAccount.js'
import { round2Safe as round2 } from '../utils/money.js'

export const norm = s => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

export const CARM_KINDS = ['tps', 'droits', 'surtaxe', 'evaluation', 'correction',
  'interet', 'penalite', 'paiement', 'garantie', 'autre']

export const KIND_LABELS = {
  tps: 'TPS à l\'importation',
  droits: 'Droits de douane',
  surtaxe: 'Surtaxe',
  interet: 'Intérêts',
  evaluation: 'Évaluation (B3) — à ventiler',
  correction: 'Correction — à ventiler',
  penalite: 'Pénalité',
  paiement: 'Paiement',
  garantie: 'Dépôt de garantie',
  autre: 'Autre',
}

// Courtiers connus : nom canonique → variantes rencontrées sur le relevé.
export const DEFAULT_BROKERS = [
  ['FedEx', /federal\s*express|fedex/],
  ['UPS', /united\s*parcel|\bups\b/],
  ['Axxess International', /axxess/],
  ['Purolator', /purolator/],
  ['DHL', /\bdhl\b/],
  ['Livingston', /livingston/],
  ['Cole International', /cole\s*international/],
]

// Règles ordonnées, de la plus spécifique à la plus générale. `when` s'applique au
// texte concaténé « detail description type » normalisé (le portail n'expose pas
// toujours la description détaillée — les règles doivent tenir sur la description
// seule).
export const CARM_RULES = [
  { id: 'tps_import', when: /recette?s?\s*(de\s*la\s*)?tps|tps sur importation|gst on import|import gst/, kind: 'tps' },
  { id: 'droits_import', when: /droits? a l.importation|import duty|customs duty|droit de douane/, kind: 'droits' },
  { id: 'surtaxe', when: /surtaxe|surtax/, kind: 'surtaxe' },
  { id: 'interet', when: /interet|interest/, kind: 'interet' },
  { id: 'penalite', when: /penalit|penalty|amende|k23|confiscation/, kind: 'penalite' },
  { id: 'garantie', when: /depot de garantie|garantie financiere|security deposit|caution/, kind: 'garantie' },
  // Déclaration ou correction dont le relevé ne donne pas la ventilation (export
  // sans « Description détaillée ») : la nature est connue, la répartition
  // droits / TPS reste à poser — le moteur ne comptabilisera rien avant.
  { id: 'evaluation_b3', when: /evaluation \(b3\)|declaration en detail|\bb3\b/, kind: 'evaluation' },
  { id: 'correction_c1', when: /^corrections?$|releve de rajustement|\bc1\b|\bb2\b/, kind: 'correction' },
  { id: 'encaissement', when: /encaissement|paiement entrant|incoming payment|lot de cartes|lot de paiements|card batch|payment batch/, kind: 'paiement' },
  { id: 'paiement', when: /^paiement$|payment|versement|remboursement|refund/, kind: 'paiement' },
]


// Nom canonique du courtier, ou null. `extra` = noms supplémentaires configurés
// (chaîne « a, b, c » ou tableau) — comparés en sous-chaîne normalisée.
export function matchBroker(party, extra = []) {
  const p = norm(party)
  if (!p) return null
  for (const [name, re] of DEFAULT_BROKERS) if (re.test(p)) return name
  const list = Array.isArray(extra) ? extra : String(extra || '').split(',')
  for (const raw of list) {
    const n = norm(raw)
    if (n && n.length > 2 && p.includes(n)) return String(raw).trim()
  }
  return null
}

// Qui a payé ? Question qui n'a de sens que sur une LIGNE DE PAIEMENT : sur une
// charge, le « fournisseur » du relevé est le courtier qui a déposé la déclaration
// (B3), pas celui qui règle la facture — le versement de 500 $ d'Orisha du
// 2026-08-03 a réglé des charges attribuées à Axxess et à FedEx. Le sort d'une
// charge se décide donc par appariement (carmPosting.js), jamais ici.
// Le code de transaction suffit dans la plupart des cas, même quand l'export du
// portail n'a ni « Fournisseur » ni « Description détaillée » :
//   LD « Lot de cartes »   → paiement par NOTRE carte
//   LP « Lot de paiements » → versement d'un courtier qui a réglé l'ASFC pour nous
// Le nom du fournisseur, quand il est là, tranche en priorité ; la confirmation
// finale vient du relevé bancaire (voir resolvePayersFromBank dans carmPosting).
export function classifyPayer({ transaction_type, party, description } = {}, brokerNames = []) {
  const code = norm(transaction_type).replace(/[^a-z0-9]/g, '')
  const text = norm(`${party || ''} ${transaction_type || ''} ${description || ''}`)
  if (/orisha|automatisation/.test(norm(party))) return { payer: 'nous', broker: null }
  const broker = matchBroker(party, brokerNames)
  if (broker) return { payer: 'courtier', broker }
  if (code === 'ld' || /lot de cartes|card batch/.test(text)) return { payer: 'nous', broker: null }
  if (code === 'lp' || /lot de paiements|payment batch/.test(text)) return { payer: 'courtier', broker: null }
  if (/^\s*asfc\s*$/.test(norm(party))) return { payer: 'nous', broker: null }
  return { payer: 'inconnu', broker: null }
}

// Nature + ventilation droits / TPS d'une ligne. La TPS d'une ligne « Recettes TPS
// sur importation » est intégralement récupérable en CTI ; les droits et surtaxes
// sont un coût (65000) ; intérêts et pénalités sont hors champ.
export function classifyCarmLine(row = {}, { brokerNames = [] } = {}) {
  const amount = Number(row.amount) || 0
  const text = norm(`${row.detail || ''} ${row.description || ''} ${row.transaction_type || ''}`)
  const rule = CARM_RULES.find(r => r.when.test(text)) || null

  const code = norm(row.transaction_type).replace(/[^a-z0-9]/g, '')
  let kind = rule?.kind || null
  if (!kind && (code === 'b3' || code === 'das')) kind = 'evaluation'
  if (!kind && (code === 'c1' || code === 'b2')) kind = 'correction'
  if (!kind && code === 'in') kind = 'interet'
  if (!kind && code === 'k23') kind = 'penalite'
  if (!kind && (code === 'lp' || code === 'ld')) kind = 'paiement'
  if (!kind) {
    const cat = carmCategory(row)
    kind = cat === 'paiement' ? 'paiement'
      : cat === 'interet' ? 'interet'
        : cat === 'penalite' ? 'penalite'
          : amount < 0 ? 'paiement' : 'autre'
  }
  // Un « paiement » positif n'existe pas : c'est une charge mal étiquetée (et
  // inversement une charge négative est une correction/crédit).
  if (kind === 'paiement' && amount > 0) kind = 'autre'
  if (kind === 'paiement' && amount < 0 && (code === 'c1' || code === 'b2')) kind = 'correction'

  let duty = null, gst = null
  if (kind === 'tps') { gst = round2(amount); duty = 0 }
  else if (kind === 'droits' || kind === 'surtaxe') { duty = round2(amount); gst = 0 }
  else if (kind === 'interet' || kind === 'penalite') { duty = 0; gst = 0 }

  // `category` reste dans le vocabulaire existant (UI, PATCH, état du compte).
  const isCorrection = kind === 'correction'
    || /correction|rajust|adjust|\bb2\b|\bc1\b/.test(norm(`${row.transaction_type || ''} ${row.description || ''}`))
  const category = kind === 'paiement' ? 'paiement'
    : kind === 'interet' ? 'interet'
      : kind === 'penalite' ? 'penalite'
        : (kind === 'tps' || kind === 'droits' || kind === 'surtaxe' || kind === 'evaluation' || kind === 'correction')
          ? (isCorrection || amount < 0 ? 'correction' : 'evaluation')
          : carmCategory(row)

  // `payer` n'est posé que sur les paiements ; sur une charge, `broker` garde le
  // déclarant à titre indicatif (c'est lui qui, le cas échéant, paiera l'ASFC).
  const declarant = matchBroker(row.party, brokerNames)
  const payer = kind === 'paiement' ? classifyPayer(row, brokerNames).payer : null
  const broker = kind === 'paiement' ? classifyPayer(row, brokerNames).broker : declarant
  return { kind, category, duty_amount: duty, gst_amount: gst, payer, broker, rule: rule?.id || 'repli_signe' }
}

// Une ligne se comptabilise-t-elle depuis le relevé ASFC ? Le dépôt de garantie de
// 597 $ (caution permanente MAP, janv. 2025) est déjà dans les livres et ne se
// consomme jamais ; un paiement fait par un courtier — comme la charge qu'il
// éteint — arrive par sa facture (module reçus) et ne doit rien produire ici.
export function postingSkipReason(row = {}) {
  if (row.kind === 'garantie') return 'garantie'
  if (row.payer === 'courtier') return `via_courtier:${row.broker || 'courtier'}`
  return null
}
