import { useMemo } from 'react'
import { useFieldOverrides, renderOverriddenValue, typeLabel } from './fieldOverrides.jsx'
import { useCustomFields } from './useCustomFields.js'
import { CUSTOM_FIELD_TABLES } from './customFieldDisplay.jsx'
import { TABLE_COLUMN_META } from './tableDefs.js'

// Registre des champs pour une FICHE DÉTAIL.
//
// Les fiches gardent leur mise en page — elles portent une vraie valeur métier
// qu'aucun rendu générique ne remplacerait — mais elles cessent d'être un
// registre de champs concurrent : libellés, types d'affichage et masquages
// viennent de la même source que les tableaux (custom_fields). Sans ça,
// renommer « Courriel » dans le tableau laissait la fiche afficher l'ancien nom,
// et un champ supprimé continuait de s'y afficher — exactement la sensation de
// « la suppression n'a pas pris » qu'on cherche à éliminer.
//
// `baseFields` : la liste codée en dur de la fiche ([{ key, label, type, … }]).
// Retourne { fields, customFields } — `fields` avec les personnalisations
// appliquées et les champs masqués retirés, `customFields` = les champs perso
// actifs à afficher dans leur propre section (lecture seule : leur édition
// inline suppose une route PATCH qui liste les colonnes cf_, ce qui n'est pas
// branché sur toutes les tables).
export function useDetailFields(erpTable, baseFields) {
  const { overrides } = useFieldOverrides(erpTable)
  const { fields: customFields } = useCustomFields(CUSTOM_FIELD_TABLES.has(erpTable) ? erpTable : null)

  // La personnalisation est indexée par l'id de colonne du tableau, la fiche
  // par nom de colonne SQL : `full_name` (tableau) et `first_name` (fiche)
  // désignent le même champ. On rapproche les deux via TABLE_COLUMN_META.
  const idByColumn = useMemo(() => {
    const m = new Map()
    for (const c of (TABLE_COLUMN_META[erpTable] || [])) {
      m.set(c.field ?? c.id, c.id ?? c.field)
    }
    return m
  }, [erpTable])

  return useMemo(() => {
    const overrideFor = key => overrides.get(key) || overrides.get(idByColumn.get(key)) || null

    const fields = baseFields
      .map(f => {
        const ov = overrideFor(f.key)
        if (!ov) return f
        return {
          ...f,
          ...(ov.label ? { label: ov.label } : {}),
          ...(ov.hidden ? { hidden: true } : {}),
        }
      })
      .filter(f => !f.hidden)

    const taken = new Set(baseFields.map(f => f.key))
    const extras = (customFields || [])
      .filter(f => !taken.has(f.column_name))
      // Seulement les champs CRÉÉS par un utilisateur (source='native'). Les
      // colonnes adoptées depuis une sync (source='airtable') se comptent par
      // dizaines — 89 sur contacts — et noieraient une fiche curée. Elles
      // restent accessibles dans les tableaux, où la visibilité se choisit par vue.
      .filter(f => f.source !== 'airtable')
      // Un bouton est une action, une liaison a son propre éditeur : ni l'un ni
      // l'autre n'est une valeur à afficher en ligne dans une fiche.
      .filter(f => f.kind !== 'button' && f.kind !== 'link')
      .map(f => ({
        key: f.column_name,
        label: f.name,
        type: f.type,
        decimals: f.decimals,
        typeLabel: typeLabel(f.type),
        render: value => renderOverriddenValue({ type: f.type, decimals: f.decimals }, value),
      }))

    return { fields, customFields: extras }
  }, [baseFields, customFields, overrides, idByColumn])
}
