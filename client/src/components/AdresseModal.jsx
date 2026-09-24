import { useState, useEffect, useRef } from 'react'
import api from '../lib/api.js'
import { Modal } from './Modal.jsx'
import Spinner from './Spinner.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'
import LinkedRecordField from './LinkedRecordField.jsx'
import { AddressCheckPanel, AddressConfirmPanel, parseCheckIssues } from './AddressCheckIssues.jsx'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { useToast } from '../contexts/ToastContext.jsx'

// États US et provinces/territoires CA — libellés complets pour rendre la recherche utile,
// valeur = code à 2 lettres (format stocké en DB).
export const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['FL', 'Florida'], ['GA', 'Georgia'],
  ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
  ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'],
  ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'],
  ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
  ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'],
  ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
].map(([value, name]) => ({ value, label: `${value} — ${name}` }))

export const CA_PROVINCES = [
  ['AB', 'Alberta'], ['BC', 'Colombie-Britannique'], ['MB', 'Manitoba'], ['NB', 'Nouveau-Brunswick'],
  ['NL', 'Terre-Neuve-et-Labrador'], ['NS', 'Nouvelle-Écosse'], ['NT', 'Territoires du Nord-Ouest'],
  ['NU', 'Nunavut'], ['ON', 'Ontario'], ['PE', 'Île-du-Prince-Édouard'], ['QC', 'Québec'],
  ['SK', 'Saskatchewan'], ['YT', 'Yukon'],
].map(([value, name]) => ({ value, label: `${value} — ${name}` }))

export const EMPTY_ADRESSE_FORM = {
  line1: '', city: '', province: '', postal_code: '', country: 'CA', address_type: 'Ferme', contact_id: '',
}

export function adresseToForm(a) {
  return {
    line1: a?.line1 || '',
    city: a?.city || '',
    province: a?.province || '',
    postal_code: a?.postal_code || '',
    country: a?.country || 'CA',
    address_type: a?.address_type || 'Ferme',
    contact_id: a?.contact_id || '',
  }
}

