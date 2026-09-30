/**
 * Moteur unique de synchronisation Airtable → Boréal.
 *
 * Ce qu'il remplace. Vingt fonctions écrites à la main dans services/airtable.js
 * (2 470 lignes) qui font toutes la même chose dans le même ordre :
 *
 *   1. lire la config (base, table, field_map)
 *   2. supprimer les records détruits côté Airtable
 *   3. sortir tôt si sync incrémental sans record concerné
 *   4. récupérer les records
 *   5. pour chacun, calculer les colonnes « cœur » puis INSERT ou UPDATE
 *   6. horodater le dernier sync
 *   7. purger les orphelins (sync complet) + alimenter les champs dynamiques
 *   8. évaluer les règles de champ
 *
 * Seule l'étape 5 varie d'un module à l'autre — quelles colonnes, et quelle
 * transformation par colonne. Tout le reste était recopié, avec ses oublis :
 * relevé le 2026-09-02, la garde anti-écho n'existait que dans 4 des 20
 * fonctions, et les colonnes gelées dans 4 aussi. Ici chaque miroir en hérite
 * par construction — c'est le seul intérêt réel de l'unification.
 *
 * Ce que le moteur ajoute et qu'aucune fonction historique ne faisait :
 * l'ÉCRITURE DIFFÉRENTIELLE. L'upsert historique fait un UPDATE inconditionnel
 * dès que le record existe, sans comparer. Chaque écriture déclenche un trigger
 * change_log, gonfle le journal, et se retrouve dans le flux de deltas que
 * chaque navigateur télécharge — 238 377 mutations en 48 h, dont la quasi-
 * totalité ne changeait aucune valeur (contacts réécrits 6 fois par record).
 * Ici, un record identique ne provoque aucune écriture.
 *
 * Bascule progressive. `airtable_mirrors.engine` dit qui exécute chaque miroir :
 * 'legacy' (défaut) ou 'unified'. Un miroir ne bascule qu'après vérification de
 * son équivalence, et repasser à 'legacy' annule la bascule sans redéploiement.
 */

import { existsSync } from 'fs'
import { newRecordId } from '../utils/recordId.js'
import path from 'path'
import db from '../db/database.js'
import { periodStartFromFields } from './paiePeriod.js'
import { getAccessToken } from '../connectors/airtable.js'
import { syncDynamicFields, updateDynamicFields } from './airtableAutoSync.js'
import { evaluateFieldRules } from './fieldRuleEngine.js'
import { consumeWritebackEcho, fieldMapDirection, importSkippedCoreKeys } from './airtableWriteback.js'
import { emitMirrorWrite } from './realtimeEmitters.js'
import { sameStored } from './airtableDiff.js'
import { getFrozenColumns } from './airtableFrozenColumns.js'
import { syncCompanies } from './airtable.js'
import {
  fetchAllRecords, getVal, lookupCompany,
  lookupContact, lookupProduct, lookupProject, lookupSerial, firstLinked,
  vendorLinkMap, refreshVendorLinkCache, ACHATS_VENDOR_LINK_FIELD,
  currencyFromCountry, downloadImage,
} from './airtable.js'
import { resolveLegacyConfig, parseFieldMap, MIRROR_SEED } from './airtableMirrorRegistry.js'
import {
  fieldMapFromUi, ORDERS_FIELD_MAP_PLAN, ASSEMBLAGES_FIELD_MAP_PLAN, PIECES_FIELD_MAP_PLAN,
  EMPLOYEES_FIELD_MAP_PLAN, PAIES_FIELD_MAP_PLAN, PAIES_UNMAPPED_AIRTABLE_FIELDS,
  CONTACTS_FIELD_MAP_PLAN, COMPANIES_FIELD_MAP_PLAN, COMPANY_PHASES,
  PROJETS_FIELD_MAP_PLAN, RETOUR_ITEMS_FIELD_MAP_PLAN, SERIALS_FIELD_MAP_PLAN,
  BOM_FIELD_MAP_PLAN,
} from './airtableUiFieldMap.js'
import { uploadsPath } from '../config/uploads.js'

// ── Transformations nommées ─────────────────────────────────────────────────
//
// Ce que faisaient les lignes de calcul de chaque fonction historique, extrait
// en fonctions nommées et réutilisables. Une transformation reçoit les champs
// Airtable du record et le NOM du champ Airtable, et rend la valeur à écrire.
//
// Aucune n'est nouvelle : chacune reproduit à l'identique une expression déjà
// présente dans services/airtable.js. C'est délibéré — le moteur doit écrire
// exactement ce que la fonction qu'il remplace écrivait, sinon la bascule n'est
// pas vérifiable.
export const TRANSFORMS = {
  // getVal : trim, tableau → join(', '), objet → email/name, '' → null.
  text: (fields, name) => getVal(fields, name),

  // `parseInt(String(x ?? 0)) || 0` — entier avec 0 par défaut. Le double
  // fallback compte : Airtable rend `undefined` pour un champ vide, et
  // parseInt('') vaut NaN.
  int0: (fields, name) => parseInt(String(fields[name] ?? 0), 10) || 0,

  // Nombre à virgule, null si absent (et non 0 : un prix absent n'est pas
  // un prix nul).
  number: (fields, name) => {
    const v = fields[name]
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  },

  // `parseFloat(String(x ?? '')) || null` — le legacy pour un coût ou une
  // valeur monétaire. Attention : `0 || null` vaut null, donc un ZÉRO devient
  // NULL. C'est bizarre, mais c'est ce que la fonction remplacée écrit, et
  // l'équivalence prime sur l'élégance. Ne pas « corriger » sans décider que
  // les valeurs à 0 doivent changer de sens.
  floatOrNull: (fields, name) => parseFloat(String(fields[name] ?? '')) || null,

  // `parseFloat(String(x ?? 1).replace(/[^0-9.-]/g, '')) || 1` — quantité de
  // nomenclature : nettoie les caractères parasites (« 2 pcs ») et retombe sur
  // 1, pas 0. Une ligne de BOM sans quantité vaut une pièce.
  qtyDefault1: (fields, name) =>
    parseFloat(String(fields[name] ?? 1).replace(/[^0-9.-]/g, '')) || 1,

  // Entreprise : record lié d'abord, repli sur une recherche par nom. C'est le
  // seul lookup qui tolère le texte — historiquement les entreprises arrivaient
  // en texte libre dans certaines tables.
  company: (fields, name) => lookupCompany(fields, name),

  // `parseFloat(String(x ?? '').replace(/[^0-9.-]/g, ''))`, NaN → 0. Le couple
  // toInt/toFloat des achats : le nettoyage compte, un montant Airtable peut
  // arriver en texte (« 1 234,50 $ »), et l'absence de valeur y vaut 0 — pas
  // null, contrairement à `number`.
  intClean0: (fields, name) => { const n = cleanNumber(fields[name]); return n === null ? 0 : Math.round(n) },
  floatClean0: (fields, name) => { const n = cleanNumber(fields[name]); return n === null ? 0 : n },

  // Les autres clés étrangères passent par le premier record lié.
  link_contact: (fields, name) => lookupContact(firstLinked(fields, name)),
  link_product: (fields, name) => lookupProduct(firstLinked(fields, name)),
  link_project: (fields, name) => lookupProject(firstLinked(fields, name)),
  link_serial: (fields, name) => lookupSerial(firstLinked(fields, name)),

  // Retour parent d'un item de retour. Pas de helper partagé : `lookupReturn`
  // n'existe pas dans services/airtable.js, la requête y est écrite en ligne.
  link_return: (fields, name) => {
    const linked = firstLinked(fields, name)
    if (!linked) return null
    return db.prepare('SELECT id FROM returns WHERE airtable_id=?').get(linked)?.id || null
  },

  // Produit avec repli par nom — la variante des achats et des sériaux : le
  // record lié d'abord, puis, SI le champ contient du texte et non un lien,
  // une recherche dans `name_fr`/`sku`. Deux tables historiques écrivent le
  // produit en texte libre ; sans ce repli elles perdraient leur rattachement.
  link_product_or_text: (fields, name) => {
    if (!name || !(name in fields)) return null
    const raw = fields[name]
    const linkedId = Array.isArray(raw) ? raw[0] : null
    if (linkedId) {
      const byId = lookupProduct(linkedId)
      if (byId) return byId
    }
    const text = Array.isArray(raw) ? null : getVal(fields, name)
    if (!text) return null
    return db.prepare('SELECT id FROM products WHERE (name_fr LIKE ? OR sku LIKE ?) LIMIT 1')
      .get(`%${text}%`, `%${text}%`)?.id || null
  },

  // Contact avec repli par nom complet (billets) : le champ Airtable contient
  // parfois un nom tapé à la main plutôt qu'un lien.
  link_contact_or_text: (fields, name) => {
    if (!name || !(name in fields)) return null
    const raw = fields[name]
    const linkedId = Array.isArray(raw) ? raw[0] : null
    if (linkedId) {
      const byId = lookupContact(linkedId)
      if (byId) return byId
    }
    const text = Array.isArray(raw) ? null : getVal(fields, name)
    if (!text) return null
    return db.prepare("SELECT id FROM contacts WHERE (first_name || ' ' || last_name) LIKE ? LIMIT 1")
      .get(`%${text}%`)?.id || null
  },

  // Variantes « nettoyées » qui laissent NULL quand il n'y a rien : les quatre
  // colonnes de priorité d'assemblage doivent pouvoir être vides, un 0 y
  // fausserait le calcul du manque.
  intCleanNull: (fields, name) => { const n = cleanNumber(fields[name]); return n === null ? null : Math.round(n) },
  floatCleanNull: (fields, name) => cleanNumber(fields[name]),

  // Paie : `Number()` strict, null si vide — un champ de paie mal typé ne doit
  // pas devenir 0, ce serait un montant.
  empNum: (fields, name) => {
    if (!name || !(name in fields)) return null
    const v = fields[name]
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  },
  // Case à cocher de paie : 1 ou 0, jamais null (les colonnes sont des drapeaux).
  empBool: (fields, name) => {
    if (!name || !(name in fields)) return 0
    const v = fields[name]
    return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0
  },

  // L'identifiant Airtable du record lié, tel quel. Les items de paie gardent
  // le `rec…` à côté de la clé étrangère : il sert de rattrapage quand le
  // parent n'est pas encore importé.
  linked_id: (fields, name) => firstLinked(fields, name),

  link_paie: (fields, name) => {
    const linked = firstLinked(fields, name)
    if (!linked) return null
    return db.prepare('SELECT id FROM paies WHERE airtable_id=?').get(linked)?.id || null
  },
  link_employee: (fields, name) => {
    const linked = firstLinked(fields, name)
    if (!linked) return null
    return db.prepare('SELECT id FROM employees WHERE airtable_id=?').get(linked)?.id || null
  },
  link_fourniture: (fields, name) => {
    const linked = firstLinked(fields, name)
    if (!linked) return null
    return db.prepare('SELECT id FROM fournitures WHERE airtable_id=?').get(linked)?.id || null
  },

  // Pièce jointe : l'URL du PREMIER fichier. Airtable renvoie un tableau
  // d'objets ; l'URL expire, mais c'est celle que la table stocke aujourd'hui.
  attachment_url: (fields, name) => {
    const atts = fields[name]
    return Array.isArray(atts) && atts.length ? (atts[0].url || null) : null
  },

  // Projet lié, avec repli par nom (commandes) : le champ « Projet » contient
  // parfois le nom du projet plutôt qu'un lien.
  link_project_or_text: (fields, name) => {
    if (!name || fields[name] == null) return null
    const raw = fields[name]
    const linkedId = Array.isArray(raw) ? raw[0] : null
    if (linkedId) {
      const byId = db.prepare('SELECT id FROM projects WHERE airtable_id=? LIMIT 1').get(linkedId)?.id
      if (byId) return byId
    }
    const text = getVal(fields, name)
    if (!text) return null
    return db.prepare('SELECT id FROM projects WHERE name LIKE ? LIMIT 1').get(`%${text}%`)?.id || null
  },

  // Adresse liée (commandes). Lien strict.
  link_address: (fields, name) => {
    const linked = firstLinked(fields, name)
    if (!linked) return null
    return db.prepare('SELECT id FROM adresses WHERE airtable_id=? LIMIT 1').get(linked)?.id || null
  },

  // Commande parente d'un item : lien ou identifiant en texte, sans repli par
  // numéro — un item rattaché à la mauvaise commande serait pire que pas d'item.
  link_order: (fields, name) => {
    const linked = firstLinked(fields, name)
    if (!linked) return null
    return db.prepare('SELECT id FROM orders WHERE airtable_id=?').get(linked)?.id || null
  },

  // Produit d'un item de commande. Même esprit que `link_product_or_text`, mais
  // le repli cherche AUSSI dans le nom anglais et exige un SKU exact — c'est ce
  // que fait la fonction remplacée, et l'équivalence prime sur l'uniformité.
  link_product_order_item: (fields, name) => {
    const linked = firstLinked(fields, name)
    if (linked) {
      const byId = lookupProduct(linked)
      if (byId) return byId
    }
    const text = getVal(fields, name)
    if (!text) return null
    return db.prepare('SELECT id FROM products WHERE (name_fr LIKE ? OR name_en LIKE ? OR sku=?) LIMIT 1')
      .get(`%${text}%`, `%${text}%`, text)?.id || null
  },

  // `parseInt(String(x ?? 1)) || 1` — quantité d'un item de commande. Pas de
  // nettoyage ici (contrairement à `qtyDefault1`) : c'est le legacy à la lettre.
  qtyInt1: (fields, name) => parseInt(String(fields[name] ?? 1), 10) || 1,

  // Ligne de commande liée (sériaux). Lien strict : pas de repli par texte,
  // un item de commande ne s'identifie pas par son libellé.
  link_order_item: (fields, name) => {
    const linked = firstLinked(fields, name)
    if (!linked) return null
    return db.prepare('SELECT id FROM order_items WHERE airtable_id=? LIMIT 1').get(linked)?.id || null
  },
}

