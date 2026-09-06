// Garde-fou : « un champ supprimé disparaît partout ».
//
// Le portier des champs supprimés vit dans client/src/lib/fieldGate.js et n'a
// que quatre portes d'entrée côté UI :
//   <DataTable>       → colonnes (déjà en place)
//   <DetailFieldGrid> → cartes de champs des fiches
//   <Field>           → un bloc de champ isolé (fiche ou modale)
//   useFieldGate()    → listes de champs déclarées en tableau ({ key, label })
//
// Une fiche qui écrit le libellé d'un champ EN DUR dans son JSX se met hors de
// portée du portier : le champ reste affiché après suppression (c'est le bug
// « Envoyé le » sur la fiche d'un envoi, 2026-09-02). Ce test relit les pages
// détail et échoue si un libellé de champ connu (tableDefs.js) apparaît hors
// d'un composant gardé.
//
// Ajouter une page détail → l'inscrire dans DETAIL_PAGES.
// Un libellé qui ressemble à un champ mais n'en est pas un (contrôle d'un
// panneau QuickBooks, en-tête d'un sous-tableau, KPI calculé) → l'inscrire dans
// ALLOWED avec sa raison.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TABLE_COLUMN_META } from '../../../client/src/lib/tableDefs.js'

const PAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../client/src/pages')

// Page détail → clé de table (celle de /champs/:table). `null` = la page
// n'affiche pas les champs d'une table configurable, avec la raison.
const DETAIL_PAGES = new Map([
  ['AdresseDetail.jsx',       'adresses'],
  ['AutomationDetail.jsx',    'automations'],
  ['CompanyDetail.jsx',       'companies'],
  ['ContactDetail.jsx',       'contacts'],
  ['DirectDepositDetail.jsx', null], // dépôt direct d'une paie : pas de table dans tableDefs
  ['EmployeeDetail.jsx',      'employees'],
  ['EnvoisDetail.jsx',        'shipments'],
  ['FactureDetail.jsx',       'factures'],
  ['OrderDetail.jsx',         'orders'],
  ['ProductDetail.jsx',       'products'],
  ['ProjectDetail.jsx',       'projects'],
  ['PurchaseDetail.jsx',      'purchases'],
  ['RetourDetail.jsx',        'retours'],
  ['SaleReceiptDetail.jsx',   'sale_receipts'],
  ['SerialDetail.jsx',        'serial_numbers'],
  ['SoumissionDetail.jsx',    'soumissions'],
  ['StripePayoutDetail.jsx',  'stripe_payouts'],
  ['TicketDetail.jsx',        'tickets'],
])

// Libellés en dur tolérés : ce ne sont PAS des champs de la table, ils portent
// juste le même mot. Clé : `Page.jsx::Libellé`.
const ALLOWED = new Map([
  ['SaleReceiptDetail.jsx::Fournisseur', 'Sélecteur du fournisseur QuickBooks dans le panneau de publication, pas la colonne `company` du reçu'],
  ['SaleReceiptDetail.jsx::Type',        'Choix du type de transaction QuickBooks (Purchase/Bill/CC), pas un champ du reçu'],
  ['SaleReceiptDetail.jsx::Total',       'Ligne de sommaire des articles extraits (total calculé), pas la colonne `total`'],
  ['SaleReceiptDetail.jsx::Statut',      'Filtre/état de traitement affiché en pastille, pas un bloc de champ'],
  ['StripePayoutDetail.jsx::Montant',    'Aperçu du Deposit QuickBooks (summary.amount), pas la colonne `amount` du payout'],
  ['StripePayoutDetail.jsx::Devise',     'Aperçu du Deposit QuickBooks (summary.currency)'],
  ['FactureDetail.jsx::Total',           'Ligne « Total » du document (tableau des lignes de facture), pas le bloc de champ'],
  ['FactureDetail.jsx::Notes',           'Titre de la carte de notes rendu par <Field id="notes">, libellé passé en repli'],
  ['OrderDetail.jsx::Statut',            'En-tête de colonne du tableau des lignes de commande'],
  ['AutomationDetail.jsx::Description', "Paramètre d'action du composant local `Field` (envoi Slack), pas la colonne `description` de l'automation"],
  ['OrderDetail.jsx::Produit',           'En-tête de colonne du tableau des lignes de commande'],
])

