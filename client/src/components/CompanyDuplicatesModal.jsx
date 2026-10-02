import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Users, ShoppingCart, FolderKanban, FileText, Merge, X } from 'lucide-react'
import api from '../lib/api.js'
import { Modal } from './Modal.jsx'
import { Badge, phaseBadgeColor } from './Badge.jsx'
import Spinner from './Spinner.jsx'
import ErrorBanner from './ErrorBanner.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'
import { useToast } from '../contexts/ToastContext.jsx'

// Outil « Doublons » de la liste des entreprises : groupes suspects (nom
// normalisé, courriel, domaine, NEQ), choix de la fiche gardée, résolution des
// champs en conflit, fusion. Voir server/src/services/companyMerge.js.

const REASON = { name: 'Nom', email: 'Courriel', domain: 'Domaine', neq: 'NEQ' }
const COUNT_ICONS = [['contacts', Users], ['orders', ShoppingCart], ['projects', FolderKanban], ['factures', FileText]]

function Counts({ counts }) {
  return (
    <span className="flex items-center gap-2 text-xs text-slate-500">
      {COUNT_ICONS.filter(([k]) => counts[k]).map(([k, Icon]) => (
        <span key={k} className="inline-flex items-center gap-0.5"><Icon size={12} />{counts[k]}</span>
      ))}
    </span>
  )
}

function Group({ group, onDone, manual = false }) {
  const [keep, setKeep] = useState(group.members[0].id)
  const [preview, setPreview] = useState(null)
  const [pick, setPick] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const { addToast } = useToast()
  const drops = group.members.filter(m => m.id !== keep).map(m => m.id)

  async function openPreview() {
    setBusy(true); setError(null)
    try {
      const p = await api.companies.mergePreview(keep, drops)
      setPreview(p)
      setPick(Object.fromEntries(p.fields.map(f => [f.col, f.values[0].id])))
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  async function merge() {
    setBusy(true); setError(null)
    try {
      await api.companies.merge({ keep_id: keep, drop_ids: drops, pick })
      addToast({ type: 'success', message: 'Fusionné', duration: 2500 })
      onDone(group.key, keep)
    } catch (e) { setError(e.message); setBusy(false) }
  }

  async function dismiss() {
    setBusy(true)
    try { await api.companies.dismissDuplicates(group.members.map(m => m.id)); onDone(group.key) }
    catch (e) { setError(e.message); setBusy(false) }
  }

  return (
    <div className="card p-3" data-testid="company-dup-group">
      {group.reasons.length > 0 && <div className="flex items-center gap-1 mb-2">
        {group.reasons.map(r => <Badge key={r} color="gray">{REASON[r] || r}</Badge>)}
      </div>}
      <div className="space-y-1">
        {group.members.map(m => (
          <label key={m.id} className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="radio" checked={keep === m.id} disabled={!!preview}
              onChange={() => setKeep(m.id)} title="Garder" />
            <Link to={`/companies/${m.id}`} className="font-medium text-brand-700 hover:underline truncate">
              {m.name || '—'}
            </Link>
            {m.lifecycle_phase && <Badge color={phaseBadgeColor(m.lifecycle_phase)}>{m.lifecycle_phase}</Badge>}
            <span className="text-xs text-slate-400 truncate">{[m.city, m.province].filter(Boolean).join(', ')}</span>
            <span className="ml-auto"><Counts counts={m.counts} /></span>
          </label>
        ))}
      </div>

      {preview && preview.fields.length > 0 && (
        <div className="mt-3 border-t border-slate-100 pt-2 space-y-1.5">
          {preview.fields.map(f => (
            <div key={f.col} className="flex items-start gap-3 text-sm">
              <span className="w-32 shrink-0 text-xs text-slate-500 pt-0.5">{f.label}</span>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {f.values.map(v => (
                  <label key={v.id} className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" checked={pick[f.col] === v.id}
                      onChange={() => setPick(p => ({ ...p, [f.col]: v.id }))} />
                    <span className="break-all">{String(v.value)}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <ErrorBanner className="mt-2">{error}</ErrorBanner>}

      <div className="flex items-center justify-end gap-2 mt-3">
        {busy && <Spinner size="sm" />}
        {preview ? (
          <>
            <button className="btn-ghost btn-sm" disabled={busy} onClick={() => setPreview(null)}>Annuler</button>
            <button className="btn-primary btn-sm" disabled={busy} onClick={merge} data-testid="company-dup-confirm">
              <Merge size={14} /> Confirmer
            </button>
          </>
        ) : (
          <>
            {!manual && (
              <button className="btn-ghost btn-sm" disabled={busy} onClick={dismiss}>
                <X size={14} /> Pas un doublon
              </button>
            )}
            <button className="btn-primary btn-sm" disabled={busy} onClick={openPreview} data-testid="company-dup-merge">
              <Merge size={14} /> Fusionner
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export function CompanyDuplicatesModal({ isOpen, onClose, onMerged }) {
  const [groups, setGroups] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!isOpen) return
    setGroups(null); setError(null)
    api.companies.duplicateGroups().then(r => setGroups(r.data || [])).catch(e => setError(e.message))
  }, [isOpen])

  function done(key) {
    setGroups(gs => gs.filter(g => g.key !== key))
    onMerged?.()
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl"
      title={`Doublons${groups ? ` · ${groups.length}` : ''}`}>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {!groups && !error && <div className="flex justify-center py-8"><Spinner /></div>}
      {groups && groups.length === 0 && <p className="text-sm text-slate-500 py-6 text-center">Aucun doublon</p>}
      {groups && groups.length > 0 && (
        <div className="space-y-3">
          {groups.map(g => <Group key={g.key} group={g} onDone={done} />)}
        </div>
      )}
    </Modal>
  )
}

// Fusion lancée depuis la fiche entreprise : on choisit l'autre fiche, puis même
// écran que l'outil « Doublons ». onMerged(id de la fiche gardée).
export function CompanyMergeModal({ isOpen, onClose, company, onMerged }) {
  const [companies, setCompanies] = useState([])
  const [otherId, setOtherId] = useState(null)

  useEffect(() => {
    if (!isOpen) return
    setOtherId(null)
    api.companies.lookup().then(setCompanies).catch(() => setCompanies([]))
  }, [isOpen])

  const options = companies.filter(c => c.id !== company?.id)
  const other = options.find(c => c.id === otherId)
  const group = company && other && {
    key: `${company.id}:${other.id}`,
    reasons: [],
    members: [
      { id: company.id, name: company.name, lifecycle_phase: company.lifecycle_phase, city: company.city, province: company.province, counts: {} },
      { id: other.id, name: other.name, counts: {} },
    ],
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" title="Fusionner">
      <div className="space-y-3">
        <SearchableSelect
          value={otherId}
          options={options}
          onChange={setOtherId}
          getOptionValue={c => c.id}
          getOptionLabel={c => c.name || '—'}
          className="input-field text-sm w-full"
          size="sm"
          testId="company-merge-target"
        />
        {group && <Group key={group.key} group={group} manual onDone={(_, keep) => onMerged?.(keep)} />}
      </div>
    </Modal>
  )
}
