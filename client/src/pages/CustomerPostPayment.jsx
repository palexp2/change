import { useEffect, useState, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'

// Public page (no auth) — onboarding wizard shown after a customer pays.
// Branches based on detected products + answers. Autosaves per change.

const inputCls = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500'
const btnPrimary = 'inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50'
const btnGhost = 'inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg'

const PROVINCES = ['QC', 'ON', 'NB', 'NS', 'PE', 'NL', 'AB', 'BC', 'MB', 'SK', 'YT', 'NT', 'NU']

// Starter list — to refine with Pap later
const FURNACE_BRANDS = [
  { brand: 'Modine', models: ['PDP', 'PTC', 'PTS', 'PV', 'PA', 'BT', 'BTV', 'BG', 'EF', 'HD'] },
  { brand: 'Reznor', models: ['F', 'UDAP', 'UDAS', 'UEAS', 'UEZ', 'V3', 'X', 'XL', 'P7', 'CF'] },
  { brand: 'Sterling', models: ['GG', 'TF', 'XF', 'QVF', 'HS', 'GFH', 'GFP', 'NEMA'] },
  { brand: 'Roberts Gordon', models: ['CoRayVac', 'Vantage', 'GORDONray', 'Blackheat', 'CTHN', 'CTH2'] },
  { brand: 'Lennox', models: ['LB-LF24', 'LF24', 'LF25', 'EL296V', 'SL280V'] },
  { brand: 'L.B. White', models: ['Therma Grow', 'Guardian', 'Premier 350', 'Premier 170', 'AD-100', 'AW250'] },
]

export default function CustomerPostPayment() {
  const [search] = useSearchParams()
  const sessionId = search.get('session_id')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [resp, setResp] = useState(null)
  const [extrasResult, setExtrasResult] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const saveTimer = useRef(null)

  useEffect(() => {
    if (!sessionId) { setError('Lien invalide — paramètre session_id manquant.'); setLoading(false); return }
    fetch(`/erp/api/customer/post-payment/${encodeURIComponent(sessionId)}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json()).error || 'Erreur')
        return r.json()
      })
      .then(d => {
        setData(d)
        // Pre-fill from existing response, or seed from company context (farm/shipping addresses)
        const seed = d.response || {}
        if (!seed.farm_address && d.context?.farm_address) seed.farm_address = d.context.farm_address
        if (!seed.shipping_address && d.context?.shipping_address) seed.shipping_address = d.context.shipping_address
        setResp(seed)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [sessionId])

  // Autosave (debounced)
  const queueSave = useCallback((patch) => {
    setResp(r => ({ ...r, ...patch }))
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      try {
        await fetch(`/erp/api/customer/post-payment/${encodeURIComponent(sessionId)}/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
      } catch (e) { /* silent — they can retry */ }
    }, 600)
  }, [sessionId])

  if (loading) return <div className="min-h-screen flex items-center justify-center text-slate-500">Chargement…</div>
  if (error) return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-sm border border-slate-200 p-6 text-center">
        <h1 className="text-lg font-semibold text-red-700">Une erreur s'est produite</h1>
        <p className="text-sm text-slate-600 mt-2">{error}</p>
      </div>
    </div>
  )
  if (!data || !resp) return null

  const submitted = resp.status === 'submitted'
  const detected = data.detected || {}
  const permission = resp.permission_level || detected.permission_level
  const hasMobileController = detected.has_mobile_controller

  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4">
      <div className="max-w-2xl mx-auto space-y-5">
        <Header data={data} />
        {submitted ? (
          <SubmittedSummary resp={resp} extrasResult={extrasResult} setExtrasResult={setExtrasResult} sessionId={sessionId} permission={permission} />
        ) : (
          <Wizard
            resp={resp}
            queueSave={queueSave}
            permission={permission}
            hasMobileController={hasMobileController}
            sessionId={sessionId}
            submitting={submitting}
            setSubmitting={setSubmitting}
            onSubmitted={() => setResp(r => ({ ...r, status: 'submitted', submitted_at: new Date().toISOString() }))}
          />
        )}
      </div>
    </div>
  )
}

