import { roofInverterSupplyKey, roofVentAnswers, thermalScreen } from '../lib/discoveryRoofs.js'
import { useEffect, useState, useCallback, useRef, useMemo, createContext, useContext, Fragment } from 'react'
import { Copy, Eye, EyeOff, HelpCircle, Pencil } from 'lucide-react'
import { Modal } from '../components/Modal.jsx'
import { useSearchParams, useParams } from 'react-router-dom'
import Spinner from '../components/Spinner.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { fmtMoney } from '../utils/formatters.js'
import ErrorBanner from '../components/ErrorBanner.jsx'
import { buildForm, controllerDistanceValue, customAnswered, sideVentOther, sideVentsOnly, FANS_HP_RANGE_OPTIONS, fansHpRangeValue } from '../lib/discoveryFormSchema.js'
import GreenhouseIllustration from '../components/GreenhouseIllustration.jsx'
import SideVentCountChoice from '../components/SideVentCountChoice.jsx'
import RoofVentCountChoice from '../components/RoofVentCountChoice.jsx'
import IrrigationValveChoice from '../components/IrrigationValveChoice.jsx'
import EndFanChoice from '../components/EndFanChoice.jsx'
import LouverCountChoice from '../components/LouverCountChoice.jsx'
import LouverFanChoice from '../components/LouverFanChoice.jsx'
import FurnaceCountChoice from '../components/FurnaceCountChoice.jsx'
import LouverTypeChoice, { LOUVER_COMBOS, louverComboValue, louverSummary } from '../components/LouverTypeChoice.jsx'
import { focusForSection, focusLabel } from '../lib/greenhouseFocus.js'
import { normalizeLang, translate, localizedImage } from '../lib/discoveryFormI18n.js'
import { DiscoveryLangContext } from '../lib/discoveryLang.js'

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

// Toutes les questions sont obligatoires : aucune page ne laisse passer le
// bouton Suivant sans réponse. Quand le client peut légitimement ignorer la
// réponse, la question offre une sortie explicite — un choix « Je ne sais pas »
// dans les listes, cette case sous les champs libres — plutôt qu'un champ
// qu'on saute en silence.
const DONT_KNOW = 'Je ne sais pas'
const filled = (v) => v != null && String(v).trim() !== ''
const MAX_VALVE_WIRE_FEET = 125
const MAX_FURNACE_WIRE_FEET = 225
// Inverseurs déjà en place sur les moteurs des côtés : la longueur ne sert plus.
// Côté « Autre » : rien ne se dimensionne sur la longueur non plus.
const asksLength = g => g.has_side_vents === true && !sideVentOther(g) && !(g.has_existing_side_vent_motors && g.side_has_inverters === true)

// Illustration de chaque accès réseau livré par le code. Un choix ajouté dans
// l'éditeur retombe sur la scène générique.
const NETWORK_FOCUS = {
  ethernet: 'network_ethernet',
  wifi_250: 'network_wifi',
  wifi_350_coax: 'network_coax',
  mobile_controller: 'network_mobile_choice',
}

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

const form_provinces = tr => PROVINCES.map(p => ({ ...p, label: tr(p.label) }))

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
  // `?page=<id>` : lien « Corriger » de la fiche interne — ouvre cette question,
  // même sur un formulaire déjà envoyé.
  const startPage = search.get('page')
  // Formulaire envoyé rouvert par le client (permis tant qu'aucune commande n'existe).
  const [editing, setEditing] = useState(!!startPage)
  const saveTimer = useRef(null)
  const saveChain = useRef(Promise.resolve())
  const [saveError, setSaveError] = useState(null)
  const pendingPatch = useRef({})
  // Langue choisie à la création du formulaire (FR par défaut).
  const lang = normalizeLang(data?.response?.form_options?.lang)
  const form = useMemo(() => buildForm(data?.form_schema, lang), [data?.form_schema, lang])
  const tr = form.tr
  useEffect(() => { document.documentElement.lang = lang }, [lang])

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
        // L'adresse pré-remplie est celle que le client valide en passant
        // l'étape : elle doit être enregistrée même s'il n'y touche pas.
        const seeded = Object.fromEntries(['farm_address', 'shipping_address'].filter(k => !d.response?.[k] && seed[k]).map(k => [k, seed[k]]))
        if (Object.keys(seeded).length && seed.status !== 'submitted') pendingPatch.current = { ...seeded, ...pendingPatch.current }
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
      if (!result.ok) throw new Error((await result.json().catch(() => ({}))).error || translate(lang, 'Enregistrement impossible'))
      setSaveError(null)
    }).catch(error => {
      pendingPatch.current = { ...body, ...pendingPatch.current }
      setSaveError(error.message)
      throw error
    })
    saveChain.current = request
    return request
  }, [baseUrl, lang])

  const queueSave = useCallback((patch) => {
    setResp(r => ({ ...r, ...patch }))
    pendingPatch.current = { ...pendingPatch.current, ...patch }
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { flushSave().catch(() => {}) }, 600)
  }, [flushSave])


  if (loading) return <Spinner fullscreen label={tr('Chargement…')} />
  if (error) return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-sm border border-slate-200 p-6 text-center">
        <h1 className="text-lg font-semibold text-red-700">{tr("Une erreur s'est produite")}</h1>
        <p className="text-sm text-slate-600 mt-2">{error}</p>
      </div>
    </div>
  )
  if (!data || !resp) return null

  const submitted = resp.status === 'submitted' && (!editing || !resp.editable)
  const detected = data.detected || {}
  const permission = resp.permission_level || detected.permission_level
  const hasMobileController = detected.has_mobile_controller
  const lockedCount = !!data.greenhouse_count_locked
  const isDiscoveryMode = mode === 'by-token'

  return (
    <DiscoveryLangContext.Provider value={form.lang}>
    <FormSchemaContext.Provider value={form}>
      <div className="discovery-form-large min-h-screen bg-slate-50 py-10 px-4">
        <div className="max-w-2xl mx-auto space-y-5">
          <img src="/erp/orisha-logo.png" alt="Orisha" className="h-9 mx-auto" />
          {/* En mode découverte, pas de page de titre : on entre directement dans les questions. */}
          {(!isDiscoveryMode || submitted) && <Header data={data} isDiscoveryMode={isDiscoveryMode} />}
          {saveError && <ErrorBanner>{saveError}</ErrorBanner>}
          {submitted ? (
            <>
              <SubmittedSummary resp={resp} extrasResult={extrasResult} setExtrasResult={setExtrasResult} sessionId={identifier} permission={permission} isDiscoveryMode={isDiscoveryMode} hasMobileController={hasMobileController} onEdit={resp.editable ? () => setEditing(true) : null} />
              <PrepareChecklist resp={resp} />
            </>
          ) : (
            <Wizard
              startOnSummary={editing}
              startPage={startPage}
              isDiscoveryMode={isDiscoveryMode}
              resp={resp}
              flushSave={flushSave}
              queueSave={queueSave}
              permission={permission}
              hasMobileController={hasMobileController}
              lockedCount={lockedCount}
              baseUrl={baseUrl}
              submitting={submitting}
              setSubmitting={setSubmitting}
              onSubmitted={() => { setEditing(false); setResp(r => ({ ...r, status: 'submitted', submitted_at: r.submitted_at || new Date().toISOString() })) }}
            />
          )}
          {/* Sortie de secours, visible à chaque étape : le client bloqué sur une
              question appelle plutôt que d'abandonner le formulaire. */}
          <p className="text-center text-xs text-slate-500">
            {tr("Besoin d'aide ?")} <a href="tel:+18882674247" className="font-medium text-brand-700 hover:text-brand-800">1-888-267-4247</a>
          </p>
        </div>
      </div>
    </FormSchemaContext.Provider>
    </DiscoveryLangContext.Provider>
  )
}