// Formulaire d'adresse partagé : édition (autosave champ par champ) ou création.
// `contacts` alimente le champ « Contact associé » ; `onSaved`/`onCreated`
// remontent la ligne renvoyée par l'API à l'appelant.
export function AdresseModalContent({
  companyId, contacts = [], editingAdresse, adresseForm, setAdresseForm, onSaved, onCreated, onClose,
}) {
  const isEdit = !!editingAdresse
  const { addToast } = useToast()
  const [fieldSaving, setFieldSaving] = useState({})
  const [saving, setSaving] = useState(false)
  // Verdict du vérificateur d'adresses, rafraîchi à chaque autosave : l'erreur
  // apparaît sous les yeux de l'utilisateur pendant qu'il corrige.
  const [check, setCheck] = useState(() => ({
    status: editingAdresse?.check_status || null,
    issues: parseCheckIssues(editingAdresse?.check_issues),
  }))
  // Confirmation auprès de l'API d'adresses (livraison / ferme). En édition,
  // elle arrive du serveur ; en création, du contrôle fait avant d'enregistrer.
  const [confirm, setConfirm] = useState(() => ({
    status: editingAdresse?.confirm_status || null,
    formatted: editingAdresse?.confirm_formatted || '',
    suggestion: editingAdresse?.confirm_suggestion || null,
  }))
  const [confirming, setConfirming] = useState(false)

  // Dernière ligne connue du serveur, et ses valeurs de formulaire : un champ
  // dont la saisie diffère de cette base est en cours d'édition — une
  // modification distante ne l'écrase pas.
  const serverRef = useRef(editingAdresse || null)
  const baseRef = useRef(adresseToForm(editingAdresse))
  useEffect(() => {
    serverRef.current = editingAdresse || null
    baseRef.current = adresseToForm(editingAdresse)
  }, [editingAdresse])

  const applySaved = (updated) => {
    serverRef.current = { ...serverRef.current, ...updated }
    baseRef.current = adresseToForm(serverRef.current)
    onSaved?.(updated)
    setCheck({ status: updated.check_status || null, issues: parseCheckIssues(updated.check_issues) })
    setConfirm({
      status: updated.confirm_status || null,
      formatted: updated.confirm_formatted || '',
      suggestion: updated.confirm_suggestion || null,
    })
  }

  // L'appelant peut fournir une ligne rafraîchie (verdict compris) sans que la
  // modale se remonte.
  useEffect(() => {
    setCheck({ status: editingAdresse?.check_status || null, issues: parseCheckIssues(editingAdresse?.check_issues) })
  }, [editingAdresse?.id, editingAdresse?.check_status, editingAdresse?.check_issues])

  useEffect(() => {
    setConfirm({
      status: editingAdresse?.confirm_status || null,
      formatted: editingAdresse?.confirm_formatted || '',
      suggestion: editingAdresse?.confirm_suggestion || null,
    })
  }, [editingAdresse?.id, editingAdresse?.confirm_status, editingAdresse?.confirm_suggestion,
    editingAdresse?.confirm_formatted])

  // Le verdict peut aussi être recalculé côté serveur pendant que la modale est
  // ouverte (import, formulaire du client, vérificateur en tâche de fond) — et
  // la confirmation d'adresse arrive TOUJOURS par ce canal : elle part en
  // tâche de fond après l'écriture, la réponse du PUT est déjà partie.
  useRealtimeChannel(editingAdresse?.id ? `adresse:${editingAdresse.id}` : null, (msg) => {
    if (msg.type !== 'adresse:updated') return
    const p = msg.payload || {}
    const remoteKeys = Object.keys(EMPTY_ADRESSE_FORM).filter(k => p[k] !== undefined)
    if (remoteKeys.length) {
      const merged = { ...serverRef.current, ...p }
      const remote = adresseToForm(merged)
      const base = baseRef.current
      const patch = {}
      let conflict = false
      for (const k of remoteKeys) {
        if (remote[k] === base[k] || remote[k] === adresseForm[k]) continue
        if (adresseForm[k] !== base[k]) conflict = true
        else patch[k] = remote[k]
      }
      serverRef.current = merged
      baseRef.current = remote
      if (Object.keys(patch).length) setAdresseForm(f => ({ ...f, ...patch }))
      if (conflict) addToast({ message: 'Adresse modifiée ailleurs — votre saisie est conservée', type: 'warning' })
      onSaved?.(merged)
    }
    if (p.check_status !== undefined) {
      setCheck({ status: msg.payload.check_status || null, issues: parseCheckIssues(msg.payload.check_issues) })
    }
    if (msg.payload?.confirm_status !== undefined) {
      setConfirm({
        status: msg.payload.confirm_status || null,
        formatted: msg.payload.confirm_formatted || '',
        suggestion: msg.payload.confirm_suggestion || null,
      })
    }
  })

  const saveField = async (key, value) => {
    setAdresseForm(f => ({ ...f, [key]: value }))
    if (!isEdit) return
    setFieldSaving(s => ({ ...s, [key]: true }))
    try {
      applySaved(await api.adresses.update(editingAdresse.id, { [key]: value }))
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setFieldSaving(s => ({ ...s, [key]: false }))
    }
  }

  const saveCountry = async (value) => {
    setAdresseForm(f => ({ ...f, country: value, province: '' }))
    if (!isEdit) return
    setFieldSaving(s => ({ ...s, country: true }))
    try {
      applySaved(await api.adresses.update(editingAdresse.id, { country: value, province: '' }))
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setFieldSaving(s => ({ ...s, country: false }))
    }
  }

  async function create(values) {
    setSaving(true)
    try {
      const created = await api.adresses.create({ ...values, company_id: companyId })
      onCreated?.(created)
      onClose()
    } catch (err) { addToast({ message: err.message, type: 'error' }) } finally { setSaving(false) }
  }

  // Création : l'adresse passe par l'API de vérification AVANT d'être
  // enregistrée. Le serveur décide seul des types concernés (livraison,
  // ferme) et répond « skipped » pour les autres. Une adresse confirmée
  // s'enregistre sans un clic de plus ; sinon l'utilisateur tranche entre
  // l'écriture proposée et la sienne.
  async function handleSubmitCreate(e) {
    e.preventDefault()
    setConfirming(true)
    let verdict = null
    try {
      verdict = await api.adresses.confirmInput(adresseForm)
    } catch {
      verdict = null // API muette : on n'empêche pas d'enregistrer.
    } finally { setConfirming(false) }

    if (verdict && (verdict.status === 'corrected' || verdict.status === 'not_found')) {
      // Le serveur rend la liste des champs qui divergent à part ; la ligne
      // stockée en base les porte dans la suggestion — même forme des deux
      // côtés pour que le panneau n'ait qu'une lecture à faire.
      setConfirm({
        status: verdict.status,
        formatted: verdict.formatted,
        suggestion: verdict.suggestion ? { ...verdict.suggestion, diff: verdict.diff } : null,
      })
      return
    }
    setConfirm({ status: verdict?.status || null, formatted: verdict?.formatted || '', suggestion: null })
    await create(adresseForm)
  }

  // « Utiliser » : l'écriture proposée remplace la saisie. En édition elle part
  // en autosave, en création elle enregistre dans la foulée.
  async function applySuggestion(s) {
    const patch = {
      line1: s.line1 || '', city: s.city || '', province: s.province || '',
      postal_code: s.postal_code || '', country: s.country || adresseForm.country,
    }
    setAdresseForm(f => ({ ...f, ...patch }))
    if (!isEdit) { await create({ ...adresseForm, ...patch }); return }
    setFieldSaving(s2 => ({ ...s2, line1: true }))
    try {
      applySaved(await api.adresses.update(editingAdresse.id, patch))
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally { setFieldSaving(s2 => ({ ...s2, line1: false })) }
  }

  async function reconfirm() {
    if (!isEdit) { await handleSubmitCreate({ preventDefault() {} }); return }
    setConfirming(true)
    try {
      applySaved(await api.adresses.reconfirm(editingAdresse.id))
    } catch (err) { addToast({ message: err.message, type: 'error' }) } finally { setConfirming(false) }
  }

  const anySaving = Object.values(fieldSaving).some(Boolean)

  const fields = (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <AddressCheckPanel
        adresseId={editingAdresse?.id}
        status={check.status}
        issues={check.issues}
        onChecked={applySaved}
        className="col-span-2"
      />
      <AddressConfirmPanel
        status={confirm.status}
        formatted={confirm.formatted}
        suggestion={confirm.suggestion}
        busy={confirming || saving}
        onApply={applySuggestion}
        onKeep={isEdit ? undefined : () => create(adresseForm)}
        onRecheck={reconfirm}
        className="col-span-2"
      />
      <div className="col-span-2">
        <label className="label">Rue / Ligne 1</label>
        <input
          value={adresseForm.line1}
          onChange={e => setAdresseForm(f => ({ ...f, line1: e.target.value }))}
          onBlur={isEdit ? e => saveField('line1', e.target.value) : undefined}
          className="input"
        />
      </div>
      <div>
        <label className="label">Ville</label>
        <input
          value={adresseForm.city}
          onChange={e => setAdresseForm(f => ({ ...f, city: e.target.value }))}
          onBlur={isEdit ? e => saveField('city', e.target.value) : undefined}
          className="input"
        />
      </div>
      <div>
        <label className="label">Province / État</label>
        <SearchableSelect
          value={adresseForm.province || ''}
          options={adresseForm.country === 'US' ? US_STATES : CA_PROVINCES}
          emptyOption="—"
          onChange={v => isEdit ? saveField('province', v) : setAdresseForm(f => ({ ...f, province: v }))}
          className="input"
          size="sm"
          testId="adresse-province-select"
        />
      </div>
      <div>
        <label className="label">Code postal</label>
        <input
          value={adresseForm.postal_code}
          onChange={e => setAdresseForm(f => ({ ...f, postal_code: e.target.value }))}
          onBlur={isEdit ? e => saveField('postal_code', e.target.value) : undefined}
          className="input"
        />
      </div>
      <div>
        <label className="label">Pays</label>
        <select value={adresseForm.country} onChange={e => saveCountry(e.target.value)} className="select">
          <option value="CA">Canada (CA)</option>
          <option value="US">États-Unis (US)</option>
        </select>
      </div>
      <div>
        <label className="label">Type</label>
        <select
          value={adresseForm.address_type}
          onChange={e => isEdit ? saveField('address_type', e.target.value) : setAdresseForm(f => ({ ...f, address_type: e.target.value }))}
          className="select"
        >
          {['Ferme', 'Livraison', 'Facturation'].map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div className="col-span-2">
        <label className="label">Contact associé</label>
        <LinkedRecordField
          name="address_contact_id"
          value={adresseForm.contact_id}
          options={contacts}
          labelFn={c => `${c.first_name || ''} ${c.last_name || ''}`.trim()}
          getHref={c => `/contacts/${c.id}`}
          saving={!!fieldSaving.contact_id}
          onChange={v => isEdit ? saveField('contact_id', v) : setAdresseForm(f => ({ ...f, contact_id: v }))}
        />
      </div>
    </div>
  )

  if (isEdit) {
    return (
      <div className="space-y-4">
        {fields}
        <div className="flex items-center justify-end gap-3 pt-2">
          {anySaving && <span className="text-xs text-slate-400">Sauvegarde…</span>}
          <button type="button" onClick={onClose} className="btn-secondary">Fermer</button>
        </div>
      </div>
    )
  }
  return (
    <form onSubmit={handleSubmitCreate} className="space-y-4">
      {fields}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving || confirming} className="btn-primary">
          {confirming ? 'Vérification…' : saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>
    </form>
  )
}

// Modale d'édition autonome : charge l'adresse (et les contacts de son entreprise)
// à partir de son seul id. Utilisée depuis les fiches qui référencent une adresse
// sans en détenir la liste complète (ex. fiche envoi).
export function AdresseEditModal({ adresseId, isOpen, onClose, onSaved }) {
  const [adresse, setAdresse] = useState(null)
  const [form, setForm] = useState(EMPTY_ADRESSE_FORM)
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isOpen || !adresseId) return
    let cancelled = false
    setLoading(true)
    setError('')
    setAdresse(null)
    setContacts([])
    api.adresses.get(adresseId)
      .then(async (a) => {
        if (cancelled) return
        setAdresse(a)
        setForm(adresseToForm(a))
        if (a.company_id) {
          try {
            const r = await api.contacts.list({ company_id: a.company_id, limit: 'all' })
            if (!cancelled) setContacts(r.data || [])
          } catch { /* le picker de contact reste vide, l'édition de l'adresse fonctionne */ }
        }
      })
      .catch(e => { if (!cancelled) setError(e.message || 'Adresse introuvable') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [isOpen, adresseId])

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Modifier l'adresse" size="lg">
      {loading ? (
        <div className="py-8 flex justify-center"><Spinner /></div>
      ) : error ? (
        <p className="py-6 text-sm text-red-600" data-testid="adresse-edit-error">{error}</p>
      ) : adresse ? (
        <AdresseModalContent
          companyId={adresse.company_id}
          contacts={contacts}
          editingAdresse={adresse}
          adresseForm={form}
          setAdresseForm={setForm}
          onSaved={updated => { setAdresse(updated); onSaved?.(updated) }}
          onClose={onClose}
        />
      ) : null}
    </Modal>
  )
}

export default AdresseEditModal
