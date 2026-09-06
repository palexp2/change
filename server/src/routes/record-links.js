import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import {
  resolveRecordKeys, searchRecords, RESOLVABLE_TABLES, LINKABLE_TABLES, MAX_KEYS,
} from '../services/recordLinks.js'

const router = Router()

// GET /api/record-links?keys=<id|recXXX,...>&table=<table ERP indicative>
//
// Traduit des identifiants d'enregistrement (id ERP ou record ID Airtable) en
// libellé + URL de fiche, pour que les champs lien importés d'Airtable
// s'affichent en vrais liens au lieu d'un `recXXXX` brut. Voir
// services/recordLinks.js pour la logique de réconciliation des deux identités.
router.get('/', requireAuth, (req, res) => {
  const raw = String(req.query.keys || '')
  const keys = raw.split(',').map(s => s.trim()).filter(Boolean)
  if (!keys.length) return res.json({ data: {} })
  if (keys.length > MAX_KEYS) {
    return res.status(400).json({ error: `Trop de clés (max ${MAX_KEYS})` })
  }
  const hint = req.query.table && RESOLVABLE_TABLES.includes(String(req.query.table))
    ? String(req.query.table)
    : null
  // `by_label=1` : les clés non résolues sont aussi cherchées comme LIBELLÉS
  // dans la table indiquée — une colonne comme `projects.company_name` porte le
  // nom de l'entreprise, pas son id, et doit pouvoir s'afficher en lien.
  const byLabel = req.query.by_label === '1' || req.query.by_label === 'true'
  res.json({ data: resolveRecordKeys(keys, { hint, byLabel }) })
})

// GET /api/record-links/tables — tables qu'on peut désigner comme cible d'un
// champ affiché en « Lien vers … » (celles qui ont une fiche à ouvrir). Sert le
// sélecteur de la modale de champ, pour qu'il ne propose que des cibles qui
// produisent vraiment un lien.
router.get('/tables', requireAuth, (_req, res) => {
  res.json({ data: LINKABLE_TABLES })
})

// GET /api/record-links/search?table=<table ERP>&q=<terme>&limit=<n>
//
// Candidats à une ASSOCIATION : les fiches de la table cible, libellées comme
// les pastilles de lien. Sert l'éditeur de lien d'une cellule de DataTable
// (client/src/components/LinkCellEditor.jsx), qui doit proposer une liste
// recherchable sans que la page ait à charger la table entière.
router.get('/search', requireAuth, (req, res) => {
  const table = String(req.query.table || '')
  if (!RESOLVABLE_TABLES.includes(table)) {
    return res.status(400).json({ error: 'Table cible inconnue' })
  }
  res.json({ data: searchRecords(table, req.query.q, req.query.limit) })
})

export default router