// `parseFloat(String(x ?? '').replace(/[^0-9.-]/g, ''))` — le nettoyage commun
// à toInt/toFloat des achats. Rend null quand il ne reste rien de numérique,
// pour que l'appelant décide entre 0 et null.
function cleanNumber(raw) {
  const n = parseFloat(String(raw ?? '').replace(/[^0-9.-]/g, ''))
  return isNaN(n) ? null : n
}

// ── Plans « cœur » par miroir ───────────────────────────────────────────────
//
// Pour chaque clé du field_map historique : la colonne ERP visée et la
// transformation à appliquer. C'est la traduction, module par module, des lignes
// de calcul de la fonction qu'on remplace — et la seule chose qui reste à écrire
// à la main pour basculer un miroir.
//
// Un miroir absent d'ici ne PEUT PAS basculer : le moteur refuse de tourner sans
// plan, plutôt que d'écrire des colonnes au hasard.
//
// Forme d'un plan :
//   fields      { clé du field_map: [colonne ERP, transformation] } — le cas courant
//   require     colonnes qui DOIVENT être non nulles, sinon le record est sauté
//   requireAny  au moins une de ces colonnes non nulle, sinon record sauté
//   insertOnly  journal append-only : on insère, on ne met jamais à jour
//   defaults    valeur de repli par colonne, appliquée APRÈS les gardes : les
//               employés stockent une chaîne vide et non NULL pour un prénom
//               absent, alors que la garde, elle, doit voir le vide.
//   derive      échappatoire pour ce qu'un mapping champ-à-champ ne sait pas
//               exprimer — une colonne calculée depuis PLUSIEURS champs, ou
//               depuis les métadonnées du record. Reçoit (fields, rec, fieldMap,
//               { values, ctx }) et rend des colonnes qui complètent (et peuvent
//               écraser) `fields` ; `values` porte les colonnes déjà calculées.
//   insertExtras(rec, fieldMap) — colonnes posées à la CRÉATION seulement
//               (le numéro de commande s'attribue une fois).
//   onWrite(outcome, erpId, ctx) — appelé sur une écriture RÉELLE, jamais sur
//               un record inchangé : collecte d'ids pour `finalize`. L'émission
//               temps réel, elle, n'est PLUS l'affaire des plans — le moteur
//               l'envoie pour tous les miroirs (voir 5b).
//   finalize    travail ASYNCHRONE d'après-sync propre à un module (les
//               soumissions recalculent la valeur en CAD des projets touchés).
//               Exécuté comme les autres étapes de fin : ISOLÉ, son échec est
//               rapporté dans `report.step_errors` sans emporter le reste.
//   prepare     travail ASYNCHRONE à faire une seule fois, avant la boucle :
//               typiquement rafraîchir un cache de records liés d'une AUTRE
//               table Airtable (les achats ont besoin de la table Fournisseurs).
//               Reçoit ({ records, cfg, fieldMap, token, changes, dryRun }) et
//               rend le contexte passé ensuite à `derive`. Hors de la
//               transaction : rien d'asynchrone ne peut vivre dedans.
//
// `derive` est volontairement du CODE et pas de la donnée : prétendre tout
// exprimer déclarativement obligerait à inventer un mini-langage pour trois
// modules. Mieux vaut une échappatoire nommée, visible, et testable.
// ── Achats : ce que le mapping champ-à-champ ne dit pas ─────────────────────
//
// Il n'en reste qu'une particularité : le FOURNISSEUR vient d'un record lié
// d'une autre table Airtable (« Fournisseurs »), dont le nom est la raison
// sociale QuickBooks exacte. Deux colonnes ERP en sortent (nom + id QB) à partir
// d'un seul champ : aucun mapping champ-à-champ ne sait l'exprimer.
//
// Ce que le `derive` ne fait PLUS :
//  • le STATUT (`purchases.status`) et la colonne texte `supplier` : droppés sur
//    demande, migration 032 ;
//  • la QUANTITÉ REÇUE : `received_date` / `qty_ordered` d'abord (035, il n'y
//    avait plus rien à en déduire), puis `purchases.qty_received` elle-même,
//    droppée sur demande (migration 036).

// Le cache rec id → { name, qb_vendor_id } est en base (`airtable_vendor_links`).
// On ne le rafraîchit que si c'est utile : sync complet, ou sync incrémental
// dont un achat pointe vers un fournisseur encore inconnu. En essai à blanc, on
// s'en passe : un essai sans effet doit être sans effet, cache compris.
async function achatsPrepareVendors({ records, cfg, token, changes, dryRun }) {
  let vendors = vendorLinkMap()
  const linked = new Set()
  for (const rec of records) {
    const raw = rec.fields?.[ACHATS_VENDOR_LINK_FIELD]
    if (Array.isArray(raw)) for (const v of raw) if (typeof v === 'string') linked.add(v)
  }
  const stale = !changes || [...linked].some(id => !vendors.has(id))
  if (stale && !dryRun) {
    await refreshVendorLinkCache(cfg.baseId, token)
    vendors = vendorLinkMap()
  }
  return { vendors }
}

function achatsDerive(fields, rec, fieldMap, { ctx = {} } = {}) {
  const rawVendorLink = fields?.[ACHATS_VENDOR_LINK_FIELD]
  const linkedVendorId = Array.isArray(rawVendorLink) ? rawVendorLink[0] : null
  const vendor = linkedVendorId ? ctx.vendors?.get(linkedVendorId) : null

  // Deux colonnes, un seul champ lié : c'est tout ce que le `derive` des achats
  // a encore à faire. La quantité reçue est partie avec sa colonne (036).
  return {
    supplier_vendor_name: vendor?.name || null,
    supplier_qb_vendor_id: vendor?.qb_vendor_id || null,
  }
}

// ── Billets ─────────────────────────────────────────────────────────────────
//
// Plus de `derive` : il nettoyait le statut (texte libre historique), le type et
// la date de création, trois colonnes droppées sur demande (migration 040). La
// table de correspondance des statuts (`status_map` du field_map) est partie
// avec elles.

// ── Soumissions : devise du projet, et valeur des projets à recalculer ──────
//
// La devise ne vient pas d'Airtable : elle se déduit du pays de livraison de
// l'entreprise du projet lié. Deux sauts, donc pas exprimable en mapping.
const soumissionPaysStmt = () => db.prepare(`
  SELECT co.pays_de_livraison AS pays
  FROM projects p LEFT JOIN companies co ON co.id = p.company_id
  WHERE p.id = ?
`)

// ── Prospects Instagram : un miroir volontairement asymétrique ──────────────
//
// L'ERP est la source de vérité ici : la fiche naît de l'appel de ManyChat, pas
// d'Airtable. Seul le SUIVI revient (statut, notes, case « Contacté ») ; tout
// le reste part de l'ERP. D'où `updateOnly` (aucune création : une ligne
// ajoutée à la main dans Airtable n'a ni IGSID ni clé de dédup) et
// `purge_orphans=0` dans le registre (une suppression Airtable ne doit pas
// faire perdre la mémoire du DM déjà envoyé, ce qui rouvrirait la porte à un
// second contact).
//
// ⚠️ Constat repris tel quel de la fonction historique, à vérifier avec
// Guillaume : la case « Contacté » d'Airtable arrive en BOOLÉEN, or `getVal` la
// rend en texte (« true ») avant la comparaison à `true`/`1`/`'1'`. Résultat :
// une case cochée dans Airtable retombe à 0 côté ERP. Le moteur reproduit ce
// comportement à la lettre — le corriger changerait des données, ce n'est pas
// une décision de bascule.
function instagramDerive(fields, rec, fieldMap) {
  if (fieldMapDirection('instagram', 'contacted') === 'push') return {}
  const atField = fieldMap?.contacted
  if (!atField) return {}
  const val = getVal(fields, atField)
  const contacted = (val === true || val === 1 || val === '1') ? 1 : 0
  if (!contacted) return { contacted: 0, contacted_at: null }
  // Déjà daté : on garde la date d'origine, c'est elle qui fait foi.
  const existing = db.prepare('SELECT contacted_at FROM instagram_prospects WHERE airtable_id=? AND deleted_at IS NULL').get(rec.id)
  return existing?.contacted_at ? { contacted: 1 } : { contacted: 1, contacted_at: new Date().toISOString() }
}

