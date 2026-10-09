import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Phone, Mail, MessageSquare, PhoneIncoming, PhoneOutgoing, Zap, Edit2, Building2, ArrowUpRight, ArrowDownLeft, Clock, MessagesSquare, Plus, Pin, ChevronDown } from 'lucide-react'
import { fmtDateTime, fmtTime, localISODate } from '../lib/formatDate.js'
import { stripEmailHtml, stripEmailText } from '../lib/emailParser.js'
import { emailDoc, emailPalette, measureEmailHeight } from '../lib/emailDoc.js'
import EmailBodyFrame from './EmailBodyFrame.jsx'
import { useIsDark } from '../lib/theme.js'
import EmptyState from './EmptyState.jsx'
import EmailTrackingBlock from './EmailTrackingBlock.jsx'

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
  return `${d.toLocaleDateString('fr-CA', { weekday: 'long' })} ${iso}`
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

// ─── Entrée du fil (aperçu compact ; un clic la déplie en place) ───────────

function Entry({ item, showContact, palette, onTogglePin }) {
  const isOut = item.direction === 'out'
  const Icon = TYPE_ICONS[item.type] || MessagesSquare
  const [emailClipped, setEmailClipped] = useState(false)
  // Plus de modale : la carte se déplie dans le fil, et l'en-tête la replie.
  const [expanded, setExpanded] = useState(false)

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
        onClick={expanded ? undefined : () => setExpanded(true)}
        data-expanded={expanded ? 'true' : undefined}
        className={`group relative flex-1 min-w-0 overflow-hidden rounded-xl border bg-white transition-colors ${expanded ? 'border-slate-300' : 'border-slate-200 cursor-pointer hover:border-slate-300'}`}
      >
        {/* Filet de direction : sortant = marque, entrant = neutre */}
        <span className={`absolute inset-y-0 left-0 w-[3px] ${isOut ? 'bg-brand-400' : 'bg-slate-200'}`} aria-hidden />

        {/* En-tête : nature + direction à gauche, horodatage à droite */}
        <div
          onClick={expanded ? e => { e.stopPropagation(); setExpanded(false) } : undefined}
          aria-expanded={expanded}
          className={`flex items-start justify-between gap-3 pl-4 pr-3 pt-2.5 ${expanded ? 'cursor-pointer' : ''}`}
        >
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
            {showContact && item.contact_name?.trim() && (
              <Link
                to={`/contacts/${item.contact_id}`}
                onClick={e => e.stopPropagation()}
                className="text-xs font-medium link-record truncate"
              >
                {item.contact_name.trim()}
              </Link>
            )}
          </div>
          <div data-testid="interaction-meta" className="flex-shrink-0 flex items-center gap-1.5 text-[11px] text-slate-400 tabular-nums">
            {onTogglePin && (
              <button
                onClick={e => { e.stopPropagation(); onTogglePin(item) }}
                className={`rounded p-0.5 transition-colors ${item.pinned ? 'text-brand-600' : 'text-slate-300 opacity-0 group-hover:opacity-100 hover:text-slate-500'}`}
                title={item.pinned ? 'Désépingler' : 'Épingler en haut du fil'}
              >
                <Pin size={12} className={item.pinned ? 'fill-current' : ''} />
              </button>
            )}
            <span title={fmtDateTime(item.timestamp)}>{time || fmtDateTime(item.timestamp)}</span>
            {item.user_name && (
              <span className="hidden sm:inline max-w-[110px] truncate" title={item.user_name}>· {item.user_name}</span>
            )}
            <ChevronDown
              size={13}
              className={`transition-transform ${expanded ? 'rotate-180 text-slate-500' : 'opacity-0 group-hover:opacity-100'}`}
              aria-hidden
            />
          </div>
        </div>

        {expanded ? (
          <div className="pl-4 pr-3 pb-3 pt-1">
            <ExpandedBody item={item} palette={palette} />
          </div>
        ) : (
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
          {hasRecording && (
            <audio
              controls
              preload="none"
              className="mt-2.5 w-full h-8"
              src={`/erp/api/calls/${item.call_id}/recording?token=${localStorage.getItem('erp_token')}`}
              onClick={e => e.stopPropagation()}
            />
          )}

          {item.type === 'email' && isOut && (
            <div className="mt-2"><EmailTrackingBlock interactionId={item.id} item={item} /></div>
          )}
        </div>
        )}
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
  // Notes : réunions et notes, mais aussi les logs manuels d'appel/SMS, qui
  // rangent leur contenu au même endroit.
  if (item.meeting_notes) {
    const title = item.meeting_title && item.meeting_title !== 'Note' ? item.meeting_title : null
    const full = item.meeting_notes
    if (full.length <= TRANSCRIPT_PREVIEW_LEN) return { kind: 'text', text: full, truncated: false, subject: title }
    return { kind: 'text', text: full.slice(0, TRANSCRIPT_PREVIEW_LEN), truncated: true, subject: title }
  }
  return {}
}

// ─── Contenu déplié (tout le contenu, dans la carte) ─────────────────────────

