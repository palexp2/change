import { useEffect, useMemo, useState } from 'react'
import api from './api.js'
import { TABLE_COLUMN_META } from './tableDefs.js'

// ── Le portier des champs supprimés ─────────────────────────────────────────
//
// Un champ supprimé (corbeille) doit disparaître de TOUTE l'interface — pas
// seulement des tableaux. Les tableaux passaient déjà par un point unique
// (`DataTable` retire les colonnes marquées `hidden`), mais les fiches détail et
// les formulaires déclaraient leurs champs en dur : supprimer « Envoyé le » dans
// /champs/shipments le laissait affiché sur la fiche d'un envoi.
//
// Ce module est le SEUL endroit qui répond à la question « ce champ existe-t-il
// encore ? ». Tout ce qui affiche un champ d'une table doit passer par lui :
//   - `<DataTable>`         → applique déjà le drapeau `hidden` sur les colonnes
//   - `<DetailFieldGrid>`   → cartes de champs des fiches
//   - `<Field>`             → un bloc de champ isolé (fiche ou formulaire)
//   - `<RecordForm>`        → formulaires d'ajout de record
//   - `useDetailFields()`   → registre des fiches qui l'utilisent
//
// L'état « champ supprimé mais encore affiché » n'est donc pas atteignable sans
// contourner le portier — et un test de garde
// (server/src/scripts/detail-field-gate.test.js) échoue si une page essaie.
//
// Source de vérité : GET /api/custom-fields/:table/native, qui republie les
// champs supprimés avec `hidden: true` (natifs personnalisés, adoptés ou
// convertis). Aucune colonne SQL n'est touchée : la donnée reste en base et la
// corbeille de l'admin peut restaurer le champ.

const FRESH_MS = 5000
// Au-delà de ce délai sans réponse, on affiche les champs déclarés plutôt que de
// laisser une fiche vide : la protection anti-clignotement ne vaut pas une carte
// de champs muette quand le réseau (ou le serveur) traîne.
const WAIT_MS = 1500

const cache = new Map() // table -> { rows, at, promise }
const subs = new Map()  // table -> Set<fn>

// Copie locale de la dernière liste connue : sans elle, la fiche s'ouvre avec le
// champ supprimé visible puis le retire quand la requête revient — exactement la
// sensation de « la suppression n'a pas pris » qu'on cherche à éliminer.
const lsKey = (table) => `erp_field_gate_${table}`

function readLocal(table) {
  try {
    const raw = JSON.parse(localStorage.getItem(lsKey(table)))
    return Array.isArray(raw) ? raw : null
  } catch { return null }
}

function writeLocal(table, rows) {
  try { localStorage.setItem(lsKey(table), JSON.stringify(rows)) } catch { /* quota / navigation privée */ }
}

function entryOf(table) {
  let entry = cache.get(table)
  if (!entry) {
    const local = readLocal(table)
    // `known` : a-t-on DÉJÀ une liste de champs pour cette table (copie locale
    // ou réponse du serveur) ? Tant que la réponse est true, on sait quels
    // champs sont supprimés ; sinon on ne le sait pas encore, et afficher un
    // champ « au cas où » reviendrait à faire réapparaître un champ supprimé le
    // temps d'un aller-retour.
    entry = { rows: local || [], known: !!local, at: 0, promise: null }
    cache.set(table, entry)
  }
  return entry
}

function notify(table) {
  for (const fn of subs.get(table) || []) fn()
}

// Forme minimale dont le portier a besoin : l'identifiant, le libellé
// personnalisé et le drapeau de suppression.
function toRows(list) {
  return (list || []).map(r => ({
    field_id: r.field_id,
    label: r.label || null,
    hidden: !!r.hidden,
  }))
}

function sameRows(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].field_id !== b[i].field_id || a[i].label !== b[i].label || a[i].hidden !== b[i].hidden) return false
  }
  return true
}

function commit(table, rows) {
  const entry = entryOf(table)
  entry.at = Date.now()
  const first = !entry.known
  entry.known = true
  if (!first && sameRows(entry.rows, rows)) return
  entry.rows = rows
  writeLocal(table, rows)
  notify(table)
}

/**
 * Alimente le portier depuis une liste déjà chargée ailleurs
 * (`useFieldOverrides`, qui interroge la même route pour l'édition des champs).
 * Évite un aller-retour de plus et propage immédiatement une suppression faite
 * depuis un tableau aux fiches déjà montées.
 */