// ── Paies : total attendu et début de période ───────────────────────────────
//
// `period_start` est relue du champ Airtable « Période de paie » (nom en dur,
// cf. PAIES_UNMAPPED_AIRTABLE_FIELDS — la migration 051 l'a démappé de
// /champs/paies, elle n'y revient pas). Illisible ou absent : la colonne n'est
// pas touchée, ce qui laisse en place la valeur interne
// (`paieTimesheetImport.computePeriod`).
function paiesDerive(fields, rec, fieldMap) {
  const num = TRANSFORMS.empNum
  // Depuis le retrait du field_map cœur, chaque clé est démappable dans
  // /champs/paies : une colonne dérivée d'une clé démappée n'est PAS calculée,
  // sinon démapper « Total de la paie » remettrait toutes les paies à vide.
  // Les deux champs d'appoint n'ont aucune colonne ERP, donc aucune ligne dans
  // l'interface : ils gardent leur nom Airtable (cf. airtableUiFieldMap.js).
  const totalExcl = num(fields, PAIES_UNMAPPED_AIRTABLE_FIELDS.total_excl_reimb)
  const reimbTotal = num(fields, PAIES_UNMAPPED_AIRTABLE_FIELDS.expense_reimb_total)
  const out = {}
  const totalIncl = num(fields, fieldMap?.total_with_charges_and_reimb)
  // Le champ « incluant les remboursements » n'est rempli qu'au write-back de
  // la comptabilisation. Avant ça, le total attendu se reconstitue depuis la
  // formule « excluant » + le rollup des remboursements — mais seulement si la
  // paie est complète côté Airtable : une formule ≤ 0 veut dire que les remises
  // aux organismes ne sont pas encore saisies.
  const totalFallback = totalExcl != null ? Math.round((totalExcl + (reimbTotal || 0)) * 100) / 100 : null
  const periodStart = periodStartFromFields(fields)
  if (periodStart) out.period_start = periodStart
  if (fieldMap?.total_with_charges_and_reimb) {
    out.total_with_charges_and_reimb = totalIncl != null ? totalIncl : (totalFallback > 0 ? totalFallback : null)
  }

  return out
}

// ── Pièces : images et type d'approvisionnement ─────────────────────────────
//
// L'image du produit est recopiée localement AVANT la transaction — une URL
// d'attachment Airtable expire, la copie locale est ce que l'app affiche. Le
// téléchargement est asynchrone, donc il vit dans `prepare`.
const PROCUREMENT_TYPES = ['Acheté', 'Fabriqué', 'Drop ship']

const PROCUREMENT_IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp']

// `table` : les fournitures réutilisent la même copie locale (même dossier,
// même route de service — le nom de fichier est l'id `rec…`, unique partout).
async function piecesPrepareImages({ records, fieldMap, dryRun }, table = 'products') {
  const imageUrl = {}
  const field = fieldMap?.image
  if (!field) return { imageUrl }
  const imagesDir = uploadsPath('products')
  // Une image déposée à la main dans l'ERP (préfixe `local-`, cf. la route
  // POST /api/products/:id/image) l'emporte sur la pièce jointe Airtable :
  // sans ça, la synchro suivante la remplacerait par la copie du miroir.
  const manual = new Set(db.prepare(
    `SELECT airtable_id FROM ${table} WHERE airtable_id IS NOT NULL AND image_url LIKE '/erp/api/product-images/local-%'`
  ).all().map(r => r.airtable_id))
  for (const rec of records) {
    if (manual.has(rec.id)) continue
    const attachments = rec.fields?.[field]
    if (!Array.isArray(attachments) || !attachments.length) continue
    // Le champ « Image » d'Airtable accepte n'importe quel fichier : une fiche
    // technique en PDF s'y glisse et donnait une vignette cassée. On ne retient
    // que la première pièce jointe qui est vraiment une image.
    const att = attachments.find(a => {
      if (a?.type) return String(a.type).startsWith('image/')
      return PROCUREMENT_IMAGE_EXT.includes(String(a?.filename || '').split('.').pop()?.toLowerCase())
    })
    if (!att) continue
    const ext = att.filename?.split('.').pop()?.toLowerCase() || 'jpg'
    const filename = `${rec.id}.${ext}`
    const destPath = path.join(imagesDir, filename)
    // Un essai à blanc ne télécharge rien ; l'URL, elle, se calcule pareil.
    if (!dryRun && !existsSync(destPath)) {
      try {
        await downloadImage(att.url, destPath)
      } catch (e) {
        // Enregistrer l'URL locale d'un fichier qu'on n'a pas réussi à
        // télécharger fabrique une vignette définitivement cassée : mieux vaut
        // pas d'image et un nouvel essai à la prochaine synchro.
        console.error('⚠️  Image download:', e.message)
        continue
      }
    }
    imageUrl[rec.id] = `/erp/api/product-images/${filename}`
  }
  return { imageUrl }
}

// ── Commandes : statut, abonnement, numéro, temps réel ──────────────────────
const ORDER_STATUS_MAP = {
  'commande vide': 'Commande vide', 'vide': 'Commande vide', 'brouillon': 'Commande vide', 'draft': 'Commande vide',
  "gel d'envois": "Gel d'envois", 'gel': "Gel d'envois",
  'en attente': 'En attente', 'confirmée': 'En attente', 'confirmed': 'En attente',
  'items à fabriquer ou à acheter': 'Items à fabriquer ou à acheter', 'en préparation': 'Items à fabriquer ou à acheter',
  'tous les items sont disponibles': 'Tous les items sont disponibles',
  'tout est dans la boite': 'Tout est dans la boite',
  'partiellement envoyé': 'Partiellement envoyé', 'partiellement envoyée': 'Partiellement envoyé', 'partial': 'Partiellement envoyé',
  'jwt-config': 'JWT-config',
  "envoyé aujourd'hui": "Envoyé aujourd'hui", 'envoyée': 'Envoyé', 'envoyé': 'Envoyé', 'sent': 'Envoyé', 'shipped': 'Envoyé',
  'drop ship seulement': 'Drop ship seulement', 'drop ship': 'Drop ship seulement',
  'erreur système': 'ERREUR SYSTÈME',
}

const ITEM_TYPES = ['Facturable', 'Remplacement', 'Non facturable']

// ── Projets : les dépendances d'abord, les choix ensuite ────────────────────
//
// Un projet lie une entreprise. Si l'ERP ne la connaît pas encore, la fonction
// historique met le record DE CÔTÉ, synchronise les entreprises manquantes,
// puis rejoue une seconde passe. Ici la dépendance est résolue AVANT la boucle
// — même résultat, une passe au lieu de deux, et plus de record « en attente »
// qui peut se perdre entre les deux.
async function projetsPrepareCompanies({ records, fieldMap, dryRun }) {
  const field = fieldMap?.company
  if (!field) return {}
  const exists = db.prepare('SELECT 1 FROM companies WHERE airtable_id=? LIMIT 1')
  const missing = new Set()
  for (const rec of records) {
    const link = rec.fields?.[field]
    if (!Array.isArray(link)) continue
    for (const v of link) {
      if (typeof v === 'string' && !exists.get(v)) missing.add(v)
    }
  }
  if (!missing.size || dryRun) return { missing_companies: missing.size }

  const crm = db.prepare('SELECT base_id, companies_table_id FROM airtable_sync_config').get()
  if (!crm?.companies_table_id) return { missing_companies: missing.size }
  console.log(`🔗 Projets: ${missing.size} entreprise(s) liée(s) manquante(s) — sync companies d'abord`)
  // Par le routeur, pas par la fonction historique : si le miroir des
  // entreprises est déjà sur le moteur, la dépendance doit s'importer de la
  // même façon que partout ailleurs.
  await routeSync('companies', {
    [crm.companies_table_id]: {
      recordIds: [...missing], destroyedIds: [], changedFieldIds: [], hasCreates: false,
    },
  }, syncCompanies)
  return { missing_companies: missing.size }
}

// Statut et type sont des listes de choix RÉGLÉES PAR L'UTILISATEUR, rangées
// dans le field_map (`status_choices`, `type_choices`). Les défauts reproduisent
// l'héritage : « Oui » = gagné, « Non » = perdu, tout le reste est ouvert.
const PROJECT_TYPES = ['Nouveau client', 'Expansion', 'Ajouts mineurs', 'Pièces de rechange']

function projetsDerive(fields, rec, fieldMap) {
  const out = {}
  // Chaque colonne n'est écrite QUE si son champ est mappé : sans mapping,
  // `status` retombait sur « Ouvert » et blanchissait tous les Gagné/Perdu à
  // chaque sync (le graphique « Taux de closing » se vidait). Même piège pour
  // `type` et `probability`.
  if (fieldMap?.status) {
    const raw = (getVal(fields, fieldMap.status) || '').trim()
    const choices = fieldMap.status_choices || { 'Oui': 'Gagné', 'Non': 'Perdu' }
    out.status = choices[raw] || 'Ouvert'
  }
  if (fieldMap?.type) {
    const raw = getVal(fields, fieldMap.type) || ''
    const choices = fieldMap.type_choices || {}
    out.type = choices[raw] || PROJECT_TYPES.find(t => t.toLowerCase() === raw.toLowerCase()) || null
  }
  if (fieldMap?.probability) {
    // Airtable stocke un pourcentage en décimal (0,30 = 30 %) — mais pas
    // toujours : au-dessus de 1, la valeur est déjà en points.
    const n = parseFloat(String(rec.fields[fieldMap.probability] ?? ''))
    out.probability = isNaN(n) ? null : Math.round(n > 1 ? n : n * 100)
  }
  return out
}

// ── Entreprises et contacts ─────────────────────────────────────────────────
//
// Le CRM est le cas où Airtable COMPLÈTE sans jamais effacer : presque toutes
// les colonnes passent par un COALESCE dans la fonction historique. Un champ
// vidé côté Airtable ne vide donc pas la fiche Boréal — c'est un choix ancien,
// reproduit ici par `keepIfNull`.
// `phone`, `website` et `type` ont été droppées (migration 045).
const COMPANY_SOFT_COLUMNS = [
  'email', 'address', 'city', 'province', 'country',
  'lifecycle_phase', 'notes',
]