// Retire les commentaires (// … , /* … */ et {/* … */}) sans toucher aux
// chaînes : sans ça, un exemple d'usage écrit en commentaire compte comme du
// vrai code et fait échouer le test à tort.
function stripComments(src) {
  let out = ''
  let i = 0
  let quote = null
  while (i < src.length) {
    const c = src[i]
    if (quote) {
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue }
      if (c === quote) quote = null
      out += c; i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? src.length : nl
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      continue
    }
    out += c; i++
  }
  return out
}

// ── Lecture des balises JSX ─────────────────────────────────────────────────
// Pas d'analyseur complet : on lit les attributs d'une balise ouvrante en
// s'arrêtant au premier `>` qui n'est pas une flèche `=>` et qui n'est pas dans
// une chaîne d'attribut. Suffisant, et insensible aux apostrophes du texte JSX
// français (« d'analyse ») qui piégeaient une approche naïve.
function attrsAt(src, start) {
  let i = start + 1
  let quote = null
  while (i < src.length) {
    const c = src[i]
    if (quote) { if (c === quote) quote = null; i++; continue }
    if (c === '"') { quote = c; i++; continue }
    if (c === '>' && src[i - 1] !== '=') break
    i++
  }
  const name = /^<([A-Za-z][\w.]*)/.exec(src.slice(start, start + 64))
  return { name: name ? name[1] : null, attrs: src.slice(start + (name ? name[0].length : 1), i) }
}

// Nom de la balise à laquelle appartient l'attribut trouvé à `idx`, ou null si
// `idx` n'est pas dans une balise ouvrante.
function ownerTagOf(src, idx) {
  const before = src.slice(0, idx)
  const lt = before.lastIndexOf('<')
  if (lt === -1) return null
  const between = before.slice(lt)
  if (between.includes('>')) return null
  const m = /^<([A-Za-z][\w.]*)/.exec(between)
  return m ? m[1] : null
}

function labelsOf(table) {
  const set = new Set()
  for (const c of (TABLE_COLUMN_META[table] || [])) {
    if (c.label) set.add(c.label)
  }
  return set
}

// Noms de balises gardés dans CE fichier.
//   strict : le composant partagé lui-même (<Field>, son alias, <DetailField>)
//            — c'est lui qui doit porter `table` et `id`.
//   loose  : strict + les enveloppes locales qui délèguent au portier
//            (`PayoutField`, `FieldShell`…) et <FieldGuard> — un libellé écrit
//            sur elles est déjà gardé.
function gatesOf(src) {
  const strict = new Set(['DetailField'])
  const m = /import\s*\{([^}]*)\}\s*from\s*'\.\.\/components\/Field\.jsx'/.exec(src)
  if (m) {
    for (const part of m[1].split(',')) {
      const alias = /Field\s+as\s+(\w+)/.exec(part)
      if (alias) strict.add(alias[1])
      else if (/^\s*Field\s*$/.test(part)) strict.add('Field')
    }
  }
  // Un composant LOCAL nommé `Field` (paramètres d'action, articles d'un
  // retour) n'est pas le composant partagé : le nom nu n'est alors pas gardé.
  if (/\n(?:function|const)\s+Field\b/.test(src)) strict.delete('Field')

  const loose = new Set(strict)
  const decl = /\n(?:function|const)\s+(\w+)\b/g
  let d
  while ((d = decl.exec(src))) {
    const from = d.index
    const nextDecl = src.slice(from + 1).search(/\n(?:export\s+)?(?:function|const)\s+\w/)
    const body = src.slice(from, nextDecl === -1 ? undefined : from + 1 + nextDecl)
    for (const g of strict) {
      if (new RegExp(`<${g}\\b[^>]*table=`).test(body)) { loose.add(d[1]); break }
    }
  }
  // <FieldGuard> (visibilité conditionnelle) porte son propre `label` pour le
  // moteur de règles ; le bloc qu'il enveloppe est gardé séparément.
  loose.add('FieldGuard')
  return { strict, loose }
}