export function seedFieldGate(table, list) {
  if (!table) return
  commit(table, toRows(list))
}

// Cesse d'attendre : les champs déclarés s'affichent (rien n'est marqué
// supprimé tant qu'on ne l'a pas lu). La réponse, quand elle arrive, s'applique
// normalement.
function giveUpWaiting(table) {
  const entry = entryOf(table)
  if (entry.known) return
  entry.known = true
  notify(table)
}

function refresh(table) {
  const entry = entryOf(table)
  if (entry.promise || Date.now() - entry.at < FRESH_MS) return
  const waitTimer = setTimeout(() => giveUpWaiting(table), WAIT_MS)
  entry.promise = api.fieldOverrides.list(table)
    .then(d => commit(table, toRows(d?.data)))
    // Échec réseau : on garde la dernière liste connue (copie locale) et on
    // cesse d'attendre. Sans ça, une API momentanément indisponible viderait la
    // fiche de tous ses champs — pire que de laisser réapparaître un champ
    // supprimé le temps que le réseau revienne. Le portier ne se met donc en
    // travers que lorsqu'il SAIT (ou n'a pas encore eu le temps de savoir).
    .catch(() => giveUpWaiting(table))
    .finally(() => { clearTimeout(waitTimer); entry.promise = null })
}

function buildGate(table, rows, known) {
  const byId = new Map(rows.map(r => [r.field_id, r]))

  // La personnalisation est indexée par l'id de colonne du tableau, les fiches et
  // formulaires par nom de colonne SQL : `full_name` (tableau) et `first_name`
  // (fiche) peuvent désigner le même champ. On rapproche les deux via
  // TABLE_COLUMN_META, dans les deux sens.
  const alias = new Map()
  for (const c of (TABLE_COLUMN_META[table] || [])) {
    const id = c.id ?? c.field
    const col = c.field ?? c.id
    const entry = { id, col, label: c.label }
    if (id && !alias.has(id)) alias.set(id, entry)
    if (col && !alias.has(col)) alias.set(col, entry)
  }

  const rowFor = (key) => {
    if (!key) return null
    const direct = byId.get(key)
    if (direct) return direct
    const a = alias.get(key)
    if (!a) return null
    return byId.get(a.id) || byId.get(a.col) || null
  }

  return {
    /**
     * La liste des champs est-elle connue ? `false` = premier affichage de
     * cette table dans ce navigateur, la réponse n'est pas encore arrivée : les
     * appelants n'affichent alors AUCUN champ gardé (mieux vaut un bloc qui
     * apparaît 200 ms plus tard qu'un champ supprimé qui clignote).
     */
    ready: known,
    /** Ce champ a-t-il été supprimé (corbeille) ? */
    isDeleted: (key) => !!rowFor(key)?.hidden,
    /**
     * Libellé à afficher : le renommage de l'utilisateur d'abord, puis le
     * libellé déclaré par la page, puis celui de tableDefs. La page garde donc
     * ses libellés contextuels, mais un renommage les remplace partout.
     */
    labelFor: (key, fallback) => rowFor(key)?.label || fallback || alias.get(key)?.label || '',
    /**
     * Retire d'une liste de champs ({ key } ou { field } ou { id }) ceux qui
     * sont supprimés — et rend une liste vide tant que la réponse n'est pas là.
     */
    keep: (list) => (known ? (list || []).filter(f => !rowFor(f?.key ?? f?.field ?? f?.id)?.hidden) : []),
  }
}

// Table absente : rien à garder, et rien à attendre.
const EMPTY_GATE = buildGate(null, [], true)

/**
 * Portier des champs d'une table (clé de vue DataTable, ex. 'shipments').
 * `table` falsy → portier neutre (rien n'est supprimé), pour un usage
 * conditionnel.
 */
export function useFieldGate(table) {
  const [, force] = useState(0)

  useEffect(() => {
    if (!table) return
    let set = subs.get(table)
    if (!set) { set = new Set(); subs.set(table, set) }
    const fn = () => force(n => n + 1)
    set.add(fn)
    refresh(table)
    return () => { set.delete(fn) }
  }, [table])

  const entry = table ? entryOf(table) : null
  const rows = entry ? entry.rows : null
  const known = entry ? entry.known : true

  return useMemo(() => (table ? buildGate(table, rows, known) : EMPTY_GATE), [table, rows, known])
}