export const CORE_PLANS = {
  assemblages: {
    // Plus de field_map « cœur » : le mapping des trois clés se règle dans
    // /champs/assemblages (cf. retireAssemblagesCoreFieldMap).
    uiFieldMapPlan: ASSEMBLAGES_FIELD_MAP_PLAN,
    fields: {
      product:         ['product_id', 'link_product'],
      qty_produced:    ['qty_produced', 'int0'],
      assembled_at:    ['assembled_at', 'text'],
      assembly_points: ['assembly_points', 'int0'],
    },
  },
  adresses: {
    fields: {
      company:      ['company_id', 'company'],
      contact:      ['contact_id', 'link_contact'],
      line1:        ['line1', 'text'],
      city:         ['city', 'text'],
      province:     ['province', 'text'],
      postal_code:  ['postal_code', 'text'],
      country:      ['country', 'text'],
      language:     ['language', 'text'],
      address_type: ['address_type', 'text'],
    },
    // Une adresse n'est liée à l'entreprise que par UN des trois liens
    // Airtable, selon son type : livraison (mappé), ferme ou facturation.
    derive: (fields, rec, fm, { values }) => {
      if (values.company_id) return {}
      const companyId = lookupCompany(fields, 'Entreprise (adresse de la ferme)')
        ?? lookupCompany(fields, 'Entreprise (adresse de factuation)')
      return companyId ? { company_id: companyId } : {}
    },
  },
  bom: {
    // Plus de field_map « cœur » : le mapping des quatre clés se règle dans
    // /champs/bom_items (cf. retireBomCoreFieldMap).
    uiFieldMapPlan: BOM_FIELD_MAP_PLAN,
    fields: {
      product:      ['product_id', 'link_product'],
      component:    ['component_id', 'link_product'],
      qty_required: ['qty_required', 'qtyDefault1'],
      ref_des:      ['ref_des', 'text'],
    },
    // Une ligne de nomenclature qui ne résout NI le produit NI le composant
    // n'a aucun sens ici — le legacy la saute (`if (!productId && !componentId)`).
    requireAny: ['product_id', 'component_id'],
  },
  serial_changes: {
    fields: {
      serial:          ['serial_id', 'link_serial'],
      previous_status: ['previous_status', 'text'],
      new_status:      ['new_status', 'text'],
      changed_at:      ['changed_at', 'text'],
    },
    // Journal des changements d'état : le legacy n'a QUE la branche INSERT
    // (`if (!existing)`). Une ligne d'historique ne se réécrit pas.
    insertOnly: true,
  },
  stock_movements: {
    fields: {
      product:        ['product_id', 'link_product'],
      unit_cost:      ['unit_cost', 'floatOrNull'],
      movement_value: ['movement_value', 'floatOrNull'],
    },
    // `stock_movements.product_id` est le pivot : sans produit, le mouvement
    // n'est rattachable à rien. Le legacy compte ces records comme « sautés ».
    require: ['product_id'],
    // Trois colonnes que le mapping champ-à-champ ne peut pas exprimer :
    //  • `type` se déduit du texte Airtable ET du SIGNE de la quantité
    //  • `qty` est la valeur absolue arrondie de cette même quantité
    //  • `reason` reçoit le texte Airtable brut du même champ que `type`
    //  • `created_at` retombe sur la date de création du record Airtable
    // Une clé réglée en Boréal → Airtable seulement n'écrit pas sa colonne ici
    // non plus (même règle que la boucle des champs) ; `type` dépend des deux.
    derive: (fields, rec, fieldMap) => {
      const rawQty = parseFloat(String(fields[fieldMap.qty_change] ?? 0)) || 0
      const atType = getVal(fields, fieldMap.type) || ''
      const type = /ajustement/i.test(atType) ? 'adjustment' : (rawQty >= 0 ? 'in' : 'out')
      const out = {
        type,
        qty: Math.round(Math.abs(rawQty)),
        reason: atType || null,
        created_at: getVal(fields, fieldMap.occurred_at) || rec.createdTime || null,
      }
      const pushKeys = new Set(['qty_change', 'type', 'occurred_at']
        .filter(key => fieldMapDirection('stock_movements', key) === 'push'))
      // Un record NOUVEAU prend tout : type et qty sont NOT NULL.
      if (!pushKeys.size || !db.prepare('SELECT 1 FROM stock_movements WHERE airtable_id=?').get(rec.id)) return out
      const pushOnly = key => pushKeys.has(key)
      if (pushOnly('qty_change')) delete out.qty
      if (pushOnly('type')) delete out.reason
      if (pushOnly('qty_change') || pushOnly('type')) delete out.type
      if (pushOnly('occurred_at')) delete out.created_at
      return out
    },
  },
  retours: {
    // Plan cœur VIDE : les 6 dernières colonnes alimentées en code du miroir
    // retours (company_id, contact, n_de_retour, problem_status, notes,
    // billed_at) ont été droppées (migration 037, « supprime tous les champs
    // Airtable codés en dur »). Le mapping champ-à-champ du module vit
    // maintenant ENTIÈREMENT dans /champs/retours (defs dynamiques). Le plan
    // reste déclaré pour que `usesMirrorEngine('retours')` continue de répondre
    // vrai — le moteur unique garde la main sur le module, avec son `derive`.
    fields: {},
    // Plus de `derive` non plus : il ne produisait que `status`, une CONSTANTE
    // (« Ouvert ») réécrite sur les 476 lignes à chaque sync — la clé n'était
    // pas dans le field_map, Airtable n'a pas de colonne « Statut » sur les
    // retours. La colonne a été droppée par la migration 041. Le plan n'écrit
    // donc plus rien : une ligne neuve se crée avec son seul `airtable_id`.
  },
  retour_items: {
    // Plus de field_map « cœur » : les 12 clés se règlent dans
    // /champs/return_items (cf. retireRetourItemsCoreFieldMap ; elles étaient 13
    // avant le drop de « Produit à envoyer », migration 046). Une clé démappée
    // n'est plus écrite du tout (la boucle ci-dessous saute les clés absentes du
    // field_map) — démapper « Retour » arrête donc l'import des NOUVEAUX
    // articles, `return_id` étant la garde d'insertion.
    uiFieldMapPlan: RETOUR_ITEMS_FIELD_MAP_PLAN,
    fields: {
      return:              ['return_id', 'link_return'],
      product_to_receive:  ['product_id', 'link_product'],
      serial:              ['serial_id', 'link_serial'],
      company:             ['company_id', 'company'],
      problem_category:    ['problem_category', 'text'],
      return_reason:       ['return_reason', 'text'],
      return_reason_notes: ['return_reason_notes', 'text'],
      action:              ['action', 'text'],
      received_at:         ['received_at', 'text'],
      received_by:         ['received_by', 'text'],
      analysis_notes:      ['analysis_notes', 'text'],
      analyzed_by:         ['analyzed_by', 'text'],
    },
    // `return_items.return_id` est NOT NULL : un item dont le retour parent
    // n'est pas (encore) importé est sauté, comme le fait le legacy.
    require: ['return_id'],
  },
  serials: {
    // Plus de field_map « cœur » en base : chaque clé se branche sur son champ
    // Airtable dans /champs/serial_numbers (cf. retireSerialsCoreFieldMap). Les
    // clés, les transformations et la garde `require` ne changent pas — seule la
    // provenance des NOMS de champs Airtable change.
    uiFieldMapPlan: SERIALS_FIELD_MAP_PLAN,
    fields: {
      serial:               ['serial', 'text'],
      product:              ['product_id', 'link_product_or_text'],
      company:              ['company_id', 'company'],
      order_item:           ['order_item_id', 'link_order_item'],
      address:              ['address', 'text'],
      manufacture_date:     ['manufacture_date', 'text'],
      last_programmed_date: ['last_programmed_date', 'text'],
      manufacture_value:    ['manufacture_value', 'floatClean0'],
      status:               ['status', 'text'],
      notes:                ['notes', 'text'],
    },
    // Un record sans numéro de série n'est pas un sériau — le legacy le saute.
    require: ['serial'],
  },
  billets: {
    // Plan cœur VIDE : les 9 colonnes alimentées en code du miroir billets
    // (title, description, response, type, status, company_id, contact_id,
    // duration_minutes, created_at) ont été droppées (migration 040, « supprime
    // tous les champs codés en dur »). Le mapping champ-à-champ du module vit
    // maintenant ENTIÈREMENT dans /champs/tickets (defs dynamiques). Le plan
    // reste déclaré pour que `usesMirrorEngine('billets')` continue de répondre
    // vrai — le moteur unique garde la main sur le module.
    //
    // `require` tombe avec lui : il exigeait un titre, qui n'existe plus. Tout
    // record de la table Airtable a donc désormais sa ligne côté ERP.
    fields: {},
  },
  soumissions: {
    fields: {
      project:            ['project_id', 'link_project'],
      quote_url:          ['quote_url', 'text'],
      pdf:                ['pdf_url', 'attachment_url'],
      purchase_price:     ['purchase_price', 'floatClean0'],
      subscription_price: ['subscription_price', 'floatClean0'],
      expiration_date:    ['expiration_date', 'text'],
    },
    derive: (fields, rec, fieldMap, { values = {} } = {}) => {
      const pays = values.project_id ? (soumissionPaysStmt().get(values.project_id)?.pays || null) : null
      return { currency: currencyFromCountry(pays) }
    },
    // Une soumission qui change fait bouger la valeur du projet — le montant
    // affiché dans le pipeline. Le recalcul lit le taux de la Banque du Canada,
    // donc il vit hors de la transaction, comme dans la fonction historique.
    finalize: async ({ records }) => {
      const ids = records.map(r => r.id)
      const projectIds = new Set()
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500)
        const rows = db.prepare(
          `SELECT DISTINCT project_id FROM soumissions WHERE project_id IS NOT NULL AND airtable_id IN (${chunk.map(() => '?').join(',')})`
        ).all(...chunk)
        for (const r of rows) projectIds.add(r.project_id)
      }
      if (!projectIds.size) return
      const { recomputeProjectValeurCad } = await import('./projectValeur.js')
      let ok = 0
      for (const pid of projectIds) {
        try { await recomputeProjectValeurCad(pid); ok++ } catch (e) { console.error('[valeur_cad_calc]', pid, e.message) }
      }
      console.log(`💱 valeur_cad_calc: ${ok}/${projectIds.size} projets recalculés`)
    },
  },
  instagram: {
    fields: {
      follow_up_status: ['follow_up_status', 'text'],
      notes:            ['notes', 'text'],
    },
    updateOnly: true,
    // Une fiche à la corbeille n'est plus une cible : la réanimer par un sync
    // ferait réapparaître un prospect que l'utilisateur a écarté.
    existingScope: 'deleted_at IS NULL',
    derive: instagramDerive,
    // La fonction historique ne fait NI champs dynamiques NI règles de champ
    // sur ce module : les 20 autres colonnes sont poussées par l'ERP, les
    // réimporter reviendrait à laisser Airtable écraser la source de vérité.
    noDynamicFields: true,
    noFieldRules: true,
  },
  paies: {
    fields: {
      number:                     ['number', 'empNum'],
      period_end:                 ['period_end', 'text'],
      status:                     ['status', 'text'],
      nb_holiday_days:            ['nb_holiday_days', 'empNum'],
      timesheets_deadline:        ['timesheets_deadline', 'text'],
      includes_hourly:            ['includes_hourly', 'empBool'],
      includes_mileage:           ['includes_mileage', 'empBool'],
      includes_expense_reimb:     ['includes_expense_reimb', 'empBool'],
      includes_paid_leave:        ['includes_paid_leave', 'empBool'],
      includes_holiday_hours:     ['includes_holiday_hours', 'empBool'],
      includes_sales_commissions: ['includes_sales_commissions', 'empBool'],
      timesheets_sent:            ['timesheets_sent', 'empBool'],
    },
    // Plus de field_map « cœur » en base : chaque clé se branche sur son champ
    // Airtable dans /champs/paies (cf. retirePaiesCoreFieldMap).
    uiFieldMapPlan: PAIES_FIELD_MAP_PLAN,
    derive: paiesDerive,
    // La paie n'a pas de champs dynamiques : ses colonnes sont toutes connues,
    // et la fonction historique n'en importe aucun.
    noDynamicFields: true,
  },
  paie_items: {
    fields: {
      paie_link:       ['paie_id', 'link_paie'],
      employee_link:   ['employee_id', 'link_employee'],
      start_date:      ['start_date', 'text'],
      hourly_rate:     ['hourly_rate', 'empNum'],
      regular_hours:   ['regular_hours', 'empNum'],
      holiday_hours:   ['holiday_hours', 'empNum'],
      vacation:        ['vacation', 'empNum'],
      commission:      ['commission', 'empNum'],
      expense_reimb:   ['expense_reimb', 'empNum'],
      rsde_pct:        ['rsde_pct', 'empNum'],
      insurance_gains: ['insurance_gains', 'empNum'],
      holiday_1_20:    ['holiday_1_20', 'empNum'],
      paid_leave:      ['paid_leave', 'text'],
      notes:           ['notes', 'text'],
      total_pay:       ['total_pay', 'empNum'],
      debited_date:    ['debited_date', 'text'],
    },
    // Les deux identifiants Airtable bruts viennent des mêmes champs que les
    // clés étrangères — une clé du field_map, deux colonnes.
    derive: (fields, rec, fieldMap) => ({
      paie_airtable_id: firstLinked(fields, fieldMap?.paie_link),
      employee_airtable_id: firstLinked(fields, fieldMap?.employee_link),
    }),
    noDynamicFields: true,
    noFieldRules: true,
  },
  employees: {
    // Plus de field_map « cœur » : le mapping des employés se règle dans
    // /champs/employees, où chacun de ces champs est maintenant un champ
    // personnalisé (cf. nativeFieldConversions.js).
    uiFieldMapPlan: EMPLOYEES_FIELD_MAP_PLAN,
    fields: {
      first_name:            ['first_name', 'text'],
      last_name:             ['last_name', 'text'],
      email_work:            ['email_work', 'text'],
      email_personal:        ['email_personal', 'text'],
      phone_work:            ['phone_work', 'text'],
      phone_personal:        ['phone_personal', 'text'],
      birth_date:            ['birth_date', 'text'],
      hire_date:             ['hire_date', 'text'],
      matricule:             ['matricule', 'text'],
      active:                ['active', 'empBool'],
      gender:                ['gender', 'text'],
      address:               ['address', 'text'],
      emergency_contact:     ['emergency_contact', 'text'],
      end_date:              ['end_date', 'text'],
      office_key:            ['office_key', 'empBool'],
      insurance_id:          ['insurance_id', 'text'],
      nethris_username:      ['nethris_username', 'text'],
      is_salesperson:        ['is_salesperson', 'empBool'],
      is_consultant:         ['is_consultant', 'empBool'],
      accounting_department: ['accounting_department', 'text'],
      hours_per_week:        ['hours_per_week', 'empNum'],
      last_raise_date:       ['last_raise_date', 'text'],
      group_insurance:       ['group_insurance', 'empBool'],
      address_verified:      ['address_verified', 'empBool'],
      banking_info:          ['banking_info', 'text'],
      issues:                ['issues', 'text'],
      peer_reviews:          ['peer_reviews', 'text'],
    },
    // Un record sans aucun nom n'est pas un employé.
    requireAny: ['first_name', 'last_name'],
    // Les deux colonnes de nom sont NOT NULL côté ERP : vide, pas NULL.
    defaults: { first_name: '', last_name: '' },
    // Champs dynamiques ACTIFS : la table est mappable depuis /champs/employees
    // (cf. AIRTABLE_FIELD_MODULES), donc les champs ajoutés là — la photo, par
    // exemple — doivent s'importer comme partout ailleurs.
  },
  pieces: {
    // Plus de field_map « cœur » : les 17 clés se règlent dans /champs/products
    // (cf. retirePiecesCoreFieldMap). Les clés, les transformations et `derive`
    // sont inchangés — seule la provenance des NOMS de champs Airtable change.
    uiFieldMapPlan: PIECES_FIELD_MAP_PLAN,
    fields: {
      name_fr:                 ['name_fr', 'text'],
      name_en:                 ['name_en', 'text'],
      sku:                     ['sku', 'text'],
      type:                    ['type', 'text'],
      unit_cost:               ['unit_cost', 'floatClean0'],
      price_cad:               ['price_cad', 'floatClean0'],
      stock_qty:               ['stock_qty', 'intClean0'],
      min_stock:               ['min_stock', 'intClean0'],
      supplier:                ['supplier', 'text'],
      weight_lbs:              ['weight_lbs', 'floatClean0'],
      assembly_status:         ['assembly_status', 'floatCleanNull'],
      finished_min_stock:      ['finished_min_stock', 'intCleanNull'],
      projected_available_qty: ['projected_available_qty', 'intCleanNull'],
      producible_qty:          ['producible_qty', 'intCleanNull'],
      supplier_link:           ['supplier_link', 'text'],
    },
    // Un record sans nom français n'est pas un produit.
    require: ['name_fr'],
    prepare: piecesPrepareImages,
    derive: (fields, rec, fieldMap, { ctx = {} } = {}) => {
      // Le type d'approvisionnement d'Airtable est du texte libre : seules trois
      // valeurs ont un sens ici, le reste vaut « non renseigné ».
      const raw = getVal(fields, fieldMap?.procurement_type) || ''
      return {
        procurement_type: PROCUREMENT_TYPES.find(p => p.toLowerCase() === raw.toLowerCase()) || null,
        image_url: ctx.imageUrl?.[rec.id] || null,
      }
    },
    // Pas d'image dans ce record ne veut pas dire « efface l'image » : le
    // legacy garde la précédente (COALESCE).
    keepIfNull: ['image_url'],
  },
  orders: {
    // Plus de field_map « cœur » : le mapping des commandes se règle dans
    // /champs/orders (cf. retireOrdersCoreFieldMap).
    uiFieldMapPlan: ORDERS_FIELD_MAP_PLAN,
    fields: {
      company:  ['company_id', 'company'],
      project:  ['project_id', 'link_project_or_text'],
      priority: ['priority', 'text'],
      notes:    ['notes', 'text'],
      address:  ['address_id', 'link_address'],
    },
    // « Adresse de livraison » n'est pas mappée aujourd'hui, donc la colonne
    // n'est pas touchée. Si elle l'était un jour, un record sans adresse ne
    // doit pas effacer celle qui est posée côté ERP.
    keepIfNull: ['address_id'],
    // Deux colonnes traduites à l'import. Chacune n'est calculée QUE si sa clé
    // est mappée : depuis que le mapping vit dans /champs/orders, l'utilisateur
    // peut démapper « Statut » ou « Abonnement » — un `derive` inconditionnel
    // remettrait alors toutes les commandes à « Commande vide » / « Achat ».
    derive: (fields, rec, fieldMap) => {
      const out = {}
      if (fieldMap?.status) {
        const rawStatus = (getVal(fields, fieldMap.status) || '').trim()
        // Toute valeur inconnue retombe sur « Commande vide » — c'est le legacy,
        // et c'est aussi ce que dit la contrainte CHECK de la colonne.
        out.status = ORDER_STATUS_MAP[rawStatus.toLowerCase()] || 'Commande vide'
      }
      if (fieldMap?.is_subscription) {
        const rawSub = fields[fieldMap.is_subscription]
        out.is_subscription = rawSub === true || rawSub === 'Oui' || rawSub === 'oui' || rawSub === 1 ? 1 : 0
      }
      return out
    },
    // Le numéro de commande : celui d'Airtable s'il est lisible, sinon le
    // suivant dans la série ERP. Posé à la création, jamais réécrit.
    insertExtras: (rec, fieldMap) => {
      const raw = fieldMap?.order_number
        ? parseInt(String(rec.fields[fieldMap.order_number] ?? '').replace(/[^0-9]/g, ''), 10)
        : NaN
      const next = () => (db.prepare('SELECT MAX(order_number) AS m FROM orders').get()?.m || 0) + 1
      return { order_number: isNaN(raw) || raw === 0 ? next() : raw }
    },
    prepare: async () => ({ touched: [] }),
    onWrite: (outcome, id, ctx) => { ctx.touched?.push(id) },
    // Constat de vente : pour chaque commande RÉELLEMENT modifiée, tenter la
    // JE Dr 23900|AR / Cr 40000 sur ses factures. `reconcileFacturesForOrder`
    // est idempotent et filtre lui-même (pas d'envoi lié, déjà constatée,
    // abonnement, payout Stripe en attente). Le legacy le lançait pour les
    // 1 159 commandes à chaque sync ; ici, seulement pour celles qui ont bougé.
    finalize: async ({ ctx }) => {
      const ids = ctx?.touched || []
      if (!ids.length) return
      const { reconcileFacturesForOrder } = await import('./quickbooks.js')
      const { logSystemRun } = await import('./systemAutomations.js')
      for (const orderId of ids) {
        try {
          const r = await reconcileFacturesForOrder(orderId)
          if (r.recognized.length || r.errors.length) {
            logSystemRun('sys_revenue_recognition', {
              status: r.errors.length ? 'error' : 'success',
              result: [
                `Commande ${orderId} (sync Airtable)`,
                `Constatées : ${r.recognized.length}`,
                `Skip : ${r.skipped.length}`,
                r.errors.length ? `Erreurs : ${r.errors.map(e => `${e.facture_id}: ${e.error}`).join(' | ')}` : null,
              ].filter(Boolean).join('\n'),
              error: r.errors.length ? r.errors.map(e => e.error).join(' | ') : undefined,
              triggerData: { order_id: orderId, source: 'airtable_sync' },
            })
          }
        } catch (e) {
          console.error('reconcileFacturesForOrder (sync Airtable):', e.message)
          logSystemRun('sys_revenue_recognition', {
            status: 'error', error: e.message,
            triggerData: { order_id: orderId, source: 'airtable_sync' },
          })
        }
      }
    },
  },
  order_items: {
    fields: {
      order:     ['order_id', 'link_order'],
      product:   ['product_id', 'link_product_order_item'],
      qty:       ['qty', 'qtyInt1'],
      notes:     ['notes', 'text'],
    },
    // Un item dont la commande n'est pas (encore) importée est sauté :
    // `order_items.order_id` est NOT NULL.
    require: ['order_id'],
    derive: (fields, rec, fieldMap) => {
      const raw = (getVal(fields, fieldMap?.item_type) || '').trim()
      return { item_type: ITEM_TYPES.find(t => t.toLowerCase() === raw.toLowerCase()) || 'Facturable' }
    },
    // Coût unitaire au moment de l'envoi : Airtable ne donne que le TOTAL gelé,
    // l'ERP en a besoin à l'unité. Rattrapage après coup, une seule fois par
    // ligne (la colonne ne se recalcule jamais).
    finalize: async () => {
      db.prepare(`
        UPDATE order_items SET shipped_unit_cost = CAST(cout_total_au_moment_de_l_envoi AS REAL) / MAX(qty, 1)
        WHERE shipped_unit_cost IS NULL
          AND cout_total_au_moment_de_l_envoi IS NOT NULL
          AND CAST(cout_total_au_moment_de_l_envoi AS REAL) > 0
      `).run()
    },
  },
  projets: {
    // Plus de field_map « cœur » : les 2 champs qui restaient annoncés « gérés
    // en code » au bas de /champs/projects (« ID » → le numéro de projet,
    // « Client final » → l'entreprise liée) s'y règlent maintenant champ par
    // champ (cf. retireProjetsCoreFieldMap).
    uiFieldMapPlan: PROJETS_FIELD_MAP_PLAN,
    fields: {
      name:           ['name', 'text'],
      company:        ['company_id', 'company'],
      value_cad:      ['value_cad', 'floatCleanNull'],
      monthly_cad:    ['monthly_cad', 'floatCleanNull'],
      nb_greenhouses: ['nb_greenhouses', 'intCleanNull'],
      close_date:     ['close_date', 'text'],
      notes:          ['notes', 'text'],
    },
    // Un record sans nom n'est pas un projet.
    require: ['name'],
    // « Client final » est vide sur une partie des projets Airtable : ne pas
    // résoudre l'entreprise ne veut pas dire « efface celle qui est là », y
    // compris celle saisie à la main dans l'ERP. Le déliage se fait depuis Boréal.
    keepIfNull: ['company_id'],
    prepare: projetsPrepareCompanies,
    derive: projetsDerive,
  },
  companies: {
    // Plus de field_map « cœur » : les 2 champs qui restaient annoncés « gérés
    // en code » au bas de /champs/companies (« Entreprise » → le nom,
    // « Phase du cycle de vie ») s'y règlent maintenant champ par champ
    // (cf. retireCompaniesCoreFieldMap).
    uiFieldMapPlan: COMPANIES_FIELD_MAP_PLAN,
    // `phone` (« Phone number ») et `website` (« URL ») sont sortis du plan :
    // colonnes droppées (migration 045), les deux champs Airtable se remappent
    // depuis /champs/companies.
    fields: {
      name:     ['name', 'text'],
      email:    ['email', 'text'],
      address:  ['address', 'text'],
      city:     ['city', 'text'],
      province: ['province', 'text'],
      country:  ['country', 'text'],
      notes:    ['notes', 'text'],
    },
    // Un record sans nom n'est pas une entreprise.
    require: ['name'],
    keepIfNull: COMPANY_SOFT_COLUMNS,
    // La phase du cycle de vie n'a plus de table de correspondance en base
    // (`phase_choices` est partie avec le field_map cœur) : on garde
    // l'orthographe canonique de l'ERP à la casse près — la seule traduction
    // que faisait cette table — et toute valeur inconnue passe telle quelle.
    // Écrite ici plutôt que dans `fields` car la colonne n'est renseignée que
    // si le champ est mappé (un `null` effacerait la phase saisie dans Boréal).
    // (« Type » a suivi sa colonne dans la migration 045.)
    derive: (fields, rec, fieldMap) => {
      if (!fieldMap?.lifecycle_phase) return {}
      const raw = getVal(fields, fieldMap.lifecycle_phase)
      if (!raw) return { lifecycle_phase: null }
      const canon = COMPANY_PHASES.find(p => p.toLowerCase() === String(raw).trim().toLowerCase())
      return { lifecycle_phase: canon || raw }
    },
    // Les champs dynamiques du CRM sont rangés sous 'airtable_companies' depuis
    // toujours : changer la clé recréerait tous les mappings à côté.
    dynamicFieldsKey: 'airtable_companies',
  },
  contacts: {
    // Plus de field_map « cœur » : les 6 champs qui étaient annoncés « gérés en
    // code » au bas de /champs/contacts (Prénom, Nom, Email, Phone number,
    // Entreprise, Langue) s'y règlent maintenant champ par champ
    // (cf. retireContactsCoreFieldMap).
    uiFieldMapPlan: CONTACTS_FIELD_MAP_PLAN,
    fields: {
      first_name: ['first_name', 'text'],
      email:      ['email', 'text'],
      phone:      ['phone', 'text'],
      mobile:     ['mobile', 'text'],
      company:    ['company_id', 'company'],
      notes:      ['notes', 'text'],
    },
    // Mobile et notes se complètent, ne s'effacent pas (COALESCE historique).
    // `company_id`, lui, suit Airtable : délier là-bas délie ici.
    keepIfNull: ['mobile', 'notes'],
    // Chaque colonne dérivée n'est calculée QUE si sa clé est mappée — depuis
    // que le mapping est démappable dans l'interface, un calcul inconditionnel
    // écraserait les 3 800 fiches au premier sync suivant (le `defaults`
    // `first_name: ''` de la version précédente les aurait toutes vidées, et
    // « Nom » démappé les aurait toutes renommées « Inconnu » — même piège que
    // le `derive` des commandes).
    derive: (fields, rec, fieldMap, { values }) => {
      const out = {}
      // `first_name` est NOT NULL côté ERP : un champ Airtable vide donne null,
      // qu'on ramène à la chaîne vide — comportement du `defaults` historique.
      if (fieldMap?.first_name && values.first_name == null) out.first_name = ''
      // Le nom de famille est obligatoire côté ERP : à défaut, le prénom, et en
      // dernier recours « Inconnu » — mieux qu'une fiche sans nom du tout.
      if (fieldMap?.last_name || fieldMap?.first_name) {
        out.last_name = getVal(fields, fieldMap?.last_name) || getVal(fields, fieldMap?.first_name) || 'Inconnu'
      }
      if (fieldMap?.language) {
        const rawLang = (getVal(fields, fieldMap.language) || '').trim()
        out.language = rawLang === 'French' || rawLang === 'Français' || rawLang === 'francais' ? 'French'
          : rawLang === 'English' || rawLang === 'Anglais' || rawLang === 'anglais' ? 'English'
          : null
      }
      return out
    },
    // Prénom et Nom sont NOT NULL : un contact CRÉÉ par le sync alors que ces
    // champs ne sont plus mappés ferait échouer l'INSERT, et l'exception
    // emporterait tout le sync. Repli posé à la création SEULEMENT — les fiches
    // existantes ne sont jamais réécrites par ce chemin. Les colonnes déjà
    // calculées par le plan ne sont pas répétées (l'INSERT les listerait deux
    // fois).
    insertExtras: (rec, fieldMap) => {
      const out = {}
      if (!fieldMap?.first_name) out.first_name = ''
      if (!fieldMap?.last_name && !fieldMap?.first_name) out.last_name = 'Inconnu'
      return out
    },
    dynamicFieldsKey: 'airtable_contacts',
  },
  achats: {
    // Plan cœur VIDE : les 7 dernières colonnes natives du miroir achats ont été
    // droppées (migration 035, « supprime tous les champs Airtable gérés en code
    // définitivement »). Le mapping champ-à-champ du module vit maintenant
    // ENTIÈREMENT dans /champs/purchases (defs dynamiques). Le plan reste
    // déclaré pour que `usesMirrorEngine('achats')` continue de répondre vrai —
    // le moteur unique garde la main sur le module, avec son `prepare`/`derive`.
    fields: {},
    // Les deux colonnes de fournisseur ne se déduisent pas d'un champ unique :
    // elles viennent d'un record lié d'une AUTRE table Airtable — voir
    // achatsDerive.
    prepare: achatsPrepareVendors,
    derive: achatsDerive,
  },
  // Catalogue des fournitures (bureau, entretien, emballage). Mapping cœur
  // réglable dans /champs (CORE_FIELD_SPECS), plus les champs Airtable
  // supplémentaires qu'on y branche (champs dynamiques). Pas de règles de champ.
  fournitures: {
    fields: {
      name:            ['name', 'text'],
      web_url:         ['web_url', 'text'],
      supplier:        ['supplier', 'text'],
      reference_price: ['reference_price', 'number'],
      unit:            ['unit', 'text'],
      notes:           ['notes', 'text'],
    },
    prepare: (args) => piecesPrepareImages(args, 'fournitures'),
    derive: (fields, rec, fieldMap, { ctx = {} } = {}) => ({ image_url: ctx.imageUrl?.[rec.id] || null }),
    keepIfNull: ['image_url'],
    noFieldRules: true,
  },
  achats_fournitures: {
    fields: {
      purchased_at: ['purchased_at', 'text'],
      fourniture:   ['fourniture_id', 'link_fourniture'],
      qty:          ['qty', 'number'],
      unit_price:   ['unit_price', 'number'],
    },
    // Un achat qui arrive avant sa fourniture (webhook des deux tables, ou
    // rattrapage en parallèle) resterait sans nom : on importe d'abord les
    // fournitures manquantes.
    prepare: async ({ records, fieldMap, dryRun }) => {
      const field = fieldMap?.fourniture
      if (!field || dryRun) return {}
      const exists = db.prepare('SELECT 1 FROM fournitures WHERE airtable_id=? LIMIT 1')
      const missing = new Set()
      for (const rec of records) {
        for (const v of rec.fields?.[field] || []) if (typeof v === 'string' && !exists.get(v)) missing.add(v)
      }
      if (!missing.size) return {}
      const tableId = db.prepare("SELECT table_id FROM airtable_module_config WHERE module='fournitures'").get()?.table_id
      if (tableId) {
        await syncMirror('fournitures', {
          [tableId]: { recordIds: [...missing], destroyedIds: [], changedFieldIds: [], hasCreates: false },
        })
      }
      return {}
    },
    noFieldRules: true,
  },
}

