import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { X, Plus } from 'lucide-react'
import { parseLinkedKeys } from '../lib/customFieldDisplay.jsx'
import { useRecordLinks } from '../lib/useRecordLinks.js'

// ── Cellule de lien « à la Airtable » ───────────────────────────────────────
//
// Variante OPTIONNELLE d'une cellule de lien du mode tableur d'un DataTable :
// la colonne pose `linkChips: true` (voir DataTable, prop `columns`). Sans ce
// drapeau, rien ne change pour les autres pages.
//
// Ce que ça donne, cellule par cellule :
//   • au repos    → une pastille par enregistrement lié, rien d'autre ;
//   • sélectionnée → chaque pastille gagne son « × » (dissocier tout de suite)
//                    et, s'il reste de la place pour un lien, un « + » ouvre la
//                    liste recherchable (LinkCellEditor, sans ses pastilles).
//
// Avant, il fallait DOUBLE-cliquer pour découvrir un panneau qui portait à la
// fois les pastilles et la recherche : la cellule, elle, n'offrait rien.
//
// Le libellé d'une pastille vient, dans l'ordre : de la page (`col.linkChipLabel`,
// quand la ligne porte déjà le nom — pas d'attente réseau), de la liste de
// candidats de la colonne (`col.linkOptions`), puis de la résolution partagée
// (useRecordLinks), qui fournit de toute façon l'URL de la fiche visée.

export default function LinkChipsCell({ col, row, value, active, editing, onCommit, onOpenPicker }) {
  const multi = !!col.linkMulti
  const keys = useMemo(() => parseLinkedKeys(value), [value])
  const resolved = useRecordLinks(keys, col.linkTarget || null)

  const optionLabels = useMemo(() => {
    const map = new Map()
    for (const o of (Array.isArray(col.linkOptions) ? col.linkOptions : [])) {
      if (o?.id != null) map.set(String(o.id), o.label || '')
    }
    return map
  }, [col.linkOptions])

  const labelFor = (key, i) => {
    const own = typeof col.linkChipLabel === 'function' ? col.linkChipLabel(row, key) : null
    if (own) return own
    const opt = optionLabels.get(String(key))
    if (opt) return opt
    const rec = resolved[i]
    if (rec === undefined) return '…'
    if (rec?.label) return rec.label
    return key.length > 12 ? `${key.slice(0, 8)}…` : key
  }

  const serialize = (next) => (multi ? JSON.stringify(next) : (next[0] ?? null))

  // Le « × » et le « + » n'apparaissent que sur la cellule sélectionnée : la
  // table au repos reste une table de lecture. Pendant que la liste est ouverte,
  // on montre les pastilles sans « × » — on est en train de CHOISIR, et un
  // retrait sous le panneau laisserait l'éditeur sur une valeur périmée.
  const showActions = active && !editing
  const canAdd = multi || keys.length === 0

  if (!keys.length && !showActions) return null

  return (
    <div
      className={`flex items-center gap-1 overflow-hidden${active ? '' : ' dt-inert-links'}`}
      data-testid="link-chips-cell"
    >
      {keys.map((key, i) => {
        const rec = resolved[i]
        const label = labelFor(key, i)
        const title = rec?.sub ? `${label} · ${rec.sub}` : label
        const chip = rec?.url
          ? <Link to={rec.url} onClick={e => e.stopPropagation()} title={title} className="chip-record">{label}</Link>
          : <span className="chip-record" title={title}>{label}</span>
        if (!showActions) return <span key={`${key}-${i}`} className="min-w-0 truncate">{chip}</span>
        return (
          <span
            key={`${key}-${i}`}
            className="inline-flex min-w-0 items-center gap-0.5 rounded bg-brand-50 pr-0.5"
          >
            {chip}
            <button
              type="button"
              title="Dissocier"
              aria-label="Dissocier"
              data-testid={`link-chip-remove-${key}`}
              onMouseDown={e => e.stopPropagation()}
              onClick={e => {
                e.stopPropagation()
                onCommit(serialize(keys.filter((_, j) => j !== i)))
              }}
              className="shrink-0 rounded p-0.5 text-brand-700/60 hover:bg-white hover:text-red-600"
            >
              <X size={11} />
            </button>
          </span>
        )
      })}
      {showActions && canAdd && (
        <button
          type="button"
          title="Associer un enregistrement"
          aria-label="Associer un enregistrement"
          data-testid="link-chip-add"
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onOpenPicker() }}
          className="shrink-0 rounded border border-slate-300 bg-white p-0.5 text-slate-500 hover:border-brand-400 hover:text-brand-600"
        >
          <Plus size={12} />
        </button>
      )}
    </div>
  )
}
