import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Phone, Mail, MessageSquare, PhoneIncoming, PhoneOutgoing, Zap, Eye, Edit2, Building2, ArrowUpRight, ArrowDownLeft, Clock, MessagesSquare } from 'lucide-react'
import { fmtDateTime, fmtTime, localISODate } from '../lib/formatDate.js'
import { stripEmailHtml, stripEmailText } from '../lib/emailParser.js'
import { Modal } from './Modal.jsx'
import { useIsDark } from '../lib/theme.js'
import EmptyState from './EmptyState.jsx'

import { INTERACTION_TYPE_LABELS as TYPE_LABELS } from './Badge.jsx'
const TYPE_ICONS = { call: Phone, email: Mail, sms: MessageSquare, meeting: Building2, note: Edit2 }
// Teinte de la pastille par type : repère de lecture dans un fil qui mêle
// courriels, appels et notes. Ni rouge ni ambre — ces deux-là sont sémantiques.
const TYPE_TINTS = {
  call: 'bg-brand-50 text-brand-600',
  email: 'bg-sky-50 text-sky-600',
  sms: 'bg-violet-50 text-violet-600',
  meeting: 'bg-indigo-50 text-indigo-600',
  note: 'bg-slate-100 text-slate-500',
}
const TRANSCRIPT_PREVIEW_LEN = 1000
// Un courriel complet mesure facilement 2000 px : sans plafond, deux messages
// suffisaient à noyer le reste du fil. Au-delà, dégradé + clic pour la suite.
const EMAIL_PREVIEW_MAX = 180

import { fmtDurationSeconds as fmtDuration } from '../lib/duration.js'

// `stripEmailHtml` renvoie un fragment : sans feuille de style, l'iframe le rend
// avec les défauts du navigateur (16 px, marges, empattements) — deux fois la
// taille du reste de l'app, ce qui donnait des aperçus disproportionnés. On
// enveloppe donc le fragment dans un document calé sur la typo de l'ERP.
const EMAIL_FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

// Un document iframe n'hérite ni de la classe `.dark` ni des variables CSS du
// thème : on lui passe les couleurs en dur, relues sur la racine de l'app pour
// que l'aperçu se fonde exactement dans sa carte.
function emailPalette() {
  const read = (name, fallback) => {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
      return v ? `rgb(${v})` : fallback
    } catch { return fallback }
  }
  return {
    surface: read('--c-white', '#ffffff'),
    text: read('--c-slate-700', '#334155'),
    muted: read('--c-slate-400', '#94a3b8'),
    rule: read('--c-slate-200', '#e2e8f0'),
    link: read('--c-brand-600', '#21B14B'),
  }
}

