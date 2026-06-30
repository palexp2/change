import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import api from '../lib/api.js'

// Avertissement de doublon (non bloquant) affiché dans les formulaires de
// création d'entreprise / contact. Interroge en debounce les routes
// /companies/duplicates et /contacts/duplicates et liste les correspondances
// trouvées (nom, courriel, téléphone) avec un lien vers la fiche existante.
//
// kind     : 'company' | 'contact'
// values   : l'objet de formulaire courant (name/email/phone ou
//            first_name/last_name/email/phone/mobile)
// excludeId: id à ignorer (utile en édition pour ne pas se matcher soi-même)

const REASON_LABEL = { name: 'nom', email: 'courriel', phone: 'téléphone' }

function buildParams(kind, values, excludeId) {
  const v = values || {}
  const trim = (s) => (s ?? '').toString().trim()
  const params = {}
  if (kind === 'company') {
    if (trim(v.name).length >= 2) params.name = trim(v.name)
    if (trim(v.email)) params.email = trim(v.email)
    if (trim(v.phone)) params.phone = trim(v.phone)
  } else {
    if (trim(v.first_name) && trim(v.last_name)) {
      params.first_name = trim(v.first_name)
      params.last_name = trim(v.last_name)
    }
    if (trim(v.email)) params.email = trim(v.email)
    if (trim(v.phone)) params.phone = trim(v.phone)
    if (trim(v.mobile)) params.mobile = trim(v.mobile)
  }
  // Aucun critère exploitable → on n'interroge pas.
  if (!Object.keys(params).length) return null
  if (excludeId) params.exclude_id = excludeId
  return params
}

export function DuplicateWarning({ kind, values, excludeId }) {
  const [matches, setMatches] = useState([])

  // On dépend des champs individuels (pas de l'objet `values` entier) pour
  // éviter de relancer la recherche à chaque rerender du parent.
  const params = buildParams(kind, values, excludeId)
  const key = params ? JSON.stringify(params) : ''

  useEffect(() => {
    if (!params) { setMatches([]); return }
    let cancelled = false
    const tid = setTimeout(async () => {
      try {
        const fn = kind === 'company' ? api.companies.duplicates : api.contacts.duplicates
        const res = await fn(params)
        if (!cancelled) setMatches(res?.matches || [])
      } catch {
        if (!cancelled) setMatches([])
      }
    }, 400)
    return () => { cancelled = true; clearTimeout(tid) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, key])

  if (!matches.length) return null

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm" data-testid="duplicate-warning">
      <div className="flex items-center gap-2 font-medium text-amber-800">
        <AlertTriangle size={15} />
        {matches.length === 1
          ? `Doublon potentiel — ${kind === 'company' ? 'cette entreprise' : 'ce contact'} existe peut-être déjà`
          : `${matches.length} doublons potentiels`}
      </div>
      <ul className="mt-1.5 space-y-1">
        {matches.map(m => {
          const label = kind === 'company' ? m.name : `${m.first_name} ${m.last_name}`.trim()
          const to = kind === 'company' ? `/companies/${m.id}` : `/contacts/${m.id}`
          const reasons = (m.reasons || []).map(r => REASON_LABEL[r] || r).join(', ')
          return (
            <li key={m.id} className="flex items-center justify-between gap-2">
              <Link
                to={to}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-600 hover:underline font-medium"
                onClick={e => e.stopPropagation()}
              >
                {label || '(sans nom)'}
              </Link>
              {reasons && <span className="text-xs text-amber-700 whitespace-nowrap">même {reasons}</span>}
            </li>
          )
        })}
      </ul>
      <p className="mt-1 text-xs text-amber-700">Ouvre la fiche existante pour vérifier, ou crée quand même si ce n'est pas un doublon.</p>
    </div>
  )
}

export default DuplicateWarning