const nowExpr = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

const mirrorSeedById = new Map(MIRROR_SEED.map(m => [m.id, m]))

// ── Purge des orphelins, tolérante aux références ───────────────────────────
//
// Un « orphelin » est une ligne ERP dont le jumeau Airtable a disparu. La
// version partagée (`purgeOrphans` de services/airtable.js) les supprime en
// boucle, hors transaction : la PREMIÈRE suppression qu'une clé étrangère
// bloque lève une exception, ce qui interrompt la boucle ET tout ce qui suivait
// dans le sync. Constaté le 2026-09-02 sur les adresses : deux adresses avaient
// disparu d'Airtable en restant référencées par un envoi ou une commande, donc
// chaque sync complet des adresses mourait sur « FOREIGN KEY constraint
// failed » — avalé par le catch du module, et les champs dynamiques n'étaient
// jamais rafraîchis.
//
// Le bon comportement n'est ni de supprimer (ça casserait le référent) ni de
// planter : c'est de SIGNALER. Une ligne encore référencée dont l'original a
// disparu demande une décision humaine, pas une suppression silencieuse.
function purgeOrphansTolerant(table, records) {
  const airtableIds = new Set(records.map(r => r.id))
  const rows = db.prepare(`SELECT id, airtable_id FROM ${table} WHERE airtable_id IS NOT NULL`).all()
  const toDelete = rows.filter(r => !airtableIds.has(r.airtable_id))
  if (!toDelete.length) return { purged: 0, blocked: [] }

  const del = db.prepare(`DELETE FROM ${table} WHERE id=?`)
  let purged = 0
  const blocked = []
  for (const row of toDelete) {
    try {
      del.run(row.id)
      purged++
    } catch (e) {
      // Une contrainte de clé étrangère, et rien d'autre : toute autre erreur
      // est anormale et doit remonter.
      if (!/FOREIGN KEY constraint failed/i.test(e.message)) throw e
      blocked.push(row.airtable_id)
    }
  }
  if (purged) console.log(`🧹 ${table}: ${purged} orphelin(s) purgé(s)`)
  if (blocked.length) {
    console.warn(`⚠️  ${table}: ${blocked.length} orphelin(s) NON supprimé(s) — encore référencé(s) ailleurs : ${blocked.slice(0, 5).join(', ')}`)
  }
  return { purged, blocked }
}

