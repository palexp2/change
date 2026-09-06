import { useMemo } from 'react'
import { typeLabel } from './fieldOverrides.jsx'
import { useFieldGate } from './fieldGate.js'
import { useCustomFields } from './useCustomFields.js'
import { CUSTOM_FIELD_TABLES, sqlTableForView, renderCustomFieldValue } from './customFieldDisplay.jsx'

// Registre des champs pour une FICHE DÉTAIL.
//
// Les fiches gardent leur mise en page — elles portent une vraie valeur métier
// qu'aucun rendu générique ne remplacerait — mais elles cessent d'être un
// registre de champs concurrent : libellés, types d'affichage et masquages
// viennent de la même source que les tableaux (custom_fields). Sans ça,
// renommer « Courriel » dans le tableau laissait la fiche afficher l'ancien nom,
// et un champ supprimé continuait de s'y afficher — exactement la sensation de
// « la suppression n'a pas pris » qu'on cherche à éliminer.

const EMPTY = []

// Champs personnalisés d'une table qui ne sont PAS déjà affichés par la fiche.
//
// C'est la moitié « champs perso » du registre, isolée pour que les fiches qui
// ne déclarent pas leur liste de champs en tableau — celles qui posent des
// <Field> ou des <DetailField> un par un — puissent l'afficher elles aussi.
// Sans ça, créer un champ sur une table obligeait à retoucher sa fiche à la
// main : il apparaissait dans le tableau et nulle part ailleurs.
//
// `erpTable` peut être une clé de vue (`retours`) : les champs perso sont
// indexés par vraie table SQL (`returns`), d'où sqlTableForView.
// `takenKeys` : colonnes déjà rendues par la fiche, à ne pas répéter. Doit être
// stable d'un rendu à l'autre (useMemo côté appelant).
//
// `includeSynced` : ajouter aussi les colonnes adoptées depuis une sync
// (source='airtable'), marquées `defaultHidden` — à réserver aux fiches dont la
// carte de champs sait ranger un champ hors de la vue (<DetailFieldGrid>, où
// elles n'apparaissent que dans le menu « Ajouter un champ »). Sans ce
// marquage, les dizaines de colonnes de sync noieraient la fiche.
export function useExtraCustomFields(erpTable, takenKeys = EMPTY, includeSynced = false) {
  const sqlTable = erpTable ? sqlTableForView(erpTable) : null
  const { fields: customFields } = useCustomFields(CUSTOM_FIELD_TABLES.has(sqlTable) ? sqlTable : null)

  return useMemo(() => {
    const taken = new Set(takenKeys)
    return (customFields || [])
      .filter(f => !taken.has(f.column_name))
      // D'office, seulement les champs CRÉÉS par un utilisateur
      // (source='native') : les colonnes adoptées depuis une sync
      // (source='airtable') se comptent par dizaines — 89 sur contacts — et
      // noieraient une fiche curée. `includeSynced` les rend disponibles quand
      // l'appelant sait les garder repliées (defaultHidden ci-dessous).
      .filter(f => includeSynced || f.source !== 'airtable')
      // Un bouton est une action, une liaison a son propre éditeur : ni l'un ni
      // l'autre n'est une valeur à afficher en ligne dans une fiche.
      .filter(f => f.kind !== 'button' && f.kind !== 'link')
      .map(f => {
        // Champ calculé affiché en URL : son type stocké reste 'text' (la valeur
        // est du texte), c'est `result_type` qui dit « lien cliquable ».
        const type = f.result_type === 'url' ? 'url' : f.type
        return {
          key: f.column_name,
          label: f.name,
          type,
          decimals: f.decimals,
          typeLabel: typeLabel(type),
          // De quoi décider si la valeur est ÉDITABLE sur une fiche : un champ
          // calculé (formula/lookup/rollup) n'a pas de valeur à écrire, et
          // `writable` vient de la règle d'éditabilité unique du serveur (un
          // champ Airtable en import seul serait écrasé au prochain sync).
          kind: f.kind,
          writable: f.writable !== false,
          // Une colonne de sync ne s'invite pas d'elle-même dans la carte :
          // elle attend dans le menu « Ajouter un champ » qu'on l'y place.
          defaultHidden: f.source === 'airtable',
          // Ligne custom_fields brute : les choix d'un select vivent dans
          // `options` (JSON), que seuls les éditeurs ont besoin de lire.
          field: f,
          // Rendu de la valeur : le MÊME que dans les tableaux
          // (renderCustomFieldValue). Un rendu propre à la fiche dérivait
          // l'affichage du seul `type` stocké, ce qui affichait les champs
          // CALCULÉS à résultat date/nombre comme du texte brut — un champ
          // « Créé le » (type stocké 'text', result_type 'date') sortait en
          // « 2026-09-01T19:31:01.823Z ». Le renderer commun lit result_type et
          // le format d'affichage choisi sur le champ (options.format).
          // `detail` : c'est une fiche — un champ lien y prend la pastille
          // pleine taille (la même que le lien d'entreprise en haut d'une fiche
          // commande), pas la pastille compacte des cellules de tableau.
          render: value => renderCustomFieldValue(f, value, null, { detail: true }),
        }
      })
  }, [customFields, takenKeys])
}

// `baseFields` : la liste codée en dur de la fiche ([{ key, label, type, … }]).
// Retourne { fields, customFields } — `fields` avec les personnalisations
// appliquées et les champs masqués retirés, `customFields` = les champs perso
// actifs à afficher dans leur propre section (lecture seule : leur édition
// inline suppose une route PATCH qui liste les colonnes cf_, ce qui n'est pas
// branché sur toutes les tables).
export function useDetailFields(erpTable, baseFields) {
  // Libellés et suppressions viennent du portier — même source que les
  // tableaux, les cartes de champs et les formulaires (lib/fieldGate.js).
  const gate = useFieldGate(erpTable)
  const takenKeys = useMemo(() => baseFields.map(f => f.key), [baseFields])
  const extras = useExtraCustomFields(erpTable, takenKeys)
  // Même attente que `gate.keep` : tant que le portier n'a pas répondu, la fiche
  // n'affiche aucun champ — sinon les champs perso se posent seuls à l'écran
  // avant que les champs codés n'arrivent.
  const customFields = gate.ready ? extras : EMPTY

  const fields = useMemo(
    () => gate.keep(baseFields)
      .filter(f => !f.hidden)
      .map(f => ({ ...f, label: gate.labelFor(f.key, f.label) })),
    [baseFields, gate],
  )

  return useMemo(() => ({ fields, customFields }), [fields, customFields])
}
