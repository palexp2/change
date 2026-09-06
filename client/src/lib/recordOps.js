// ── RecordOps — le « deuxième type » de DataTable ────────────────────────────
//
// Par défaut, un `DataTable` est une table de LECTURE : on regarde, on trie, on
// filtre, on ouvre la fiche. Les enregistrements naissent et meurent ailleurs
// (bouton « Ajouter » + formulaire, page dédiée, mode expédition…).
//
// Une instance de cette classe passée en prop `recordOps` fait basculer la table
// dans son second type : une table MANIPULABLE au niveau des données, à la
// Airtable —
//
//   • clic droit sur une ligne  → « Dupliquer » / « Supprimer » l'enregistrement
//   • « + » sous le dernier     → crée un enregistrement vide EN LIGNE (aucun
//     enregistrement               formulaire) ; en mode tableur (`onCellEdit`),
//                                  le curseur ouvre aussitôt la première
//                                  cellule éditable de la ligne neuve.
//
// L'activation est explicite et locale : une table sans `recordOps` ne change
// pas d'un pixel. Chaque opération est fournie par la page (elle seule sait quel
// endpoint appeler et comment rafraîchir son état) ; la classe ne porte que le
// contrat, les libellés et les garde-fous.
//
// Usage :
//   const envoiOps = useMemo(() => new RecordOps({
//     labels: { add: 'Ajouter un envoi', duplicate: "Dupliquer l'envoi", … },
//     create:    () => api.shipments.create({ order_id: id }),
//     duplicate: row => api.shipments.create({ …copie de row }),
//     remove:    row => api.shipments.delete(row.id),
//     deleteConfirm: row => `Supprimer l'envoi ${row.tracking_number} ?`,
//   }), [id])
//   <DataTable … recordOps={envoiOps} onCellEdit={handleEnvoiCellEdit} />

const DEFAULT_LABELS = {
  add: 'Ajouter un enregistrement',
  duplicate: "Dupliquer l'enregistrement",
  delete: "Supprimer l'enregistrement",
  duplicated: 'Enregistrement dupliqué',
  deleted: 'Enregistrement supprimé',
}

export class RecordOps {
  /**
   * @param {object} cfg
   * @param {() => Promise<object|void>}        [cfg.create]     crée un enregistrement vide (valeurs par défaut incluses) et retourne la ligne créée.
   * @param {(row) => Promise<object|void>}     [cfg.duplicate]  duplique la ligne et retourne la copie.
   * @param {(row) => Promise<void>}            [cfg.remove]     supprime la ligne.
   * @param {(row) => string|null}              [cfg.deleteConfirm] message de confirmation avant suppression ; `null` = supprimer sans demander (action réversible).
   * @param {Partial<typeof DEFAULT_LABELS>}    [cfg.labels]     libellés du menu contextuel et du « + ».
   * @param {boolean}                           [cfg.editOnCreate=true] en mode tableur, ouvrir la première cellule éditable de la ligne créée.
   */
  constructor(cfg = {}) {
    const { create, duplicate, remove, deleteConfirm, labels, editOnCreate = true } = cfg
    this.labels = { ...DEFAULT_LABELS, ...(labels || {}) }
    this.editOnCreate = editOnCreate !== false
    this._create = typeof create === 'function' ? create : null
    this._duplicate = typeof duplicate === 'function' ? duplicate : null
    this._remove = typeof remove === 'function' ? remove : null
    this._deleteConfirm = deleteConfirm
  }

  get canCreate() { return !!this._create }
  get canDuplicate() { return !!this._duplicate }
  get canDelete() { return !!this._remove }
  // Une instance sans aucune opération n'active rien : la table reste en lecture.
  get isActive() { return this.canCreate || this.canDuplicate || this.canDelete }

  create() { return Promise.resolve(this._create?.()) }
  duplicate(row) { return Promise.resolve(this._duplicate?.(row)) }
  remove(row) { return Promise.resolve(this._remove?.(row)) }

  // Message de confirmation à afficher avant suppression, ou null pour
  // supprimer directement. Par défaut on demande : la plupart des tables n'ont
  // pas de « Annuler » à offrir derrière.
  deleteConfirmMessage(row) {
    if (this._deleteConfirm === null || this._deleteConfirm === false) return null
    if (typeof this._deleteConfirm === 'function') return this._deleteConfirm(row)
    if (typeof this._deleteConfirm === 'string') return this._deleteConfirm
    return `${this.labels.delete} ? Cette action est irréversible.`
  }
}

export default RecordOps
