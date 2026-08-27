import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { Star } from 'lucide-react'
import Spinner from '../components/Spinner.jsx'

// Page PUBLIQUE (aucune auth) du sondage de satisfaction — /s/:token.
// Cible : un client qui vient de recevoir un SMS, sur son téléphone. D'où le
// parti pris mobile-first, les cibles tactiles généreuses (44 px minimum) et
// l'absence totale de navigation : cette page ne fait qu'une chose.
//
// Le parcours suit la note :
//   ★★★ et plus → « Accepteriez-vous d'être contacté par téléphone ? »
//                  puis commentaire facultatif
//   ★★ et moins → commentaire facultatif directement
//
// La langue vient de contacts.language (l'envoi est bloqué si elle manque),
// mais le sélecteur FR/EN reste offert : le contact inscrit dans l'ERP n'est
// pas forcément la personne qui tient le téléphone.

const T = {
  French: {
    title: 'Votre avis compte',
    question: 'À quel point êtes-vous satisfait du service Orisha ?',
    ratingHints: ['Très insatisfait', 'Insatisfait', 'Neutre', 'Satisfait', 'Très satisfait'],
    callQuestion: 'Accepteriez-vous d\'être contacté par téléphone pour parler de votre expérience ?',
    yes: 'Oui',
    no: 'Non',
    commentLabel: 'Un commentaire ? (facultatif)',
    commentPlaceholder: 'Dites-nous en plus…',
    submit: 'Envoyer',
    saving: 'Envoi…',
    thanksTitle: 'Merci !',
    thanksBody: 'Votre réponse a bien été enregistrée.',
    changeHint: 'Vous pouvez modifier votre réponse tant que ce lien est actif.',
    edit: 'Modifier ma réponse',
    expiredTitle: 'Ce sondage a expiré',
    expiredBody: 'Le lien n\'est plus actif. Merci quand même de votre intérêt !',
    notFoundTitle: 'Lien invalide',
    notFoundBody: 'Ce sondage est introuvable. Vérifiez le lien reçu par message texte.',
    errorTitle: 'Une erreur s\'est produite',
    retry: 'Réessayer',
    about: 'À propos de votre demande :',
  },
  English: {
    title: 'Your feedback matters',
    question: 'How satisfied are you with Orisha\'s service?',
    ratingHints: ['Very unsatisfied', 'Unsatisfied', 'Neutral', 'Satisfied', 'Very satisfied'],
    callQuestion: 'Would you be open to a phone call to talk about your experience?',
    yes: 'Yes',
    no: 'No',
    commentLabel: 'Any comments? (optional)',
    commentPlaceholder: 'Tell us more…',
    submit: 'Send',
    saving: 'Sending…',
    thanksTitle: 'Thank you!',
    thanksBody: 'Your response has been recorded.',
    changeHint: 'You can change your answer while this link is active.',
    edit: 'Change my answer',
    expiredTitle: 'This survey has expired',
    expiredBody: 'The link is no longer active. Thanks for your interest!',
    notFoundTitle: 'Invalid link',
    notFoundBody: 'This survey could not be found. Please check the link from your text message.',
    errorTitle: 'Something went wrong',
    retry: 'Try again',
    about: 'About your request:',
  },
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4 flex flex-col items-center">
      <img src="/erp/orisha-logo.png" alt="Orisha" className="h-9 mb-6" />
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-slate-200 p-6 sm:p-8">
        {children}
      </div>
    </div>
  )
}

function Message({ title, body, tone = 'slate' }) {
  return (
    <div className="text-center py-4">
      <h1 className={`text-xl font-semibold ${tone === 'red' ? 'text-red-700' : 'text-slate-900'}`}>{title}</h1>
      {body && <p className="text-sm text-slate-600 mt-2 leading-relaxed">{body}</p>}
    </div>
  )
}

// Sélecteur d'étoiles. `hover` prime sur la valeur choisie pour que le survol
// prévisualise la note ; sur mobile (pas de survol) seul le tap compte.
function StarRating({ value, onChange, hints }) {
  const [hover, setHover] = useState(0)
  const shown = hover || value || 0
  return (
    <div>
      <div className="flex justify-center gap-1.5" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            type="button"
            aria-label={`${n} / 5`}
            onMouseEnter={() => setHover(n)}
            onFocus={() => setHover(n)}
            onClick={() => onChange(n)}
            className="p-1.5 rounded-lg transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <Star
              size={38}
              className={n <= shown ? 'text-amber-400' : 'text-slate-200'}
              fill={n <= shown ? 'currentColor' : 'none'}
              strokeWidth={1.5}
            />
          </button>
        ))}
      </div>
      {/* Hauteur réservée : sans elle, le survol ferait sauter le formulaire. */}
      <div className="h-5 mt-2 text-center text-xs text-slate-500">
        {shown ? hints[shown - 1] : ''}
      </div>
    </div>
  )
}

