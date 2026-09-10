import { useEffect, useState, useCallback, useRef, useMemo, createContext, useContext } from 'react'
import { useSearchParams, useParams } from 'react-router-dom'
import Spinner from '../components/Spinner.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { fmtMoney } from '../utils/formatters.js'
import ErrorBanner from '../components/ErrorBanner.jsx'
import { buildForm, customAnswered } from '../lib/discoveryFormSchema.js'
import GreenhouseIllustration from '../components/GreenhouseIllustration.jsx'
import { focusForSection, focusLabel } from '../lib/greenhouseFocus.js'

// Public page (no auth). Deux entrées :
//   - /customer/post-payment?session_id=cs_xxx  → flow Stripe Checkout (legacy)
//   - /d/:token                                  → formulaire de découverte standalone
// Dans les deux cas, mêmes étapes ; en mode by-token le nb de serres est verrouillé
// (les cartes sont pré-créées 1-pour-1 à partir des Helper/Chef de culture commandés).
//
// Les libellés, les choix et les questions supplémentaires viennent du schéma
// éditable (lib/discoveryFormSchema.js + calque servi dans `form_schema`) : la
// page rend une structure, pas un texte figé. Cf. /discovery-form-editor.

const inputCls = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500'
const btnPrimary = 'inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50'
const btnGhost = 'inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg'

// value = code à 2 lettres (sauvegardé), label = code + nom complet pour la recherche
const PROVINCES = [
  { value: 'QC', label: 'QC — Québec' },
  { value: 'ON', label: 'ON — Ontario' },
  { value: 'NB', label: 'NB — Nouveau-Brunswick' },
  { value: 'NS', label: 'NS — Nouvelle-Écosse' },
  { value: 'PE', label: 'PE — Île-du-Prince-Édouard' },
  { value: 'NL', label: 'NL — Terre-Neuve-et-Labrador' },
  { value: 'AB', label: 'AB — Alberta' },
  { value: 'BC', label: 'BC — Colombie-Britannique' },
  { value: 'MB', label: 'MB — Manitoba' },
  { value: 'SK', label: 'SK — Saskatchewan' },
  { value: 'YT', label: 'YT — Yukon' },
  { value: 'NT', label: 'NT — Territoires du Nord-Ouest' },
  { value: 'NU', label: 'NU — Nunavut' },
]

// Le schéma traverse toute la page (une dizaine de composants d'étape) : un
// contexte évite de le faire descendre en prop à chaque niveau.
const FormSchemaContext = createContext(buildForm(null))
const useFormSchema = () => useContext(FormSchemaContext)

