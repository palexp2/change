import { escapeHtml } from './emailHtml.js'

// Modèles de courriel : texte brut avec
//  - des variables [First name], [Email]… (noms anglais ou français, casse
//    indifférente), remplacées par les valeurs du destinataire ;
//  - des liens [texte](url), posés depuis la fiche du modèle en sélectionnant
//    le texte ; l'url peut contenir des variables (…?contact=[Contact ID]).
// Une variable sans valeur prend le texte de remplacement du modèle
// (fallbacks : { company: 'your farm' }), sinon n'insère rien.
const VARS = {
  first_name: ['first name', 'prénom', 'prenom'],
  last_name: ['last name', 'nom de famille'],
  full_name: ['full name', 'name', 'nom complet', 'nom'],
  email: ['email', 'courriel', 'e-mail'],
  company: ['company', 'entreprise', 'compagnie'],
  // Id du contact : reconnaît le client sur les pages avec acceptation (?contact=[Contact ID]).
  contact_id: ['contact id', 'id contact', 'id du contact'],
}
export const TEMPLATE_VARS = ['First name', 'Last name', 'Email', 'Company', 'Contact ID']
const ALIAS = Object.fromEntries(Object.entries(VARS).flatMap(([k, names]) => names.map(n => [n, k])))
const VAR_RE = /\[([^\]\n]{1,40})\]/g
const LINK_RE = /\[([^\]\n]+)\]\(((?:[^)\s[]|\[[^\]\n]*\])+)\)/g

export function templateValues({ contact, company, email, fallbacks = {} }) {
  const first = contact?.first_name || ''
  const last = contact?.last_name || ''
  return {
    first_name: first,
    last_name: last,
    full_name: [first, last].filter(Boolean).join(' '),
    email: email || contact?.email || '',
    company: company || '',
    contact_id: contact?.id || '',
    __fallbacks: fallbacks,
  }
}

const key = name => ALIAS[name.trim().toLowerCase()]
/** Clé d'une variable d'après son nom écrit ([Company] → company), ou undefined. */
export const varKey = key
// Jeton connu sans valeur ni texte de remplacement : rien (Charles, 2026-10-09),
// et l'espace laissé en trop est resserré. Un [texte] inconnu reste tel quel.
const fill = (s, values, enc = v => v, tidy = true) => {
  const out = s.replace(VAR_RE, (m, name) => {
    const k = key(name)
    if (!k) return m
    const v = values[k] || values.__fallbacks?.[k]
    return v ? enc(v) : ''
  })
  return tidy ? out.replace(/ {2,}/g, ' ').replace(/ +([,.;:!?)])/g, '$1') : out
}

// Libellé affiché de chaque variable (clé → [Libellé]).
export const VAR_LABELS = Object.fromEntries(TEMPLATE_VARS.map(l => [ALIAS[l.toLowerCase()], l]))

/** Variables présentes dans un texte (clés), dans l'ordre d'apparition. */
export function usedVars(...texts) {
  const out = []
  for (const t of texts) for (const m of String(t || '').matchAll(VAR_RE)) {
    const k = key(m[1])
    if (k && !out.includes(k)) out.push(k)
  }
  return out
}

/** Textes de remplacement enregistrés sur un modèle (JSON) → objet. */
export function templateFallbacks(t) {
  try { return t?.fallbacks ? JSON.parse(t.fallbacks) : {} } catch { return {} }
}

export const fillText = (text, values) => fill(String(text || ''), values)

// Texte hors [texte](url) : une adresse https://… écrite telle quelle devient un lien.
const URL_RE = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g
const autoLink = s => {
  let out = ''
  let last = 0
  for (const m of s.matchAll(URL_RE)) {
    out += escapeHtml(s.slice(last, m.index)) + `<a href="${escapeHtml(m[0])}">${escapeHtml(m[0])}</a>`
    last = m.index + m[0].length
  }
  return out + escapeHtml(s.slice(last))
}

// Corps du modèle → HTML (un paragraphe par ligne), liens cliquables.
export function renderTemplateHtml(text, values) {
  return String(text || '').split('\n').map(line => {
    let out = ''
    let last = 0
    for (const m of line.matchAll(LINK_RE)) {
      out += autoLink(fill(line.slice(last, m.index), values))
      out += `<a href="${escapeHtml(fill(m[2], values, encodeURIComponent, false))}">${escapeHtml(fill(m[1], values))}</a>`
      last = m.index + m[0].length
    }
    out += autoLink(fill(line.slice(last), values))
    return `<p>${out || '&nbsp;'}</p>`
  }).join('')
}