function Header({ data }) {
  const inv = data.invoice
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
      <h1 className="text-2xl font-bold text-slate-900">Merci pour votre achat</h1>
      <p className="text-slate-600 mt-1">Pour finaliser votre installation, nous avons besoin de quelques informations.</p>
      {inv && (
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-xs text-slate-400 uppercase tracking-wide">Facture</div>
            <div className="font-medium">{inv.number || inv.id}</div>
          </div>
          <div>
            <div className="text-xs text-slate-400 uppercase tracking-wide">Total payé</div>
            <div className="font-medium">{fmtMoney(inv.total, inv.currency)}</div>
          </div>
          {inv.pdf_url && (
            <div className="col-span-2">
              <a href={inv.pdf_url} target="_blank" rel="noreferrer" className="text-xs text-brand-600 hover:underline">Télécharger la facture (PDF)</a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function fmtMoney(amount, currency) {
  if (amount == null) return ''
  try { return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: String(currency || 'CAD').toUpperCase() }).format(amount / 100) }
  catch { return `${(amount / 100).toFixed(2)} $` }
}

// ─── Wizard ───────────────────────────────────────────────────────────────

function Wizard({ resp, queueSave, permission, hasMobileController, sessionId, submitting, setSubmitting, onSubmitted }) {
  const [error, setError] = useState(null)

  // Determine if we have all required answers to enable submit
  const ready = canSubmit(resp, hasMobileController)

  async function handleSubmit() {
    setError(null)
    setSubmitting(true)
    try {
      const r = await fetch(`/erp/api/customer/post-payment/${encodeURIComponent(sessionId)}/submit`, { method: 'POST' })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error || 'Erreur')
      }
      onSubmitted()
    } catch (e) { setError(e.message) }
    finally { setSubmitting(false) }
  }

  return (
    <>
      <Step_NewOrExisting resp={resp} queueSave={queueSave} />
      {resp.is_new_site === 'new' && (
        <>
          <Step_FarmAddress resp={resp} queueSave={queueSave} />
          <Step_ShippingAddress resp={resp} queueSave={queueSave} />
          {!hasMobileController && <Step_Network resp={resp} queueSave={queueSave} />}
          {hasMobileController && (
            <Card title="Réseau">
              <p className="text-sm text-slate-600">Le contrôleur internet mobile est inclus dans votre commande — vous n'avez besoin d'aucun Wi-Fi local. Assurez-vous que l'endroit où sera installé le contrôleur central a une bonne couverture cellulaire.</p>
            </Card>
          )}
        </>
      )}
      {resp.is_new_site === 'add_to_existing' && (
        <Step_ShippingAddress resp={resp} queueSave={queueSave} title="Adresse de livraison" />
      )}
      {resp.is_new_site && <Step_Greenhouses resp={resp} queueSave={queueSave} permission={permission} />}

      {error && <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>}

      {resp.is_new_site && (
        <div className="flex justify-end items-center gap-3">
          {!ready && <span className="text-xs text-slate-500">Complétez les champs obligatoires pour continuer</span>}
          <button onClick={handleSubmit} disabled={!ready || submitting} className={btnPrimary}>
            {submitting ? 'Envoi…' : 'Soumettre'}
          </button>
        </div>
      )}
    </>
  )
}

function canSubmit(resp, hasMobileController) {
  if (!resp.is_new_site) return false
  if (resp.is_new_site === 'new') {
    const farm = resp.farm_address
    if (!farm?.line1 || !farm?.province) return false
    if (resp.shipping_same_as_farm == null) return false
    if (resp.shipping_same_as_farm === false) {
      const ship = resp.shipping_address
      if (!ship?.line1 || !ship?.province) return false
    }
    if (!hasMobileController && !resp.network_access) return false
  } else {
    const ship = resp.shipping_address
    if (!ship?.line1 || !ship?.province) return false
  }
  if (!Number.isFinite(Number(resp.num_greenhouses)) || Number(resp.num_greenhouses) <= 0) return false
  return true
}

// ─── Steps ────────────────────────────────────────────────────────────────

function Card({ title, children }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm space-y-3">
      {title && <h2 className="text-lg font-semibold text-slate-900">{title}</h2>}
      {children}
    </div>
  )
}