export default function CustomerPostPayment() {
  const [search] = useSearchParams()
  const { token } = useParams()
  const sessionId = search.get('session_id')
  const mode = token ? 'by-token' : 'by-session'
  const identifier = token || sessionId

  const baseUrl = mode === 'by-token'
    ? `/erp/api/customer/post-payment/by-token/${encodeURIComponent(token || '')}`
    : `/erp/api/customer/post-payment/${encodeURIComponent(sessionId || '')}`

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [resp, setResp] = useState(null)
  const [extrasResult, setExtrasResult] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const saveTimer = useRef(null)
  const saveChain = useRef(Promise.resolve())
  const [saveError, setSaveError] = useState(null)
  const pendingPatch = useRef({})
  const form = useMemo(() => buildForm(data?.form_schema), [data?.form_schema])

  useEffect(() => {
    if (!identifier) {
      const reason = mode === 'by-token' ? 'token manquant.' : 'paramètre session_id manquant.'
      setError(`Lien invalide — ${reason}`)
      setLoading(false)
      return
    }
    fetch(baseUrl)
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
  }, [identifier, baseUrl, mode])

  const flushSave = useCallback(() => {
    clearTimeout(saveTimer.current)
    const body = pendingPatch.current
    pendingPatch.current = {}
    if (!Object.keys(body).length) return saveChain.current
    const request = saveChain.current.catch(() => {}).then(async () => {
      const result = await fetch(`${baseUrl}/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!result.ok) throw new Error((await result.json().catch(() => ({}))).error || 'Enregistrement impossible')
      setSaveError(null)
    }).catch(error => {
      pendingPatch.current = { ...body, ...pendingPatch.current }
      setSaveError(error.message)
      throw error
    })
    saveChain.current = request
    return request
  }, [baseUrl])

  const queueSave = useCallback((patch) => {
    setResp(r => ({ ...r, ...patch }))
    pendingPatch.current = { ...pendingPatch.current, ...patch }
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { flushSave().catch(() => {}) }, 600)
  }, [flushSave])


  if (loading) return <Spinner fullscreen label="Chargement…" />
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
  const lockedCount = !!data.greenhouse_count_locked
  const isDiscoveryMode = mode === 'by-token'

  return (
    <FormSchemaContext.Provider value={form}>
      <div className="min-h-screen bg-slate-50 py-10 px-4">
        <div className="max-w-2xl mx-auto space-y-5">
          <Header data={data} isDiscoveryMode={isDiscoveryMode} />
          {saveError && <ErrorBanner>{saveError}</ErrorBanner>}
          {submitted ? (
            <SubmittedSummary resp={resp} extrasResult={extrasResult} setExtrasResult={setExtrasResult} sessionId={identifier} permission={permission} isDiscoveryMode={isDiscoveryMode} hasMobileController={hasMobileController} />
          ) : (
            <Wizard
              resp={resp}
              flushSave={flushSave}
              queueSave={queueSave}
              permission={permission}
              hasMobileController={hasMobileController}
              lockedCount={lockedCount}
              baseUrl={baseUrl}
              submitting={submitting}
              setSubmitting={setSubmitting}
              onSubmitted={() => setResp(r => ({ ...r, status: 'submitted', submitted_at: new Date().toISOString() }))}
            />
          )}
        </div>
      </div>
    </FormSchemaContext.Provider>
  )
}

function Header({ data, isDiscoveryMode }) {
  const form = useFormSchema()
  const inv = data.invoice
  if (isDiscoveryMode) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
        <h1 className="text-2xl font-bold text-slate-900">{form.t('header.title')}</h1>
        <p className="text-slate-600 mt-1">{form.t('header.intro')}</p>
      </div>
    )
  }
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
            <div className="font-medium">{fmtMoney(inv.total, inv.currency, { cents: true, fallback: '' })}</div>
          </div>
          {inv.pdf_url && (
            <div className="col-span-2">
              <a href={inv.pdf_url} target="_blank" rel="noreferrer" className="text-xs link-record">Télécharger la facture (PDF)</a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}


// ─── Wizard ───────────────────────────────────────────────────────────────

function Wizard({ resp, queueSave, flushSave, permission, hasMobileController, lockedCount, baseUrl, submitting, setSubmitting, onSubmitted }) {
  const [error, setError] = useState(null)
  const [outdated, setOutdated] = useState(false)
  const [activeId, setActiveId] = useState(null)
  const [moving, setMoving] = useState(false)
  const pageRef = useRef(null)
  const resumed = useRef(false)
  const form = useFormSchema()
  const pages = buildQuestionPages({ resp, queueSave, permission, hasMobileController, lockedCount, baseUrl, form })
  if (resp.is_new_site) pages.push({ id: 'submit', title: null, content: null, complete: true })
  const index = Math.max(0, pages.findIndex(page => page.id === activeId))
  const current = pages[index]
  const last = current.id === 'submit'
  const firstIncomplete = pages.find(page => !page.complete)
  const ready = !firstIncomplete && canSubmit(resp, hasMobileController, form)

  // Formulaire déjà entamé : on reprend à la première question sans réponse
  // plutôt qu'au tout début. C'est aussi le chemin de sortie quand une question
  // a été ajoutée après l'ouverture de la page (cf. handleSubmit) : après
  // rechargement, elle est droit devant.
  useEffect(() => {
    if (resumed.current) return
    resumed.current = true
    if (resp.is_new_site) setActiveId((firstIncomplete || pages[pages.length - 1]).id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    pageRef.current?.focus({ preventScroll: true })
    pageRef.current?.scrollIntoView({ block: 'start' })
  }, [current.id])

  async function navigate(target) {
    setError(null)
    setMoving(true)
    try {
      await flushSave()
      setActiveId(target.id)
    } catch (e) { setError(e.message) }
    finally { setMoving(false) }
  }

  async function handleSubmit() {
    setError(null)
    setOutdated(false)
    setSubmitting(true)
    try {
      queueSave(resp)
      await flushSave()
      const r = await fetch(`${baseUrl}/submit`, { method: 'POST' })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        // Le bouton Soumettre n'est actif que si toutes ces réponses sont là :
        // si le serveur en réclame une, c'est que cette page ne pose pas encore
        // la question (onglet ouvert avant une mise à jour du formulaire).
        // Afficher le message tel quel enverrait chercher une question absente.
        if (Array.isArray(j.errors) && j.errors.length) { setOutdated(true); return }
        throw new Error(j.error || 'Erreur')
      }
      onSubmitted()
    } catch (e) { setError(e.message) }
    finally { setSubmitting(false) }
  }

  return (
    <form onSubmit={e => {
      e.preventDefault()
      if (last) { if (ready) handleSubmit() }
      else if (current.complete && pages[index + 1]) navigate(pages[index + 1])
    }}>
      <fieldset disabled={submitting || moving} className="space-y-5 min-w-0">
        <div key={current.id} ref={pageRef} tabIndex={-1} className="outline-none scroll-mt-4" data-question-page={current.id}>
          <p className="text-xs text-slate-500 mb-3" aria-live="polite">Étape {index + 1} sur {pages.length}</p>
          {last ? <Card title="Prêt à envoyer ?">
            <p className="text-sm text-slate-600">{ready ? 'Vos réponses sont enregistrées.' : form.t('submit.incomplete')}</p>
            {firstIncomplete && <button type="button" className={btnGhost} onClick={() => navigate(firstIncomplete)}>Compléter</button>}
          </Card> : current.title ? <Card title={current.title}>{current.content}</Card> : current.content}
        </div>
        {outdated && <ErrorBanner>
          Une question a été ajoutée depuis l'ouverture de cette page.{' '}
          <button type="button" onClick={() => window.location.reload()} className="underline underline-offset-2 font-medium">Recharger</button>
        </ErrorBanner>}
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <div className="flex flex-wrap justify-between items-center gap-3">
          <button type="button" disabled={index === 0} onClick={() => navigate(pages[index - 1])} className={btnGhost + ' disabled:opacity-50'}>Précédent</button>
          <button type="submit" disabled={last ? !ready : !current.complete} className={btnPrimary}>
            {submitting ? 'Envoi…' : moving ? 'Enregistrement…' : last ? form.t('submit.label') : 'Suivant'}
          </button>
        </div>
        {!last && !current.complete && <p className="text-xs text-slate-500">{form.t('submit.incomplete')}</p>}
      </fieldset>
    </form>
  )
}

// Sections de questions personnalisées effectivement rendues, d'après l'état
// courant du formulaire : seules celles-là peuvent bloquer la soumission.
function visibleCustomSections(resp, hasMobileController) {
  const s = ['intro', 'order_type']
  if (resp.is_new_site === 'new') {
    s.push('farm_address', 'shipping_address')
    if (!hasMobileController) s.push('network')
  } else if (resp.is_new_site === 'add_to_existing') {
    s.push('shipping_address')
  }
  if (resp.is_new_site) s.push('end')
  return s
}

function canSubmit(resp, hasMobileController, form) {
  if (!resp.is_new_site) return false
  if (resp.is_new_site === 'add_to_existing' && !hasMobileController && typeof resp.within_central_controller_range !== 'boolean') return false
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
  // Questions ajoutées via l'éditeur et marquées obligatoires. Une question que
  // sa condition d'affichage masque ne bloque pas la soumission.
  const answers = resp.custom_answers || {}
  const rootCtx = { record: resp, custom: answers }
  for (const section of visibleCustomSections(resp, hasMobileController)) {
    for (const q of form.custom(section, rootCtx)) {
      if (q.required && !customAnswered(q, answers[q.id])) return false
    }
  }
  for (const g of (resp.greenhouses || [])) {
    if (g.has_side_vents === true && !form.isHidden('greenhouse.length') && g.length_range === 'over_200' && (!Number.isFinite(Number(g.length)) || Number(g.length) <= 200)) return false
    if (typeof g.has_louvers !== 'boolean') return false
    if (g.has_louvers && (!(g.louvers?.length) || g.louvers.some(l => !['110', '24', '12', 'other'].includes(l.voltage) || (l.voltage === 'other' && !l.voltage_other?.trim()) || !['spring_loaded', 'open_close', 'other'].includes(l.control_type) || (l.voltage === '110' && l.control_type === 'open_close') || typeof l.has_fan !== 'boolean'))) return false
    if (resp.form_options?.humidity_retention && (typeof g.humidity_valve !== 'boolean' || typeof g.humidity_haf !== 'boolean' || (g.humidity_haf && (!Number.isInteger(Number(g.humidity_haf_count)) || Number(g.humidity_haf_count) < 1 || Number(g.humidity_haf_count) > 100)))) return false
    const ghCtx = { record: g, custom: g.custom, root: resp, rootCustom: answers }
    const perCard = [...form.custom('greenhouse', ghCtx)]
    if ((g.permission_level || resp.permission_level) === 'chief_grower') perCard.push(...form.custom('greenhouse_chief', ghCtx))
    for (const q of perCard) {
      if (q.required && !customAnswered(q, (g.custom || {})[q.id])) return false
    }
  }
  // Si des blocs de 4 valves supplémentaires sont requis, soit ils sont payés,
  // soit le client doit baisser à ≤ 4 zones. Sinon on bloque la soumission.
  const blocksNeeded = Number(resp.valve_blocks_needed) || 0
  if (blocksNeeded > 0 && !resp.valve_blocks_paid) return false
  return true
}

function Step_ValveBlocksPayment({ resp, baseUrl }) {
  const blocksNeeded = Number(resp.valve_blocks_needed) || 0
  const paid = !!resp.valve_blocks_paid
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  if (blocksNeeded <= 0 && !paid) return null

  async function handlePay() {
    setErr(null); setLoading(true)
    try {
      const r = await fetch(`${baseUrl}/valve-blocks-checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pricing: 'one_time' }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || 'Erreur de paiement')
      if (j.checkout_url) {
        window.location.href = j.checkout_url
        return
      }
      throw new Error('URL de paiement manquante')
    } catch (e) {
      setErr(e.message)
      setLoading(false)
    }
  }

  if (paid) {
    return (
      <Card title="Blocs de valves supplémentaires">
        <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-800">
          ✓ Paiement reçu — vos {blocksNeeded} bloc{blocksNeeded > 1 ? 's' : ''} de 4 valves supplémentaire{blocksNeeded > 1 ? 's' : ''} {blocksNeeded > 1 ? 'ont' : 'a'} été {blocksNeeded > 1 ? 'achetés' : 'acheté'}.
        </div>
      </Card>
    )
  }

  const unitPriceCad = 400
  const totalCad = unitPriceCad * blocksNeeded
  return (
    <Card title="Blocs de valves supplémentaires">
      <p className="text-sm text-slate-700">
        Vous avez configuré plus de 4 zones d'irrigation dans au moins une serre. Pour soumettre, vous devez payer <strong>{blocksNeeded} bloc{blocksNeeded > 1 ? 's' : ''} de 4 valves supplémentaire{blocksNeeded > 1 ? 's' : ''}</strong>, ou baisser à 4 zones par serre.
      </p>

      <div className="rounded-lg border border-slate-200 p-4 space-y-2">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="font-medium text-slate-900">Achat unique</div>
            <div className="text-xs text-slate-500">{blocksNeeded} × 400 $ CAD</div>
          </div>
          <div className="text-lg font-semibold text-slate-900">{totalCad} $ CAD</div>
        </div>
        <button type="button" onClick={handlePay} disabled={loading} className={btnPrimary + ' w-full'}>
          {loading ? 'Redirection…' : `Payer ${totalCad} $ par Stripe`}
        </button>
        {err && <div className="text-sm text-red-700">{err}</div>}
      </div>

      <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm text-slate-700">
        <div className="font-medium text-slate-800">Préférez l'option mensuelle (25 $/mois par bloc) ?</div>
        <p className="mt-1 text-xs text-slate-600">
          Cette option s'ajoute à votre abonnement existant — contactez votre conseiller @orisha pour qu'il l'active de son côté.
        </p>
      </div>
    </Card>
  )
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

// Chaque question montre une illustration de son équipement.
// Sur écran étroit, elle passe sous les champs.
function Ask({ questionId, image, focus, height = 96, pipeType, children }) {
  const form = useFormSchema()
  return (
    <div className="flex flex-col sm:flex-row items-start gap-3">
      <div className="flex-1 min-w-0 w-full space-y-2">{children}</div>
      <GreenhouseIllustration image={image || form.image(questionId)} focus={focus} pipeType={pipeType} height={height} label={focusLabel(focus)} className="self-center sm:self-start" />
    </div>
  )
}

// La liste et le contenu des pages sont construits ensemble : les branches
// conditionnelles et les questions ajoutées dans l'éditeur restent synchronisées.
function buildQuestionPages({ resp, queueSave, permission, hasMobileController, lockedCount, baseUrl, form }) {
  const pages = []
  const add = (id, title, content, complete = true) => pages.push({ id, title, content, complete: !!complete })
  const rootCustom = (section) => {
    for (const q of form.custom(section, { record: resp, custom: resp.custom_answers })) {
      add(`custom:${q.id}`, q.label, <CustomFields questions={[q]} values={resp.custom_answers} onChange={patch => queueSave({ custom_answers: { ...(resp.custom_answers || {}), ...patch } })} />, !q.required || customAnswered(q, resp.custom_answers?.[q.id]))
    }
  }
  const address = (field, title, questionId) => {
    const value = resp[field] || {}
    add(field, title, <Ask questionId={questionId} focus={field === 'farm_address' ? 'farm' : 'shipping'} height={110}>
      <p className="text-sm text-slate-600">{form.t(field === 'farm_address' ? 'farm.help' : 'shipping.prompt_existing')}</p>
      <AddressForm value={value} baseUrl={baseUrl} onChange={patch => queueSave({ [field]: { ...value, ...patch } })} />
    </Ask>, value.line1?.trim() && value.province)
  }
  rootCustom('intro')
  add('order_type', form.t('order_type.title'), <Ask questionId="order_type.prompt" focus="site" height={116}>
    <p className="text-sm text-slate-600">{form.t('order_type.prompt')}</p>
    <div className="space-y-2">{form.opts('order_type.options').map(o => <RadioOption key={o.value} checked={resp.is_new_site === o.value} onChange={() => queueSave({ is_new_site: o.value })} label={o.label} help={o.help} />)}</div>
  </Ask>, resp.is_new_site)
  // Un contrôleur central internet mobile déjà à la commande en fournit un
  // nouveau : la distance au contrôleur existant ne change plus rien.
  if (resp.is_new_site === 'add_to_existing' && !hasMobileController) {
    add('controller_distance', form.t('controller_distance.title'), <div className="space-y-2">
      <p className="text-sm text-slate-600">{form.t('controller_distance.prompt')}</p>
      <RadioOption checked={resp.within_central_controller_range === true} onChange={() => queueSave({ within_central_controller_range: true })} label="Oui" />
      <RadioOption checked={resp.within_central_controller_range === false} onChange={() => queueSave({ within_central_controller_range: false })} label="Non" />
      {typeof resp.within_central_controller_range === 'boolean' && <p className="text-sm text-slate-600">{form.t(resp.within_central_controller_range ? 'controller_distance.near' : 'controller_distance.far')}</p>}
    </div>, typeof resp.within_central_controller_range === 'boolean')
  }
  rootCustom('order_type')
  if (!resp.is_new_site) return pages

  if (resp.is_new_site === 'new') {
    address('farm_address', form.t('farm.title'), 'farm.title')
    rootCustom('farm_address')
    add('shipping_same', form.t('shipping.title'), <Ask questionId="shipping.prompt_new" focus="shipping" height={110}>
      <p className="text-sm text-slate-600">{form.t('shipping.prompt_new')}</p>
      <RadioOption checked={resp.shipping_same_as_farm === true} onChange={() => queueSave({ shipping_same_as_farm: true })} label={form.t('shipping.same_yes')} />
      <RadioOption checked={resp.shipping_same_as_farm === false} onChange={() => queueSave({ shipping_same_as_farm: false })} label={form.t('shipping.same_no')} />
    </Ask>, typeof resp.shipping_same_as_farm === 'boolean')
  }
  if (resp.is_new_site !== 'new' || resp.shipping_same_as_farm === false) address('shipping_address', form.t('shipping.title'), 'shipping.prompt_existing')
  rootCustom('shipping_address')
  if (resp.is_new_site === 'new' && !hasMobileController) {
    add('network', form.t('network.title'), <Ask questionId="network.prompt" focus="network" height={116}>
      <p className="text-sm text-slate-600">{form.t('network.prompt')}</p>
      <div className="space-y-2">{form.opts('network.options').map(o => <RadioOption key={o.value} checked={resp.network_access === o.value} onChange={() => queueSave({ network_access: o.value })} label={o.label} help={o.help} />)}</div>
    </Ask>, resp.network_access)
    if (!form.isHidden('network.wifi') && ['wifi_250', 'wifi_350_coax'].includes(resp.network_access)) {
      for (const field of ['wifi_ssid', 'wifi_password']) add(field, form.t('network.title'), <Ask questionId="network.wifi" focus="network">
        <p className="text-sm text-slate-600">{form.t('network.wifi_prompt')}</p>
        <Field label={form.t(`network.${field === 'wifi_ssid' ? 'wifi_ssid_label' : 'wifi_password_label'}`)}>
          <input aria-label={form.t(`network.${field === 'wifi_ssid' ? 'wifi_ssid_label' : 'wifi_password_label'}`)} type={field === 'wifi_password' ? 'password' : 'text'} autoComplete={field === 'wifi_password' ? 'new-password' : undefined} className={inputCls} value={resp[field] || ''} onChange={e => queueSave({ [field]: e.target.value })} />
        </Field>
      </Ask>)
    }
    rootCustom('network')
  }
  if (hasMobileController || (resp.is_new_site === 'new' && resp.network_access === 'mobile_controller')) {
    add('mobile', form.t('network.mobile_title'), <Ask questionId="network.mobile_title" focus="network_mobile" height={116}><p className="text-sm text-slate-600">{form.t(hasMobileController ? 'network.mobile_text' : 'network.mobile_needed_text')}</p></Ask>)
  }
  const greenhouses = resp.greenhouses || []
  if (!lockedCount) add('greenhouse_count', form.t('greenhouses.count_title'), <Ask questionId="greenhouses.count_label" focus="count" height={116}>
    <Field label={form.t('greenhouses.count_label')}><input aria-label={form.t('greenhouses.count_label')} type="number" min={1} max={50} className={inputCls} value={resp.num_greenhouses || ''} onChange={e => {
      const count = Math.max(0, Math.min(50, parseInt(e.target.value) || 0))
      queueSave({ num_greenhouses: count, greenhouses: Array.from({ length: count }, (_, i) => greenhouses[i] || {}) })
    }} /></Field>
  </Ask>, Number(resp.num_greenhouses) > 0)
  greenhouses.forEach((g, idx) => {
    const onChange = patch => queueSave({ greenhouses: greenhouses.map((item, i) => i === idx ? { ...item, ...patch } : item) })
    addGreenhousePages({ add, idx, g, onChange, permission, root: resp, form })
  })
  if (Number(resp.valve_blocks_needed) > 0 || resp.valve_blocks_paid) add('valve_payment', null, <Step_ValveBlocksPayment resp={resp} baseUrl={baseUrl} />, resp.valve_blocks_paid)
  rootCustom('end')
  return pages
}

const FURNACE_WIRE_PRESETS = ['25', '50', '75', '100']

function addGreenhousePages({ add, idx, g, onChange, permission, root, form }) {
  const cardPermission = g.permission_level || permission
  const title = `Serre #${idx + 1}${g.permission_level === 'chief_grower' ? ' (Chef de culture)' : g.permission_level === 'helper' ? ' (Helper)' : ''}`
  const page = (id, content, complete = true, suffix = '') => add(`greenhouse:${idx}:${id}`, suffix ? `${title} · ${suffix}` : title, content, complete)
  const question = (id, label, control, { focus = 'overview', questionId = id, complete = true, suffix = '', help } = {}) => page(id,
    <Ask questionId={questionId} focus={focus} pipeType={g.side_pipe_type}>
      <Field label={label}>{control}{help && <div className="text-xs text-slate-500 mt-1">{help}</div>}</Field>
    </Ask>, complete, suffix)
  const input = (id, label, value, change, options = {}) => question(id, label,
    <input aria-label={label} className={inputCls} value={value ?? ''} onChange={e => change(e.target.value)} type={options.type || 'text'} min={options.min} max={options.max} step={options.step} />, options)
  const select = (id, label, value, change, choices, options = {}) => question(id, label,
    <select aria-label={label} className={inputCls} value={value ?? ''} onChange={e => change(e.target.value)}><option value="">—</option>{choices.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>, options)
  const boolean = (id, label, value, change, options = {}) => select(id, label, value == null ? '' : value ? 'yes' : 'no', v => change(v === '' ? null : v === 'yes'), [{ value: 'yes', label: 'Oui' }, { value: 'no', label: 'Non' }], options)
  const diameter = (id, label, value, change, preset, focus) => {
    const other = value?.startsWith('Autre:')
    select(id, label, other ? '__other' : value, v => change(v === '__other' ? 'Autre: ' : v), [{ value: preset, label: preset }, { value: '__other', label: 'Autre (préciser)' }], { focus, questionId: focus === 'side_pipe' ? 'greenhouse.side_pipe_type_label' : 'greenhouse.guide_pipes_label' })
    if (other) input(`${id}:other`, form.t('greenhouse.diameter_other_label'), value.replace('Autre:', '').trim(), v => change(`Autre: ${v}`), { focus })
  }
  if (!form.isHidden('greenhouse.side_vents')) {
    select('side_vents', form.t('greenhouse.side_vents_label'), g.has_side_vents == null ? '' : g.has_side_vents ? 'yes' : 'no', v => {
      if (!v) return
      onChange(v === 'yes' ? { has_side_vents: true } : { has_side_vents: false, side_vent_height: '', side_vent_height_range: '', side_pipe_type: '', side_pipe_diameter: '', guide_pipes_state: '', guide_pipe_diameter: '', wants_compatible_guide_pipes: false, num_side_vent_motors: 0, has_existing_side_vent_motors: null })
    }, form.opts('greenhouse.side_vents_options'), { focus: 'side_vents', questionId: 'greenhouse.side_vents_label' })
    if (g.has_side_vents === true) {
      boolean('existing_motors', 'Avez-vous déjà les moteurs ?', g.has_existing_side_vent_motors, v => onChange({ has_existing_side_vent_motors: v }), { focus: 'side_vents', questionId: 'greenhouse.motors', complete: typeof g.has_existing_side_vent_motors === 'boolean' })
    }
  }
  const lengthRange = g.length_range || (Number(g.length) > 0 ? (Number(g.length) > 200 ? 'over_200' : 'up_to_200') : '')
  if (g.has_side_vents === true && !form.isHidden('greenhouse.length')) {
    select('length_range', form.t('greenhouse.length_label'), lengthRange, range => {
      const keep = range === 'up_to_200' ? Number(g.length) > 0 && Number(g.length) <= 200 : range === 'over_200' && Number(g.length) > 200
      onChange({ length_range: range, length: keep ? g.length : '' })
    }, [{ value: 'up_to_200', label: '200 pi ou moins' }, { value: 'over_200', label: 'Plus de 200 pi' }], { questionId: 'greenhouse.length_label', focus: 'length' })
    if (lengthRange === 'over_200') input('length', 'Précisez la longueur (pi)', g.length, v => onChange({ length_range: 'over_200', length: v }), { type: 'number', min: 200, step: 'any', focus: 'length', questionId: 'greenhouse.length_label', complete: Number.isFinite(Number(g.length)) && Number(g.length) > 200 })
  }
  if (!form.isHidden('greenhouse.side_vents')) {
    if (g.has_side_vents === true) {
      if (g.has_existing_side_vent_motors === false) {
        const heightRange = g.side_vent_height_range || (Number(g.side_vent_height) > 0 ? (Number(g.side_vent_height) > 6 ? 'over_6' : 'up_to_6') : '')
        select('side_vent_height_range', form.t('greenhouse.side_vent_height_label'), heightRange, range => {
          const keep = range === 'up_to_6' ? Number(g.side_vent_height) > 0 && Number(g.side_vent_height) <= 6 : range === 'over_6' && Number(g.side_vent_height) > 6
          onChange({ side_vent_height_range: range, side_vent_height: keep ? g.side_vent_height : '' })
        }, [{ value: 'up_to_6', label: '6 pi et moins' }, { value: 'over_6', label: 'Plus de 6 pi' }], { focus: 'vent_height', questionId: 'greenhouse.side_vent_height_label' })
        if (heightRange === 'over_6') input('side_vent_height', 'Précisez la hauteur (pi)', g.side_vent_height, v => onChange({ side_vent_height_range: 'over_6', side_vent_height: v }), { type: 'number', min: 6, step: 'any', focus: 'vent_height', questionId: 'greenhouse.side_vent_height_label', complete: Number.isFinite(Number(g.side_vent_height)) && Number(g.side_vent_height) > 6 })
        select('side_pipe_type', form.t('greenhouse.side_pipe_type_label'), g.side_pipe_type, v => onChange({ side_pipe_type: v, side_pipe_diameter: '' }), form.opts('greenhouse.side_pipe_type_options'), { focus: 'side_pipe', questionId: 'greenhouse.side_pipe_type_label' })
        if (['aluminum_C', 'steel_O'].includes(g.side_pipe_type)) diameter('side_pipe_diameter', g.side_pipe_type === 'aluminum_C' ? 'Diamètre du tuyau aluminium' : 'Diamètre du tuyau acier', g.side_pipe_diameter, v => onChange({ side_pipe_diameter: v }), g.side_pipe_type === 'aluminum_C' ? '2"' : '1 5/16"', 'side_pipe')
      }
      select('guide_pipes', form.t('greenhouse.guide_pipes_label'), g.guide_pipes_state, v => onChange({ guide_pipes_state: v, guide_pipe_diameter: '' }), form.opts('greenhouse.guide_pipes_options'), { focus: 'guide_pipes', questionId: 'greenhouse.guide_pipes_label' })
      if (g.guide_pipes_state === 'present') {
        diameter('guide_diameter', 'Diamètre des tuyaux guides existants', g.guide_pipe_diameter, v => onChange({ guide_pipe_diameter: v }), '1 5/16"', 'guide_pipes')
        if (g.guide_pipe_diameter?.startsWith('Autre:')) page('guide_compatibility', <CompatibilityWarning value={g.guide_pipe_diameter.replace('Autre:', '').trim()} onAccept={() => onChange({ wants_compatible_guide_pipes: true })} accepted={!!g.wants_compatible_guide_pipes} />)
      }
      input('motor_count', 'Nombre de moteurs de côtés', g.num_side_vent_motors, v => onChange({ num_side_vent_motors: v }), { type: 'number', min: 0, max: 8, focus: 'side_vents', questionId: 'greenhouse.motors' })
      if (g.has_existing_side_vent_motors) {
        input('motor_brand', 'Marque des moteurs', g.side_vent_motor_brand, v => onChange({ side_vent_motor_brand: v }), { focus: 'side_vents' })
        input('motor_model', 'Modèle des moteurs', g.side_vent_motor_model, v => onChange({ side_vent_motor_model: v }), { focus: 'side_vents' })
      }
    }
  }
  select('fans', 'Ventilateurs de bout de serre sans louvre associée', g.num_fans, v => onChange({ num_fans: v, fans_combined_hp: v === '2' ? g.fans_combined_hp : '' }), [{ value: '0', label: 'Aucun' }, { value: '1', label: '1 ventilateur' }, { value: '2', label: '2 ventilateurs' }], { questionId: 'greenhouse.fans' })
  if (Number(g.num_fans) === 2) input('fans_hp', 'Puissance combinée (HP)', g.fans_combined_hp, v => onChange({ fans_combined_hp: v }), { type: 'number', min: 0, step: '0.1', questionId: 'greenhouse.fans' })

  const louvers = g.louvers || []
  boolean('louvers', form.t('louvers.present'), g.has_louvers, v => onChange({ has_louvers: v, louvers: v ? (louvers.length ? louvers : [{}]) : [] }), { complete: typeof g.has_louvers === 'boolean' })
  if (g.has_louvers) {
    input('louver_count', form.t('louvers.count'), louvers.length || '', value => {
      const n = Math.min(50, Math.max(0, parseInt(value) || 0))
      onChange({ louvers: Array.from({ length: n }, (_, i) => louvers[i] || {}) })
    }, { type: 'number', min: 1, max: 50, step: 1, complete: louvers.length > 0 })
    louvers.forEach((l, i) => {
      const set = patch => onChange({ louvers: louvers.map((item, j) => i === j ? { ...item, ...patch } : item) })
      const opts = { suffix: `Louvre #${i + 1}` }
      select(`louver:${i}:voltage`, form.t('louvers.voltage'), l.voltage, v => set({ voltage: v, voltage_other: '', ...(v === '110' && l.control_type === 'open_close' ? { control_type: '' } : {}) }), form.opts('louvers.voltages'), { ...opts, complete: ['110', '24', '12', 'other'].includes(l.voltage) })
      if (l.voltage === 'other') input(`louver:${i}:voltage_other`, form.t('louvers.voltage_other'), l.voltage_other, v => set({ voltage_other: v }), { ...opts, complete: l.voltage_other?.trim() })
      select(`louver:${i}:type`, form.t('louvers.type'), l.control_type, v => set({ control_type: v }), form.opts('louvers.types').filter(option => l.voltage !== '110' || option.value !== 'open_close'), { ...opts, complete: ['spring_loaded', 'open_close', 'other'].includes(l.control_type) && !(l.voltage === '110' && l.control_type === 'open_close') })
      boolean(`louver:${i}:fan`, form.t('louvers.fan'), l.has_fan, v => set({ has_fan: v }), { ...opts, complete: typeof l.has_fan === 'boolean', help: l.control_type === 'open_close' && l.has_fan ? form.t('louvers.fan_unavailable') : null })
    })
  }
  if (root.form_options?.humidity_retention) {
    boolean('humidity_valve', form.t('humidity.valve'), g.humidity_valve, v => onChange({ humidity_valve: v }), { complete: typeof g.humidity_valve === 'boolean' })
    boolean('humidity_haf', form.t('humidity.haf'), g.humidity_haf, v => onChange({ humidity_haf: v, humidity_haf_count: v ? (g.humidity_haf_count || 1) : 0 }), { complete: typeof g.humidity_haf === 'boolean' })
    if (g.humidity_haf) input('haf_count', form.t('humidity.haf_count'), g.humidity_haf_count, v => onChange({ humidity_haf_count: v }), { type: 'number', min: 1, max: 100, step: 1, complete: Number.isInteger(Number(g.humidity_haf_count)) && Number(g.humidity_haf_count) >= 1 && Number(g.humidity_haf_count) <= 100 })
  }
  if (cardPermission === 'chief_grower') {
    if (!form.isHidden('chief.furnaces')) {
      select('furnaces', form.t('chief.has_furnaces_label'), g.has_furnaces == null ? '' : g.has_furnaces ? 'yes' : 'no', v => {
        if (v) onChange(v === 'yes' ? { has_furnaces: true } : { has_furnaces: false, num_furnaces: 0, furnaces: [] })
      }, form.opts('chief.has_furnaces_options'), { focus: 'furnaces', questionId: 'chief.has_furnaces_label' })
      if (g.has_furnaces) {
        const furnaces = g.furnaces || []
        select('furnace_count', form.t('chief.num_furnaces_label'), g.num_furnaces ? String(g.num_furnaces) : '', value => {
          const count = Math.max(0, Math.min(2, parseInt(value) || 0))
          onChange({ num_furnaces: count, furnaces: Array.from({ length: count }, (_, i) => furnaces[i] || {}) })
        }, [{ value: '1', label: '1' }, { value: '2', label: '2' }], { focus: 'furnaces', questionId: 'chief.has_furnaces_label', complete: Number(g.num_furnaces) > 0 })
        furnaces.forEach((f, i) => {
          const set = patch => onChange({ furnaces: furnaces.map((item, j) => i === j ? { ...item, ...patch } : item) })
          const opts = { suffix: `Fournaise #${i + 1}`, focus: 'furnaces' }
          const brand = form.brands.find(b => b.brand === f.brand)
          select(`furnace:${i}:brand`, form.t('furnace.brand_label'), f.brand, v => set({ brand: v, model: '' }), [...form.brands.map(b => ({ value: b.brand, label: b.brand })), { value: 'Autre', label: 'Autre' }], { ...opts, questionId: 'furnace.brand_label' })
          if (brand) select(`furnace:${i}:model`, form.t('furnace.model_label'), f.model, v => set({ model: v }), [...brand.models.map(m => ({ value: m, label: m })), { value: 'Autre', label: 'Autre / Je ne sais pas' }], { ...opts, questionId: 'furnace.brand_label' })
          else input(`furnace:${i}:model`, form.t('furnace.model_label'), f.model, v => set({ model: v }), { ...opts, questionId: 'furnace.brand_label' })
          if (f.model === 'Autre') input(`furnace:${i}:model_other`, form.t('furnace.model_other_label'), f.model_other, v => set({ model_other: v }), { ...opts, questionId: 'furnace.brand_label' })
          // Longueurs livrées telles quelles (25/50/75/100 pi) ; tout autre choix
          // ouvre la question du nombre exact de pieds. `control_wire_feet` reste
          // un nombre de pieds : le calcul d'équipement n'a pas à changer.
          const wireFeet = f.control_wire_feet
          const wireRange = f.control_wire_range || (Number(wireFeet) > 0 ? (FURNACE_WIRE_PRESETS.includes(String(Number(wireFeet))) ? String(Number(wireFeet)) : 'over_100') : '')
          const wirePreset = FURNACE_WIRE_PRESETS.includes(wireRange)
          select(`furnace:${i}:wire`, form.t('furnace.wire_label'), wireRange, v => set({ control_wire_range: v, control_wire_feet: FURNACE_WIRE_PRESETS.includes(v) ? v : '' }), form.opts('furnace.wire_options'), { ...opts, focus: 'furnace_wire', questionId: 'furnace.wire_label', help: form.t('furnace.wire_help') })
          if (wireRange && !wirePreset) input(`furnace:${i}:wire_feet`, form.t('furnace.wire_feet_label'), wireFeet, v => set({ control_wire_feet: v }), { ...opts, type: 'number', min: 101, focus: 'furnace_wire', questionId: 'furnace.wire_label', help: form.t('furnace.wire_help'), complete: Number(wireFeet) > 100 })
          select(`furnace:${i}:thermostat`, form.t('furnace.thermostat_label'), f.backup_thermostat == null ? '' : f.backup_thermostat ? 'yes' : 'no', v => set({ backup_thermostat: v === '' ? null : v === 'yes' }), form.opts('furnace.thermostat_options'), { ...opts, focus: 'thermostat', questionId: 'furnace.thermostat_label' })
        })
      }
    }
    const zones = Number(g.irrigation_zones) || 0
    input('irrigation_zones', form.t('chief.irrigation_zones_label'), g.irrigation_zones, v => onChange({ irrigation_zones: v }), { type: 'number', min: 0, max: 50, focus: 'irrigation', questionId: 'chief.irrigation_zones_label', help: zones > 4 ? `${Math.ceil((zones - 4) / 4)} bloc(s) de 4 valves supplémentaire(s) requis. Paiement avant l’envoi ou ajout à l’abonnement avec votre conseiller.` : null })
    if (zones > 0) {
      select('orisha_valves', form.t('chief.orisha_valves_label'), g.needs_orisha_valves == null ? '' : g.needs_orisha_valves ? 'yes' : 'no', v => onChange({ needs_orisha_valves: v === '' ? null : v === 'yes' }), form.opts('chief.orisha_valves_options'), { focus: 'valves', questionId: 'chief.orisha_valves_label' })
      page('valve_wire', <Ask questionId="chief.orisha_valves_label" focus="valves"><ValveWireLength value={g.valve_control_wire_feet} onChange={value => onChange({ valve_control_wire_feet: value })} /></Ask>)
      if (!g.needs_orisha_valves) {
        input('valve_brand', 'Marque des valves', g.valve_brand, v => onChange({ valve_brand: v }), { focus: 'valves' })
        input('valve_model', 'Modèle des valves', g.valve_model, v => onChange({ valve_model: v }), { focus: 'valves' })
      }
    }
  }
  const ghCtx = { record: g, custom: g.custom, root, rootCustom: root.custom_answers }
  const sections = cardPermission === 'chief_grower' ? ['greenhouse', 'greenhouse_chief'] : ['greenhouse']
  for (const section of sections) for (const q of form.custom(section, ghCtx)) {
    page(`custom:${q.id}`, <CustomFields questions={[q]} values={g.custom} onChange={patch => onChange({ custom: { ...(g.custom || {}), ...patch } })} />, !q.required || customAnswered(q, g.custom?.[q.id]))
  }
}

// Confirmation de l'adresse auprès de l'API d'adresses (Google), au blur du
// bloc : l'adresse de ferme et l'adresse de livraison sont celles qui font
// partir un camion, autant les valider ici plutôt qu'au retour du colis.
function AddressConfirm({ value, baseUrl, onChange }) {
  const [verdict, setVerdict] = useState(null)
  const [busy, setBusy] = useState(false)
  const lastRef = useRef('')

  const key = [value.line1, value.city, value.province, value.postal_code, value.country].join('|')

  async function run() {
    if (!value.line1?.trim() || !value.city?.trim() || key === lastRef.current) return
    lastRef.current = key
    setBusy(true)
    try {
      const r = await fetch(`${baseUrl}/confirm-address`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      })
      setVerdict(r.ok ? await r.json() : null)
    } catch { setVerdict(null) } finally { setBusy(false) }
  }

  // Le blur du bloc déclenche la vérification (un champ à la fois enverrait
  // une adresse à moitié saisie).
  const onBlur = (e) => { if (!e.currentTarget.contains(e.relatedTarget)) run() }

  const s = verdict?.suggestion
  return (
    <div onBlur={onBlur}>
      <AddressFields value={value} onChange={onChange} />
      {busy && <p className="mt-2 text-xs text-slate-400">Vérification…</p>}
      {!busy && verdict?.status === 'confirmed' && (
        <p className="mt-2 text-xs text-green-700">Adresse confirmée</p>
      )}
      {!busy && verdict?.status === 'not_found' && (
        <p className="mt-2 text-xs text-orange-700">Adresse introuvable — vérifiez la rue et la ville.</p>
      )}
      {!busy && s && (
        <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
          <div className="text-xs text-slate-600">Adresse trouvée</div>
          <div className="text-sm text-slate-900">
            {[s.line1, s.city, s.province, s.postal_code].filter(Boolean).join(', ')}
          </div>
          <button
            type="button"
            className="mt-1.5 text-xs font-medium text-brand-700 hover:text-brand-800"
            onClick={() => {
              // Le pays reste celui que le client a écrit : Google le rend en
              // code (CA), le formulaire l'affiche en toutes lettres.
              lastRef.current = ''
              setVerdict(null)
              onChange({ line1: s.line1, city: s.city, province: s.province, postal_code: s.postal_code })
            }}
          >
            Utiliser
          </button>
        </div>
      )}
    </div>
  )
}

function AddressForm({ value, onChange, baseUrl }) {
  if (baseUrl) return <AddressConfirm value={value} onChange={onChange} baseUrl={baseUrl} />
  return <AddressFields value={value} onChange={onChange} />
}

function AddressFields({ value, onChange }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Adresse" colSpan={2}>
        <input className={inputCls} value={value.line1 || ''} onChange={e => onChange({ line1: e.target.value })} />
      </Field>
      <Field label="Ville">
        <input className={inputCls} value={value.city || ''} onChange={e => onChange({ city: e.target.value })} />
      </Field>
      <Field label="Province">
        <SearchableSelect
          value={value.province || ''}
          options={PROVINCES}
          onChange={v => onChange({ province: v })}
          emptyOption="—"
          searchPlaceholder="Rechercher une province…"
          className={inputCls}
          size="sm"
          testId="province-select"
        />
      </Field>
      <Field label="Code postal">
        <input className={inputCls} value={value.postal_code || ''} onChange={e => onChange({ postal_code: e.target.value })} />
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
      <label className="label">{label}</label>
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

function ValveWireLength({ value, onChange }) {
  const [custom, setCustom] = useState(false)
  const hasValue = value !== '' && value != null
  const isPreset = [15, 25].includes(Number(value))
  const selection = custom || (hasValue && !isPreset) ? 'custom' : hasValue ? String(value) : ''
  return (
    <Field label="Longueur de filage des valves">
      <select aria-label="Longueur de filage des valves" className={inputCls} value={selection} onChange={e => {
        setCustom(e.target.value === 'custom')
        onChange(e.target.value === 'custom' ? '' : e.target.value)
      }}>
        <option value="">—</option>
        <option value="15">15 pi</option>
        <option value="25">25 pi</option>
        <option value="custom">Longueur personnalisée</option>
      </select>
      {selection === 'custom' && <label className="block mt-2 text-sm text-slate-600">
        Longueur personnalisée (pi)
        <input type="number" min="0" className={inputCls} value={value ?? ''} onChange={e => onChange(e.target.value)} />
      </label>}
    </Field>
  )
}

// ─── Questions ajoutées depuis l'éditeur ──────────────────────────────────

// Les champs seuls (utilisés à l'intérieur d'une carte existante).
function CustomFields({ questions, values, onChange, disabled }) {
  if (!questions.length) return null
  const v = values || {}
  // Une question ajoutée n'a pas de sujet connu : sa vue est celle de sa
  // section (cf. lib/greenhouseFocus.js).
  return questions.map(q => (
    <Ask key={q.id} image={q.image} focus={focusForSection(q.section)}>
      <Field label={q.label + (q.required ? ' *' : '')} colSpan={q.type === 'textarea' ? 2 : 1}>
        <CustomInput q={q} value={v[q.id]} onChange={(nv) => onChange({ [q.id]: nv })} disabled={disabled} />
        {q.help && <div className="text-xs text-slate-500 mt-1">{q.help}</div>}
      </Field>
    </Ask>
  ))
}

function CustomInput({ q, value, onChange, disabled }) {
  const common = { className: inputCls, disabled }
  switch (q.type) {
    case 'textarea':
      return <textarea {...common} rows={3} value={value || ''} onChange={e => onChange(e.target.value)} />
    case 'number':
      return <input {...common} type="number" value={value ?? ''} onChange={e => onChange(e.target.value)} />
    case 'checkbox':
      return (
        <label className="inline-flex items-center gap-2 text-sm text-slate-800">
          <input type="checkbox" disabled={disabled} checked={value === true} onChange={e => onChange(e.target.checked)} />
          {q.label}
        </label>
      )
    case 'yesno':
      return (
        <select {...common} value={value == null ? '' : (value ? 'yes' : 'no')} onChange={e => onChange(e.target.value === '' ? null : e.target.value === 'yes')}>
          <option value="">—</option>
          <option value="yes">Oui</option>
          <option value="no">Non</option>
        </select>
      )
    case 'radio':
      return (
        <div className="space-y-2">
          {q.options.map(o => (
            <RadioOption key={o.value} checked={value === o.value} onChange={() => !disabled && onChange(o.value)} label={o.label} />
          ))}
        </div>
      )
    case 'select':
      return (
        <select {...common} value={value || ''} onChange={e => onChange(e.target.value)}>
          <option value="">—</option>
          {q.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )
    default:
      return <input {...common} value={value || ''} onChange={e => onChange(e.target.value)} />
  }
}

// ─── Submitted summary + extras flow ──────────────────────────────────────

function SubmittedSummary({ resp, extrasResult, setExtrasResult, sessionId, permission, isDiscoveryMode, hasMobileController }) {
  // Le flow extras est lié au Stripe Checkout (création d'un pending_invoice +
  // redirection Checkout Session). Pas applicable au flow qualification.
  const form = useFormSchema()
  const extras = isDiscoveryMode ? { items: [] } : computeExtras(resp, permission)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [showAnswers, setShowAnswers] = useState(false)

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
    <Card title={form.t('submitted.title')}>
      <p className="text-sm text-slate-700">{form.t('submitted.text')}</p>
      <button type="button" className="btn-ghost btn-sm mt-2" onClick={() => setShowAnswers(v => !v)}>{showAnswers ? 'Masquer mes réponses' : 'Consulter mes réponses'}</button>
      {showAnswers && <div className="mt-3 border-t border-slate-100 pt-3 space-y-3 text-sm text-slate-700">
        {resp.is_new_site === 'add_to_existing' && !hasMobileController && <div>
          <p>{form.t('controller_distance.prompt')} <strong>{resp.within_central_controller_range == null ? '—' : resp.within_central_controller_range ? 'Oui' : 'Non'}</strong></p>
          {typeof resp.within_central_controller_range === 'boolean' && <p>{form.t(resp.within_central_controller_range ? 'controller_distance.near' : 'controller_distance.far')}</p>}
        </div>}
        <div className="grid grid-cols-2 gap-2"><span>Nombre de serres</span><span className="font-medium text-slate-900">{resp.num_greenhouses || '—'}</span><span>Accès réseau</span><span className="font-medium text-slate-900">{form.opts('network.options').find(o => o.value === resp.network_access)?.label || '—'}</span>{resp.wifi_ssid && <><span>Réseau Wi‑Fi</span><span className="font-medium text-slate-900">{resp.wifi_ssid}</span></>}</div>
        {(resp.greenhouses || []).map((g, i) => <div key={i} className="rounded-lg bg-slate-50 p-3"><p className="font-medium text-slate-900">Serre #{i + 1}</p><div className="mt-1 grid grid-cols-2 gap-1 text-xs"><span>Longueur</span><span>{g.length_range === 'up_to_200' ? '200 pi ou moins' : g.length ? `${g.length} pi` : '—'}</span><span>Côtés ouvrants</span><span>{g.has_side_vents ? 'Oui' : 'Non'}</span><span>Ventilateurs</span><span>{g.num_fans ?? '—'}</span>{g.has_side_vents && <><span>Moteurs</span><span>{g.num_side_vent_motors ?? '—'}</span></>}{g.permission_level === 'chief_grower' && <><span>Zones d’irrigation</span><span>{g.irrigation_zones ?? '—'}</span><span>Fournaises</span><span>{g.num_furnaces ?? '—'}</span></>}</div></div>)}
      </div>}
      {extras.items.length > 0 && !extrasResult && (
        <div className="mt-3 rounded-lg bg-blue-50 border border-blue-200 p-4">
          <h3 className="font-semibold text-blue-900">Extras suggérés selon vos réponses</h3>
          <ul className="text-sm text-blue-900 mt-2 list-disc pl-5 space-y-0.5">
            {extras.items.map((it, i) => (
              <li key={i}>{it.qty} × {it.description} — {fmtMoney(it.unit_price, 'CAD', { fallback: '' })} l'unité</li>
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
  if (resp.is_new_site === 'new' && resp.network_access === 'mobile_controller' && !resp.form_options?.mobile_controller) {
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
