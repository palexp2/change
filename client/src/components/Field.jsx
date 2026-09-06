import { useFieldGate } from '../lib/fieldGate.js'
import { FieldPulse } from './FieldPulse.jsx'

// Un bloc « libellé + valeur » pour UN champ d'une table, gardé par le portier
// des champs supprimés (lib/fieldGate.js).
//
// À utiliser partout où une fiche ou une modale affiche un champ d'une table
// sans passer par <DetailFieldGrid> (qui, lui, gère en plus l'ordre et la
// personnalisation de la carte). La page garde sa mise en page : <Field> ne rend
// que le libellé et ce qu'on lui donne en enfant.
//
//   <Field table="factures" id="due_date" label="Date d'échéance">
//     <p className="text-sm text-slate-700">{fmtDate(facture.due_date)}</p>
//   </Field>
//
// Deux garanties, non contournables depuis la page :
//   - champ supprimé (corbeille) → le bloc n'est PAS rendu ;
//   - champ renommé → le libellé de l'utilisateur remplace celui du code.
//
// `variant="form"` pour un champ de formulaire (libellé `<label className="label">`
// au-dessus de l'input) au lieu du libellé de fiche en petites majuscules.
//
// Le libellé porte aussi la pastille « mis à jour ailleurs » (<FieldPulse>) :
// quand Airtable ou un collègue change ce champ, elle s'allume quelques
// secondes. Elle a besoin de l'id du record, qu'elle lit du panneau qui monte
// la fiche (RecordScope) — la page n'a rien à passer.

const DETAIL_LABEL_CLASS = 'text-xs font-medium text-slate-500 uppercase tracking-wide mb-1'

export function Field({
  table,
  id,
  label,
  saving = false,
  variant = 'detail',
  className = '',
  labelClassName,
  htmlFor,
  testId,
  children,
}) {
  const gate = useFieldGate(table)

  // Sans table ni id, le portier ne peut rien vérifier : c'est une erreur de
  // programmation, pas un cas d'usage (le test de garde la refuse aussi).
  if (!table || !id) {
    console.error('[Field] `table` et `id` sont obligatoires — champ non gardé:', { table, id, label })
  }

  // Tant que la liste des champs n'est pas connue (premier affichage de cette
  // table dans ce navigateur), on n'affiche rien : un champ supprimé ne doit pas
  // clignoter avant de disparaître.
  if (!gate.ready || gate.isDeleted(id)) return null

  const text = gate.labelFor(id, label)
  const spinner = saving
    ? <span className="inline-block w-3 h-3 border border-brand-400 border-t-transparent rounded-full animate-spin" />
    : null

  return (
    <div className={className} data-field-key={id} data-testid={testId || `field-${id}`}>
      {variant === 'form' ? (
        <label className={labelClassName || 'label'} htmlFor={htmlFor}>
          {text}{spinner && <> {spinner}</>} <FieldPulse field={id} />
        </label>
      ) : (
        <div className={`${labelClassName || DETAIL_LABEL_CLASS} flex items-center gap-1`}>
          {text}{spinner}<FieldPulse field={id} />
        </div>
      )}
      {children}
    </div>
  )
}

export default Field