function emailDoc(html, { compact, palette }) {
  const p = palette || { surface: '#ffffff', text: '#334155', muted: '#94a3b8', rule: '#e2e8f0', link: '#21B14B' }
  // Aperçu : on neutralise la mise en forme du courriel (les gabarits marketing
  // arrivent en 24 px sur fond coloré) et on repeint tout aux couleurs de la
  // carte — l'entrée reste lisible en jour comme en nuit. `body *` et non `*`,
  // sinon la règle écraserait le fond posé sur `html`/`body`.
  // Plein écran : mise en page d'origine préservée, donc fond blanc fixe.
  const surface = compact ? p.surface : '#ffffff'
  const text = compact ? p.text : '#334155'
  const link = compact ? p.link : '#21B14B'
  const neutralize = compact
    ? `body * { background: transparent !important; background-image: none !important; color: inherit !important;
         font-family: ${EMAIL_FONT} !important; font-size: 13px !important; line-height: 1.55 !important; }
       a, a * { color: ${link} !important; }
       p { margin: 0 0 0.5em }`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8">
<base target="_blank">
<style>
  html { color-scheme: ${compact ? 'normal' : 'light'} }
  html, body { margin: 0; padding: 0; background: ${surface}; }
  body { font: 400 ${compact ? '13px/1.55' : '14px/1.6'} ${EMAIL_FONT}; color: ${text}; overflow-wrap: anywhere; -webkit-font-smoothing: antialiased; }
  img, video { max-width: 100% !important; height: auto; }
  table { max-width: 100% !important; }
  a { color: ${link}; }
  blockquote { margin: 0.5em 0; padding-left: 0.75em; border-left: 2px solid ${compact ? p.rule : '#e2e8f0'}; color: ${compact ? p.muted : '#64748b'}; }
  ${neutralize}
</style></head><body>${html}</body></html>`
}

// Hauteur réelle du courriel. `body.scrollHeight` compte les blocs vides que
// tous les clients laissent en fin de message (Gmail en met trois) : la carte
// se terminait sur 80 px de blanc. Un Range ignore ces boîtes vides — mais
// aussi les images, qu'on remesure à part.
function measureEmailHeight(frame) {
  const doc = frame.contentDocument
  if (!doc?.body) return null
  const scroll = doc.body.scrollHeight
  let tight = 0
  try {
    const range = doc.createRange()
    range.selectNodeContents(doc.body)
    tight = Math.ceil(range.getBoundingClientRect().bottom)
  } catch { /* Range indisponible : on retombe sur scrollHeight */ }
  for (const img of doc.images) {
    if (img.complete && img.naturalHeight > 0) tight = Math.max(tight, Math.ceil(img.getBoundingClientRect().bottom))
  }
  return tight > 0 ? Math.min(scroll, tight + 4) : scroll
}

// « Aujourd'hui »/« Hier » plutôt qu'une date longue : sur un fil consulté au
// quotidien, c'est l'information qu'on cherche.
function dayLabel(date) {
  const d = new Date(date)
  const iso = localISODate(d)
  const today = localISODate()
  if (iso === today) return "Aujourd'hui"
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  if (iso === localISODate(yesterday)) return 'Hier'
  return d.toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

function DaySeparator({ date }) {
  return (
    <div className="relative flex items-center gap-3 pt-5 pb-1 first:pt-0">
      <span className="flex w-8 justify-center">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-300 ring-[5px] ring-slate-50" />
      </span>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {dayLabel(date)}
      </span>
    </div>
  )
}

// ⚠ Pas de couple `uppercase tracking-wide` sur ces pastilles : dans un panneau
// latéral, `.peek-panel div:has(> .uppercase.tracking-wide)` (index.css) prend
// le conteneur pour une ligne de champ et le passe en grille libellé|valeur.
// D'où l'interlettrage en valeur arbitraire.
const CHIP = 'inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium uppercase tracking-[0.04em]'

function DirectionChip({ direction, type }) {
  if (direction !== 'in' && direction !== 'out') return null
  const isOut = direction === 'out'
  const Icon = type === 'call'
    ? (isOut ? PhoneOutgoing : PhoneIncoming)
    : (isOut ? ArrowUpRight : ArrowDownLeft)
  return (
    <span className={`${CHIP} ${isOut ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-500'}`}>
      <Icon size={10} />{isOut ? 'Envoyé' : 'Reçu'}
    </span>
  )
}

// ─── Entrée du fil (aperçu compact, cliquable) ───────────────────────────────

