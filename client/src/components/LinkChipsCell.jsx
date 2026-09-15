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

  const optionLabels = useMemo(() => {
    const map = new Map()
    for (const o of (Array.isArray(col.linkOptions) ? col.linkOptions : [])) {
      if (o?.id != null) map.set(String(o.id), o.label || '')
    }
    return map
  }, [col.linkOptions])

  // Ce que la page sait déjà dire de chaque lien. Tout connu → aucune
  // résolution réseau à demander (une commande de 20 articles n'ouvre plus un
  // appel juste pour retrouver des noms déjà présents dans la ligne).
  const own = keys.map(key => ({
    label: (typeof col.linkChipLabel === 'function' ? col.linkChipLabel(row, key) : null)
      || optionLabels.get(String(key)) || null,
    href: typeof col.linkChipHref === 'function' ? col.linkChipHref(row, key) : null,
  }))
  const needResolve = own.some(o => !o.label || !o.href)
  const resolved = useRecordLinks(needResolve ? keys : [], col.linkTarget || null)

  const labelFor = (key, i) => {
    if (own[i]?.label) return own[i].label
    const rec = resolved[i]
    if (rec === undefined) return '…'
    if (rec?.label) return rec.label
    return key.length > 12 ? `${key.slice(0, 8)}…` : key
  }
  const hrefFor = (i) => own[i]?.href || resolved[i]?.url || null

  const serialize = (next) => (multi ? JSON.stringify(next) : (next[0] ?? null))

  // Le « × » et le « + » n'apparaissent que sur la cellule sélectionnée : la
  // table au repos reste une table de lecture. Pendant que la liste est ouverte,
  // on montre les pastilles sans « × » — on est en train de CHOISIR, et un
  // retrait sous le panneau laisserait l'éditeur sur une valeur périmée.
  const showRemove = active && !editing
  const showAdd = active && (multi || keys.length === 0)

  // Cellule vide : le conteneur reste rendu (avec sa hauteur) même sans
  // pastille. Un div réellement vide s'effondre à 0 px de haut — la case
  // n'attrapait plus le clic, donc plus moyen de la sélectionner pour poser un
  // premier lien.
  return (
    <div
      className={`flex min-h-[1.5rem] min-w-0 items-center gap-1 overflow-hidden${active ? '' : ' dt-inert-links'}`}
      data-testid="link-chips-cell"
    >
      {keys.map((key, i) => {
        const rec = resolved[i]
        const label = labelFor(key, i)
        const href = hrefFor(i)
        const title = rec?.sub ? `${label} · ${rec.sub}` : label
        const chip = href
          ? <Link to={href} onClick={e => e.stopPropagation()} title={title} className="chip-record">{label}</Link>
          : <span className="chip-record" title={title}>{label}</span>
        if (!showRemove) return <span key={`${key}-${i}`} className="min-w-0 truncate">{chip}</span>
        return (
          <span
            key={`${key}-${i}`}
            className={`inline-flex min-w-0 items-center gap-0.5 rounded pr-0.5 ${href ? 'bg-brand-50' : 'bg-slate-100'}`}
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
              className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-white hover:text-red-600"
            >
              <X size={11} />
            </button>
          </span>
        )
      })}
      {showAdd && (
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