export default function TicketSurvey() {
  const { token } = useParams()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [lang, setLang] = useState('French')
  const [rating, setRating] = useState(0)
  const [acceptsCall, setAcceptsCall] = useState(null)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [done, setDone] = useState(false)

  const base = `/erp/api/public/ticket-survey/${encodeURIComponent(token || '')}`

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const r = await fetch(base)
      if (r.status === 404) { setLoadError('not_found'); return }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      setData(j)
      setLang(j.language === 'English' ? 'English' : 'French')
      setRating(j.rating || 0)
      setAcceptsCall(j.accepts_call === null || j.accepts_call === undefined ? null : !!j.accepts_call)
      setComment(j.comment || '')
      setDone(!!j.responded)
    } catch {
      setLoadError('error')
    } finally {
      setLoading(false)
    }
  }, [base])

  useEffect(() => { load() }, [load])

  const t = T[lang] || T.French

  useEffect(() => { document.title = `${t.title} — Orisha` }, [t.title])

  const minForCall = data?.callback_question_min_rating ?? 3
  const wantsCallQuestion = rating >= minForCall
  // On n'affiche le commentaire qu'une fois le parcours débloqué : après la
  // question de rappel pour les notes hautes, tout de suite pour les basses.
  const showComment = rating > 0 && (!wantsCallQuestion || acceptsCall !== null)

  async function submit() {
    setSubmitting(true)
    setSubmitError(null)
    try {
      const r = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rating,
          accepts_call: wantsCallQuestion ? acceptsCall : null,
          comment: comment.trim() || null,
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setData(j)
      setDone(true)
    } catch (e) {
      setSubmitError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <Spinner fullscreen label="…" />

  if (loadError === 'not_found') {
    return <Shell><Message title={t.notFoundTitle} body={t.notFoundBody} tone="red" /></Shell>
  }
  if (loadError) {
    return (
      <Shell>
        <Message title={t.errorTitle} tone="red" />
        <button onClick={load} className="mt-4 w-full py-3 rounded-lg bg-slate-100 hover:bg-slate-200 text-sm font-medium text-slate-700">
          {t.retry}
        </button>
      </Shell>
    )
  }
  if (data?.expired) {
    return <Shell><Message title={t.expiredTitle} body={t.expiredBody} /></Shell>
  }

  if (done) {
    return (
      <Shell>
        <Message title={t.thanksTitle} body={t.thanksBody} />
        <div className="flex justify-center gap-1 mt-4">
          {[1, 2, 3, 4, 5].map(n => (
            <Star key={n} size={22} className={n <= rating ? 'text-amber-400' : 'text-slate-200'}
                  fill={n <= rating ? 'currentColor' : 'none'} strokeWidth={1.5} />
          ))}
        </div>
        <p className="text-center text-xs text-slate-400 mt-5">{t.changeHint}</p>
        <button onClick={() => setDone(false)} className="mt-2 w-full py-2.5 text-sm font-medium text-brand-600 hover:text-brand-700">
          {t.edit}
        </button>
      </Shell>
    )
  }

  return (
    <Shell>
      <div className="flex justify-end -mt-2 -mr-1 mb-1">
        <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs">
          {['French', 'English'].map(l => (
            <button
              key={l}
              onClick={() => setLang(l)}
              className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                lang === l ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {l === 'French' ? 'FR' : 'EN'}
            </button>
          ))}
        </div>
      </div>

      <h1 className="text-lg font-semibold text-slate-900 text-center leading-snug">{t.question}</h1>
      {data?.ticket_title && (
        <p className="text-xs text-slate-400 text-center mt-1.5">{t.about} {data.ticket_title}</p>
      )}

      <div className="mt-6">
        <StarRating
          value={rating}
          hints={t.ratingHints}
          onChange={n => {
            setRating(n)
            // Changer de note peut faire disparaître la question de rappel :
            // on repart de zéro pour ne jamais soumettre une réponse orpheline.
            if (n < minForCall) setAcceptsCall(null)
          }}
        />
      </div>

      {wantsCallQuestion && (
        <div className="mt-6 pt-6 border-t border-slate-100">
          <p className="text-sm text-slate-700 leading-snug">{t.callQuestion}</p>
          <div className="grid grid-cols-2 gap-2.5 mt-3">
            {[true, false].map(v => (
              <button
                key={String(v)}
                type="button"
                onClick={() => setAcceptsCall(v)}
                className={`py-3 rounded-lg text-sm font-medium border transition-colors ${
                  acceptsCall === v
                    ? 'bg-brand-600 border-brand-600 text-white'
                    : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300'
                }`}
              >
                {v ? t.yes : t.no}
              </button>
            ))}
          </div>
        </div>
      )}

      {showComment && (
        <div className="mt-6 pt-6 border-t border-slate-100">
          <label className="block text-sm text-slate-700 mb-2">{t.commentLabel}</label>
          <textarea
            value={comment}
            onChange={e => setComment(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder={t.commentPlaceholder}
            className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
          />
          {submitError && <p className="text-xs text-red-600 mt-2">{submitError}</p>}
          <button
            onClick={submit}
            disabled={submitting}
            className="mt-3 w-full py-3 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium disabled:opacity-50"
          >
            {submitting ? t.saving : t.submit}
          </button>
        </div>
      )}
    </Shell>
  )
}