// ── Écriture différentielle ─────────────────────────────────────────────────

// Mémoïsé : le schéma ne change pas en cours d'exécution, et un PRAGMA par
// record coûterait plus cher que l'UPDATE lui-même.
const updatedAtCache = new Map()
function hasUpdatedAt(table) {
  if (!updatedAtCache.has(table)) {
    updatedAtCache.set(table, db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === 'updated_at'))
  }
  return updatedAtCache.get(table)
}

/**
 * INSERT, UPDATE différentiel, ou rien du tout.
 * Retourne 'imported' | 'updated' | 'unchanged'.
 *
 * Le troisième cas est la raison d'être de cette fonction : c'est lui qui
 * supprime le trafic fantôme. Un record dont aucune valeur n'a bougé ne
 * déclenche aucun trigger change_log, donc aucun delta renvoyé aux navigateurs.
 */
function differentialUpsert(table, airtableId, values, { dryRun = false, insertOnly = false, updateOnly = false, existingScope = null, keepIfNull = [], frozen = null, insertExtras = null, onWrite = null } = {}) {
  const columns = Object.keys(values)
  // `existingScope` restreint ce qui compte comme « la ligne jumelle » : les
  // prospects Instagram ne reconnaissent que les fiches vivantes, une fiche à
  // la corbeille ne doit pas se faire réanimer par un sync.
  const scope = existingScope ? ` AND ${existingScope}` : ''
  const select = columns.length ? `id, ${columns.map(c => `"${c}"`).join(', ')}` : 'id'
  const existing = db.prepare(`SELECT ${select} FROM ${table} WHERE airtable_id=?${scope}`).get(airtableId)

  // Miroir en lecture de suivi seulement : Airtable peut modifier une fiche
  // existante, jamais en créer une. Voir le plan `instagram`.
  if (!existing && updateOnly) return 'no_target'

  if (!existing) {
    if (!dryRun) {
      // `insertExtras` : colonnes posées à la CRÉATION seulement — le numéro de
      // commande s'attribue une fois et ne se recalcule jamais ensuite.
      const extras = insertExtras ? insertExtras() : null
      const extraCols = extras ? Object.keys(extras) : []
      const allCols = ['id', 'airtable_id', ...columns, ...extraCols]
      const newId = newRecordId()
      db.prepare(`INSERT INTO ${table} (${allCols.map(c => `"${c}"`).join(',')}) VALUES (${allCols.map(() => '?').join(',')})`)
        .run(newId, airtableId, ...columns.map(c => values[c] ?? null), ...extraCols.map(c => extras[c] ?? null))
      onWrite?.('imported', newId, null)
    }
    return 'imported'
  }

  // Journal append-only : la ligne existe, on n'y touche pas.
  if (insertOnly) return 'unchanged'

  // `keepIfNull` : une colonne dont la nouvelle valeur est vide n'est pas
  // effacée (le `COALESCE(@x, x)` des paies). Le début de période ne se lit que
  // sur certains records ; l'absence d'information n'est pas une information.
  // Colonne GELÉE : l'utilisateur a dit « Airtable ne réécrit pas celle-ci ».
  // Le gel ne vaut qu'à la mise à jour — à la création il n'y a rien à protéger.
  let writable = frozen?.size ? columns.filter(c => !frozen.has(c)) : columns
  if (keepIfNull.length) {
    writable = writable.filter(c => !(keepIfNull.includes(c) && (values[c] === null || values[c] === undefined)))
  }
  const changed = writable.filter(c => !sameStored(existing[c], values[c] ?? null))
  if (!changed.length) return 'unchanged'

  if (!dryRun) {
    // Toutes les tables mirroirées n'ont pas d'`updated_at` (return_items n'en a
    // pas), et l'y ajouter d'office ferait échouer l'UPDATE sur « no such
    // column ». On horodate là où la colonne existe, c'est tout.
    const stamp = hasUpdatedAt(table) ? `, updated_at=${nowExpr}` : ''
    db.prepare(`UPDATE ${table} SET ${changed.map(c => `"${c}"=?`).join(', ')}${stamp} WHERE id=?`)
      .run(...changed.map(c => values[c] ?? null), existing.id)
    // Les colonnes RÉELLEMENT écrites : c'est ce qui permet à l'interface de
    // ne surligner que le champ qui a bougé (pastille de mise à jour).
    onWrite?.('updated', existing.id, changed)
  }
  return 'updated'
}

