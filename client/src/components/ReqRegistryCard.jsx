// Bloc « Registre des entreprises » de la fiche entreprise.
//
// LECTURE SEULE côté registre : rien ne repart vers le Registraire. La seule
// écriture est le NEQ porté par la fiche ERP, et elle reste un geste explicite —
// la correspondance trouvée par le nom + la ville est PROPOSÉE, jamais liée
// d'office : deux serres homonymes dans deux municipalités existent vraiment.
import { useState, useEffect, useCallback, useRef } from 'react'
import { Landmark, AlertTriangle, Link2, Pencil, Search, X, Check } from 'lucide-react'
import api from '../lib/api.js'
import { Badge } from './Badge.jsx'
import ReqSourceNotice from './ReqSourceNotice.jsx'
import { useToast } from '../contexts/ToastContext.jsx'

function Field({ label, children }) {
  return (
    <div>
      <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-0.5">{label}</div>
      <div className="text-sm text-slate-800">{children ?? <span className="text-slate-400">—</span>}</div>
    </div>
  )
}

function EntrepriseFields({ e }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label="NEQ"><span className="font-mono">{e.neq}</span></Field>
      <Field label="Nom légal">{e.nom_legal}</Field>
      <Field label="Statut d'immatriculation">
        {e.statut_immat
          ? <Badge color={e.struck_off ? 'orange' : 'green'}>{e.statut_immat}</Badge>
          : null}
      </Field>
      <Field label="Date d'immatriculation">{e.date_immat}</Field>
      <Field label="Forme juridique">{e.forme_juridique}</Field>
      <Field label="Activité déclarée">
        {[e.code_activite, e.desc_activite].filter(Boolean).join(' — ') || null}
      </Field>
      <Field label="Adresse au registre">
        {[e.adresse, e.ville, e.province, e.code_postal].filter(Boolean).join(', ') || null}
      </Field>
      <Field label="Autres noms utilisés">
        {e.noms_usage?.length ? e.noms_usage.join(' · ') : null}
      </Field>
    </div>
  )
}

/**
 * Picker recherchable sur le registre. La recherche se fait côté serveur (le
 * miroir compte potentiellement des millions de lignes : aucun filtrage local
 * n'est possible), avec un debounce pour ne pas frapper à chaque frappe.
 */