function Header({ data, isDiscoveryMode }) {
  const form = useFormSchema()
  const { tr } = form
  const inv = data.invoice
  if (isDiscoveryMode) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
        <h1 className="text-2xl font-bold text-slate-900">{form.t('header.title')}</h1>
      </div>
    )
  }
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
      <h1 className="text-2xl font-bold text-slate-900">{tr('Merci pour votre achat')}</h1>
      <p className="text-slate-600 mt-1">{tr('Pour finaliser votre installation, nous avons besoin de quelques informations.')}</p>
      {inv && (
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-xs text-slate-400 uppercase tracking-wide">{tr('Facture')}</div>
            <div className="font-medium">{inv.number || inv.id}</div>
          </div>
          <div>
            <div className="text-xs text-slate-400 uppercase tracking-wide">{tr('Total payé')}</div>
            <div className="font-medium">{fmtMoney(inv.total, inv.currency, { cents: true, fallback: '' })}</div>
          </div>
          {inv.pdf_url && (
            <div className="col-span-2">
              <a href={inv.pdf_url} target="_blank" rel="noreferrer" className="text-xs link-record">{tr('Télécharger la facture (PDF)')}</a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}


// ─── Wizard ───────────────────────────────────────────────────────────────

function Wizard({ cover, startOnSummary, startPage, isDiscoveryMode, resp, queueSave, flushSave, permission, hasMobileController, lockedCount, baseUrl, submitting, setSubmitting, onSubmitted }) {
  const [error, setError] = useState(null)
  const [outdated, setOutdated] = useState(false)
  const [activeId, setActiveId] = useState(null)
  const [moving, setMoving] = useState(false)
  // Ouvert depuis le résumé : un bouton ramène au résumé sans refaire les étapes.
  const [fromSummary, setFromSummary] = useState(false)
  const pageRef = useRef(null)
  const resumed = useRef(false)
  const form = useFormSchema()
  const { tr } = form
  const pages = buildQuestionPages({ resp, queueSave, permission, hasMobileController, lockedCount, baseUrl, form })
  // Page de garde : le titre du formulaire, seul, sans question. Elle ne compte
  // pas dans la numérotation des étapes.
  if (cover) pages.unshift({ id: 'cover', title: null, content: cover, complete: true, cover: true })
  if (resp.is_new_site) pages.push({ id: 'submit', title: null, content: null, complete: true })
  const coverOffset = pages[0]?.cover ? 1 : 0
  const index = Math.max(0, pages.findIndex(page => page.id === activeId))
  const current = pages[index]
  const last = current.id === 'submit'
  const firstIncomplete = pages.find(page => !page.complete)
  const ready = !firstIncomplete && canSubmit(resp, hasMobileController, form, permission)

  // Formulaire déjà entamé : on rouvre toujours sur la première question (la
  // page de garde est sautée), jamais sur la première sans réponse. Une
  // question ajoutée depuis (cf. handleSubmit) reste atteignable par
  // « Compléter » sur le résumé.
  useEffect(() => {
    if (resumed.current) return
    resumed.current = true
    // Question demandée absente (réponses changées depuis) : le résumé.
    if (startPage && resp.is_new_site) {
      setActiveId(pages.some(p => p.id === startPage) ? startPage : 'submit')
      setFromSummary(true)
    } else if (resp.is_new_site) setActiveId(startOnSummary ? 'submit' : pages[coverOffset].id)
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
      if (target.id === 'submit') setFromSummary(false)
    } catch (e) { setError(e.message) }
    finally { setMoving(false) }
  }

  // Flèches gauche / droite : question précédente / suivante, même après un
  // clic sur un choix. Ignorées dans un champ texte (le curseur s'y déplace)
  // et vers l'avant tant que la question n'est pas répondue.
  useEffect(() => {
    function onKey(e) {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const t = e.target
      if (t?.closest?.('textarea, select, [contenteditable="true"]') || (t?.tagName === 'INPUT' && !['radio', 'checkbox'].includes(t.type))) return
      if (submitting || moving) return
      if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); navigate(pages[index - 1]) }
      if (e.key === 'ArrowRight' && !last && current.complete && pages[index + 1]) { e.preventDefault(); navigate(pages[index + 1]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Serre `idx` et section du résumé → première page de cette section.
  function editFromSummary(idx, section) {
    const match = SUMMARY_SECTION_PAGES[section]
    const target = idx == null
      ? pages.find(p => p.id === section) || pages.find(p => !p.cover)
      : pages.find(p => p.id.startsWith(`greenhouse:${idx}:`) && match?.test(p.id.slice(`greenhouse:${idx}:`.length)))
    if (!target) return
    setFromSummary(true)
    navigate(target)
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
        throw new Error(j.error || tr('Erreur'))
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
          {!current.cover && <p className="text-xs text-slate-500 mb-3" aria-live="polite">{form.lang === 'en' ? `Step ${index + 1 - coverOffset} of ${pages.length - coverOffset}` : `Étape ${index + 1 - coverOffset} sur ${pages.length - coverOffset}`}</p>}
          {last ? <Card title={tr('Prêt à envoyer ?')}>
            <p className="text-sm text-slate-600">{ready ? tr('Vos réponses sont enregistrées.') : form.t('submit.incomplete')}</p>
            {firstIncomplete && <button type="button" className={btnGhost} onClick={() => navigate(firstIncomplete)}>{tr('Compléter')}</button>}
            <AnswersSummary resp={resp} permission={permission} hasMobileController={hasMobileController} grouped={isDiscoveryMode} className="border-t border-slate-100 pt-3" onEdit={editFromSummary} />
          </Card> : current.title ? <Card title={current.title}>{current.content}</Card> : current.content}
        </div>
        {outdated && <ErrorBanner>
          {tr("Une question a été ajoutée depuis l'ouverture de cette page.")}{' '}
          <button type="button" onClick={() => window.location.reload()} className="underline underline-offset-2 font-medium">{tr('Recharger')}</button>
        </ErrorBanner>}
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <div className="flex flex-wrap justify-between items-center gap-3">
          {index > 0 && <button type="button" onClick={() => navigate(pages[index - 1])} className={btnGhost + ' disabled:opacity-50'}>{tr('Précédent')}</button>}
          {fromSummary && !last && <button type="button" onClick={() => navigate(pages[pages.length - 1])} className={btnGhost}>{tr('Retour au résumé')}</button>}
          <button type="submit" disabled={last ? !ready : !current.complete} className={btnPrimary + ' ml-auto'}>
            {submitting ? tr('Envoi…') : moving ? tr('Enregistrement…') : last ? form.t('submit.label') : tr('Suivant')}
          </button>
        </div>
      </fieldset>
    </form>
  )
}

// Sections de questions personnalisées effectivement rendues, d'après l'état
// courant du formulaire : seules celles-là peuvent bloquer la soumission.
// Accès réseau : posé à un nouveau site, et à un site existant dont les serres
// sont à plus de 350 pi du contrôleur central (il en faut un nouveau).
function asksNetwork(resp, hasMobileController) {
  if (hasMobileController) return false
  return resp.is_new_site === 'new' || (resp.is_new_site === 'add_to_existing' && resp.within_central_controller_range === false)
}

// Site existant avec au moins une serre Chef de culture : il a souvent déjà son
// capteur de vent, on lui demande s'il en faut un.
function asksWindSensor(resp, permission) {
  return resp.is_new_site === 'add_to_existing' && (resp.greenhouses || []).some(g => (g.permission_level || resp.permission_level || permission) === 'chief_grower')
}

function visibleCustomSections(resp, hasMobileController) {
  const s = ['intro', 'order_type']
  if (resp.is_new_site === 'new') {
    s.push('farm_address', 'shipping_address')
  } else if (resp.is_new_site === 'add_to_existing') {
    s.push('shipping_address')
  }
  if (asksNetwork(resp, hasMobileController)) s.push('network')
  if (resp.is_new_site) s.push('end')
  return s
}

function canSubmit(resp, hasMobileController, form, permission) {
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
  } else {
    const ship = resp.shipping_address
    if (!ship?.line1 || !ship?.province) return false
  }
  if (asksNetwork(resp, hasMobileController) && !resp.network_access) return false
  if (asksWindSensor(resp, permission) && typeof resp.needs_wind_sensor !== 'boolean') return false
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
    // Serre Helper : ni louvres ni humidité ne lui sont demandées (côtés
    // ouvrants seulement), donc rien à exiger de ce côté.
    const helperOnly = sideVentsOnly(g.permission_level || resp.permission_level || permission)
    if (asksLength(g) && !form.isHidden('greenhouse.length') && g.length_range === 'over_200' && (!Number.isFinite(Number(g.length)) || Number(g.length) <= 200)) return false
    if (!helperOnly && typeof g.has_louvers !== 'boolean') return false
    // « Autre » ne porte pas de voltage : seule la commande est exigée.
    if (!helperOnly && g.has_louvers && (!(g.louvers?.length) || g.louvers.some(l => !['spring_loaded', 'open_close', 'other'].includes(l.control_type) || typeof l.has_fan !== 'boolean'
      || (l.control_type !== 'other' && (!['110', '24', '12', 'other'].includes(l.voltage) || (l.voltage === 'other' && !l.voltage_other?.trim()) || (l.voltage === '110' && l.control_type === 'open_close')))))) return false
    const ghCtx = { record: g, custom: g.custom, root: resp, rootCustom: answers }
    const perCard = [...form.custom('greenhouse', ghCtx)]
    if ((g.permission_level || resp.permission_level) === 'chief_grower') perCard.push(...form.custom('greenhouse_chief', ghCtx))
    for (const q of perCard) {
      if (q.required && !customAnswered(q, (g.custom || {})[q.id])) return false
    }
  }
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

// Chaque question montre une illustration de son équipement.
// Sur écran étroit, elle passe sous les champs.
function Ask({ questionId, image, focus, height = 96, pipeType, children }) {
  const form = useFormSchema()
  return (
    <div className="flex flex-col sm:flex-row items-start gap-3">
      <div className="flex-1 min-w-0 w-full space-y-2">{children}</div>
      <GreenhouseIllustration image={image || form.image(questionId)} focus={focus} variant={focus === 'furnaces' ? 'furnace-choice' : focus === 'furnace_wire' ? 'furnace-wire-choice' : undefined} pipeType={pipeType} height={height} label={form.tr(focusLabel(focus))} className="self-center sm:self-start" />
    </div>
  )
}

// La liste et le contenu des pages sont construits ensemble : les branches
// conditionnelles et les questions ajoutées dans l'éditeur restent synchronisées.
function buildQuestionPages({ resp, queueSave, permission, hasMobileController, lockedCount, baseUrl, form }) {
  const pages = []
  // « Même adresse » montre l'illustration de la question ; « différente », le même camion devant une maison.
  const sameAddressImage = (form.image('shipping.prompt_new') !== 'none' && form.image('shipping.prompt_new')) || 'shipping.webp'
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
  // Même fiche pour un nouveau site et pour des serres à plus de 350 pi du
  // contrôleur existant.
  const networkPages = () => {
    if (!asksNetwork(resp, hasMobileController)) return
    // Quatre scènes cliquables : chaque façon de rejoindre la serre porte sa réponse.
    add('network', form.t('network.title'), <div className="space-y-2">
      <p className="text-sm text-slate-600">{form.t('network.prompt')}<Req /></p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {form.opts('network.options').map(o => <ImageOption key={o.value} checked={resp.network_access === o.value} onChange={() => queueSave({ network_access: o.value })} label={o.label} help={o.help} focus={NETWORK_FOCUS[o.value] || 'network'} image={form.image(`network.image_${o.value}`)} />)}
      </div>
    </div>, resp.network_access)
    if (!form.isHidden('network.wifi') && ['wifi_250', 'wifi_350_coax'].includes(resp.network_access)) {
      // Sans nom de réseau, le mot de passe ne sert à rien : on ne le demande pas.
      for (const field of resp.wifi_ssid === DONT_KNOW ? ['wifi_ssid'] : ['wifi_ssid', 'wifi_password']) {
        const label = form.t(`network.${field === 'wifi_ssid' ? 'wifi_ssid_label' : 'wifi_password_label'}`)
        const unknown = resp[field] === DONT_KNOW
        add(field, form.t('network.title'), <Ask questionId="network.wifi" focus="network_wifi_credentials">
          <p className="text-sm text-slate-600">{form.t('network.wifi_prompt')}</p>
          <Field label={label} required>
            {field === 'wifi_password' && !unknown
              ? <PasswordInput label={label} value={resp[field] || ''} onChange={v => queueSave({ [field]: v })} />
              : <input aria-label={label} type="text" autoComplete={field === 'wifi_password' ? 'new-password' : undefined} disabled={unknown} className={inputCls} value={unknown ? '' : (resp[field] || '')} onChange={e => queueSave({ [field]: e.target.value })} />}
            <DontKnow checked={unknown} onChange={on => queueSave({ [field]: on ? DONT_KNOW : '' })} />
          </Field>
        </Ask>, filled(resp[field]))
      }
    }
    rootCustom('network')
  }
  rootCustom('intro')
  // Deux scènes cliquables : un nouveau site (une serre) ou un site qui a déjà
  // son contrôleur central (deux serres). L'image porte la réponse.
  add('order_type', form.t('order_type.title'), <div className="space-y-2">
    <p className="text-sm text-slate-600">{form.t('order_type.prompt')}<Req /></p>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {form.opts('order_type.options').map(o => {
        const focus = o.value === 'add_to_existing' ? 'site_existing' : 'site_new'
        return <ImageOption key={o.value} checked={resp.is_new_site === o.value} onChange={() => queueSave({ is_new_site: o.value })} label={o.label} help={o.help} focus={focus} image={form.image(o.value === 'add_to_existing' ? 'order_type.image_existing' : 'order_type.image_new')} />
      })}
    </div>
  </div>, resp.is_new_site)
  // Un contrôleur central internet mobile déjà à la commande en fournit un
  // nouveau : la distance au contrôleur existant ne change plus rien.
  if (resp.is_new_site === 'add_to_existing' && !hasMobileController) {
    const distance = controllerDistanceValue(resp)
    add('controller_distance', form.t('controller_distance.title'), <div className="space-y-2">
      <p className="text-sm text-slate-600">{form.t('controller_distance.prompt')}<Req /></p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {form.opts('controller_distance.options').map(o => <ControllerDistanceOption key={o.value} value={o.value} checked={distance === o.value} onChange={() => queueSave({ central_controller_distance: o.value, within_central_controller_range: o.value !== 'no' })} label={o.label} help={o.help} />)}
      </div>
      {resp.within_central_controller_range === true && <p className="text-sm text-slate-600">{form.t('controller_distance.near')}</p>}
    </div>, typeof resp.within_central_controller_range === 'boolean')
    networkPages()
  }
  if (asksWindSensor(resp, permission)) add('wind_sensor', form.t('wind_sensor.title'), <div className="space-y-2">
    <p className="text-sm text-slate-600">{form.t('wind_sensor.prompt')}<Req /></p>
    <YesNoButtons value={resp.needs_wind_sensor} onChange={v => queueSave({ needs_wind_sensor: v })} />
  </div>, typeof resp.needs_wind_sensor === 'boolean')
  rootCustom('order_type')
  if (!resp.is_new_site) return pages

  if (resp.is_new_site === 'new') {
    address('farm_address', form.t('farm.title'), 'farm.title')
    rootCustom('farm_address')
    add('shipping_same', form.t('shipping.title'), <div className="space-y-2">
      <p className="text-sm text-slate-600">{form.t('shipping.prompt_new')}<Req /></p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ImageOption checked={resp.shipping_same_as_farm === true} onChange={() => queueSave({ shipping_same_as_farm: true })} label={form.t('shipping.same_yes')} image={sameAddressImage} />
        <ImageOption checked={resp.shipping_same_as_farm === false} onChange={() => queueSave({ shipping_same_as_farm: false })} label={form.t('shipping.same_no')} image="shipping_home.webp" />
      </div>
    </div>, typeof resp.shipping_same_as_farm === 'boolean')
  }
  if (resp.is_new_site !== 'new' || resp.shipping_same_as_farm === false) address('shipping_address', form.t('shipping.title'), 'shipping.prompt_existing')
  rootCustom('shipping_address')
  if (resp.is_new_site === 'new') networkPages()
  const greenhouses = resp.greenhouses || []
  if (!lockedCount) add('greenhouse_count', form.t('greenhouses.count_title'), <Ask questionId="greenhouses.count_label" focus="count" height={116}>
    <Field label={form.t('greenhouses.count_label')} required><input aria-label={form.t('greenhouses.count_label')} type="number" min={1} max={50} className={inputCls} value={resp.num_greenhouses || ''} onChange={e => {
      const count = Math.max(0, Math.min(50, parseInt(e.target.value) || 0))
      queueSave({ num_greenhouses: count, greenhouses: Array.from({ length: count }, (_, i) => greenhouses[i] || {}) })
    }} /></Field>
  </Ask>, Number(resp.num_greenhouses) > 0)
  greenhouses.forEach((g, idx) => {
    const onChange = patch => queueSave({ greenhouses: greenhouses.map((item, i) => i === idx ? { ...item, ...patch } : item) })
    addGreenhousePages({ add, idx, g, onChange, permission, root: resp, form })
  })
  rootCustom('end')
  return pages
}

const FURNACE_WIRE_PRESETS = ['25', '50', '75', '100']
// Colonnes de la question du nombre de fournaises : les images tiennent sur
// deux lignes, pour rester grandes.
const FURNACE_GRID_COLS = { 1: 'grid-cols-1', 2: 'grid-cols-1', 3: 'grid-cols-2', 4: 'grid-cols-2', 5: 'grid-cols-3', 6: 'grid-cols-3' }
const validEquipmentCount = value => filled(value) && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 100

// Permissions supplémentaires fixées par Orisha : elles ne fournissent rien,
// elles relèvent le nombre d'appareils que le client peut déclarer dans la
// serre. Chauffage = 2 fournaises de plus, Irrigation = 4 valves, Côtés
// ouvrants = 2 moteurs, Toits ouvrants = 1 toit, Toiles thermiques = 1 toile.
const EXTRA_UNITS = { furnaces: 2, valves: 4, rollups: 2, roofs: 1, screens: 1 }
// Chauffage ouvre jusqu'à 4 fournaises, Irrigation jusqu'à 8 valves — sauf au
// Helper : un extra lui donne 1 à 2 fournaises, 1 à 4 valves, 1 toit sans question.
const PERMISSION_FLOOR = { furnaces: 4, valves: 8 }
const STANDARD_LIMITS = {
  chief_grower: { rollups: 2, furnaces: 2, valves: 4, roofs: 1, screens: 0 },
  helper: { rollups: 2, furnaces: 0, valves: 0, roofs: 0, screens: 0 },
}
const SCREEN_COUNT_LABELS = { 0: 'Aucune toile thermique', 1: '1 toile thermique', 2: '2 toiles thermiques' }
// Une seule toile achetée en extra : elle existe, la question n'est pas posée.
const SCREEN_IMPLIED = { has_roof_vents: true, num_roof_vents: 1 }
const screenRec = (g, lim) => (lim === 1 ? { ...thermalScreen(g), ...SCREEN_IMPLIED } : thermalScreen(g))
// Helper avec un toit en extra : idem, le toit existe.
const roofRec = (g, limit) => (limit.roofImplied ? { ...g, ...SCREEN_IMPLIED } : g)
function greenhouseLimits(options, idx, permission) {
  const e = Array.isArray(options?.additional_equipment) ? options.additional_equipment[idx] || {} : {}
  const base = STANDARD_LIMITS[permission] || STANDARD_LIMITS.chief_grower
  const helper = permission === 'helper'
  const n = key => {
    const extra = Math.max(0, Number(e[key]) || 0) * EXTRA_UNITS[key]
    return extra && PERMISSION_FLOOR[key] && !helper ? Math.max(base[key] + extra, PERMISSION_FLOOR[key] + extra - EXTRA_UNITS[key]) : base[key] + extra
  }
  // Permission Ventilation : louvres et ventilateurs de bout de 2 à 4.
  const aerators = e.ventilation === true ? 4 : 2
  return { furnaces: n('furnaces'), valves: n('valves'), rollups: n('rollups'), roofs: n('roofs'), screens: n('screens'), louvers: aerators, fans: aerators, extraFurnaces: Number(e.furnaces) > 0,
    minValves: helper && Number(e.valves) > 0 ? 1 : 0, roofImplied: helper && n('roofs') === 1 }
}

// Au-delà des choix illustrés (0 à `from`), un nombre libre jusqu'au plafond.
function MoreCount({ from, max, value, onChange, label }) {
  const { tr } = useFormSchema()
  if (max <= from) return null
  const v = Number(value)
  return (
    <Field label={`${label} (${from + 1} ${tr('à')} ${max})`}>
      <input aria-label={label} className={inputCls} type="number" min={from + 1} max={max} step={1} value={v > from ? v : ''}
        onChange={e => { const n = Math.min(max, Math.max(0, parseInt(e.target.value) || 0)); if (n > from) onChange(n) }} />
    </Field>
  )
}

// Les deux profils de tuyau de côté sont proposés en photo, pas en liste.
const SIDE_PIPE_IMAGES = { aluminum_C: 'pipe-c.svg', steel_O: 'pipe-o.svg' }

// Le diamètre se choisit en image : la mesure standard du tuyau montré, une
// autre mesure à préciser, ou « je ne sais pas ».
const DIAMETER_PRESET_IMAGES = { '2"': 'diameter-2in.svg', '1 5/16"': 'diameter-1-5-16.svg' }
// Le choix reste stocké à la mesure maximale ; le libellé et la variante
// d’illustration montrent la plage acceptée.
const DIAMETER_PRESET_LABELS = { '1 5/16"': 'Entre 3/4 po et 1 14/4 po' }
const DIAMETER_IMAGE_IDS = { standard: 'greenhouse.image_diameter_standard', other: 'greenhouse.image_diameter_other', unknown: 'greenhouse.image_diameter_unknown' }

// Les deux longueurs possibles sont proposées en scène cliquable.
const LENGTH_RANGE_FOCUS = { up_to_200: 'length_up_to_200', over_200: 'length_over_200' }
const LENGTH_RANGE_IMAGE_IDS = { up_to_200: 'greenhouse.image_length_up_to_200', over_200: 'greenhouse.image_length_over_200' }

// Moteurs des côtés : la réponse se choisit sur l'image — le moteur déjà monté
// sur le tuyau, ou la place encore vide.
const MOTORS_FOCUS = { yes: 'motors_existing', no: 'motors_needed' }
const MOTORS_IMAGE_IDS = { yes: 'greenhouse.image_motors_existing', no: 'greenhouse.image_motors_needed' }

// Hauteur du côté ouvrant : le film relevé se montre, court ou haut.
const VENT_HEIGHT_FOCUS = { up_to_6: 'vent_height_up_to_6', over_6: 'vent_height_over_6' }
const VENT_HEIGHT_IMAGE_IDS = { up_to_6: 'greenhouse.image_vent_height_up_to_6', over_6: 'greenhouse.image_vent_height_over_6', unknown: 'greenhouse.image_vent_height_unknown' }

// Pages de chaque section du résumé, pour son bouton « Modifier ».
const SUMMARY_SECTION_PAGES = {
  sides: /^(side_vents|existing_motors|motor_|length|side_|guide)/,
  roofs: /^roof/,
  screens: /^screen/,
  louvers: /^louver/,
  fans: /^fans/,
  irrigation: /^(irrigation|orisha_valves|valve)/,
  heating: /^furnace/,
  custom: /^custom/,
}

// Moteurs de côtés déjà en place : deux modèles courants, un autre, ou inconnu.
const SIDE_MOTOR_CHOICES = [
  { value: 'kingzo', label: 'Kingzo 24 V DC', image: 'motor-kingzo-24vdc.webp', brand: 'Kingzo', model: '24 V DC' },
  { value: 'lvm', label: 'LVM60 / LVM100', image: 'motor-lvm60-lvm100.webp', brand: 'LVM', model: 'LVM60 / LVM100' },
  { value: 'other', label: 'Autre' },
  { value: 'unknown', label: DONT_KNOW, brand: DONT_KNOW },
]

// Inverseurs des moteurs de côtés déjà en place.
const SIDE_INVERTER_MODELS = [['8ZE133L', '8ZE133L'], ['8ZE133LDC', '8ZE133LDC'], ['other', 'Autre'], [DONT_KNOW, DONT_KNOW]]

// Marques de valves proposées quand le client a déjà les siennes.
const VALVE_BRANDS = ['Rainbird', 'Irritrol', 'Autre marque']

// Mode de la serre, à côté de son numéro. Le nom donné par le client suit le
// numéro ; avec `onRename`, un crayon le rend modifiable sur place.
const PERMISSION_MODES = { chief_grower: 'Chef de culture', helper: 'Assistant' }
function GreenhouseTitle({ idx, permission, suffix, name, onRename }) {
  const { tr } = useFormSchema()
  const [draft, setDraft] = useState(null)
  const mode = tr(PERMISSION_MODES[permission])
  const label = `${tr('Nom de la serre')} #${idx + 1}`
  const commit = () => { if (draft != null && draft.trim() !== (name || '')) onRename(draft.trim()); setDraft(null) }
  const title = draft != null
    ? <input autoFocus aria-label={label} className="ml-2 border-b border-slate-300 focus:border-emerald-500 outline-none font-semibold bg-transparent w-48 max-w-full"
      value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit() } else if (e.key === 'Escape') setDraft(null) }} />
    : <>{name && ` · ${name}`}{onRename && <button type="button" onClick={() => setDraft(name || '')} aria-label={label} title={tr('Nommer')}
      className="ml-1.5 align-middle text-slate-400 hover:text-slate-700"><Pencil size={14} /></button>}</>
  return <>{tr('Serre')} #{idx + 1}{title}{mode && <span className="ml-2 text-sm font-normal text-slate-500">{mode}</span>}{suffix && ` · ${suffix}`}</>
}

function addGreenhousePages({ add, idx, g, onChange, permission, root, form }) {
  const cardPermission = g.permission_level || permission
  const helperOnly = sideVentsOnly(cardPermission)
  const limit = greenhouseLimits(root.form_options, idx, cardPermission)
  const { tr } = form
  const page = (id, content, complete = true, suffix = '') => add(`greenhouse:${idx}:${id}`, <GreenhouseTitle idx={idx} permission={cardPermission} suffix={suffix} name={g.name} onRename={v => onChange({ name: v })} />, content, complete)
  // Toute question retient le bouton Suivant (d'où l'astérisque rouge) : par
  // défaut une réponse saisie suffit, `complete` en options dit mieux quand la
  // réponse doit remplir une condition (nombre au-delà d'un seuil, liste non
  // vide…).
  const question = (id, label, control, options = {}) => {
    const { focus = 'overview', questionId = id, complete, suffix = '', help, image } = options
    return page(id,
      <Ask questionId={questionId} focus={focus} image={image} pipeType={g.side_pipe_type}>
        <Field label={label} required>{control}{help && <div className="text-xs text-slate-500 mt-1">{help}</div>}</Field>
      </Ask>, complete, suffix)
  }
  const select = (id, label, value, change, choices, options = {}) => question(id, label,
    <select aria-label={label} className={inputCls} value={value ?? ''} onChange={e => change(e.target.value)}><option value="">—</option>{choices.map(o => <option key={o.value} value={o.value}>{tr(o.label)}</option>)}</select>, { complete: filled(value), ...options })
  // Cartes de choix : sans illustration à côté, elles prennent toute la largeur.
  const boolean = (id, label, value, change, options = {}) => question(id, label,
    <YesNoButtons value={value} onChange={change} unknown={options.unknown} />, { complete: typeof value === 'boolean' || (options.unknown && value === 'unknown'), image: 'none', ...options })
  const diameter = (id, label, value, change, preset) => {
    const other = value?.startsWith('Autre:')
    const exactDiameter = other ? value.slice('Autre:'.length).trimStart() : ''
    const selected = other ? '__other' : value
    const steel = preset === '1 5/16"'
    const choices = [
      { value: preset, label: tr(DIAMETER_PRESET_LABELS[preset] || preset), focus: 'diameter_standard', image: form.image(DIAMETER_IMAGE_IDS.standard) || DIAMETER_PRESET_IMAGES[preset], variant: steel ? 'diameter-range' : undefined },
      // Acier : seconde plage, stockée elle aussi à sa mesure maximale.
      ...(steel ? [{ value: '1 1/2"', label: tr('Entre 1 5/16 po et 1 1/2 po'), focus: 'diameter_other', variant: 'diameter-over-1-5-16' }] : []),
      { value: '__other', label: tr(steel ? 'Autre, préciser' : 'Autre (préciser)'), focus: 'diameter_other', image: form.image(DIAMETER_IMAGE_IDS.other) },
      { value: DONT_KNOW, label: tr(DONT_KNOW), focus: 'diameter_unknown', image: form.image(DIAMETER_IMAGE_IDS.unknown) },
    ]
    page(id, <div className="space-y-2">
      <p className="text-sm text-slate-600">{label}<Req /></p>
      <div className={`grid grid-cols-1 gap-3 ${steel ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
        {choices.map(o => (
          <ImageOption key={o.value} checked={selected === o.value} onChange={() => change(o.value === '__other' ? 'Autre: ' : o.value)} label={o.label} focus={o.focus} image={o.image} variant={o.variant} />
        ))}
      </div>
      {other && <Field label={form.t('greenhouse.diameter_other_label')} required>
        <input aria-label={form.t('greenhouse.diameter_other_label')} className={inputCls} value={exactDiameter} onChange={e => change(`Autre: ${e.target.value}`)} />
      </Field>}
    </div>, other ? filled(exactDiameter) : filled(value))
  }
  if (!form.isHidden('greenhouse.side_vents')) {
    // Le nombre de côtés ouvrants à automatiser se choisit sur l'image : aucun,
    // un seul côté, ou un de chaque côté — soit un moteur par côté automatisé.
    // Une permission Côtés ouvrants permet de déclarer davantage de moteurs.
    const sideVents = g.has_side_vents === false ? 0 : g.has_side_vents === true && filled(g.num_side_vent_motors) ? Number(g.num_side_vent_motors) : null
    const pickSideVents = n => onChange(n === 0
      ? { has_side_vents: false, side_vent_height: '', side_vent_height_range: '', side_pipe_type: '', side_pipe_diameter: '', guide_pipes_state: '', guide_pipe_diameter: '', wants_compatible_guide_pipes: false, num_side_vent_motors: 0, has_existing_side_vent_motors: null }
      : { has_side_vents: true, num_side_vent_motors: n })
    // Côtés supplémentaires achetés : « Aucun » disparaît, les images vont de 1
    // à 4 sur deux rangées ; au-delà, un nombre libre.
    const extraSides = limit.rollups > 2
    const sideChoices = extraSides ? Array.from({ length: Math.min(limit.rollups, 4) }, (_, i) => i + 1) : [0, 1, 2]
    page('side_vents', <div className="space-y-2">
      <p className="text-sm text-slate-600">{form.t('greenhouse.side_vents_count_label')}<Req /></p>
      <div className={`grid gap-3 ${extraSides ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-3'}`}>
        {sideChoices.map(n => <SideVentCountChoice key={n} name={`side-vents-${idx}`} count={n} checked={sideVents === n} onChange={() => pickSideVents(n)} />)}
      </div>
      <MoreCount from={extraSides ? 4 : 2} max={limit.rollups} value={sideVents} onChange={pickSideVents} label={tr('Moteurs')} />
    </div>, sideVents != null && sideVents >= (extraSides ? 1 : 0) && sideVents <= Math.max(2, limit.rollups))
    if (g.has_side_vents === true) {
      // Roll-up ou autre système : « Autre » saute les questions roll-up.
      const ventType = g.side_vent_type
      page('side_vent_type', <fieldset className="min-w-0 space-y-2">
        <legend className="text-sm text-slate-600">{form.t('greenhouse.side_vent_type_label')}<Req /></legend>
        <div className="grid grid-cols-2 gap-3">
          {form.opts('greenhouse.side_vent_type_options').map(o => <RadioOption key={o.value} checked={ventType === o.value} label={o.label} help={o.help} onChange={() => onChange({ side_vent_type: o.value })} />)}
        </div>
        {ventType === 'other' && <Field label={tr('Précisez')} required>
          <input aria-label={tr('Précisez')} className={inputCls} value={g.side_vent_type_other || ''} onChange={e => onChange({ side_vent_type_other: e.target.value })} />
        </Field>}
      </fieldset>, ventType === 'other' ? filled(g.side_vent_type_other?.trim()) : filled(ventType))
    }
    if (g.has_side_vents === true && !sideVentOther(g)) {
      const motors = g.has_existing_side_vent_motors == null ? '' : g.has_existing_side_vent_motors ? 'yes' : 'no'
      page('existing_motors', <div className="space-y-2">
        <p className="text-sm text-slate-600">{form.t('greenhouse.motors_label')}<Req /></p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {form.opts('greenhouse.motors_options').map(o => (
            <ImageOption key={o.value} checked={motors === o.value} onChange={() => onChange({ has_existing_side_vent_motors: o.value === 'yes', ...(o.value === 'yes' ? { guide_pipes_state: '', guide_pipe_diameter: '', wants_compatible_guide_pipes: false } : {}) })} label={o.label} help={o.help}
              focus={MOTORS_FOCUS[o.value] || 'side_vents'} image={form.image(MOTORS_IMAGE_IDS[o.value])} />
          ))}
        </div>
      </div>, typeof g.has_existing_side_vent_motors === 'boolean')
      // Moteurs déjà là : inverseurs d'abord, puis marque et modèle s'il n'y en a pas.
      if (g.has_existing_side_vent_motors) {
        // Inverseurs des moteurs en place : présence, répartition (si plus d'un
        // moteur), puis modèle ; « Autre » demande marque et modèle dessous.
        const manyMotors = Number(g.num_side_vent_motors) > 1
        const inverterModel = g.side_inverter_model
        const otherInverter = inverterModel === 'other'
        const choiceRow = (items, current, pick, cols = 'grid-cols-2') => <div className={`grid ${cols} gap-3`}>
          {items.map(([v, label]) => <RadioOption key={v} label={tr(label)} checked={current === v} onChange={() => pick(v)} />)}
        </div>
        page('side_inverters', <fieldset className="min-w-0 space-y-3">
          <legend className="text-sm text-slate-600">{tr('Avez-vous des inverseurs pour ces moteurs ?')}<Req /></legend>
          {choiceRow([['yes', 'Oui'], ['no', 'Non'], ['unknown', DONT_KNOW]], g.side_has_inverters == null ? '' : g.side_has_inverters === 'unknown' ? 'unknown' : g.side_has_inverters ? 'yes' : 'no',
            v => onChange({ side_has_inverters: v === 'unknown' ? 'unknown' : v === 'yes', side_inverter_ratio: '', side_inverter_model: '', side_inverter_brand_other: '', side_inverter_model_other: '', ...(v === 'yes' ? { length_range: '', length: '', side_vent_motor_choice: '', side_vent_motor_brand: '', side_vent_motor_model: '' } : {}) }), 'grid-cols-1 sm:grid-cols-3')}
          {g.side_has_inverters === true && manyMotors && <div className="space-y-2">
            <p className="text-sm text-slate-600">{tr('Combien d’inverseurs ?')}<Req /></p>
            {choiceRow([['per_motor', 'Un par moteur'], ['per_two', 'Un pour deux moteurs'], ['unknown', DONT_KNOW]], g.side_inverter_ratio, v => onChange({ side_inverter_ratio: v }), 'grid-cols-1 sm:grid-cols-3')}
          </div>}
          {g.side_has_inverters === true && <div className="space-y-2">
            <p className="text-sm text-slate-600">{tr('Modèle de l’inverseur')}<Req /></p>
            {choiceRow(SIDE_INVERTER_MODELS, inverterModel, v => onChange({ side_inverter_model: v, side_inverter_brand_other: '', side_inverter_model_other: '' }), 'grid-cols-2 sm:grid-cols-4')}
            {otherInverter && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label={tr('Marque')} required><input aria-label={tr('Marque de l’inverseur')} className={inputCls} value={g.side_inverter_brand_other || ''} onChange={e => onChange({ side_inverter_brand_other: e.target.value })} /></Field>
              <Field label={tr('Modèle')}><input aria-label={tr('Modèle de l’inverseur')} className={inputCls} value={g.side_inverter_model_other || ''} onChange={e => onChange({ side_inverter_model_other: e.target.value })} /></Field>
            </div>}
          </div>}
        </fieldset>, g.side_has_inverters === false || g.side_has_inverters === 'unknown' || (g.side_has_inverters === true
          && (!manyMotors || ['per_motor', 'per_two', 'unknown'].includes(g.side_inverter_ratio))
          && SIDE_INVERTER_MODELS.some(([v]) => v === inverterModel)
          && (!otherInverter || filled(g.side_inverter_brand_other?.trim()))))
        // Inverseurs déjà là : le moteur ne change rien, on ne le demande pas.
        // Sinon deux moteurs courants en photo, ou « Autre » avec marque et modèle dessous.
        if (g.side_has_inverters === false || g.side_has_inverters === 'unknown') {
          const motorChoice = g.side_vent_motor_choice
          const otherMotor = motorChoice === 'other'
          page('motor_brand', <fieldset className="min-w-0 space-y-2">
            <legend className="text-sm text-slate-600">{tr('Marque des moteurs')}<Req /></legend>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {SIDE_MOTOR_CHOICES.map(o => <ImageOption key={o.value} name={`motor-brand-${idx}`} checked={motorChoice === o.value} label={tr(o.label)} image={o.image || 'none'}
                onChange={() => onChange({ side_vent_motor_choice: o.value, side_vent_motor_brand: o.brand || '', side_vent_motor_model: o.model || '' })} />)}
            </div>
            {otherMotor && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label={tr('Marque')} required><input aria-label={tr('Marque des moteurs')} className={inputCls} value={g.side_vent_motor_brand || ''} onChange={e => onChange({ side_vent_motor_brand: e.target.value })} /></Field>
              <Field label={tr('Modèle')}><input aria-label={tr('Modèle des moteurs')} className={inputCls} value={g.side_vent_motor_model || ''} onChange={e => onChange({ side_vent_motor_model: e.target.value })} /></Field>
            </div>}
          </fieldset>, SIDE_MOTOR_CHOICES.some(o => o.value === motorChoice) && (!otherMotor || filled(g.side_vent_motor_brand?.trim())))
        }
      }
    }
  }
  const lengthRange = g.length_range || (Number(g.length) > 0 ? (Number(g.length) > 200 ? 'over_200' : 'up_to_200') : '')
  if (asksLength(g) && !form.isHidden('greenhouse.length')) {
    // La longueur se choisit sur l'image : une serre courte, ou une serre longue.
    const pickLength = range => {
      const keep = range === 'up_to_200' ? Number(g.length) > 0 && Number(g.length) <= 200 : range === 'over_200' && Number(g.length) > 200
      onChange({ length_range: range, length: keep ? g.length : '' })
    }
    // Plus de 200 pi : la longueur exacte se demande juste dessous, même page.
    const longGreenhouse = lengthRange === 'over_200'
    page('length_range', <div className="space-y-2">
      <p className="text-sm text-slate-600">{form.t('greenhouse.length_label')}<Req /></p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {form.opts('greenhouse.length_range_options').map(o => (
          <ImageOption key={o.value} checked={lengthRange === o.value} onChange={() => pickLength(o.value)} label={o.label} help={o.help}
            focus={LENGTH_RANGE_FOCUS[o.value] || 'length'} image={form.image(LENGTH_RANGE_IMAGE_IDS[o.value])} />
        ))}
      </div>
      {longGreenhouse && <Field label={tr('Précisez la longueur (pi)')} required>
        <input aria-label={tr('Précisez la longueur (pi)')} className={inputCls} type="number" min={200} step="any" value={g.length ?? ''} onChange={e => onChange({ length_range: 'over_200', length: e.target.value })} />
      </Field>}
    </div>, longGreenhouse ? Number.isFinite(Number(g.length)) && Number(g.length) > 200 : filled(lengthRange))
  }
  if (!form.isHidden('greenhouse.side_vents')) {
    if (g.has_side_vents === true && !sideVentOther(g)) {
      if (g.has_existing_side_vent_motors === false) {
        const heightRange = g.side_vent_height_range || (g.side_vent_height === DONT_KNOW ? 'unknown' : Number(g.side_vent_height) > 0 ? (Number(g.side_vent_height) > 6 ? 'over_6' : 'up_to_6') : '')
        // Deux seuils existants et une hauteur inconnue, sans inventer de mesure.
        const pickHeight = range => {
          const keep = range === 'up_to_6' ? Number(g.side_vent_height) > 0 && Number(g.side_vent_height) <= 6 : range === 'over_6' && Number(g.side_vent_height) > 6
          onChange({ side_vent_height_range: range, side_vent_height: range === 'unknown' ? DONT_KNOW : keep ? g.side_vent_height : '' })
        }
        page('side_vent_height_range', <fieldset className="min-w-0 space-y-2">
          <legend className="text-sm text-slate-600">{form.t('greenhouse.side_vent_height_label')}<Req /></legend>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {form.opts('greenhouse.side_vent_height_range_options').map(o => (
              <ImageOption key={o.value} name={`vent-height-${idx}`} checked={heightRange === o.value} onChange={() => pickHeight(o.value)} label={o.label} help={o.help}
                focus={VENT_HEIGHT_FOCUS[o.value] || 'vent_height'} image={form.image(VENT_HEIGHT_IMAGE_IDS[o.value]) || (o.value === 'unknown' ? 'vent-height-unknown.svg' : undefined)} />
            ))}
          </div>
          {/* Plus de 6 pi : la hauteur exacte se demande juste dessous, même page. */}
          {heightRange === 'over_6' && <Field label={tr('Précisez la hauteur (pi)')} required>
            <input aria-label={tr('Précisez la hauteur (pi)')} className={inputCls} type="number" min={6} step="any" value={g.side_vent_height ?? ''} onChange={e => onChange({ side_vent_height_range: 'over_6', side_vent_height: e.target.value })} />
          </Field>}
        </fieldset>, heightRange === 'over_6' ? Number.isFinite(Number(g.side_vent_height)) && Number(g.side_vent_height) > 6 : filled(heightRange))
        // Le type de tuyau se choisit sur la photo : les deux profils sont
        // montrés côte à côte au lieu d'être cachés derrière une liste.
        const pipeOpts = form.opts('greenhouse.side_pipe_type_options')
        const pickPipe = v => onChange({ side_pipe_type: v, side_pipe_diameter: '' })
        page('side_pipe_type', <div className="space-y-2">
          <p className="text-sm text-slate-600">{form.t('greenhouse.side_pipe_type_label')}<Req /></p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {pipeOpts.filter(o => SIDE_PIPE_IMAGES[o.value]).map(o => (
              <ImageOption key={o.value} checked={g.side_pipe_type === o.value} onChange={() => pickPipe(o.value)} label={o.label} image={SIDE_PIPE_IMAGES[o.value]} />
            ))}
          </div>
          {pipeOpts.filter(o => !SIDE_PIPE_IMAGES[o.value]).map(o => (
            <RadioOption key={o.value} checked={g.side_pipe_type === o.value} onChange={() => pickPipe(o.value)} label={o.label} help={o.help} />
          ))}
        </div>, filled(g.side_pipe_type))
        if (['aluminum_C', 'steel_O'].includes(g.side_pipe_type)) diameter('side_pipe_diameter', tr(g.side_pipe_type === 'aluminum_C' ? 'Diamètre du tuyau aluminium' : 'Diamètre externe du tuyau d\'acier'), g.side_pipe_diameter, v => onChange({ side_pipe_diameter: v }), g.side_pipe_type === 'aluminum_C' ? '2"' : '1 5/16"')
      }
      // Moteurs déjà en place : leurs tuyaux guides aussi, on ne le demande pas.
      if (g.has_existing_side_vent_motors === false) page('guide_pipes', <fieldset className="space-y-2">
        <legend className="text-sm text-slate-600">{form.t('greenhouse.guide_pipes_label')}<Req /></legend>
        <img src={`${import.meta.env.BASE_URL}images/discovery/guide-pipes-present.${form.lang === 'en' ? 'webp' : 'svg'}`} alt="" className="w-full max-h-72 object-contain" />
        <div className="grid grid-cols-3 gap-3">
          {form.opts('greenhouse.guide_pipes_options').map(o => (
            <RadioOption key={o.value} checked={g.guide_pipes_state === o.value} label={o.label} help={o.help}
              onChange={() => onChange({ guide_pipes_state: o.value, guide_pipe_diameter: '' })} />
          ))}
        </div>
      </fieldset>, filled(g.guide_pipes_state))
      // La question fixe déjà le diamètre (1 po à 1 5/16 po) : rien à préciser ensuite.
    }
  }
  // Toits ouvrants en images : sans ou avec toit pour le chef de culture.
  // Toit acheté en extra : « Aucun » disparaît, on choisit 1 ou 2 toits (au-delà,
  // un nombre libre). Le Helper n'y a droit qu'avec l'extra. Puis la motorisation.
  // Toile thermique (extra seulement) : mêmes questions, rangées dans
  // `thermal_screen` (voir thermalScreen), pages `screen_…`.
  const ventKinds = [
    { limit: limit.roofs, t: 'roofs', id: 'roof', focus: 'roof_vents', name: 'Toit ouvrant', implied: limit.roofImplied, rec: roofRec(g, limit), patch: p => onChange(limit.roofImplied ? { ...SCREEN_IMPLIED, ...p } : p) },
    { limit: limit.screens, t: 'screens', id: 'screen', focus: 'thermal_screens', image: 'none', name: 'Toile thermique', implied: limit.screens === 1, rec: screenRec(g, limit.screens), patch: p => onChange({ thermal_screen: { ...screenRec(g, limit.screens), ...p } }) },
  ]
  for (const kind of ventKinds.filter(k => k.limit > 0)) {
    const g = kind.rec, onChange = kind.patch, limit = { roofs: kind.limit }
    const roofCount = Number(g.num_roof_vents)
    const roofValue = g.has_roof_vents === false ? 0 : g.has_roof_vents === true && roofCount > 0 ? roofCount : null
    const extraRoofs = limit.roofs > 1
    const pickRoofs = n => onChange(n === 0
      ? { has_roof_vents: false, num_roof_vents: 0, roof_motor_voltage: '', roof_motor_ridder_rw240: null, has_roof_inverter: null, roof_inverter_type: '', roof_inverter_brand: '', roof_inverter_model: '', extra_roof_vents: [] }
      : { has_roof_vents: true, num_roof_vents: n, extra_roof_vents: g.extra_roof_vents || [] })
    if (!kind.implied) page(`${kind.id}_present`, <fieldset className="min-w-0 space-y-2">
      <legend className="text-sm text-slate-600">{form.t(`${kind.t}.${extraRoofs ? 'present_count' : 'present'}`)}<Req /></legend>
      <div className="grid grid-cols-2 gap-3">
        {(extraRoofs ? [1, 2] : [0, 1]).map(n => kind.t === 'roofs'
          ? <RoofVentCountChoice key={n} name={`roofs-${idx}`} count={n} checked={roofValue === n} onChange={() => pickRoofs(n)} />
          : <RadioOption key={n} checked={roofValue === n} onChange={() => pickRoofs(n)} label={tr(SCREEN_COUNT_LABELS[n])} />)}
      </div>
      {extraRoofs && <MoreCount from={2} max={limit.roofs} value={roofValue} onChange={pickRoofs} label={form.t(`${kind.t}.count`)} />}
    </fieldset>, roofValue != null && Number.isInteger(roofValue) && roofValue >= (extraRoofs ? 1 : 0) && roofValue <= limit.roofs)
    // Inverseur et moteur se demandent pour chaque toit : le toit #1 garde ses
    // pages d'origine, les suivants ont les leurs (`roof:<i>:…`).
    const roofAnswers = roofCount > 0 ? roofVentAnswers(g) : []
    roofAnswers.forEach((r, i) => {
      const set = i === 0 ? onChange : patch => {
        const extra = Array.from({ length: roofCount - 1 }, (_, j) => (g.extra_roof_vents || [])[j] || {})
        onChange({ extra_roof_vents: extra.map((item, j) => (j === i - 1 ? { ...item, ...patch } : item)) })
      }
      const id = key => (i === 0 ? `${kind.id}_${key}` : `${kind.id}:${i}:${key}`)
      const suffix = roofCount > 1 ? `${tr(kind.name)} #${i + 1}` : kind.t === 'roofs' ? '' : tr(kind.name)
      // L'inverseur d'abord : la tension ne sert qu'à savoir qui le fournit,
      // elle n'est donc demandée qu'à qui n'en a pas.
      boolean(id('inverter'), form.t(`${kind.t}.inverter`), r.has_roof_inverter,
        v => set({ has_roof_inverter: v, roof_motor_voltage: '', roof_motor_ridder_rw240: null, roof_inverter_type: '', roof_inverter_brand: '', roof_inverter_model: '' }),
        { focus: kind.focus, questionId: `${kind.id}_inverter`, suffix, unknown: true })
      if (r.has_roof_inverter === true) {
        // « Autre » : marque et modèle dessous, sur la même page.
        const label = form.t(`${kind.t}.inverter_model`)
        const other = r.roof_inverter_type === 'other'
        question(id('inverter_type'), label, <>
          <div role="radiogroup" aria-label={label} className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {form.opts('roofs.inverter_options').map(o => <RadioOption key={o.value} label={tr(o.label)} checked={r.roof_inverter_type === o.value}
              onChange={() => set({ roof_inverter_type: o.value, roof_inverter_brand: '', roof_inverter_model: '' })} />)}
          </div>
          {other && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <Field label={form.t(`${kind.t}.brand`)} required><input aria-label={form.t(`${kind.t}.brand`)} className={inputCls} value={r.roof_inverter_brand || ''} onChange={e => set({ roof_inverter_brand: e.target.value })} /></Field>
            <Field label={form.t(`${kind.t}.model`)} required><input aria-label={form.t(`${kind.t}.model`)} className={inputCls} value={r.roof_inverter_model || ''} onChange={e => set({ roof_inverter_model: e.target.value })} /></Field>
          </div>}
        </>, { focus: kind.focus, questionId: `${kind.id}_inverter_type`, image: 'none', suffix, complete: filled(r.roof_inverter_type) && (!other || (filled(r.roof_inverter_brand) && filled(r.roof_inverter_model))) })
      } else if (r.has_roof_inverter === false) {
        select(id('voltage'), form.t(`${kind.t}.voltage`), r.roof_motor_voltage,
          v => set({ roof_motor_voltage: v, roof_motor_ridder_rw240: null }), form.opts('roofs.voltage_options'), { focus: kind.focus, questionId: `${kind.id}_voltage`, image: kind.image, suffix })
        if (r.roof_motor_voltage === '240') boolean(id('ridder'), form.t(`${kind.t}.ridder`), r.roof_motor_ridder_rw240, v => set({ roof_motor_ridder_rw240: v }), { focus: kind.focus, questionId: `${kind.id}_ridder`, image: kind.image, suffix })
        // Seul le cas où le client doit fournir l'inverseur mérite une page.
        if (roofInverterSupplyKey(r) === 'roofs.supply_customer') {
          page(id('supply'), <p className="text-sm text-slate-600">{form.t(`${kind.t}.supply_customer`)}</p>, true, suffix)
        }
      }
    })
  }
  // Serre Helper : ventilateurs, louvres et conservation de l'humidité ne sont
  // pas proposés.
  if (!helperOnly) {
    // Les louvres d'abord : la question des ventilateurs porte sur ceux qui
    // n'y sont pas associés, elle ne se comprend qu'une fois les louvres dites.
    const louvers = g.louvers || []
    // La réponse se choisit sur l'image : bout de serre nu, avec une louvre, ou
    // avec deux. Un enregistrement plus ancien peut en porter davantage : aucune
    // image n'est alors cochée, mais ses louvres restent saisies plus loin.
    const louverCount = g.has_louvers === false ? 0 : g.has_louvers === true && louvers.length ? louvers.length : null
    const pickLouvers = n => onChange({ has_louvers: n > 0, louvers: Array.from({ length: n }, (_, i) => louvers[i] || {}) })
    page('louvers', <div className="space-y-2">
      <p className="text-sm text-slate-600">{form.t('louvers.present')}<Req /></p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {Array.from({ length: limit.louvers + 1 }, (_, n) => n).map(n => <LouverCountChoice key={n} name={`louvers-${idx}`} count={n} checked={louverCount === n} onChange={() => pickLouvers(n)} />)}
      </div>
    </div>, louverCount != null)
    if (g.has_louvers) {
      louvers.forEach((l, i) => {
        const set = patch => onChange({ louvers: louvers.map((item, j) => i === j ? { ...item, ...patch } : item) })
        const opts = { suffix: `${tr('Louvre')} #${i + 1}` }
        // Voltage et commande en une seule question illustrée : chaque image est
        // une combinaison offerte. Une réponse plus ancienne hors combinaisons
        // (12 V, autre voltage…) reste acceptée telle quelle.
        const combo = louverComboValue(l)
        page(`louver:${i}:type`, <div className="space-y-2">
          <p className="text-sm text-slate-600">{form.t('louvers.type')}<Req /></p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {form.opts('louvers.types').map(o => {
              const def = LOUVER_COMBOS.find(c => c.value === o.value)
              return <LouverTypeChoice key={o.value} name={`louver-${idx}-${i}`} combo={o.value}
                label={o.value === 'spring_110' ? tr('Actuateur 110 ou 240 V et retour automatique en position fermée avec un ressort.') : o.label} checked={combo === o.value}
                onChange={() => set({ control_type: def?.control_type || o.value, voltage: def?.voltage ?? '', voltage_other: '' })} />
            })}
          </div>
        </div>, !!combo || (filled(l.voltage) && filled(l.control_type)), opts.suffix)
        page(`louver:${i}:fan`, <fieldset className="min-w-0 space-y-2">
          <legend className="text-sm text-slate-600">{form.t('louvers.fan')}<Req /></legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[true, false].map(hasFan => (
              <LouverFanChoice key={String(hasFan)} name={`louver-fan-${idx}-${i}`} hasFan={hasFan}
                checked={l.has_fan === hasFan} onChange={() => set({ has_fan: hasFan })} />
            ))}
          </div>
          {l.control_type === 'open_close' && l.has_fan && l.voltage !== '24' && <p className="text-xs text-slate-500">{form.t('louvers.fan_unavailable')}</p>}
        </fieldset>, typeof l.has_fan === 'boolean', opts.suffix)
      })
    }
    // La réponse se choisit sur l'image : bout de serre nu, avec un ventilateur, ou avec deux.
    page('fans', <div className="space-y-2">
      <p className="text-sm text-slate-600">{tr('Ventilateurs de bout de serre sans louvre associée')}<Req /></p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {Array.from({ length: limit.fans + 1 }, (_, n) => String(n)).map(n => (
          <EndFanChoice key={n} name={`fans-${idx}`} count={Number(n)} checked={filled(g.num_fans) && String(g.num_fans) === n}
            onChange={() => onChange({ num_fans: n, fans_combined_hp: n === '2' ? g.fans_combined_hp : '', fans_hp_range: n === '2' ? g.fans_hp_range : '' })} />
        ))}
      </div>
    </div>, filled(g.num_fans))
    // Seule la plage compte pour l'équipement : on ne demande plus le nombre
    // exact de HP, que le client cherchait sur la plaque du moteur.
    if (Number(g.num_fans) === 2) page('fans_hp', <fieldset className="space-y-2">
      <legend className="text-sm text-slate-600 flex items-center gap-1">{tr('Puissance combinée des deux moteurs de ventilateurs (HP)')}<Req /><MotorHpHelp /></legend>
      <div className="grid grid-cols-3 gap-3">
        {[...FANS_HP_RANGE_OPTIONS, { value: DONT_KNOW, label: DONT_KNOW }].map(o => (
          <RadioOption key={o.value} label={tr(o.label)} checked={fansHpRangeValue(g) === o.value}
            onChange={() => onChange({ fans_hp_range: o.value, fans_combined_hp: '' })} />
        ))}
      </div>
    </fieldset>, filled(fansHpRangeValue(g)))
  }
  // Chauffage et irrigation : posés au chef de culture, et au Helper qui a
  // reçu la permission correspondante.
  {
    if (limit.furnaces > 0 && !form.isHidden('chief.furnaces')) {
      const furnaceCount = g.has_furnaces === false ? 0 : g.has_furnaces === true && validEquipmentCount(g.num_furnaces) ? Number(g.num_furnaces) : null
      const minFurnaces = limit.extraFurnaces ? 1 : 0
      const pickFurnaces = total => onChange({ has_furnaces: total > 0, num_furnaces: total, furnaces: Array.from({ length: total }, (_, i) => g.furnaces?.[i] || {}) })
      page('furnaces', <fieldset className="space-y-2">
        <legend className="text-sm text-slate-600">{form.t('chief.furnaces_count_label')}<Req /></legend>
        {/* Une image par nombre permis, de 0 à 5 ; au-delà, un nombre libre.
            Des fournaises extra achetées excluent « Aucune ». */}
        <div className={`grid gap-3 ${FURNACE_GRID_COLS[Math.min(limit.furnaces, 5) + 1 - minFurnaces] || FURNACE_GRID_COLS[3]}`}>
          {Array.from({ length: Math.min(limit.furnaces, 5) + 1 - minFurnaces }, (_, i) => i + minFurnaces).map(n => <FurnaceCountChoice key={n} name={`furnaces-${idx}`} count={n} checked={furnaceCount === n} onChange={() => pickFurnaces(n)} />)}
        </div>
        <MoreCount from={5} max={limit.furnaces} value={furnaceCount} onChange={pickFurnaces} label={tr('Fournaises')} />
      </fieldset>, furnaceCount != null && furnaceCount >= minFurnaces && furnaceCount <= limit.furnaces)
      if (g.has_furnaces) {
        const furnaces = g.furnaces || []
        furnaces.forEach((f, i) => {
          const set = patch => onChange({ furnaces: furnaces.map((item, j) => i === j ? { ...item, ...patch } : item) })
          const opts = { suffix: `${tr('Fournaise')} #${i + 1}`, focus: 'furnaces' }
          // Le contact sec de 24 V AC suffit à savoir quoi brancher. Marque et
          // modèle ne servent qu'à trancher pour qui répond « Non » ou ne sait pas.
          // Photo du thermostat en grand, puis les réponses en boutons dessous.
          const asksBrand = v => v === 'no' || v === 'unknown'
          // Fournaises 2 et suivantes : toutes les réponses de la #1 d'un clic.
          const canCopy = i > 0 && filled(furnaces[0]?.dry_contact_24v)
          page(`furnace:${i}:dry_contact`, <fieldset className="min-w-0 space-y-2">
            <legend className="text-sm text-slate-600">{form.t('furnace.dry_contact_label')}<Req /></legend>
            {canCopy && <button type="button" className={btnGhost} onClick={() => set({ ...furnaces[0] })}><Copy size={14} />{tr('Recopier la fournaise #1')}</button>}
            <GreenhouseIllustration image={form.image('furnace.dry_contact_label')} focus="furnace_dry_contact" height={200} className="block mx-auto" />
            <div className="grid grid-cols-3 gap-3">
              {form.opts('furnace.dry_contact_options').map(o => (
                <RadioOption key={o.value} checked={f.dry_contact_24v === o.value} label={o.label} help={o.help}
                  onChange={() => set({ dry_contact_24v: o.value, ...(asksBrand(o.value) ? {} : { brand: '', brand_other: '', model: '' }) })} />
              ))}
            </div>
          </fieldset>, filled(f.dry_contact_24v), opts.suffix)
          if (asksBrand(f.dry_contact_24v)) {
            // Quatre boutons ; « Autre » demande marque et modèle juste dessous.
            const brands = form.opts('furnace.brand_options')
            const otherBrand = f.brand === 'Autre'
            page(`furnace:${i}:brand`, <fieldset className="min-w-0 space-y-2">
              <legend className="text-sm text-slate-600">{form.t('furnace.brand_label')}<Req /></legend>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {brands.map(o => <RadioOption key={o.value} checked={f.brand === o.value} label={o.label} help={o.help} onChange={() => set({ brand: o.value, brand_other: '', model: '', model_other: '' })} />)}
              </div>
              {otherBrand && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label={tr('Marque')} required><input aria-label={tr('Marque de la fournaise')} className={inputCls} value={f.brand_other || ''} onChange={e => set({ brand_other: e.target.value })} /></Field>
                <Field label={form.t('furnace.model_label')}><input aria-label={tr('Modèle de la fournaise')} className={inputCls} value={f.model || ''} onChange={e => set({ model: e.target.value })} /></Field>
              </div>}
            </fieldset>, brands.some(o => o.value === f.brand) && (!otherBrand || filled(f.brand_other?.trim())), opts.suffix)
          }
          // Longueurs livrées telles quelles (25/50/75/100 pi) ; tout autre choix
          // ouvre la question du nombre exact de pieds. `control_wire_feet` reste
          // un nombre de pieds : le calcul d'équipement n'a pas à changer.
          const wireFeet = f.control_wire_feet
          const wireRange = f.control_wire_range || (Number(wireFeet) > 0 ? (FURNACE_WIRE_PRESETS.includes(String(Number(wireFeet))) ? String(Number(wireFeet)) : 'over_100') : '')
          const wirePreset = FURNACE_WIRE_PRESETS.includes(wireRange) || wireRange === 'unknown'
          page(`furnace:${i}:wire`, <fieldset className="min-w-0 space-y-2">
            <legend className="text-sm text-slate-600">{form.t('furnace.wire_label')}<Req /></legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {form.opts('furnace.wire_options').map(o => (
                <ImageOption key={o.value} name={`furnace-wire-${idx}-${i}`} checked={wireRange === o.value}
                  onChange={() => set({ control_wire_range: o.value, control_wire_feet: wireRange === o.value ? wireFeet : FURNACE_WIRE_PRESETS.includes(o.value) ? o.value : '' })}
                  label={o.label} help={o.help} focus="furnace_wire" image={form.image('furnace.wire_label')} variant="furnace-wire-choice" />
              ))}
            </div>
            {wireRange && !wirePreset && <Field label={form.t('furnace.wire_feet_label')} required>
              <input aria-label={form.t('furnace.wire_feet_label')} className={inputCls} type="number" min={101} max={MAX_FURNACE_WIRE_FEET} value={wireFeet ?? ''} onChange={e => set({ control_wire_feet: Number(e.target.value) > MAX_FURNACE_WIRE_FEET ? String(MAX_FURNACE_WIRE_FEET) : e.target.value })} />
              <span className="text-xs text-slate-500">{tr('Maximum :')} {MAX_FURNACE_WIRE_FEET} {tr('pi')}.</span>
            </Field>}
            <p className="text-xs text-slate-500">{form.t('furnace.wire_help')}</p>
          </fieldset>, filled(wireRange) && (wirePreset || (Number(wireFeet) > 100 && Number(wireFeet) <= MAX_FURNACE_WIRE_FEET)), opts.suffix)
          const backup = f.backup_thermostat == null ? '' : f.backup_thermostat ? 'yes' : 'no'
          page(`furnace:${i}:thermostat`, <fieldset className="min-w-0 space-y-2">
            <legend className="text-sm text-slate-600">{form.t('furnace.thermostat_label')}<Req /></legend>
            <GreenhouseIllustration image={form.image('furnace.thermostat_label')} focus="thermostat" height={200} className="block mx-auto" />
            <div className="grid grid-cols-2 gap-3">
              {form.opts('furnace.thermostat_options').map(o => (
                <RadioOption key={o.value} checked={backup === o.value} label={o.label} help={o.help} onChange={() => set({ backup_thermostat: o.value === 'yes' })} />
              ))}
            </div>
          </fieldset>, backup !== '', opts.suffix)
        })
      }
    }
    if (limit.valves > 0) {
    const zones = Number(g.irrigation_zones) || 0
    // La réponse se choisit sur l'image : de 0 à 8 valves selon le plafond ;
    // au-delà (plusieurs permissions Irrigation), un nombre jusqu'au plafond.
    const zonesDone = validEquipmentCount(g.irrigation_zones) && Number(g.irrigation_zones) >= limit.minValves && Number(g.irrigation_zones) <= limit.valves
    page('irrigation_zones', <>
      <IrrigationZones name={`valves-${idx}`} label={form.t('chief.irrigation_zones_label')} value={g.irrigation_zones} min={limit.minValves} max={limit.valves} onChange={v => onChange({ irrigation_zones: v })} />
    </>, zonesDone)
    if (zones > 0) {
      // Oui : combien de valves (une par zone). Non : quelle marque.
      const countChoices = Array.from({ length: Math.min(limit.valves, zones) }, (_, n) => n + 1)
      const valveCount = Number(g.orisha_valves_count)
      const otherBrand = g.valve_brand === VALVE_BRANDS[2]
      const valvesDone = g.needs_orisha_valves === true ? countChoices.includes(valveCount) : g.needs_orisha_valves === false && VALVE_BRANDS.includes(g.valve_brand) && (!otherBrand || filled(g.valve_brand_other?.trim()))
      page('orisha_valves', <fieldset className="min-w-0 space-y-2">
        <legend className="text-sm text-slate-600">{form.t('chief.orisha_valves_label')}<Req /></legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {form.opts('chief.orisha_valves_options').map(o => (
            <ImageOption key={o.value} name={`orisha-valves-${idx}`} label={o.label} help={o.help}
              checked={typeof g.needs_orisha_valves === 'boolean' && g.needs_orisha_valves === (o.value === 'yes')}
              onChange={() => onChange({ needs_orisha_valves: o.value === 'yes', orisha_valves_count: '', valve_brand: '', valve_model: '' })}
              focus="valves" image={o.value === 'yes' ? 'valves-needed.svg' : 'valves-existing.svg'} />
          ))}
        </div>
        {g.needs_orisha_valves === true && <div className="space-y-2 pt-2">
          <p className="text-sm text-slate-600">{tr('Combien de valves ?')}<Req /></p>
          <div className="grid grid-cols-4 gap-3">
            {countChoices.map(n => <RadioOption key={n} checked={valveCount === n} label={String(n)} onChange={() => onChange({ orisha_valves_count: n })} />)}
          </div>
        </div>}
        {g.needs_orisha_valves === false && <div className="space-y-2 pt-2">
          <p className="text-sm text-slate-600">{tr('Marque de vos valves')}<Req /></p>
          <div className="grid grid-cols-3 gap-3">
            {VALVE_BRANDS.map(b => <RadioOption key={b} checked={g.valve_brand === b} label={tr(b)} onChange={() => onChange({ valve_brand: b, valve_brand_other: '', valve_model: '' })} />)}
          </div>
          {otherBrand && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={tr('Marque')} required><input aria-label={tr('Marque des valves')} className={inputCls} value={g.valve_brand_other || ''} onChange={e => onChange({ valve_brand_other: e.target.value })} /></Field>
            <Field label={tr('Modèle')}><input aria-label={tr('Modèle des valves')} className={inputCls} value={g.valve_model || ''} onChange={e => onChange({ valve_model: e.target.value })} /></Field>
          </div>}
        </div>}
      </fieldset>, valvesDone)
      page('valve_wire', <Ask questionId="chief.orisha_valves_label" focus="valves" image="none"><ValveWireLength value={g.valve_control_wire_feet} onChange={value => onChange({ valve_control_wire_feet: value })} /></Ask>, filled(g.valve_control_wire_feet) && Number.isFinite(Number(g.valve_control_wire_feet)) && Number(g.valve_control_wire_feet) >= 0 && Number(g.valve_control_wire_feet) <= MAX_VALVE_WIRE_FEET)
    }
    }
  }
  const ghCtx = { record: g, custom: g.custom, root, rootCustom: root.custom_answers }
  const sections = cardPermission === 'chief_grower' ? ['greenhouse', 'greenhouse_chief'] : ['greenhouse']
  for (const section of sections) for (const q of form.custom(section, ghCtx)) {
    page(`custom:${q.id}`, <CustomFields questions={[q]} values={g.custom} onChange={patch => onChange({ custom: { ...(g.custom || {}), ...patch } })} />, !q.required || customAnswered(q, g.custom?.[q.id]))
  }
}

// Zones d'irrigation : 5 images de 0 à 4 valves.
function IrrigationZones({ name, label, value, onChange, min = 0, max = 4 }) {
  const { tr } = useFormSchema()
  const zones = Number(value) || 0
  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-600">{label}<Req /></p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {Array.from({ length: Math.min(max, 8) + 1 - min }, (_, n) => n + min).map(n => <IrrigationValveChoice key={n} name={name} count={n} checked={filled(value) && zones === n} onChange={() => onChange(n)} />)}
      </div>
      <MoreCount from={8} max={max} value={filled(value) ? zones : ''} onChange={onChange} label={tr('Valves')} />
    </div>
  )
}

// Confirmation de l'adresse auprès de l'API d'adresses (Google), au blur du
// bloc : l'adresse de ferme et l'adresse de livraison sont celles qui font
// partir un camion, autant les valider ici plutôt qu'au retour du colis.
function AddressConfirm({ value, baseUrl, onChange }) {
  const [verdict, setVerdict] = useState(null)
  const [busy, setBusy] = useState(false)
  const lastRef = useRef('')
  const { tr } = useFormSchema()

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
      {busy && <p className="mt-2 text-xs text-slate-400">{tr('Vérification…')}</p>}
      {!busy && verdict?.status === 'confirmed' && (
        <p className="mt-2 text-xs text-green-700">{tr('Adresse confirmée')}</p>
      )}
      {!busy && verdict?.status === 'not_found' && (
        <p className="mt-2 text-xs text-orange-700">{tr('Adresse introuvable — vérifiez la rue et la ville.')}</p>
      )}
      {!busy && s && (
        <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
          <div className="text-xs text-slate-600">{tr('Adresse trouvée')}</div>
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
            {tr('Utiliser')}
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
  const { tr } = useFormSchema()
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label={tr('Adresse')} required colSpan={2}>
        <input className={inputCls} value={value.line1 || ''} onChange={e => onChange({ line1: e.target.value })} />
      </Field>
      <Field label={tr('Ville')}>
        <input className={inputCls} value={value.city || ''} onChange={e => onChange({ city: e.target.value })} />
      </Field>
      <Field label={tr('Province')} required>
        <SearchableSelect
          value={value.province || ''}
          options={form_provinces(tr)}
          onChange={v => onChange({ province: v })}
          emptyOption="—"
          searchPlaceholder={tr('Rechercher une province…')}
          className={inputCls}
          size="sm"
          testId="province-select"
        />
      </Field>
      <Field label={tr('Code postal')}>
        <input className={inputCls} value={value.postal_code || ''} onChange={e => onChange({ postal_code: e.target.value })} />
      </Field>
      <Field label={tr('Pays')}>
        <input className={inputCls} value={value.country || 'Canada'} onChange={e => onChange({ country: e.target.value })} />
      </Field>
    </div>
  )
}

// Astérisque rouge : la seule marque d'une question obligatoire (la page ne
// répète plus « Complétez les champs obligatoires » sous le bouton Suivant).
function Req() {
  const { tr } = useFormSchema()
  return <span className="text-red-500" title={tr('Obligatoire')}> *</span>
}

function DontKnow({ checked, onChange }) {
  const { tr } = useFormSchema()
  return (
    <label className="mt-2 inline-flex items-center gap-2 text-xs text-slate-500">
      <input type="checkbox" data-dont-know checked={checked} onChange={e => onChange(e.target.checked)} />
      {tr(DONT_KNOW)}
    </label>
  )
}

// Mot de passe masqué par défaut, l'œil le révèle le temps de le relire.
function PasswordInput({ label, value, onChange }) {
  const [shown, setShown] = useState(false)
  const { tr } = useFormSchema()
  return (
    <div className="relative">
      <input aria-label={label} type={shown ? 'text' : 'password'} autoComplete="new-password" className={`${inputCls} pr-10`} value={value} onChange={e => onChange(e.target.value)} />
      <button type="button" aria-label={tr(shown ? 'Masquer' : 'Afficher')} onClick={() => setShown(s => !s)}
        className="absolute inset-y-0 right-0 px-3 flex items-center text-slate-400 hover:text-slate-600">
        {shown ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  )
}

function Field({ label, required, colSpan = 1, children }) {
  return (
    <div className={colSpan === 2 ? 'col-span-2' : ''}>
      <label className="label">{label}{required && <Req />}</label>
      {children}
    </div>
  )
}

const CONTROLLER_DISTANCE_IMAGES = {
  yes: 'controller-distance-near.svg',
  coax_350: 'controller-distance-coax.svg',
  no: 'controller-distance-far.svg',
}

function ControllerDistanceOption({ value, checked, onChange, label, help }) {
  const { lang } = useFormSchema()
  const image = CONTROLLER_DISTANCE_IMAGES[value] && localizedImage(lang, CONTROLLER_DISTANCE_IMAGES[value])
  return (
    <label className={`flex flex-col items-center gap-2 p-3 rounded-lg cursor-pointer border focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-2 ${checked ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
      {image && <img src={`${import.meta.env.BASE_URL}images/discovery/${image}`} alt="" width="300" height="190" className="w-full h-32 object-contain" draggable={false} />}
      <span className="flex items-center gap-2 text-sm text-slate-800">
        <input type="radio" name="controller-distance" value={value} aria-label={label} checked={checked} onChange={onChange} />
        {label}
      </span>
      {help && <span className="text-xs text-slate-500 text-center">{help}</span>}
    </label>
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

// Oui / Non : deux boutons côte à côte plutôt qu'un menu déroulant.
// `unknown` : troisième bouton « Je ne sais pas », stocké 'unknown'.
function YesNoButtons({ value, onChange, unknown = false }) {
  const { tr } = useFormSchema()
  const items = [[true, 'Oui'], [false, 'Non'], ...(unknown ? [['unknown', DONT_KNOW]] : [])]
  return (
    <div className={`grid ${unknown ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2'} gap-3`}>
      {items.map(([v, label]) => <RadioOption key={label} label={tr(label)} checked={value === v} onChange={() => onChange(v)} />)}
    </div>
  )
}

// Aide : où lire les HP sur la plaque signalétique du moteur.
function MotorHpHelp() {
  const [open, setOpen] = useState(false)
  const { tr } = useFormSchema()
  return <>
    <button type="button" onClick={() => setOpen(true)} aria-label={tr('Où trouver les HP ?')} title={tr('Où trouver les HP ?')}
      className="text-slate-400 hover:text-brand-600"><HelpCircle className="w-4 h-4" /></button>
    <Modal isOpen={open} onClose={() => setOpen(false)} title={tr('Où trouver les HP ?')}>
      <img src={`${import.meta.env.BASE_URL}images/discovery/motor-hp-plate.webp`} alt={tr('Plaque du moteur : HP 1/3')} width="1069" height="557" className="w-full h-auto rounded-lg" />
      <p className="mt-2 text-sm text-slate-600">{tr('Plaque du moteur, ligne « HP ». Additionnez les deux ventilateurs.')}</p>
    </Modal>
  </>
}

function ImageOption({ checked, onChange, label, help, image, focus, name, variant }) {
  return (
    <label className={`flex flex-col items-center gap-2 p-3 rounded-lg cursor-pointer border ${name ? 'focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-2' : ''} ${checked ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
      <GreenhouseIllustration image={image} focus={focus} variant={variant} height={96} label={label} className="w-full" />
      <div className="flex items-center gap-2">
        <input type="radio" name={name} aria-label={name ? label : undefined} checked={checked} onChange={onChange} />
        <span className="text-sm text-slate-800">{label}</span>
      </div>
      {help && <div className="text-xs text-slate-500 text-center">{help}</div>}
    </label>
  )
}

function ValveWireLength({ value, onChange }) {
  const hasValue = value !== '' && value != null
  const isPreset = [15, 25].includes(Number(value))
  const [custom, setCustom] = useState(hasValue && !isPreset)
  const selection = custom || (hasValue && !isPreset) ? 'custom' : hasValue ? String(value) : ''
  const { tr } = useFormSchema()
  return (
    <fieldset className="min-w-0">
      <legend className="label">{tr('Longueur de fil nécessaire pour les valves (Orisha fournira un fil par valve)')}<Req /></legend>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[{ value: '15', label: tr('15 pi') }, { value: '25', label: tr('25 pi') }, { value: 'custom', label: tr('Longueur personnalisée') }].map(option => (
          <label key={option.value} className={`flex flex-col items-center gap-2 p-3 rounded-lg cursor-pointer border focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-2 ${selection === option.value ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
            <svg viewBox="0 0 180 110" className="w-full h-24" aria-hidden="true">
              <g className="fill-none stroke-slate-500" strokeWidth="4">
                {[0, 1, 2, ...(option.value === '25' ? [3, 4] : [])].map(i => (
                  <ellipse key={i} cx={64 + i * 7} cy="51" rx="31" ry="34" />
                ))}
                <path d={`M${78 + (option.value === '25' ? 14 : 0)} 81 Q122 100 146 73`} strokeLinecap="round" />
              </g>
              <path d="M145 74 l9 -13" className="stroke-amber-600" strokeWidth="4" strokeLinecap="round" />
              <rect x="102" y="8" width="70" height="29" rx="5" className="fill-brand-50 stroke-brand-500" />
              <text x="137" y="28" textAnchor="middle" fontSize="16" className="fill-brand-700 font-semibold">{option.value === 'custom' ? `? ${tr('pi')}` : option.label}</text>
              {option.value === 'custom' && <g className="stroke-amber-600 fill-amber-50" strokeWidth="1.5">
                <rect x="25" y="88" width="91" height="14" rx="2" />
                {[35, 47, 59, 71, 83, 95, 107].map(x => <path key={x} d={`M${x} 88 v7`} />)}
              </g>}
            </svg>
            <span className="flex items-center gap-2 text-sm text-slate-800">
              <input type="radio" name="valve-wire-length" value={option.value} checked={selection === option.value} onChange={() => {
                setCustom(option.value === 'custom')
                onChange(option.value === 'custom' ? '' : option.value)
              }} />
              {option.label}
            </span>
          </label>
        ))}
      </div>
      {selection === 'custom' && <label className="block mt-2 text-sm text-slate-600">
        {tr('Longueur personnalisée (pi)')}
        <input type="number" min="0" max={MAX_VALVE_WIRE_FEET} className={inputCls} value={value ?? ''} onChange={e => onChange(Number(e.target.value) > MAX_VALVE_WIRE_FEET ? String(MAX_VALVE_WIRE_FEET) : e.target.value)} />
        <span className="text-xs">{tr('Maximum :')} {MAX_VALVE_WIRE_FEET} {tr('pi')}.</span>
      </label>}
    </fieldset>
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
      <Field label={q.label} required={q.required} colSpan={q.type === 'textarea' ? 2 : 1}>
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
      return <YesNoButtons value={value} onChange={v => !disabled && onChange(v)} />
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

// Relecture des réponses : après l'envoi, et juste avant le bouton Soumettre.
function AnswersSummary({ resp, permission, hasMobileController, grouped, className = '', onEdit }) {
  const form = useFormSchema()
  const { tr } = form
  const addr = v => [v?.line1, v?.line2, v?.city, v?.province, v?.postal_code].filter(Boolean).join(', ') || '—'
  const newSite = resp.is_new_site === 'new'
  const general = [
    [tr('Commande'), 'order_type', [
      [form.t('order_type.title'), form.opts('order_type.options').find(o => o.value === resp.is_new_site)?.label || '—'],
      resp.is_new_site === 'add_to_existing' && !hasMobileController && [tr('Distance du contrôleur central'), form.opts('controller_distance.options').find(o => o.value === controllerDistanceValue(resp))?.label || '—'],
      asksWindSensor(resp, permission) && [form.t('wind_sensor.title'), typeof resp.needs_wind_sensor === 'boolean' ? tr(resp.needs_wind_sensor ? 'Oui' : 'Non') : '—'],
    ]],
    [tr('Adresses'), newSite ? 'farm_address' : 'shipping_address', [
      newSite && [tr('Ferme'), addr(resp.farm_address)],
      [tr('Livraison'), newSite && resp.shipping_same_as_farm !== false ? tr('Même adresse que la ferme') : addr(resp.shipping_address)],
    ]],
    [tr('Serres et réseau'), newSite && asksNetwork(resp, hasMobileController) ? 'network' : 'greenhouse_count', [
      [tr('Nombre de serres'), resp.num_greenhouses || '—'],
      asksNetwork(resp, hasMobileController) && [tr('Accès réseau'), form.opts('network.options').find(o => o.value === resp.network_access)?.label || '—'],
      asksNetwork(resp, hasMobileController) && resp.wifi_ssid && [tr('Réseau Wi‑Fi'), resp.wifi_ssid === DONT_KNOW ? tr(DONT_KNOW) : resp.wifi_ssid],
    ]],
  ]
  return (
    <div className={`space-y-3 text-sm text-slate-700 ${className}`}>
      {general.map(([title, pageId, items]) => <section key={title} aria-label={title} className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          {onEdit && <EditLink onClick={() => onEdit(null, pageId)} />}
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
          {items.filter(Boolean).map(([label, value]) => <Fragment key={label}><dt className="min-w-0 break-words">{label}</dt><dd className="min-w-0 break-words font-medium text-slate-900">{value}</dd></Fragment>)}
        </dl>
      </section>)}
      {(resp.greenhouses || []).map((g, i) => <GreenhouseAnswers key={i} g={g} idx={i} form={form} permission={permission} root={resp} grouped={grouped} onEdit={onEdit} />)}
    </div>
  )
}

function SubmittedSummary({ resp, extrasResult, setExtrasResult, sessionId, permission, isDiscoveryMode, hasMobileController, onEdit }) {
  // Le flow extras est lié au Stripe Checkout (création d'un pending_invoice +
  // redirection Checkout Session). Pas applicable au flow qualification.
  const form = useFormSchema()
  const { tr } = form
  const extras = isDiscoveryMode ? { items: [] } : computeExtras(resp, permission, tr)
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
        throw new Error(j.error || tr('Erreur'))
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
      <div className="flex flex-wrap gap-2 mt-2">
        {/* Encore modifiable : le bouton ouvre directement le résumé modifiable. */}
        <button type="button" className="btn-ghost btn-sm" onClick={onEdit || (() => setShowAnswers(v => !v))}>{tr(showAnswers ? 'Masquer mes réponses' : 'Consulter mes réponses')}</button>
      </div>
      {showAnswers && <AnswersSummary resp={resp} permission={permission} hasMobileController={hasMobileController} grouped={isDiscoveryMode} className="mt-3 border-t border-slate-100 pt-3" />}
      {extras.items.length > 0 && !extrasResult && (
        <div className="mt-3 rounded-lg bg-blue-50 border border-blue-200 p-4">
          <h3 className="font-semibold text-blue-900">{tr('Extras suggérés selon vos réponses')}</h3>
          <ul className="text-sm text-blue-900 mt-2 list-disc pl-5 space-y-0.5">
            {extras.items.map((it, i) => (
              <li key={i}>{it.qty} × {it.description} — {fmtMoney(it.unit_price, 'CAD', { fallback: '' })} {tr("l'unité")}</li>
            ))}
          </ul>
          <p className="text-sm text-blue-800 mt-2">{tr('Voulez-vous les acheter maintenant ? Vous serez redirigé vers une page de paiement Stripe.')}</p>
          <div className="mt-3 flex gap-2">
            <button onClick={handleBuyExtras} disabled={loading} className={btnPrimary}>{tr(loading ? 'Création…' : 'Acheter les extras')}</button>
            <button onClick={() => setExtrasResult({ skipped: true })} className={btnGhost}>{tr('Non merci')}</button>
          </div>
          {err && <div className="mt-2 text-sm text-red-700">{err}</div>}
        </div>
      )}
      {extrasResult?.checkout_url && (
        <div className="mt-3 rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-800">
          {tr('Redirection vers Stripe…')} <a href={extrasResult.checkout_url} className="underline">{tr('cliquez ici si rien ne se passe')}</a>.
        </div>
      )}
    </Card>
  )
}

// Travaux à faire par le client avant l'installation (Google Doc de l'équipe
// d'installation). Un toit ouvrant 240 V demande en plus un disjoncteur double.
// Le tuyau ne sert qu'aux capteurs extérieurs : vent (Chef de culture), pluie,
// solaire — sans aucun d'eux, l'étape disparaît ; `{capteurs}` les nomme.
function PrepareChecklist({ resp }) {
  const form = useFormSchema()
  const { tr } = form
  const breaker = (resp.greenhouses || []).some(g => [...roofVentAnswers(g, { legacy: true }), ...roofVentAnswers(thermalScreen(g))].some(r => r.roof_motor_voltage === '240'))
  const chief = resp.permission_level === 'chief_grower' || (resp.greenhouses || []).some(g => g.permission_level === 'chief_grower')
  const sensors = resp.form_options?.sensors || {}
  const mounted = [
    (chief || sensors.wind_sensor > 0) && tr('le capteur de vent'),
    sensors.rain_sensor > 0 && tr('le capteur de pluie'),
    sensors.solar_sensor > 0 && tr('le capteur solaire'),
  ].filter(Boolean)
  const and = ` ${tr('et')} `
  const sensorList = mounted.length > 1 ? `${mounted.slice(0, -1).join(', ')}${and}${mounted.at(-1)}` : mounted[0]
  const items = [
    ['prepare-panel.webp', form.t('prepare.panel')],
    breaker ? ['prepare-outlet-breaker.webp', form.t('prepare.outlet_breaker')] : ['prepare-outlet.webp', form.t('prepare.outlet')],
    mounted.length > 0 && ['prepare-wind-pipe.webp', form.t('prepare.pipe'), form.t('prepare.pipe_help').replace('{capteurs}', sensorList)],
  ].filter(Boolean)
  return (
    <Card title={form.t('prepare.title')}>
      <ol className="space-y-5">
        {items.map(([img, text, help]) => <li key={img} className="grid sm:grid-cols-[12rem_1fr] gap-3 items-center">
          <img src={`${import.meta.env.BASE_URL}images/discovery/${img}`} alt="" className="w-full max-h-48 object-contain" draggable={false} />
          <div className="space-y-1">
            <p className="text-sm font-medium text-slate-900">{text}</p>
            {help && <p className="text-sm text-slate-600">{help}</p>}
          </div>
        </li>)}
      </ol>
    </Card>
  )
}

// Relecture des réponses d'une serre : le résumé reprend TOUTES les questions
// répondues (côtés, tuyaux, louvres, humidité, fournaises, irrigation, questions
// ajoutées), pas seulement les cinq premières. Une ligne n'apparaît que si elle
// a une réponse — l'écran reste court quand le formulaire l'était.
function EditLink({ onClick }) {
  const { tr } = useFormSchema()
  return <button type="button" onClick={onClick} className="text-xs font-medium text-brand-700 hover:text-brand-800 underline underline-offset-2">{tr('Modifier')}</button>
}

function GreenhouseAnswers({ g, idx, form, permission, root, grouped = false, onEdit }) {
  const cardPermission = g.permission_level || permission
  const helperOnly = sideVentsOnly(cardPermission)
  const chief = cardPermission === 'chief_grower'
  const { tr } = form
  const yn = v => typeof v === 'boolean' ? tr(v ? 'Oui' : 'Non') : null
  const choice = (list, value) => value ? (form.opts(list).find(o => o.value === value)?.label || tr(value)) : null
  const feet = v => !filled(v) ? null : v === DONT_KNOW ? tr(DONT_KNOW) : `${v} ${tr('pi')}`
  const rows = []
  // Libellés et réponses fixes passent par `tr` ; une réponse libre du client
  // n'a pas de traduction et reste telle quelle.
  const row = (label, value, section = 'sides') => { if (value != null && value !== '') rows.push([tr(label), typeof value === 'string' ? tr(value) : value, section]) }

  row('Longueur', g.length_range === 'up_to_200' ? '200 pi ou moins' : feet(g.length))
  row('Côtés ouvrants', g.has_side_vents === false ? 'Aucun' : filled(g.num_side_vent_motors) ? String(g.num_side_vent_motors) : yn(g.has_side_vents))
  if (sideVentOther(g)) row('Type de côté ouvrant', [tr('Autre'), g.side_vent_type_other].filter(Boolean).join(' · '))
  else if (g.has_side_vents) {
    row('Moteurs déjà en place', yn(g.has_existing_side_vent_motors))
    if (g.has_existing_side_vent_motors) {
      row('Marque des moteurs', g.side_vent_motor_brand)
      row('Modèle des moteurs', g.side_vent_motor_model)
      row('Inverseurs', g.side_has_inverters === false ? 'Aucun' : g.side_has_inverters === 'unknown' ? DONT_KNOW : g.side_has_inverters === true
        ? [g.side_inverter_model === 'other' ? [g.side_inverter_brand_other, g.side_inverter_model_other].filter(Boolean).join(' ') || tr('Autre') : tr(g.side_inverter_model),
          tr({ per_motor: 'un par moteur', per_two: 'un pour deux moteurs', unknown: 'nombre inconnu' }[g.side_inverter_ratio])].filter(Boolean).join(', ')
        : null)
    }
    if (!(g.has_existing_side_vent_motors && g.side_has_inverters === true)) row('Hauteur des côtés', g.side_vent_height_range === 'up_to_6' ? '6 pi et moins' : feet(g.side_vent_height))
    row('Tuyau de côté', choice('greenhouse.side_pipe_type_options', g.side_pipe_type))
    // La seconde plage d'acier est stockée à sa mesure maximale : le résumé montre la plage.
    row('Diamètre du tuyau', g.side_pipe_diameter === '1 1/2"' ? 'Entre 1 5/16 po et 1 1/2 po' : g.side_pipe_diameter?.replace(/^Autre:\s*/, ''))
    if (!g.has_existing_side_vent_motors) row('Tuyaux guides', { present: 'Déjà présents', needed: 'Fournis par Orisha' }[g.guide_pipes_state] || choice('greenhouse.guide_pipes_options', g.guide_pipes_state))
    if (!g.has_existing_side_vent_motors) row('Diamètre des guides', g.guide_pipe_diameter?.replace(/^Autre:\s*/, ''))
    if (g.wants_compatible_guide_pipes) row('Guides compatibles', 'À fournir')
  }
  const limit = greenhouseLimits(root.form_options, idx, cardPermission)
  // Toile thermique : mêmes lignes que le toit, section à part.
  for (const [lim, sec, rec, one, many] of [[limit.roofs, 'roofs', roofRec(g, limit), 'Toit ouvrant', 'Nombre de toits ouvrants'], [limit.screens, 'screens', screenRec(g, limit.screens), 'Toile thermique', 'Nombre de toiles thermiques']]) {
    if (!lim) continue
    const g = rec, limit = { roofs: lim }
    const roofTotal = g.has_roof_vents === true ? Number(g.num_roof_vents) || 0 : 0
    row(one, roofTotal ? 'Oui' : sec === 'roofs' && g.has_roof_vents === false ? 'Aucun' : yn(g.has_roof_vents), sec)
    if (roofTotal) {
      if (limit.roofs > 1) row(many, roofTotal, sec)
      // Un bloc par toit : « Inverseur déjà présent · #2 »…
      roofVentAnswers(g, { legacy: true }).forEach((r, i) => {
        const roofRow = (label, value) => row(roofTotal > 1 ? `${tr(label)} · #${i + 1}` : label, value, sec)
        roofRow('Inverseur déjà présent', r.has_roof_inverter === 'unknown' ? DONT_KNOW : yn(r.has_roof_inverter))
        if (r.has_roof_inverter === false) roofRow('Tension du moteur', choice('roofs.voltage_options', r.roof_motor_voltage))
        if (r.has_roof_inverter === true) {
          roofRow('Inverseur', choice('roofs.inverter_options', r.roof_inverter_type))
          if (r.roof_inverter_type === 'other') {
            roofRow('Marque', r.roof_inverter_brand)
            roofRow('Modèle', r.roof_inverter_model)
          }
        } else if (r.has_roof_inverter === false) {
          if (r.roof_motor_voltage) roofRow('Marque du moteur', r.roof_motor_voltage === '24_dc' ? '24 V DC' : r.roof_motor_voltage === '240' && r.roof_motor_ridder_rw240 === true ? 'Ridder RW240, 1 phase, 5 fils' : 'Autre')
          if (roofInverterSupplyKey(r) === 'roofs.supply_customer') roofRow('Fourniture de l’inverseur', form.t(`${sec}.supply_customer`))
        }
      })
    }
  }
  if (!helperOnly) {
    row('Louvres', g.has_louvers === false ? 'Aucune' : g.louvers?.length || null, 'louvers')
    // Sous l'en-tête « Ventilateurs », l'absence se lit seule : « Aucun ».
    if (grouped && filled(g.num_fans) && Number(g.num_fans) === 0) rows.push([null, tr('Aucun'), 'fans'])
    else row('Ventilateurs', filled(g.num_fans) && Number(g.num_fans) === 0 ? 'Aucun' : g.num_fans, 'fans')
    if (Number(g.num_fans) === 2) {
      const hpRange = fansHpRangeValue(g)
      row('Puissance des ventilateurs', FANS_HP_RANGE_OPTIONS.find(o => o.value === hpRange)?.label || (filled(hpRange) ? hpRange : null), 'fans')
    }
  }
  if (limit.furnaces) row('Fournaises', g.has_furnaces === false ? 'Aucune' : g.num_furnaces || null, 'heating')
  if (limit.valves) {
    row('Zones d’irrigation', !filled(g.irrigation_zones) ? null : Number(g.irrigation_zones) === 0 ? 'Aucune' : g.irrigation_zones, 'irrigation')
    if (Number(g.irrigation_zones) > 0) {
      row('Valves', g.needs_orisha_valves === true ? `${g.orisha_valves_count || '—'} ${tr('fournie(s) par Orisha')}` : g.needs_orisha_valves === false ? 'Déjà présentes' : null, 'irrigation')
      if (g.needs_orisha_valves === false) row('Marque des valves', g.valve_brand === VALVE_BRANDS[2] ? [g.valve_brand_other, g.valve_model].filter(Boolean).join(' ') || g.valve_brand : g.valve_brand, 'irrigation')
      row('Filage des valves', feet(g.valve_control_wire_feet), 'irrigation')
    }
  }
  const ctx = { record: g, custom: g.custom, root, rootCustom: root.custom_answers }
  for (const section of chief ? ['greenhouse', 'greenhouse_chief'] : ['greenhouse']) {
    for (const q of form.custom(section, ctx)) {
      const v = g.custom?.[q.id]
      if (v == null || v === '') continue
      row(q.label, typeof v === 'boolean' ? tr(v ? 'Oui' : 'Non') : (q.options?.find(o => o.value === v)?.label ?? String(v)), 'custom')
    }
  }

  const louvers = !helperOnly && g.has_louvers ? (g.louvers || []) : []
  const furnaces = chief && g.has_furnaces ? (g.furnaces || []) : []
  // Un louvre ou une fournaise se lit en retrait, rattaché à sa section.
  const sub = (title, items) => <div key={title} className="mt-2 ml-3 border-l-2 border-slate-300 pl-3">
    <p className="text-xs font-medium text-slate-900">{title}</p>
    <div className="mt-1 grid grid-cols-2 gap-1 text-xs">{items.map(([l, v], i) => <Fragment key={i}><span className="min-w-0 break-words">{l}</span><span className="min-w-0 break-words">{v}</span></Fragment>)}</div>
  </div>
  const louverDetails = louvers.map((l, i) => sub(`${tr('Louvre')} #${i + 1}`, [
    [tr('Commande'), choice('louvers.types', louverComboValue(l)) || louverSummary(l, tr) || '—'],
    [tr('Ventilateur associé'), yn(l.has_fan) || '—'],
  ]))
  const furnaceDetails = furnaces.map((f, i) => sub(`${tr('Fournaise')} #${i + 1}`, [
    [tr('Compatible'), choice('furnace.dry_contact_options', f.dry_contact_24v) || '—'],
    ...(f.brand ? [[tr('Marque'), (f.brand === 'Autre' ? f.brand_other : f.brand) || tr(f.brand)]] : []),
    ...(f.model ? [[tr('Modèle'), f.model === 'Autre' ? f.model_other || tr(f.model) : f.model]] : []),
    [tr('Filage'), f.control_wire_range === 'unknown' ? tr(DONT_KNOW) : feet(f.control_wire_feet) || '—'],
    [tr('Thermostat de secours'), typeof f.backup_thermostat === 'boolean' ? tr(f.backup_thermostat ? 'Fourni par Orisha' : 'Déjà présent') : '—'],
  ]))
  const sections = [
    ['sides', 'Côtés ouvrants'],
    ['roofs', 'Toits ouvrants'],
    ['screens', 'Toiles thermiques'],
    ['louvers', 'Louvres', louverDetails],
    ['fans', 'Ventilateurs'],
    ['irrigation', 'Irrigation'],
    ['heating', 'Chauffage', furnaceDetails],
    ['custom', 'Autres réponses'],
  ].map(([id, title, details]) => [id, tr(title), details])

  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium text-slate-900"><GreenhouseTitle idx={idx} permission={cardPermission} name={g.name} /></p>
        {onEdit && !grouped && <EditLink onClick={() => onEdit(idx, 'sides')} />}
      </div>
      {grouped ? <div className="mt-3 space-y-3">
        {sections.map(([id, title, details]) => {
          const items = rows.filter(([, , section]) => section === id)
          if (!items.length && !details?.length) return null
          return <section key={id} aria-label={title} className="border-t border-slate-200 pt-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
              {onEdit && <EditLink onClick={() => onEdit(idx, id)} />}
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              {items.map(([label, value], i) => label == null
                ? <dd key={i} className="col-span-2 min-w-0 break-words">{value}</dd>
                : <Fragment key={i}><dt className="min-w-0 break-words">{label}</dt><dd className="min-w-0 break-words">{value}</dd></Fragment>)}
            </dl>
            {details}
          </section>
        })}
      </div> : <>
        <div className="mt-1 grid grid-cols-2 gap-1 text-xs">
          {rows.map(([label, value], i) => <Fragment key={i}><span>{label}</span><span>{value}</span></Fragment>)}
        </div>
        {louverDetails}
        {furnaceDetails}
      </>}
    </div>
  )
}

// Compute extras from the response — called after submission.
// Returns { items: [{ role, qty, unit_price, description }] }.
function computeExtras(resp, permission, tr = s => s) {
  const items = []
  // Mobile controller — if customer asked for it via network step
  if (asksNetwork(resp, false) && resp.network_access === 'mobile_controller' && !resp.form_options?.mobile_controller) {
    items.push({ role: 'mobile_controller', qty: 1, description: tr('Contrôleur internet mobile (1 unité)'), unit_price: 0 })
  }
  if (permission === 'chief_grower') {
    let extraValveBlocks = 0
    let needsValves = 0
    for (const g of (resp.greenhouses || [])) {
      const z = Number(g.irrigation_zones) || 0
      if (z > 4) extraValveBlocks += Math.ceil((z - 4) / 4)
      if (z > 0 && g.needs_orisha_valves) needsValves += Number(g.orisha_valves_count) || z
    }
    if (extraValveBlocks > 0) {
      items.push({ role: 'valve_block_onetime', qty: extraValveBlocks, description: `${extraValveBlocks} ${tr("bloc(s) de 4 valves d'irrigation supplémentaires")}`, unit_price: 0 })
    }
    if (needsValves > 0) {
      items.push({ role: 'valve_1in', qty: needsValves, description: `${needsValves} ${tr('valve(s) 1 po')}`, unit_price: 0 })
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
    items.push({ role: 'guide_pipe', qty: needsGuidePipes, description: `${needsGuidePipes} ${tr('tuyau(x) guide(s) compatible(s)')}`, unit_price: 0 })
  }
  return { items }
}