// Au-delà de ce nombre d'écritures dans un même sync, on n'envoie plus de
// messages temps réel : ce n'est plus « quelqu'un a modifié un champ », c'est un
// import. Le cache du navigateur se resynchronise de toute façon au prochain
// delta (10 s).
const LIVE_WRITE_CAP = 60

// ── Le moteur ───────────────────────────────────────────────────────────────

function readMirrorRow(mirrorId) {
  return db.prepare('SELECT * FROM airtable_mirrors WHERE id=?').get(mirrorId)
}

/** Un miroir est-il servi par le moteur unique ? Sert d'aiguillage au routeur. */
export function usesUnifiedEngine(mirrorId) {
  const row = readMirrorRow(mirrorId)
  return row?.engine === 'unified' && !!CORE_PLANS[mirrorId]
}

/**
 * Synchronise un miroir. `changes` non nul = sync incrémental piloté par
 * webhook ({ [tableId]: { recordIds, destroyedIds } }).
 *
 * `dryRun` calcule tout sans écrire une seule ligne : c'est ce qui permet de
 * comparer le moteur à la fonction historique avant de basculer.
 *
 * Retourne un compte-rendu chiffré, dont `unchanged` — l'indicateur qui dit
 * combien d'écritures inutiles le moteur vient d'éviter.
 */