// ⚠ Libellés sans `uppercase tracking-wide` : voir CHIP (grille du panneau latéral).
const SECTION_LABEL = 'text-[11px] font-medium text-slate-400 mb-1'
const SECTION_BOX = 'p-3 bg-slate-50 rounded-lg text-sm text-slate-700 whitespace-pre-wrap break-words border border-slate-200'

function ExpandedBody({ item, palette }) {
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

  const notesTitle = item.meeting_title && item.meeting_title !== 'Note' ? item.meeting_title : null
  const subject = item.type === 'email' ? item.subject : notesTitle
  const hasRecording = Boolean(item.call_id && (item.recording_path || item.drive_file_id))
  const hasContent = Boolean(emailBody || item.call_summary || item.call_next_steps || item.transcript_formatted || item.meeting_notes || hasRecording)

  return (
    <div className="space-y-3">
      {subject && <div className="text-sm font-medium text-slate-900 leading-snug">{subject}</div>}

      {/* Adresses / numéro : le reste (date, direction, contact) est dans l'en-tête */}
      {(item.from_address || item.to_address || item.callee_number) && (
        <div className="text-xs text-slate-500 space-y-0.5 break-all">
          {item.type === 'email' && item.from_address && <div><span className="text-slate-400">De </span>{item.from_address}</div>}
          {item.type === 'email' && item.to_address && <div><span className="text-slate-400">À </span>{item.to_address}</div>}
          {item.type === 'call' && item.callee_number && <div className="font-mono">{item.callee_number}</div>}
        </div>
      )}

      {hasRecording && (
        <audio controls preload="none" className="w-full h-8"
          src={`/erp/api/calls/${item.call_id}/recording?token=${localStorage.getItem('erp_token')}`} />
      )}

      {emailBody?.kind === 'html' && (
        <div className="rounded-lg overflow-hidden">
          <EmailBodyFrame html={emailBody.html} palette={palette} />
        </div>
      )}
      {emailBody?.kind === 'text' && <div className={SECTION_BOX}>{emailBody.text}</div>}
      {emailBody?.hasHidden && (
        <button onClick={() => setShowFull(v => !v)} className="text-xs link-record">
          {showFull ? 'Masquer chaîne et signature' : 'Afficher chaîne et signature'}
        </button>
      )}

      {item.type === 'call' && item.call_summary && (
        <div>
          <div className={SECTION_LABEL}>Résumé</div>
          <div className={SECTION_BOX}>{item.call_summary}</div>
        </div>
      )}
      {item.type === 'call' && item.call_next_steps && (
        <div>
          <div className={SECTION_LABEL}>Prochaines étapes</div>
          <div className={SECTION_BOX}>{item.call_next_steps}</div>
        </div>
      )}
      {item.type === 'call' && item.transcript_formatted && (
        <div>
          <div className={SECTION_LABEL}>Transcription</div>
          <div className={`${SECTION_BOX} text-xs font-mono max-h-96 overflow-y-auto`}>{item.transcript_formatted}</div>
        </div>
      )}
      {item.meeting_notes && <div className={SECTION_BOX}>{item.meeting_notes}</div>}

      {!hasContent && !subject && <div className="text-sm text-slate-400 italic">Aucun contenu</div>}

      {item.type === 'email' && item.direction === 'out' && <EmailTrackingBlock interactionId={item.id} item={item} defaultOpen />}
    </div>
  )
}

// ─── Timeline (the list) ───────────────────────────────

// `onLog` (optionnel) : quand la page sait consigner une interaction à la main,
// l'état vide propose l'action au lieu de rester un cul-de-sac. Les appelants
// qui ne le passent pas gardent l'état vide sans bouton.
export default function InteractionTimeline({ interactions, loading, total, onLoadMore, loadingMore, showContact = true, onLog, onTogglePin }) {
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
          cta={onLog ? { label: 'Consigner', icon: Plus, onClick: onLog } : undefined}
        />
      </div>
    )
  }

  // Épinglées d'abord (le backend les trie déjà en tête, peu importe leur
  // date) : section à part, sans séparateur de jour, puis le fil chronologique
  // normal pour le reste.
  const pinnedItems = interactions.filter(i => i.pinned)
  const restItems = interactions.filter(i => !i.pinned)

  let lastDate = null
  const elements = []
  for (const item of restItems) {
    const day = item.timestamp ? item.timestamp.slice(0, 10) : null
    if (day && day !== lastDate) {
      elements.push(<DaySeparator key={`date-${day}`} date={item.timestamp} />)
      lastDate = day
    }
    elements.push(<Entry key={item.id} item={item} showContact={showContact} palette={palette} onTogglePin={onTogglePin} />)
  }

  return (
    <div className="py-1">
      {pinnedItems.length > 0 && (
        <div className="mb-3">
          <div className="flex items-center gap-1.5 pl-11 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            <Pin size={11} className="fill-current" />Épinglé
          </div>
          <div className="space-y-2.5">
            {pinnedItems.map(item => (
              <Entry key={item.id} item={item} showContact={showContact} palette={palette} onTogglePin={onTogglePin} />
            ))}
          </div>
        </div>
      )}
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
  )
}
