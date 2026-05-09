import { useState, useEffect, useMemo } from 'react'
import { Modal } from './Modal.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import api from '../lib/api.js'

// Modal pour créer ou éditer un champ custom.
// Trois "kinds" :
//   - data    : colonne réelle stockée (text/number) — éditable inline
//   - formula : expression SQLite calculée à la lecture via la VUE
//   - lookup  : valeur tirée d'une table liée via FK
// En mode édition, le kind est figé.
export function CustomFieldModal({ isOpen, onClose, erpTable, editing, onSaved }) {
  const { addToast } = useToast()
  const [kind, setKind] = useState('data')
  const [name, setName] = useState('')
  const [type, setType] = useState('text')        // pour kind='data'
  const [decimals, setDecimals] = useState(2)
  const [resultType, setResultType] = useState('text')   // pour kind='formula'/'lookup'
  const [formulaExpr, setFormulaExpr] = useState('')
  const [lookupFk, setLookupFk] = useState('')
  const [lookupTargetTable, setLookupTargetTable] = useState('')
  const [lookupTargetColumn, setLookupTargetColumn] = useState('')
  const [meta, setMeta] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!isOpen) return
    if (editing) {
      setKind(editing.kind || 'data')
      setName(editing.name || '')
      setType(editing.type || 'text')
      setDecimals(editing.decimals ?? 2)
      setResultType(editing.result_type || 'text')
      setFormulaExpr(editing.formula_expr || '')
      setLookupFk(editing.lookup_fk || '')
      setLookupTargetTable(editing.lookup_target_table || '')
      setLookupTargetColumn(editing.lookup_target_column || '')
    } else {
      setKind('data')
      setName('')
      setType('text')
      setDecimals(2)
      setResultType('text')
      setFormulaExpr('')
      setLookupFk('')
      setLookupTargetTable('')
      setLookupTargetColumn('')
    }
    setError(null)
  }, [isOpen, editing])

  // Charge les méta (FK + tables cibles) une seule fois quand la modale ouvre.
  useEffect(() => {
    if (!isOpen || !erpTable) return
    api.customFields.lookupMeta(erpTable)
      .then(setMeta)
      .catch(() => setMeta({ fk_columns: [], allowed_targets: [], target_columns: {} }))
  }, [isOpen, erpTable])

  // Quand l'utilisateur choisit une FK qui a une cible inférée, pré-remplir.
  useEffect(() => {
    if (kind !== 'lookup' || !meta || !lookupFk) return
    const fk = meta.fk_columns.find(f => f.column === lookupFk)
    if (fk && !lookupTargetTable) setLookupTargetTable(fk.target_table)
  }, [kind, lookupFk, meta, lookupTargetTable])

  const targetColumnOptions = useMemo(() => {
    if (!meta || !lookupTargetTable) return []
    return meta.target_columns[lookupTargetTable] || []
  }, [meta, lookupTargetTable])

  async function handleSubmit(e) {
    e?.preventDefault()
    setError(null)
    if (!name.trim()) { setError('Nom requis'); return }
    setSaving(true)
    try {
      let result
      if (editing) {
        // Édition : mise à jour partielle selon le kind
        const payload = { name: name.trim() }
        if (editing.kind === 'data' && type === 'number') payload.decimals = decimals
        if (editing.kind === 'formula') payload.formula_expr = formulaExpr.trim()
        if (editing.kind === 'lookup') {
          payload.lookup_fk = lookupFk
          payload.lookup_target_table = lookupTargetTable
          payload.lookup_target_column = lookupTargetColumn
        }
        result = await api.customFields.update(editing.id, payload)
      } else if (kind === 'data') {
        result = await api.customFields.create(erpTable, {
          name: name.trim(),
          type,
          ...(type === 'number' ? { decimals } : {}),
        })
      } else if (kind === 'formula') {
        if (!formulaExpr.trim()) { setError('Expression requise'); setSaving(false); return }
        result = await api.customFields.createFormula(erpTable, {
          name: name.trim(),
          formula_expr: formulaExpr.trim(),
          result_type: resultType,
        })
      } else if (kind === 'lookup') {
        if (!lookupFk || !lookupTargetTable || !lookupTargetColumn) {
          setError('Choisir un champ de référence, une table cible et une colonne')
          setSaving(false); return
        }
        result = await api.customFields.createLookup(erpTable, {
          name: name.trim(),
          lookup_fk: lookupFk,
          lookup_target_table: lookupTargetTable,
          lookup_target_column: lookupTargetColumn,
          result_type: resultType,
        })
      }
      addToast({ message: editing ? 'Champ modifié' : 'Champ créé', type: 'success' })
      onSaved?.(result)
      onClose?.()
    } catch (e) {
      setError(e.message || 'Erreur')
    } finally {
      setSaving(false)
    }
  }

  // Tabs pour le kind, masqués en mode édition
  const KIND_TABS = [
    { value: 'data',    label: 'Donnée',  hint: 'Texte ou nombre éditable' },
    { value: 'formula', label: 'Formule', hint: 'Calcul à partir d\'autres colonnes' },
    { value: 'lookup',  label: 'Lookup',  hint: 'Valeur d\'une table liée' },
  ]

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editing ? 'Modifier le champ' : 'Nouveau champ'} size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {!editing && (
          <div>
            <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Type de champ</label>
            <div className="grid grid-cols-3 gap-2">
              {KIND_TABS.map(t => (
                <button
                  type="button"
                  key={t.value}
                  onClick={() => setKind(t.value)}
                  className={`flex flex-col items-start gap-0.5 px-3 py-2 text-sm rounded-lg border transition-colors ${kind === t.value ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50 text-slate-700'}`}
                >
                  <span className="font-medium">{t.label}</span>
                  <span className="text-[11px] text-slate-400">{t.hint}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Nom</label>
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            className="input text-sm w-full"
            placeholder={kind === 'lookup' ? 'ex: Email entreprise' : kind === 'formula' ? 'ex: Mois du document' : 'ex: Priorité interne'}
          />
        </div>

        {/* Mode "data" — texte/nombre éditable */}
        {kind === 'data' && (
          <>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Type</label>
              <div className="flex gap-2">
                {['text', 'number'].map(t => (
                  <label key={t} className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border cursor-pointer transition-colors ${type === t ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50 text-slate-700'} ${editing ? 'opacity-60 cursor-not-allowed' : ''}`}>
                    <input
                      type="radio" name="cf-type" value={t}
                      checked={type === t}
                      onChange={() => setType(t)}
                      disabled={!!editing}
                      className="sr-only"
                    />
                    {t === 'text' ? 'Texte' : 'Nombre'}
                  </label>
                ))}
              </div>
              {editing && <p className="text-[11px] text-slate-400 mt-1">Le type ne peut pas être modifié après création.</p>}
            </div>
            {type === 'number' && (
              <div>
                <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Décimales (0 à 5)</label>
                <input
                  type="number" min={0} max={5}
                  value={decimals}
                  onChange={e => setDecimals(Math.max(0, Math.min(5, parseInt(e.target.value) || 0)))}
                  className="input text-sm w-24"
                />
              </div>
            )}
          </>
        )}

        {/* Mode "formula" — expression SQLite */}
        {kind === 'formula' && (
          <>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Expression SQLite</label>
              <textarea
                value={formulaExpr}
                onChange={e => setFormulaExpr(e.target.value)}
                rows={3}
                className="input text-sm w-full font-mono"
                placeholder="ex: substr(document_date, 1, 7)"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                Référence les colonnes de la table par leur nom. Fonctions autorisées : <code className="bg-slate-100 px-1 rounded">substr</code>, <code className="bg-slate-100 px-1 rounded">strftime</code>, <code className="bg-slate-100 px-1 rounded">coalesce</code>, <code className="bg-slate-100 px-1 rounded">case when…then…end</code>, opérateurs <code className="bg-slate-100 px-1 rounded">||</code>, <code className="bg-slate-100 px-1 rounded">+</code>, <code className="bg-slate-100 px-1 rounded">-</code>, <code className="bg-slate-100 px-1 rounded">*</code>, <code className="bg-slate-100 px-1 rounded">/</code>.
              </p>
            </div>
            <ResultTypeSelect value={resultType} onChange={setResultType} />
          </>
        )}

        {/* Mode "lookup" — JOIN sur table liée */}
        {kind === 'lookup' && (
          <>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Champ de référence</label>
              <select
                value={lookupFk}
                onChange={e => { setLookupFk(e.target.value); setLookupTargetTable(''); setLookupTargetColumn('') }}
                className="input text-sm w-full"
              >
                <option value="">— Choisir une colonne FK —</option>
                {meta?.fk_columns?.map(fk => (
                  <option key={fk.column} value={fk.column}>
                    {fk.column} → {fk.target_table}{fk.inferred ? ' (inféré)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Table cible</label>
              <select
                value={lookupTargetTable}
                onChange={e => { setLookupTargetTable(e.target.value); setLookupTargetColumn('') }}
                className="input text-sm w-full"
                disabled={!lookupFk}
              >
                <option value="">— Choisir une table —</option>
                {meta?.allowed_targets?.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Colonne à récupérer</label>
              <select
                value={lookupTargetColumn}
                onChange={e => setLookupTargetColumn(e.target.value)}
                className="input text-sm w-full"
                disabled={!lookupTargetTable}
              >
                <option value="">— Choisir une colonne —</option>
                {targetColumnOptions.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <ResultTypeSelect value={resultType} onChange={setResultType} />
          </>
        )}

        {error && <div className="rounded bg-red-50 border border-red-200 p-2 text-xs text-red-700">{error}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? 'Enregistrement…' : (editing ? 'Enregistrer' : 'Créer')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ResultTypeSelect({ value, onChange }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Type d'affichage</label>
      <div className="flex gap-2">
        {[
          { v: 'text',   label: 'Texte' },
          { v: 'number', label: 'Nombre' },
          { v: 'date',   label: 'Date' },
        ].map(o => (
          <label key={o.v} className={`flex-1 flex items-center justify-center px-3 py-2 text-sm rounded-lg border cursor-pointer transition-colors ${value === o.v ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50 text-slate-700'}`}>
            <input
              type="radio" name="cf-result-type" value={o.v}
              checked={value === o.v}
              onChange={() => onChange(o.v)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
    </div>
  )
}

export default CustomFieldModal