export async function syncMirror(mirrorId, changes = null, { dryRun = false, token = null } = {}) {
  const mirror = readMirrorRow(mirrorId)
  if (!mirror) throw new Error(`Miroir « ${mirrorId} » absent du registre`)
  if (mirror.status !== 'mirrored') {
    return { mirror: mirrorId, skipped: `statut ${mirror.status}` }
  }
  const plan = CORE_PLANS[mirrorId]
  if (!plan) throw new Error(`Miroir « ${mirrorId} » sans plan cœur — bascule impossible`)

  const seed = mirrorSeedById.get(mirrorId)
  if (!seed) throw new Error(`Miroir « ${mirrorId} » absent de MIRROR_SEED`)
  const cfg = resolveLegacyConfig(seed)
  if (!cfg?.baseId || !cfg?.tableId) {
    return { mirror: mirrorId, skipped: 'configuration incomplète' }
  }
  const erpTable = mirror.erp_table
  const report = {
    mirror: mirrorId, erp_table: erpTable, dry_run: dryRun,
    imported: 0, updated: 0, unchanged: 0, deleted: 0, purged: 0, echo_skipped: 0,
    skipped_missing_link: 0, no_target: 0,
  }

  // 2. Records supprimés côté Airtable. Fait AVANT la lecture : un record
  //    détruit ne reviendra pas dans la réponse de l'API.
  // `purge_orphans` du registre décide si Airtable a le droit d'EFFACER ici.
  // Pour les prospects Instagram la réponse est non : une ligne supprimée dans
  // Airtable ne doit pas faire perdre la mémoire du DM déjà envoyé, ce qui
  // rouvrirait la porte à un second contact.
  const airtableMayDelete = mirror.purge_orphans !== 0
  const destroyed = airtableMayDelete ? changes?.[cfg.tableId]?.destroyedIds : null
  if (destroyed?.length && !dryRun) {
    const del = db.prepare(`DELETE FROM ${erpTable} WHERE airtable_id=?`)
    for (const id of destroyed) report.deleted += del.run(id).changes
  } else if (destroyed?.length) {
    report.deleted = destroyed.length
  }

  // 3. Sync incrémental ne concernant aucun record de cette table.
  const recordIds = changes?.[cfg.tableId]?.recordIds
  if (changes && !recordIds?.length) return report

  const accessToken = token || await getAccessToken()

  // 4. Lecture.
  const records = await fetchAllRecords(cfg.baseId, cfg.tableId, accessToken, mirrorId, recordIds || null)
  report.records = records.length

  // 5. Colonnes cœur, en une transaction.
  // Un miroir qui déclare `uiFieldMapPlan` n'a plus de field_map « cœur » en
  // base : son mapping se règle dans /champs/:table et se relit ici sous la
  // même forme (cf. services/airtableUiFieldMap.js). Les clés logiques du plan
  // ci-dessous, les transformations et `derive` ne changent pas — seule la
  // provenance des NOMS de champs Airtable change.
  const fieldMap = plan.uiFieldMapPlan
    ? fieldMapFromUi(erpTable, plan.uiFieldMapPlan)
    : parseFieldMap(cfg.fieldMapRaw)
  const planEntries = Object.entries(plan.fields || {})
  // Clés en écriture SEULE (Boréal → Airtable), calculées une fois pour la
  // passe : le sens d'un module à `uiFieldMapPlan` se lit sur la colonne.
  const pushOnlyKeys = importSkippedCoreKeys(mirrorId, planEntries.map(([k]) => k))
  // Le gel de colonnes est réglé par l'utilisateur dans Connecteurs. Seule la
  // fonction historique des projets le consultait ; ici il vaut pour tous les
  // miroirs — c'est un réglage explicite, pas une préférence par module.
  const frozenColumns = getFrozenColumns(erpTable)

  // Préparation asynchrone du plan (caches d'autres tables Airtable) — avant la
  // transaction, qui est synchrone par construction.
  const ctx = plan.prepare
    ? await plan.prepare({ records, cfg, fieldMap, token: accessToken, changes, dryRun })
    : {}
  // Écritures réelles de ce sync, pour l'émission temps réel APRÈS la
  // transaction : émettre dedans exposerait aux navigateurs un état pas encore
  // validé (et une fiche qui re-fetche verrait l'ancienne valeur).
  const liveWrites = []
  const apply = db.transaction((recs) => {
    for (const rec of recs) {
      // Garde anti-écho : si ce record revient d'une écriture que Boréal vient
      // de pousser vers Airtable, le webhook n'est que le retour de notre propre
      // modification. Historiquement présente dans 4 fonctions sur 20 — ici tous
      // les miroirs en héritent.
      //
      // Jamais en essai à blanc : la garde est à USAGE UNIQUE (elle supprime sa
      // ligne, echo ou pas). Un « à blanc » qui la consommerait ferait rejouer
      // au vrai sync suivant une modification qu'il aurait dû ignorer — un
      // essai sans effet doit être sans effet, y compris sur cet état-là.
      if (!dryRun && consumeWritebackEcho(rec.id, rec.fields)) {
        report.echo_skipped++
        continue
      }
      const values = {}
      for (const [coreKey, [column, transformName]] of planEntries) {
        const airtableField = fieldMap[coreKey]
        if (!airtableField) continue // clé non mappée : on ne touche pas la colonne
        // Champ que l'utilisateur a mis en écriture SEULE (ERP → Airtable) :
        // le réimporter écraserait la valeur qu'on vient de pousser. Le legacy
        // ne consulte ce réglage que dans un module sur vingt ; ici il vaut
        // pour tous, ce qui est le seul comportement défendable — l'utilisateur
        // a dit « Airtable ne décide pas de cette colonne ».
        if (pushOnlyKeys.has(coreKey)) continue
        const transform = TRANSFORMS[transformName]
        if (!transform) throw new Error(`Transformation « ${transformName} » inconnue (${mirrorId}.${coreKey})`)
        values[column] = transform(rec.fields, airtableField, rec)
      }

      // Colonnes dérivées : après les champs, donc elles peuvent en écraser une.
      if (plan.derive) Object.assign(values, plan.derive(rec.fields, rec, fieldMap, { values, ctx }))

      // Gardes de record. Un record qui ne résout pas ses rattachements
      // obligatoires est SAUTÉ, pas écrit à moitié — c'est le comportement des
      // fonctions historiques, et il évite de violer une contrainte NOT NULL.
      if (plan.require?.some(c => values[c] === null || values[c] === undefined)) {
        report.skipped_missing_link++
        continue
      }
      if (plan.requireAny?.length && plan.requireAny.every(c => values[c] === null || values[c] === undefined)) {
        report.skipped_missing_link++
        continue
      }

      // Repli par colonne, après les gardes — sinon un défaut ferait passer un
      // record que la garde devait écarter.
      if (plan.defaults) {
        for (const [column, fallback] of Object.entries(plan.defaults)) {
          if (values[column] === null || values[column] === undefined) values[column] = fallback
        }
      }

      const outcome = differentialUpsert(erpTable, rec.id, values, {
        dryRun,
        insertOnly: !!plan.insertOnly,
        updateOnly: !!plan.updateOnly,
        existingScope: plan.existingScope || null,
        keepIfNull: plan.keepIfNull || [],
        frozen: frozenColumns,
        insertExtras: plan.insertExtras ? () => plan.insertExtras(rec, fieldMap) : null,
        // `onWrite` n'est appelé que sur une écriture RÉELLE — c'est là toute la
        // différence avec le legacy, qui poussait un message temps réel par
        // record traité (1 159 messages par sync des commandes, dont la quasi-
        // totalité pour une ligne inchangée). Il reçoit AUSSI les colonnes
        // modifiées : sans elles, l'interface ne saurait pas quel champ vient
        // d'être mis à jour par Airtable.
        onWrite: (o, id, changed) => {
          liveWrites.push({ outcome: o, id, changed })
          plan.onWrite?.(o, id, ctx)
        },
      })
      report[outcome]++
    }
  })
  apply(records)

  // 5b. Temps réel. Une modification faite dans Airtable doit apparaître dans
  //     Boréal sans rafraîchir la page — et sur le bon champ (pastille
  //     « mis à jour par une API »). Au-delà de LIVE_WRITE_CAP écritures (gros
  //     import, premier sync), on se tait : le delta poll du cache client
  //     rattrapera en quelques secondes, alors qu'un millier de messages
  //     ferait clignoter toute l'interface.
  if (!dryRun && liveWrites.length && liveWrites.length <= LIVE_WRITE_CAP) {
    for (const w of liveWrites) {
      try { emitMirrorWrite(erpTable, w.outcome, w.id, w.changed) }
      catch (e) { console.error(`realtime ${mirrorId}: ${e.message}`) }
    }
  }

  if (!dryRun) {
    // 6. Horodatage. Le registre ET la config historique, tant que les deux
    //    coexistent — sinon la page Connecteurs afficherait un sync périmé.
    db.prepare(`UPDATE airtable_mirrors SET last_synced_at=${nowExpr}, updated_at=${nowExpr} WHERE id=?`).run(mirrorId)
    if (seed.module) {
      db.prepare(`UPDATE airtable_module_config SET last_synced_at=${nowExpr} WHERE module=?`).run(seed.module)
    }

    // 7 et 8. Étapes d'après, chacune ISOLÉE. Les fonctions historiques
    //    enveloppaient tout dans un seul try/catch : la purge des orphelins qui
    //    échouait emportait le rafraîchissement des champs dynamiques et les
    //    règles de champ, sans que rien ne le dise. Ici chaque étape rate pour
    //    son propre compte, et son échec est rapporté au lieu d'être avalé.
    report.step_errors = []
    const step = async (name, fn) => {
      try { return await fn() }
      catch (e) {
        report.step_errors.push({ step: name, error: e.message })
        console.error(`❌ ${mirrorId}/${name}: ${e.message}`)
        return null
      }
    }

    if (!changes && airtableMayDelete) {
      const purge = await step('purge-orphelins', () => purgeOrphansTolerant(erpTable, records))
      if (purge) { report.purged = purge.purged; report.purge_blocked = purge.blocked }
    }
    if (!plan.noDynamicFields) {
      if (!changes) {
        // Réutilise les helpers existants : leur logique est déjà générique, la
        // réécrire n'apporterait qu'un risque de divergence.
        await step('champs-dynamiques', () =>
          syncDynamicFields(plan.dynamicFieldsKey || mirrorId, erpTable, cfg.baseId, cfg.tableId, fieldMap, records))
      } else {
        await step('champs-dynamiques', () => updateDynamicFields(erpTable, fieldMap, records))
      }
    }

    if (!plan.noFieldRules) {
      await step('regles-de-champ', () =>
        evaluateFieldRules({ erpTable, tableId: cfg.tableId, changes }))
    }

    if (plan.finalize) {
      await step('finalize', () => plan.finalize({ records, report, changes, ctx, fieldMap }))
    }
  }

  const skipped = report.unchanged ? `, ${report.unchanged} inchangés (aucune écriture)` : ''
  const echo = report.echo_skipped ? `, ${report.echo_skipped} échos ignorés` : ''
  const noLink = report.skipped_missing_link ? `, ${report.skipped_missing_link} sautés (rattachement manquant)` : ''
  const noTarget = report.no_target ? `, ${report.no_target} sans fiche ERP (ignorés)` : ''
  console.log(`⚙️  ${mirrorId}${dryRun ? ' [à blanc]' : ''}: ${report.imported} importés, ${report.updated} mis à jour${skipped}${echo}${noLink}${noTarget}`)
  return report
}

// Miroirs nés sur le moteur unique : aucune fonction historique derrière eux.
// Cette carte tient la place de LEGACY_SYNCS pour les trois appelants (webhook,
// rattrapage quotidien, bouton « Synchro »).
export const ENGINE_ONLY_SYNCS = {
  fournitures: (changes) => syncMirror('fournitures', changes),
  achats_fournitures: (changes) => syncMirror('achats_fournitures', changes),
}

// ── Aiguillage ──────────────────────────────────────────────────────────────

/**
 * Route un module vers le moteur unique ou vers sa fonction historique, selon
 * `airtable_mirrors.engine`. Un seul point de décision, utilisé par les DEUX
 * appelants (le routeur de webhooks et le sync planifié) — deux copies de cette
 * condition finiraient par ne plus dire la même chose.
 *
 * Le drapeau est relu à chaque appel : basculer un miroir, ou le ramener à
 * 'legacy' pour annuler, prend effet immédiatement, sans redémarrage.
 */
export async function routeSync(mirrorId, changes, legacyFn) {
  const out = usesUnifiedEngine(mirrorId) ? await syncMirror(mirrorId, changes) : await legacyFn(changes)
  // Les achats créés à l'instant arrivent sans leur code LIA (formule Airtable pas
  // encore calculée au moment du webhook). On le récupère tout de suite après le
  // sync — sans quoi l'achat reste invisible du rattachement des factures.
  if (mirrorId === 'achats') {
    try {
      const { healMissingLiaCodes } = await import('./purchaseLiaCodeHeal.js')
      await healMissingLiaCodes()
    } catch (e) { console.warn(`Achats : récupération des codes LIA impossible (${e.message})`) }
  }
  return out
}

// Exposé UNIQUEMENT pour les tests. Les deux comportements que le moteur
// apporte — écriture différentielle et purge tolérante — sont ceux qui
// « marchent » en apparence même cassés : un upsert qui réécrit tout donne le
// bon résultat, une purge qui plante est avalée par un catch. Les tester à
// travers `syncMirror()` demanderait le réseau et une vraie base Airtable ; les
// exposer ici les rend éprouvables directement.
export const __test = { differentialUpsert, purgeOrphansTolerant, sameStored }