function ReqPicker({ onPick, onCancel }) {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const timer = useRef(null)
  const seq = useRef(0)

  useEffect(() => {
    clearTimeout(timer.current)
    const term = q.trim()
    if (term.length < 2) { setRows([]); setLoading(false); return }
    setLoading(true)
    timer.current = setTimeout(() => {
      const mine = ++seq.current
      api.req.search(term, 25)
        // Réponses hors d'ordre : seule la dernière requête lancée compte.
        .then(r => { if (mine === seq.current) setRows(r.data || []) })
        .catch(() => { if (mine === seq.current) setRows([]) })
        .finally(() => { if (mine === seq.current) setLoading(false) })
    }, 350)
    return () => clearTimeout(timer.current)
  }, [q])

  return (
    <div className="mt-3 border border-slate-200 rounded-lg p-3 bg-slate-50" data-testid="req-picker">
      <div className="flex items-center gap-2">
        <Search size={14} className="text-slate-400 flex-shrink-0" />
        <input
          autoFocus
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Nom d'entreprise, NEQ ou municipalité…"
          data-testid="req-picker-input"
          className="flex-1 px-2 py-1.5 text-sm bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400"
        />
        <button onClick={onCancel} className="text-slate-400 hover:text-slate-600 p-1" title="Annuler" data-testid="req-picker-cancel">
          <X size={15} />
        </button>
      </div>
      <div className="mt-2 max-h-64 overflow-y-auto divide-y divide-slate-100 bg-white rounded-md border border-slate-200">
        {loading && <div className="px-3 py-2 text-xs text-slate-400">Recherche…</div>}
        {!loading && q.trim().length >= 2 && rows.length === 0 && (
          <div className="px-3 py-2 text-xs text-slate-400">Aucune entreprise trouvée au registre.</div>
        )}
        {!loading && q.trim().length < 2 && (
          <div className="px-3 py-2 text-xs text-slate-400">Saisir au moins deux caractères.</div>
        )}
        {rows.map(r => (
          <button
            key={r.neq}
            onClick={() => onPick(r)}
            data-testid={`req-picker-option-${r.neq}`}
            className="w-full text-left px-3 py-2 hover:bg-brand-50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-800 truncate">{r.nom_legal}</span>
              {r.struck_off && <Badge color="orange" size="xs">Radiée</Badge>}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              <span className="font-mono">{r.neq}</span>
              {r.ville ? ` · ${r.ville}` : ''}
              {r.desc_activite ? ` · ${r.desc_activite}` : ''}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

export default function ReqRegistryCard({ companyId }) {
  const { addToast } = useToast()
  const [state, setState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [picking, setPicking] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    if (!companyId) return
    setLoading(true)
    api.req.match(companyId)
      .then(setState)
      .catch(() => setState(null))
      .finally(() => setLoading(false))
  }, [companyId])

  useEffect(() => { load() }, [load])

  async function link(neq) {
    setSaving(true)
    try {
      await api.req.link(companyId, neq)
      setPicking(false)
      load()
      addToast({ message: neq ? 'Entreprise liée au registre' : 'Liaison au registre retirée', type: 'success' })
    } catch (e) {
      addToast({ message: e.message || 'Liaison impossible', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="card p-6 mt-4" data-testid="req-registry-card">
        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2"><Landmark size={15} className="text-slate-400" /> Registre des entreprises</h3>
        <div className="text-xs text-slate-400 mt-3">Chargement…</div>
      </div>
    )
  }
  if (!state) return null

  const linked = state.linked ? state.entreprise : null
  const suggestion = !state.linked ? state.match : null
  const shown = linked || suggestion

  return (
    <div className="card p-6 mt-4" data-testid="req-registry-card">
      <div className="flex items-center justify-between mb-4 gap-3">
        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <Landmark size={15} className="text-slate-400" /> Registre des entreprises
          {state.linked && <Badge color="green" size="xs">Liée</Badge>}
          {suggestion && <Badge color="blue" size="xs">Correspondance proposée</Badge>}
        </h3>
        <div className="flex items-center gap-2 flex-shrink-0">
          {suggestion && (
            <button
              onClick={() => link(suggestion.neq)}
              disabled={saving}
              className="btn-primary btn-sm"
              data-testid="req-link-button"
            >
              <Link2 size={13} /> Lier
            </button>
          )}
          <button
            onClick={() => setPicking(p => !p)}
            className="btn-secondary btn-sm"
            data-testid="req-fix-match-button"
          >
            <Pencil size={13} /> {state.linked ? 'Corriger la correspondance' : 'Chercher au registre'}
          </button>
          {state.linked && (
            <button
              onClick={() => link(null)}
              disabled={saving}
              className="btn-secondary btn-sm"
              data-testid="req-unlink-button"
            >
              <X size={13} /> Délier
            </button>
          )}
        </div>
      </div>

      {/* Une entreprise radiée d'office est toujours au registre : c'est une
          alerte commerciale (facturation, contrat), pas une erreur d'appariement. */}
      {shown?.struck_off && (
        <div
          className="flex items-start gap-2 mb-4 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm"
          data-testid="req-struck-off-banner"
        >
          <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
          <span>
            Cette entreprise est <strong>radiée</strong> au registre ({shown.statut_immat}
            {shown.date_statut_immat ? `, depuis le ${shown.date_statut_immat}` : ''}).
            Vérifier avant de contracter ou de facturer.
          </span>
        </div>
      )}

      {state.linked && state.missing_from_registry && (
        <div className="flex items-start gap-2 mb-4 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-slate-600 text-sm">
          <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
          <span>NEQ <span className="font-mono">{state.neq}</span> lié, mais absent de la dernière livraison du registre importée.</span>
        </div>
      )}

      {shown && <EntrepriseFields e={shown} />}

      {!shown && !picking && (
        <p className="text-sm text-slate-500" data-testid="req-no-match">
          {state.ambiguous
            ? 'Plusieurs entreprises du registre portent ce nom dans des municipalités différentes — choisir la bonne.'
            : "Aucune correspondance trouvée au registre pour ce nom d'entreprise."}
        </p>
      )}

      {suggestion && (
        <p className="text-xs text-slate-400 mt-3 flex items-center gap-1.5">
          <Check size={12} className="text-slate-300" />
          Trouvée par le nom{state.exact_city ? ' et la municipalité' : ''} — à confirmer avec « Lier ».
        </p>
      )}

      {picking && <ReqPicker onPick={r => link(r.neq)} onCancel={() => setPicking(false)} />}

      {/* Attribution obligatoire (CC BY). Pas de mention « commerciale » ici :
          vérifier au registre l'entreprise avec qui on fait déjà affaire n'est
          pas l'exploitation commerciale du jeu de données que vise le « NC ». */}
      <ReqSourceNotice className="mt-4 pt-3 border-t border-slate-100" />
    </div>
  )
}