function Step_NewOrExisting({ resp, queueSave }) {
  return (
    <Card title="Type de commande">
      <p className="text-sm text-slate-600">Cette commande est pour :</p>
      <div className="space-y-2">
        <RadioOption checked={resp.is_new_site === 'new'} onChange={() => queueSave({ is_new_site: 'new' })} label="Un nouveau site de production avec Orisha" />
        <RadioOption checked={resp.is_new_site === 'add_to_existing'} onChange={() => queueSave({ is_new_site: 'add_to_existing' })} label="Ajouter à un site de production existant qui a déjà Orisha" />
      </div>
    </Card>
  )
}

function Step_FarmAddress({ resp, queueSave }) {
  const a = resp.farm_address || {}
  const setAddr = (patch) => queueSave({ farm_address: { ...a, ...patch } })
  return (
    <Card title="Adresse de la ferme">
      <p className="text-sm text-slate-600">Cette adresse sert à pré-programmer le contrôleur central avec les coordonnées géographiques de votre ferme.</p>
      <AddressForm value={a} onChange={setAddr} />
    </Card>
  )
}

function Step_ShippingAddress({ resp, queueSave, title = "Adresse de livraison" }) {
  const isNew = resp.is_new_site === 'new'
  const same = resp.shipping_same_as_farm
  return (
    <Card title={title}>
      {isNew ? (
        <>
          <p className="text-sm text-slate-600">L'adresse de livraison est-elle la même que celle de la ferme ?</p>
          <div className="space-y-2">
            <RadioOption checked={same === true} onChange={() => queueSave({ shipping_same_as_farm: true })} label="Oui, même adresse" />
            <RadioOption checked={same === false} onChange={() => queueSave({ shipping_same_as_farm: false })} label="Non, différente" />
          </div>
          {same === false && (
            <div className="pt-2">
              <AddressForm value={resp.shipping_address || {}} onChange={(patch) => queueSave({ shipping_address: { ...(resp.shipping_address || {}), ...patch } })} />
            </div>
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-slate-600">Confirmez l'adresse de livraison :</p>
          <AddressForm value={resp.shipping_address || {}} onChange={(patch) => queueSave({ shipping_address: { ...(resp.shipping_address || {}), ...patch } })} />
        </>
      )}
    </Card>
  )
}

function AddressForm({ value, onChange }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Adresse" colSpan={2}>
        <input className={inputCls} value={value.line1 || ''} onChange={e => onChange({ line1: e.target.value })} placeholder="123 rang Saint-Joseph" />
      </Field>
      <Field label="Ville">
        <input className={inputCls} value={value.city || ''} onChange={e => onChange({ city: e.target.value })} />
      </Field>
      <Field label="Province">
        <select className={inputCls} value={value.province || ''} onChange={e => onChange({ province: e.target.value })}>
          <option value="">—</option>
          {PROVINCES.map(p => <option key={p}>{p}</option>)}
        </select>
      </Field>
      <Field label="Code postal">
        <input className={inputCls} value={value.postal_code || ''} onChange={e => onChange({ postal_code: e.target.value })} placeholder="A1A 1A1" />
      </Field>
      <Field label="Pays">
        <input className={inputCls} value={value.country || 'Canada'} onChange={e => onChange({ country: e.target.value })} />
      </Field>
    </div>
  )
}

function Field({ label, colSpan = 1, children }) {
  return (
    <div className={colSpan === 2 ? 'col-span-2' : ''}>
      <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">{label}</label>
      {children}
    </div>
  )
}

function RadioOption({ checked, onChange, label, help }) {
  return (
    <label className={`flex items-start gap-2 p-3 rounded-lg cursor-pointer border ${checked ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
      <input type="radio" checked={checked} onChange={onChange} className="mt-0.5" />
      <div>
        <div className="text-sm text-slate-800">{label}</div>
        {help && <div className="text-xs text-slate-500 mt-0.5">{help}</div>}
      </div>
    </label>
  )
}

function Step_Network({ resp, queueSave }) {
  const v = resp.network_access
  return (
    <Card title="Accès réseau">
      <p className="text-sm text-slate-600">Aurez-vous accès à un câble Ethernet ou un Wi-Fi à moins de 250 pi de la serre, avec une ligne de vue directe ?</p>
      <div className="space-y-2">
        <RadioOption checked={v === 'ethernet'} onChange={() => queueSave({ network_access: 'ethernet' })} label="Oui — câble Ethernet à moins de 250 pi" />
        <RadioOption checked={v === 'wifi_250'} onChange={() => queueSave({ network_access: 'wifi_250' })} label="Oui — Wi-Fi à moins de 250 pi avec ligne de vue" />
        <RadioOption checked={v === 'wifi_350_coax'} onChange={() => queueSave({ network_access: 'wifi_350_coax' })} label="Non, mais 350 pi est possible — fournissez le câble coaxial" help="Nous fournirons un câble coaxial pour monter l'antenne en hauteur (+100 pi de portée)." />
        <RadioOption checked={v === 'mobile_controller'} onChange={() => queueSave({ network_access: 'mobile_controller' })} label="Aucune des options ci-dessus — j'ai besoin d'un contrôleur internet mobile" help="Nous l'ajouterons aux extras à la fin. Nécessite une bonne couverture cellulaire à l'endroit du contrôleur central." />
      </div>
      {(v === 'wifi_250' || v === 'wifi_350_coax') && (
        <div className="pt-3 border-t border-slate-100">
          <p className="text-sm text-slate-600 mb-2">Pour pré-programmer le contrôleur central, fournissez les infos Wi-Fi (optionnel mais recommandé) :</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Nom du Wi-Fi (SSID)">
              <input className={inputCls} value={resp.wifi_ssid || ''} onChange={e => queueSave({ wifi_ssid: e.target.value })} />
            </Field>
            <Field label="Mot de passe">
              <input className={inputCls} value={resp.wifi_password || ''} onChange={e => queueSave({ wifi_password: e.target.value })} />
            </Field>
          </div>
        </div>
      )}
    </Card>
  )
}

function Step_Greenhouses({ resp, queueSave, permission }) {
  const n = Number(resp.num_greenhouses) || 0
  const greenhouses = resp.greenhouses || []

  function setN(newN) {
    const clamped = Math.max(0, Math.min(50, parseInt(newN) || 0))
    const arr = [...greenhouses]
    while (arr.length < clamped) arr.push({})
    arr.length = clamped
    queueSave({ num_greenhouses: clamped, greenhouses: arr })
  }

  function setGreenhouse(idx, patch) {
    const arr = greenhouses.map((g, i) => i === idx ? { ...g, ...patch } : g)
    queueSave({ greenhouses: arr })
  }

  return (
    <>
      <Card title="Serres à automatiser">
        <Field label="Combien de serres voulez-vous automatiser avec Orisha ?">
          <input type="number" min={1} max={50} className={inputCls} value={n || ''} onChange={e => setN(e.target.value)} />
        </Field>
      </Card>
      {greenhouses.map((g, i) => (
        <GreenhouseCard key={i} idx={i} g={g} onChange={(patch) => setGreenhouse(i, patch)} permission={permission} />
      ))}
    </>
  )
}

function GreenhouseCard({ idx, g, onChange, permission }) {
  return (
    <Card title={`Serre #${idx + 1}`}>
      {/* Helper questions (always shown — chief grower includes helper questions) */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Longueur de la serre (pi)">
          <input type="number" className={inputCls} value={g.length || ''} onChange={e => onChange({ length: e.target.value })} />
        </Field>
        <Field label="Hauteur des côtés ouvrants (pi)">
          <input type="number" className={inputCls} value={g.side_vent_height || ''} onChange={e => onChange({ side_vent_height: e.target.value })} />
        </Field>
      </div>
      <Field label="Type de tuyau de côté">
        <select className={inputCls} value={g.side_pipe_type || ''} onChange={e => onChange({ side_pipe_type: e.target.value, side_pipe_diameter: '' })}>
          <option value="">—</option>
          <option value="aluminum_C">Aluminium extrudé (profil C)</option>
          <option value="steel_O">Acier (profil rond / O)</option>
        </select>
      </Field>
      {g.side_pipe_type === 'aluminum_C' && (
        <DiameterPicker label="Diamètre du tuyau aluminium" defaultOption='2"' value={g.side_pipe_diameter} onChange={(v) => onChange({ side_pipe_diameter: v })} />
      )}
      {g.side_pipe_type === 'steel_O' && (
        <DiameterPicker label="Diamètre du tuyau acier" defaultOption='1 5/16"' value={g.side_pipe_diameter} onChange={(v) => onChange({ side_pipe_diameter: v })} />
      )}

      <div className="pt-2 border-t border-slate-100">
        <Field label="Tuyaux guides">
          <select className={inputCls} value={g.guide_pipes_state || ''} onChange={e => onChange({ guide_pipes_state: e.target.value, guide_pipe_diameter: '' })}>
            <option value="">—</option>
            <option value="present">Déjà présents</option>
            <option value="needed">À fournir</option>
          </select>
        </Field>
        {g.guide_pipes_state === 'present' && (
          <>
            <DiameterPicker label="Diamètre des tuyaux guides existants" defaultOption='1 5/16"' value={g.guide_pipe_diameter} onChange={(v) => onChange({ guide_pipe_diameter: v })} />
            {g.guide_pipe_diameter && g.guide_pipe_diameter.startsWith('Autre:') && (
              <CompatibilityWarning value={g.guide_pipe_diameter.replace('Autre:', '').trim()} onAccept={() => onChange({ wants_compatible_guide_pipes: true })} accepted={!!g.wants_compatible_guide_pipes} />
            )}
          </>
        )}
      </div>

      {permission === 'chief_grower' && (
        <ChiefGrowerSection g={g} onChange={onChange} />
      )}
    </Card>
  )
}

function DiameterPicker({ label, defaultOption, value, onChange }) {
  const isOther = value && value.startsWith('Autre:')
  const otherText = isOther ? value.replace('Autre:', '').trim() : ''
  return (
    <div className="pl-2 border-l-2 border-slate-100 space-y-2">
      <Field label={label}>
        <select className={inputCls} value={isOther ? '__other' : (value || '')} onChange={e => {
          if (e.target.value === '__other') onChange('Autre: ')
          else onChange(e.target.value)
        }}>
          <option value="">—</option>
          <option value={defaultOption}>{defaultOption}</option>
          <option value="__other">Autre (préciser)</option>
        </select>
      </Field>
      {isOther && (
        <Field label="Diamètre exact">
          <input className={inputCls} value={otherText} onChange={e => onChange(`Autre: ${e.target.value}`)} placeholder="Ex. 1 1/2&quot;" />
        </Field>
      )}
    </div>
  )
}

function CompatibilityWarning({ value, onAccept, accepted }) {
  // Crude heuristic: warn if the dimension contains "1/2" or numbers different from 1 5/16
  return (
    <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 mt-2">
      <p className="font-medium">Compatibilité à vérifier</p>
      <p className="text-xs mt-1">Le diamètre « {value || '—'} » pourrait ne pas être compatible avec nos moteurs (recommandé : 1 5/16"). Voulez-vous que nous vous fournissions des tuyaux guides compatibles ?</p>
      <label className="mt-2 inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={accepted} onChange={onAccept} />
        Oui, ajouter des tuyaux guides compatibles aux extras
      </label>
    </div>
  )
}

function ChiefGrowerSection({ g, onChange }) {
  const numFurnaces = Number(g.num_furnaces) || 0
  const furnaces = g.furnaces || []
  function setNumFurnaces(n) {
    const clamped = Math.max(0, Math.min(20, parseInt(n) || 0))
    const arr = [...furnaces]
    while (arr.length < clamped) arr.push({})
    arr.length = clamped
    onChange({ num_furnaces: clamped, furnaces: arr })
  }
  function setFurnace(idx, patch) {
    const arr = furnaces.map((f, i) => i === idx ? { ...f, ...patch } : f)
    onChange({ furnaces: arr })
  }
  const irrZones = Number(g.irrigation_zones) || 0
  const baseZones = 4
  const extraBlocks = Math.max(0, Math.ceil((irrZones - baseZones) / 4))

  return (
    <div className="pt-3 border-t border-slate-100 space-y-3">
      <h3 className="text-sm font-semibold text-slate-800">Fournaises</h3>
      <Field label="Nombre de fournaises dans cette serre">
        <input type="number" min={0} max={20} className={inputCls} value={numFurnaces || ''} onChange={e => setNumFurnaces(e.target.value)} />
      </Field>
      {furnaces.map((f, i) => (
        <FurnaceForm key={i} idx={i} f={f} onChange={(patch) => setFurnace(i, patch)} />
      ))}

      <h3 className="text-sm font-semibold text-slate-800 pt-2 border-t border-slate-100">Irrigation</h3>
      <Field label="Combien de zones d'irrigation pour cette serre ?">
        <input type="number" min={0} max={50} className={inputCls} value={irrZones || ''} onChange={e => onChange({ irrigation_zones: e.target.value })} />
      </Field>
      {irrZones > baseZones && (
        <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-sm text-blue-800">
          Plus de {baseZones} zones — il faudra {extraBlocks} bloc{extraBlocks > 1 ? 's' : ''} de 4 valves supplémentaires (400 $ unique ou 25 $/mois par bloc). Vous pourrez choisir à la fin.
        </div>
      )}
      {irrZones > 0 && (
        <Field label="Souhaitez-vous qu'Orisha fournisse les valves 1 po ?">
          <select className={inputCls} value={g.needs_orisha_valves == null ? '' : (g.needs_orisha_valves ? 'yes' : 'no')} onChange={e => onChange({ needs_orisha_valves: e.target.value === 'yes' })}>
            <option value="">—</option>
            <option value="yes">Oui, fournir les valves 1 po</option>
            <option value="no">Non, j'ai déjà mes valves</option>
          </select>
        </Field>
      )}
    </div>
  )
}

function FurnaceForm({ idx, f, onChange }) {
  const brand = FURNACE_BRANDS.find(b => b.brand === f.brand)
  return (
    <div className="rounded-lg border border-slate-200 p-3 space-y-2">
      <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">Fournaise #{idx + 1}</div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Marque">
          <select className={inputCls} value={f.brand || ''} onChange={e => onChange({ brand: e.target.value, model: '' })}>
            <option value="">—</option>
            {FURNACE_BRANDS.map(b => <option key={b.brand}>{b.brand}</option>)}
            <option value="Autre">Autre</option>
          </select>
        </Field>
        <Field label="Modèle">
          {brand ? (
            <select className={inputCls} value={f.model || ''} onChange={e => onChange({ model: e.target.value })}>
              <option value="">—</option>
              {brand.models.map(m => <option key={m}>{m}</option>)}
              <option value="Autre">Autre</option>
            </select>
          ) : (
            <input className={inputCls} value={f.model || ''} onChange={e => onChange({ model: e.target.value })} placeholder="Marque + modèle" />
          )}
        </Field>
        {f.model === 'Autre' && (
          <Field label="Précisez le modèle" colSpan={2}>
            <input className={inputCls} value={f.model_other || ''} onChange={e => onChange({ model_other: e.target.value })} />
          </Field>
        )}
      </div>
      <Field label="Filage de contrôle requis ? (pieds)" >
        <input type="number" min={0} className={inputCls} value={f.control_wire_feet || ''} onChange={e => onChange({ control_wire_feet: e.target.value })} placeholder="Ex. 50" />
        <div className="text-xs text-slate-500 mt-1">Pensez à inclure les longueurs verticales (monter, traverser une porte, redescendre) — pas seulement la distance horizontale.</div>
      </Field>
      <Field label="Thermostat de secours requis ? (gratuit)">
        <select className={inputCls} value={f.backup_thermostat == null ? '' : (f.backup_thermostat ? 'yes' : 'no')} onChange={e => onChange({ backup_thermostat: e.target.value === 'yes' })}>
          <option value="">—</option>
          <option value="yes">Oui, fournir un thermostat de secours</option>
          <option value="no">Non merci</option>
        </select>
      </Field>
    </div>
  )
}

// ─── Submitted summary + extras flow ──────────────────────────────────────

function SubmittedSummary({ resp, extrasResult, setExtrasResult, sessionId, permission }) {
  const extras = computeExtras(resp, permission)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)

  async function handleBuyExtras() {
    setErr(null); setLoading(true)
    try {
      const r = await fetch(`/erp/api/customer/post-payment/${encodeURIComponent(sessionId)}/extras`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: extras.items }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error || 'Erreur')
      }
      const data = await r.json()
      setExtrasResult(data)
      // Auto-redirect to checkout
      if (data.checkout_url) {
        setTimeout(() => { window.location.href = data.checkout_url }, 1200)
      }
    } catch (e) { setErr(e.message) }
    finally { setLoading(false) }
  }

  return (
    <Card title="Informations enregistrées">
      <p className="text-sm text-slate-700">Merci, nous avons bien reçu vos informations. Notre équipe va les utiliser pour préparer votre installation.</p>
      {extras.items.length > 0 && !extrasResult && (
        <div className="mt-3 rounded-lg bg-blue-50 border border-blue-200 p-4">
          <h3 className="font-semibold text-blue-900">Extras suggérés selon vos réponses</h3>
          <ul className="text-sm text-blue-900 mt-2 list-disc pl-5 space-y-0.5">
            {extras.items.map((it, i) => (
              <li key={i}>{it.qty} × {it.description} — {fmtMoney(Math.round(it.unit_price * 100), 'CAD')} l'unité</li>
            ))}
          </ul>
          <p className="text-sm text-blue-800 mt-2">Voulez-vous les acheter maintenant ? Vous serez redirigé vers une page de paiement Stripe.</p>
          <div className="mt-3 flex gap-2">
            <button onClick={handleBuyExtras} disabled={loading} className={btnPrimary}>{loading ? 'Création…' : 'Acheter les extras'}</button>
            <button onClick={() => setExtrasResult({ skipped: true })} className={btnGhost}>Non merci</button>
          </div>
          {err && <div className="mt-2 text-sm text-red-700">{err}</div>}
        </div>
      )}
      {extrasResult?.checkout_url && (
        <div className="mt-3 rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-800">
          Redirection vers Stripe… <a href={extrasResult.checkout_url} className="underline">cliquez ici si rien ne se passe</a>.
        </div>
      )}
    </Card>
  )
}

// Compute extras from the response — called after submission.
// Returns { items: [{ role, qty, unit_price, description }] }.
function computeExtras(resp, permission) {
  const items = []
  // Mobile controller — if customer asked for it via network step
  if (resp.network_access === 'mobile_controller') {
    items.push({ role: 'mobile_controller', qty: 1, description: 'Contrôleur internet mobile (1 unité)', unit_price: 0 })
  }
  if (permission === 'chief_grower') {
    let extraValveBlocks = 0
    let needsValves = 0
    for (const g of (resp.greenhouses || [])) {
      const z = Number(g.irrigation_zones) || 0
      if (z > 4) extraValveBlocks += Math.ceil((z - 4) / 4)
      if (z > 0 && g.needs_orisha_valves) needsValves += z
    }
    if (extraValveBlocks > 0) {
      items.push({ role: 'valve_block_onetime', qty: extraValveBlocks, description: `${extraValveBlocks} bloc(s) de 4 valves d'irrigation supplémentaires`, unit_price: 0 })
    }
    if (needsValves > 0) {
      items.push({ role: 'valve_1in', qty: needsValves, description: `${needsValves} valve(s) 1 po`, unit_price: 0 })
    }
  }
  // Compatible guide pipes
  let needsGuidePipes = 0
  for (const g of (resp.greenhouses || [])) {
    if (g.wants_compatible_guide_pipes) {
      needsGuidePipes += Number(g.length || 0) > 0 ? Math.ceil(Number(g.length) / 6) : 1
    }
  }
  if (needsGuidePipes > 0) {
    items.push({ role: 'guide_pipe', qty: needsGuidePipes, description: `${needsGuidePipes} tuyau(x) guide(s) compatible(s)`, unit_price: 0 })
  }
  return { items }
}