function Entry({ item, showContact, onOpen, palette }) {
  const isOut = item.direction === 'out'
  const Icon = TYPE_ICONS[item.type] || MessagesSquare
  const [emailClipped, setEmailClipped] = useState(false)

  // Body preview : full stripped message for emails, truncated transcript for
  // calls, truncated notes for meetings/notes.
  const preview = useMemo(() => buildPreview(item), [item])
  const time = fmtTime(item.timestamp)
  const hasRecording = Boolean(item.call_id && (item.recording_path || item.drive_file_id))
  const hasBody = Boolean(preview.kind || preview.subject || hasRecording)
  // Rien à lire dans la carte, mais l'en-tête porte déjà une information (durée
  // d'appel) : inutile d'annoncer « aucun contenu ».
  const hasSideInfo = item.type === 'call' && item.duration_seconds > 0

  return (
    <div className="relative flex gap-3">
      {/* Pastille sur le rail : opaque, donc elle interrompt proprement le filet */}
      <span className={`relative z-10 mt-2 flex-shrink-0 w-8 h-8 rounded-full grid place-items-center ring-4 ring-slate-50 ${TYPE_TINTS[item.type] || TYPE_TINTS.note}`}>
        <Icon size={14} />
      </span>

      <div
        onClick={() => onOpen(item)}
        className="group relative flex-1 min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white cursor-pointer transition-colors hover:border-slate-300"
      >
        {/* Filet de direction : sortant = marque, entrant = neutre */}
        <span className={`absolute inset-y-0 left-0 w-[3px] ${isOut ? 'bg-brand-400' : 'bg-slate-200'}`} aria-hidden />

        {/* En-tête : nature + direction à gauche, horodatage à droite */}
        <div className="flex items-start justify-between gap-3 pl-4 pr-3 pt-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
            <span className="text-xs font-semibold text-slate-700">{TYPE_LABELS[item.type] || item.type}</span>
            <DirectionChip direction={item.direction} type={item.type} />
            {item.type === 'call' && item.duration_seconds > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-400 tabular-nums">
                <Clock size={10} />{fmtDuration(item.duration_seconds)}
              </span>
            )}
            {item.automated === 1 && (
              <span className={`${CHIP} bg-slate-100 text-slate-500`} title="Envoi automatisé">
                <Zap size={10} />Auto
              </span>
            )}
            {item.automated === 1 && item.open_count > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] text-green-600" title={`Ouvert ${item.open_count}×`}>
                <Eye size={10} />{item.open_count}
              </span>
            )}
            {showContact && item.contact_name?.trim() && (
              <Link
                to={`/contacts/${item.contact_id}`}
                onClick={e => e.stopPropagation()}
                className="text-xs font-medium text-brand-600 hover:underline truncate"
              >
                {item.contact_name.trim()}
              </Link>
            )}
          </div>
          <div data-testid="interaction-meta" className="flex-shrink-0 flex items-center gap-1.5 text-[11px] text-slate-400 tabular-nums">
            <span title={fmtDateTime(item.timestamp)}>{time || fmtDateTime(item.timestamp)}</span>
            {item.user_name && (
              <span className="hidden sm:inline max-w-[110px] truncate" title={item.user_name}>· {item.user_name}</span>
            )}
          </div>
        </div>

        <div className={`pl-4 pr-3 ${hasBody ? 'pb-3 pt-1' : 'pb-2.5'}`}>
          {/* Sujet du courriel, titre de la réunion/note */}
          {preview.subject && (
            <div className="text-sm font-medium text-slate-900 leading-snug">{preview.subject}</div>
          )}

          {/* Corps — courriel nettoyé (plafonné) ou transcription/notes tronquées */}
          {preview.kind === 'html' && (
            <div
              className="relative mt-1.5 overflow-hidden rounded-lg"
              style={{ maxHeight: `${EMAIL_PREVIEW_MAX}px` }}
            >
              <iframe
                srcDoc={emailDoc(preview.html, { compact: true, palette })}
                sandbox="allow-same-origin"
                scrolling="no"
                className="w-full border-0"
                style={{ minHeight: '32px', pointerEvents: 'none' }}
                onLoad={e => {
                  try {
                    const h = measureEmailHeight(e.target)
                    if (h == null) return
                    e.target.style.height = `${h}px`
                    setEmailClipped(h > EMAIL_PREVIEW_MAX)
                  } catch { /* cross-origin : on garde la hauteur minimale */ }
                }}
              />
              {emailClipped && (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-white to-transparent" aria-hidden />
              )}
            </div>
          )}
          {preview.kind === 'text' && (
            <div className="text-sm mt-1 text-slate-600 leading-relaxed whitespace-pre-wrap break-words line-clamp-4">
              {preview.text}
              {preview.truncated && ' …'}
            </div>
          )}
          {/* Ni corps, ni sujet, ni durée, ni enregistrement : le dire plutôt que
              de laisser une carte vide. */}
          {!hasBody && !hasSideInfo && (
            <div className="text-sm text-slate-400 italic">Aucun contenu</div>
          )}

          {/* Enregistrement (appels seulement) */}
          {item.call_id && (item.recording_path || item.drive_file_id) && (
            <audio
              controls
              preload="none"
              className="mt-2.5 w-full h-8"
              src={`/erp/api/calls/${item.call_id}/recording?token=${localStorage.getItem('erp_token')}`}
              onClick={e => e.stopPropagation()}
            />
          )}

          {(emailClipped || preview.truncated) && (
            <div className="mt-1.5 text-[11px] font-medium text-brand-600 opacity-0 transition-opacity group-hover:opacity-100">
              Ouvrir le détail
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function buildPreview(item) {
  if (item.type === 'email') {
    const subject = item.subject || null
    if (item.body_html) {
      const { html } = stripEmailHtml(item.body_html)
      // Un message qui n'était qu'une citation + une signature ne laisse rien :
      // on retombe sur la version texte plutôt que d'afficher une iframe vide.
      if (html.trim()) return { kind: 'html', html, subject }
    }
    if (item.body_text) {
      const { text } = stripEmailText(item.body_text)
      return { kind: 'text', text, truncated: false, subject }
    }
    return { subject }
  }
  if (item.type === 'call' && item.call_summary) {
    return { kind: 'text', text: item.call_summary, truncated: false }
  }
  if (item.type === 'call' && item.transcript_formatted) {
    const full = item.transcript_formatted
    if (full.length <= TRANSCRIPT_PREVIEW_LEN) return { kind: 'text', text: full, truncated: false }
    return { kind: 'text', text: full.slice(0, TRANSCRIPT_PREVIEW_LEN), truncated: true }
  }
  if ((item.type === 'meeting' || item.type === 'note') && item.meeting_notes) {
    const title = item.meeting_title && item.meeting_title !== 'Note' ? item.meeting_title : null
    const full = item.meeting_notes
    if (full.length <= TRANSCRIPT_PREVIEW_LEN) return { kind: 'text', text: full, truncated: false, subject: title }
    return { kind: 'text', text: full.slice(0, TRANSCRIPT_PREVIEW_LEN), truncated: true, subject: title }
  }
  return {}
}

// ─── Detail modal (all the content + metadata) ───────────────────────────────

function InteractionDetail({ item }) {
  const [showFull, setShowFull] = useState(false)

  const emailBody = useMemo(() => {
    if (item.type !== 'email') return null
    if (item.body_html) {
      const { html, hasHidden } = stripEmailHtml(item.body_html)
      if (showFull || html.trim()) return { html: showFull ? item.body_html : html, hasHidden, kind: 'html' }
    }
    if (item.body_text) {
      const { text, hasHidden } = stripEmailText(item.body_text)
      return { text: showFull ? item.body_text : text, hasHidden, kind: 'text' }
    }
    return null
  }, [item.type, item.body_html, item.body_text, showFull])

  return (
    <div className="space-y-4">
      {/* Metadata */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">Date</dt>
        <dd className="text-slate-800">{fmtDateTime(item.timestamp)}</dd>

        {item.direction && (<>
          <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">Direction</dt>
          <dd className="text-slate-800">{item.direction === 'in' ? 'Entrant' : 'Sortant'}</dd>
        </>)}

        {item.contact_name?.trim() && (<>
          <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">Contact</dt>
          <dd>{item.contact_id
            ? <Link to={`/contacts/${item.contact_id}`} className="text-brand-600 hover:underline">{item.contact_name.trim()}</Link>
            : <span className="text-slate-800">{item.contact_name.trim()}</span>}
          </dd>
        </>)}

        {item.company_name && (<>
          <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">Entreprise</dt>
          <dd>{item.company_id
            ? <Link to={`/companies/${item.company_id}`} className="text-brand-600 hover:underline">{item.company_name}</Link>
            : <span className="text-slate-800">{item.company_name}</span>}
          </dd>
        </>)}

        {item.type === 'email' && item.subject && (<>
          <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">Sujet</dt>
          <dd className="text-slate-800 font-medium">{item.subject}</dd>
        </>)}
        {item.type === 'email' && item.from_address && (<>
          <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">De</dt>
          <dd className="text-slate-700 text-xs font-mono">{item.from_address}</dd>
        </>)}
        {item.type === 'email' && item.to_address && (<>
          <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">À</dt>
          <dd className="text-slate-700 text-xs font-mono">{item.to_address}</dd>
        </>)}

        {item.type === 'call' && item.callee_number && (<>
          <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">Numéro</dt>
          <dd className="text-slate-800 font-mono">{item.callee_number}</dd>
        </>)}
        {item.type === 'call' && item.duration_seconds != null && (<>
          <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">Durée</dt>
          <dd className="text-slate-800">{fmtDuration(item.duration_seconds)}</dd>
        </>)}

        {item.user_name && (<>
          <dt className="text-xs font-medium text-slate-400 uppercase tracking-wide self-center">Enregistré par</dt>
          <dd className="text-slate-800">{item.user_name}</dd>
        </>)}
      </dl>

      {/* Audio */}
      {item.call_id && (item.recording_path || item.drive_file_id) && (
        <audio controls preload="none" className="w-full h-10 rounded"
          src={`/erp/api/calls/${item.call_id}/recording?token=${localStorage.getItem('erp_token')}`} />
      )}

      {/* Full body */}
      {emailBody?.kind === 'html' && (
        <div className="rounded-lg overflow-hidden border border-slate-200 bg-white">
          <iframe srcDoc={emailDoc(emailBody.html, { compact: false })} sandbox="allow-same-origin" scrolling="no"
            className="w-full border-0" style={{ minHeight: '40px' }}
            onLoad={e => { try { const h = measureEmailHeight(e.target); if (h != null) e.target.style.height = `${h}px` } catch {} }} />
        </div>
      )}
      {emailBody?.kind === 'text' && (
        <div className="p-3 bg-slate-50 rounded-lg text-sm text-slate-700 whitespace-pre-wrap border border-slate-200">
          {emailBody.text}
        </div>
      )}
      {item.type === 'call' && item.call_summary && (
        <div>
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Résumé</div>
          <div className="p-3 bg-slate-50 rounded-lg text-sm text-slate-700 whitespace-pre-wrap border border-slate-200">
            {item.call_summary}
          </div>
        </div>
      )}
      {item.type === 'call' && item.call_next_steps && (
        <div>
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Prochaines étapes</div>
          <div className="p-3 bg-slate-50 rounded-lg text-sm text-slate-700 whitespace-pre-wrap border border-slate-200">
            {item.call_next_steps}
          </div>
        </div>
      )}
      {item.type === 'call' && item.transcript_formatted && (
        <div>
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Transcription</div>
          <div className="p-3 bg-slate-50 rounded-lg text-xs text-slate-700 whitespace-pre-wrap font-mono max-h-96 overflow-y-auto border border-slate-200">
            {item.transcript_formatted}
          </div>
        </div>
      )}
      {(item.type === 'meeting' || item.type === 'note') && item.meeting_notes && (
        <div>
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Notes</div>
          <div className="p-3 bg-slate-50 rounded-lg text-sm text-slate-700 whitespace-pre-wrap border border-slate-200">
            {item.meeting_notes}
          </div>
        </div>
      )}

      {emailBody?.hasHidden && (
        <button
          onClick={() => setShowFull(v => !v)}
          className="text-xs text-brand-600 hover:underline"
        >
          {showFull ? 'Masquer chaîne et signature' : 'Afficher chaîne et signature'}
        </button>
      )}
    </div>
  )
}

// ─── Timeline (the list + modal orchestration) ───────────────────────────────

export default function InteractionTimeline({ interactions, loading, total, onLoadMore, loadingMore, showContact = true }) {
  const [selected, setSelected] = useState(null)
  // Le document d'une iframe ne suit ni `.dark` ni les variables CSS du thème :
  // on relit la palette à chaque bascule et on la passe aux aperçus.
  const dark = useIsDark()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `dark` est la clé de cache, pas une entrée du calcul
  const palette = useMemo(() => emailPalette(), [dark])

  if (loading) {
    // Squelettes calés sur la géométrie du fil (pastille + carte) : pas de
    // sursaut de mise en page quand les données arrivent.
    return (
      <div className="space-y-2.5 py-2">
        {[0, 1, 2].map(i => (
          <div key={i} className="flex gap-3 animate-pulse">
            <span className="mt-2 flex-shrink-0 w-8 h-8 rounded-full bg-slate-200" />
            <div className="flex-1 h-20 rounded-xl bg-slate-100" />
          </div>
        ))}
      </div>
    )
  }
  if (interactions.length === 0) {
    return (
      <div className="card">
        <EmptyState
          compact
          icon={MessagesSquare}
          title="Aucune interaction"
          description="Les courriels, appels, SMS et notes apparaîtront ici au fil des échanges."
        />
      </div>
    )
  }

  let lastDate = null
  const elements = []
  for (const item of interactions) {
    const day = item.timestamp ? item.timestamp.slice(0, 10) : null
    if (day && day !== lastDate) {
      elements.push(<DaySeparator key={`date-${day}`} date={item.timestamp} />)
      lastDate = day
    }
    elements.push(<Entry key={item.id} item={item} showContact={showContact} onOpen={setSelected} palette={palette} />)
  }

  return (
    <>
      <div className="py-1">
        <div className="relative">
          {/* Rail vertical : lie les entrées entre elles et pose la colonne des
              pastilles (16 px ≈ moitié de la pastille de 32 px). */}
          <span className="absolute left-[15.5px] top-3 bottom-3 w-px bg-slate-200" aria-hidden />
          <div className="relative space-y-2.5">
            {elements}
          </div>
        </div>
        {total != null && interactions.length < total && (
          <div className="pl-11 pt-3">
            <button onClick={onLoadMore} disabled={loadingMore} className="btn-secondary btn-sm w-full">
              {loadingMore ? 'Chargement…' : `Charger plus (${total - interactions.length} restants)`}
            </button>
          </div>
        )}
      </div>

      <Modal
        isOpen={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? (TYPE_LABELS[selected.type] || selected.type) : ''}
        size="lg"
      >
        {selected && <InteractionDetail item={selected} />}
      </Modal>
    </>
  )
}
