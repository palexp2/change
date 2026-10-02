/**
 * Le même mouvement, dans les deux langues de la banque.
 *
 * QuickBooks reçoit le fil bancaire en anglais, notre fichier de suivi porte les
 * mêmes opérations en français : « PAYMENT RECEIVED THANK YOU » chez eux,
 * « VOTRE PAIEMENT - MERCI » chez nous ; « MISCELLANEOUS ACC. » chez eux,
 * « COMPTE DIVERS » chez nous. Une règle écrite dans QuickBooks n'attrape donc
 * rien ici, alors qu'elle vise exactement la bonne chose.
 *
 * Chaque ligne ci-dessous est un groupe de formulations ÉQUIVALENTES. Toutes
 * ont été relevées dans nos propres relevés ou dans les règles exportées — rien
 * n'est traduit à vue. Un groupe fait que la règle reconnaît indifféremment
 * l'une ou l'autre : le libellé de la règle n'est pas réécrit, c'est la
 * comparaison qui devient bilingue.
 *
 * Pour en ajouter un : mettre les formulations côte à côte, en minuscules et
 * sans ponctuation (la normalisation s'en charge).
 */
export const EQUIVALENTS = [
  // Banque Nationale — opérations courantes
  ['miscellaneous acc', 'compte divers'],
  ['account payable', 'accounts payable', 'compte a payer'],
  ['transaction fee', 'transaction fees', 'frais transaction'],
  ['excess transaction', 'trans excedent'],
  ['package fee', 'frais forfait'],
  ['monthly billing', 'facturation mensuelle'],
  ['amount chqs depos', 'mnt effets dep'],
  ['amount chqs issued', 'mnt effets emis'],
  ['op loan disb', 'debourse mcr'],
  ['op loan repmnt', 'remb mcr'],
  ['interest payment', 'paiement interets'],

  // Desjardins — marge de crédit et frais
  ['deposit from line of credit', 'depot provenant de marge de credit'],
  ['loan payment', 'remboursement automatique', 'virement remboursement'],
  ['int on op loan', 'interet sur eop'],
  ['fixed service charges', 'frais fixes d utilisation'],
  ['overdraft interest', 'frais d interets sur decouvert'],
  ['statement fee', 'frais releve'],

  // Cartes
  ['payment received thank you', 'votre paiement merci', 'paiement caisse'],
  ['foreign transaction fee', 'frais de transaction etranger'],
  ['annual fee', 'frais annuels'],

  // Vocabulaire général
  ['insurance', 'assurance'],
  ['interest', 'interet', 'interets'],
  ['deposit', 'depot'],
  ['transfer', 'virement'],
  ['payment', 'paiement'],
  ['wages', 'salaires'],
]

// « MISCELLANEOUS ACC. » → « miscellaneous acc », pour comparer des phrases
// écrites par deux banques et deux langues sans se soucier de la ponctuation.
const norm = (v) => String(v || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim()

// Index construit une fois : formulation normalisée → son groupe.
const GROUPS = EQUIVALENTS.map((g) => g.map(norm))
const INDEX = new Map()
for (const group of GROUPS) {
  for (const phrase of group) {
    if (!INDEX.has(phrase)) INDEX.set(phrase, group)
  }
}

/**
 * Les formulations qu'un motif peut prendre — la sienne d'abord, puis celles
 * obtenues en remplaçant une expression connue par ses équivalentes.
 *
 * On ne remplace qu'UNE expression à la fois : une règle bilingue se reconnaît,
 * une règle réécrite mot à mot ne veut plus rien dire.
 */
export function patternVariants(pattern) {
  const base = norm(pattern)
  if (!base) return []
  const out = [base]
  // Les expressions les plus longues d'abord : « payment received thank you »
  // doit l'emporter sur « payment » seul.
  const phrases = [...INDEX.keys()].sort((a, b) => b.length - a.length)
  for (const phrase of phrases) {
    if (!base.includes(phrase)) continue
    for (const other of INDEX.get(phrase)) {
      if (other === phrase) continue
      const variant = base.replace(phrase, other).replace(/\s+/g, ' ').trim()
      if (variant && !out.includes(variant)) out.push(variant)
    }
    // Une seule substitution par motif.
    break
  }
  return out
}