test('toute page détail est inscrite dans DETAIL_PAGES', () => {
  const found = readdirSync(PAGES_DIR).filter(f => /Detail\.jsx$/.test(f))
  const missing = found.filter(f => !DETAIL_PAGES.has(f))
  assert.deepEqual(
    missing, [],
    `Pages détail non inscrites dans DETAIL_PAGES (detail-field-gate.test.js) : ${missing.join(', ')}.\n` +
    'Inscrire la page avec sa table (celle de /champs/:table), ou `null` + la raison.',
  )
})

test('un libellé de champ n\'est jamais écrit en dur hors d\'un composant gardé', () => {
  const violations = []

  for (const [file, table] of DETAIL_PAGES) {
    if (!table) continue
    const labels = labelsOf(table)
    if (labels.size === 0) continue
    const src = stripComments(readFileSync(join(PAGES_DIR, file), 'utf8'))
    const { loose: gated } = gatesOf(src)

    // 1. `label="Libellé"` sur une balise non gardée.
    const labelRe = /\slabel="([^"]+)"/g
    let hitLabel
    while ((hitLabel = labelRe.exec(src))) {
      const label = hitLabel[1]
      if (!labels.has(label)) continue
      const owner = ownerTagOf(src, hitLabel.index)
      if (!owner || gated.has(owner)) continue
      if (ALLOWED.has(`${file}::${label}`)) continue
      violations.push(`${file} : <${owner} label="${label}"> — passer par <Field table="${table}" id="…"> ou inscrire une exception`)
    }

    // 2. Libellé rendu en texte JSX dans un bloc au style « libellé de champ ».
    const styleRe = /uppercase tracking-wide/g
    let hit
    while ((hit = styleRe.exec(src))) {
      const gt = src.indexOf('>', hit.index)
      if (gt === -1) continue
      const text = src.slice(gt + 1, src.indexOf('<', gt + 1)).trim()
      if (!labels.has(text)) continue
      if (ALLOWED.has(`${file}::${text}`)) continue
      violations.push(`${file} : libellé « ${text} » écrit en dur — passer par <Field table="${table}" id="…"> ou inscrire une exception`)
    }
  }

  assert.deepEqual(violations, [], `Champs hors du portier :\n${violations.join('\n')}`)
})

test('tout composant gardé porte les identifiants que le portier exige', () => {
  const problems = []
  const files = readdirSync(PAGES_DIR).filter(f => f.endsWith('.jsx'))

  for (const file of files) {
    const src = stripComments(readFileSync(join(PAGES_DIR, file), 'utf8'))
    const { strict: gated } = gatesOf(src)

    const tagRe = /<([A-Za-z][\w.]*)/g
    let t
    while ((t = tagRe.exec(src))) {
      const tag = attrsAt(src, t.index)
      if (tag.name === 'DetailField') {
        if (!/(?:^|\s)id[=\s]/.test(tag.attrs)) {
          problems.push(`${file} : <DetailField> sans \`id\` — le portier ne peut pas savoir de quel champ il s'agit`)
        }
        continue
      }
      // `Field` (ou son alias) seulement s'il vient bien du composant partagé :
      // plusieurs pages ont un composant local du même nom pour des données qui
      // ne sont pas des champs de table.
      if (!gated.has(tag.name)) continue
      const hasTable = /(?:^|\s)table[=\s]/.test(tag.attrs)
      const hasId = /(?:^|\s)id[=\s]/.test(tag.attrs)
      if (!hasTable || !hasId) {
        problems.push(`${file} : <${tag.name}> sans ${!hasTable ? '`table`' : ''}${!hasTable && !hasId ? ' ni ' : ''}${!hasId ? '`id`' : ''}`)
      }
    }
  }

  assert.deepEqual(problems, [], `Composants gardés incomplets :\n${problems.join('\n')}`)
})
