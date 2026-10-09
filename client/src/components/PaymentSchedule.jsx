// Cédule hebdomadaire de paiements fournisseurs — la sous-vue « À payer » de
// /paiements-emis.
//
// L'écran ne montre QUE la liste à payer : les factures ouvertes de la séance,
// échues d'abord, regroupées par fournisseur. Les trois tuiles de tête (total
// de la séance, solde BNC après cédule, solde projeté de la carte) ont été
// retirées le 12 août 2026 à la demande de Charles — le solde se regarde dans
// /comptabilite, la carte dans son relevé. Ne pas les remettre sans demande :
// le serveur continue de les calculer (`balance`, `mastercard`), c'est
// l'affichage qui a été jugé superflu.
//
// Cocher une ligne, c'est payer : ça crée le paiement émis dans /paiements-emis
// (lié à la facture, donc plus de double compte dans la projection), daté par
// défaut du DERNIER jour de l'échéance (veille ouvrable si les banques ferment
// ce jour-là) — modifiable sur la ligne avant de cocher, et encore après dans
// « À passer à la banque ». Juste après le clic, la ligne demande la RÉFÉRENCE du paiement
// (n° de confirmation, n° de chèque…) : ce numéro n'existe qu'une fois le
// paiement fait, et le saisir ici évite d'aller rouvrir le détail du paiement
// dans l'autre onglet. Ce numéro se lit AILLEURS (site de la banque, appli
// mobile) : la ligne attend donc le retour — changer d'onglet ne valide rien,
// et le curseur revient dans le champ au retour. Entrée l'enregistre, Échap (ou
// « Sans référence ») passe — puis la ligne QUITTE
// la cédule — la suite se joue dans l'onglet
// « À passer à la banque », seul endroit où l'on suit un paiement émis (et où
// l'on peut le supprimer si on s'est trompé). Pas de section « déjà payées »
// ici : un état, un endroit.
// Le report n'est plus une action offerte sur la ligne : une facture qu'on ne
// paie pas cette séance se laisse simplement là. La section « Reportés » reste
// affichée pour les factures déjà reportées — leur raison, leur date de retour
// et leur reprise continuent de se piloter d'ici.
import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react'
import { Link } from 'react-router-dom'
import {
  Circle, CheckCircle2, AlertTriangle, CreditCard,
  RotateCcw, ChevronRight, ReceiptText, Clock, EyeOff, X,
} from 'lucide-react'
import api from '../lib/api.js'
import { VendorHover } from './VendorProfileHint.jsx'
import RecordPeekDrawer from './RecordPeekDrawer.jsx'
import { payDateForDue } from '../lib/bankDays.js'
// Le moyen de paiement nomme la référence à saisir (n° de chèque, n° de
// confirmation Interac, code de paiement…).
import { spec } from '../lib/paymentMethods.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { fmtMoney } from '../utils/formatters.js'

// Pas de garde null historique : un montant absent s'affiche « 0,00 $ ».
const fmtCad = (n, currency = 'CAD') => fmtMoney(n, currency, { nullIsZero: true })
const fmtDay = d => (d ? String(d).slice(0, 10) : '—')
// « mardi 2026-08-18 » — le jour de la semaine porte la règle de la cédule, il
// doit être écrit en toutes lettres.
const fmtWeekday = d => (d ? `${new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('fr-CA', { weekday: 'long' })} ${String(d).slice(0, 10)}` : '—')

const inputXs = 'px-1.5 py-0.5 text-xs border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400'

// Formulaire de l'achat fournisseur (pas de route de fiche), chargé à la demande.
const AchatPanel = lazy(() => import('../pages/AchatsFournisseurs.jsx').then(m => ({ default: m.AchatModal })))

// N° de facture cliquable : ouvre la facture DANS l'ERP, en panneau latéral —
// on reste sur la cédule (demande d'Antoine Lambert, 2026-10-06 : plus de
// lien vers QuickBooks ici). Le lien garde son href pour le Ctrl+clic.
function BillLink({ item, onChanged }) {
  const [achat, setAchat] = useState(null)
  const num = item.invoice_number || 'sans n°'
  const open = async (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return
    e.preventDefault()
    try { setAchat(await api.achatsFournisseurs.get(item.id)) } catch { /* lien mort */ }
  }
  return (
    <>
      <Link to={`/fournisseurs/achats?id=${item.id}`} onClick={open} data-testid={`schedule-qb-${item.id}`}
        className="min-w-0 inline-flex items-center text-sm link-record"
        title={`Facture ${item.vendor}${item.invoice_number ? ` ${item.invoice_number}` : ''}`}>
        <span className="truncate">{num}</span>
      </Link>
      {achat && (
        <RecordPeekDrawer open onClose={() => setAchat(null)} peekKey="achats" width={640}
          title={achat.vendor || 'Facture fournisseur'}
          subtitle={[achat.vendor_invoice_number, achat.invoice_date].filter(Boolean).join(' · ')}>
          <div className="px-5 py-4">
            <Suspense fallback={<div className="p-6 text-sm text-slate-400">Chargement…</div>}>
              <AchatPanel achat={achat} onClose={() => setAchat(null)} onSaved={() => onChanged?.()} />
            </Suspense>
          </div>
        </RecordPeekDrawer>
      )}
    </>
  )
}

// La remarque ambre d'une facture n'appartient pas à la facture : c'est la
// particularité du PROFIL du fournisseur (« facturer au ctb le 30 du mois
// précédent »…). C'est en payant qu'on s'aperçoit qu'elle est fausse ou
// périmée, donc elle se corrige sur place — clic sur le texte, autosave au blur
// — mais l'écriture va dans le profil : la même remarque n'a pas à être
// corrigée facture par facture, et /fournisseurs comme le formulaire de
// paiement affichent aussitôt la version à jour. Vider le champ la retire.
function VendorParticularites({ item, onChanged }) {
  const { addToast } = useToast()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  // Échap = abandon : le blur qui suit ne doit rien écrire.
  const cancelled = useRef(false)

  const save = async (value) => {
    setEditing(false)
    if (cancelled.current) { cancelled.current = false; return }
    if ((value || '').trim() === (item.particularites || '').trim()) return
    setSaving(true)
    try { await api.treasury.schedule.setParticularites(item.id, value); onChanged() }
    catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setSaving(false) }
  }

  if (editing) {
    return (
      <div className="w-full">
        <textarea autoFocus rows={2} defaultValue={item.particularites || ''}
          data-testid={`schedule-particularites-input-${item.id}`}
          className="w-full px-2 py-1 text-[11px] leading-snug text-amber-800 bg-amber-50/60 border border-amber-200 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-400/30"
          onBlur={e => save(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') { e.preventDefault(); cancelled.current = true; setEditing(false) }
            // Entrée enregistre, Maj+Entrée passe à la ligne.
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.blur() }
          }} />
        <p className="mt-0.5 text-[10px] text-slate-400">
          Enregistrée sur le profil du fournisseur {item.vendor} · Échap pour annuler
        </p>
      </div>
    )
  }
  // Pas de remarque : rien sur la ligne. L'ajout se fait depuis le profil du
  // fournisseur (/fournisseurs), là où la remarque vit de toute façon — la
  // cédule ne sert qu'à lire et corriger celles qui existent.
  if (!item.particularites) return null
  return (
    <p className={`w-full flex items-start gap-1.5 text-[11px] leading-snug text-amber-700 ${saving ? 'opacity-50' : ''}`}
      data-testid={`schedule-particularites-${item.id}`}>
      <AlertTriangle size={12} className="shrink-0 mt-px" />
      <button type="button" onClick={() => setEditing(true)} data-testid={`schedule-particularites-edit-${item.id}`}
        className="text-left hover:underline decoration-amber-300"
        title="Cliquer pour corriger — la remarque est enregistrée sur le profil du fournisseur">
        {item.particularites}
      </button>
    </p>
  )
}

// Une facture de la cédule. Autosave partout : cocher, changer le compte à
// débiter et écrire la raison d'un report sauvegardent immédiatement.
function ScheduleItem({ item, accounts, cardAccount, today, onChanged, onPaid, onAccountChange }) {
  const { addToast } = useToast()
  const [busy, setBusy] = useState(false)
  // Paiement qui vient d'être créé, en attente de sa référence : le n° de
  // confirmation (ou de chèque) n'existe qu'APRÈS avoir payé — on le saisit
  // donc ici, sur la ligne, plutôt que d'aller rouvrir le détail du paiement
  // dans « À passer à la banque ». Tant qu'il est là, la ligne reste affichée :
  // c'est lui qui retient le rechargement de la cédule.
  const [paid, setPaid] = useState(null)
  // Le champ de référence, pour y ramener le curseur au retour d'onglet.
  const refInput = useRef(null)
  const late = item.due_date && item.due_date < today
  // Payer une facture dont l'échéance n'est pas atteinte n'est pas interdit,
  // mais c'est le cas typique du faux clic : on le signale sans le bloquer.
  const early = item.due_date && item.due_date > today
  // Date à laquelle le paiement sera émis : par défaut le DERNIER jour de
  // l'échéance (veille ouvrable si les banques ferment ce jour-là) — modifiable
  // si on paie plus tôt ou plus tard que prévu.
  const suggestedPay = useMemo(() => payDateForDue(item.due_date, today), [item.due_date, today])
  const [payDate, setPayDate] = useState(suggestedPay.date)
  // Payer = créer le paiement émis à la date choisie. La ligne ne quitte la
  // cédule qu'une fois la référence saisie (ou passée) — la suite se joue dans
  // « À passer à la banque », où la date reste modifiable au besoin.
  const pay = async () => {
    setBusy(true)
    try {
      const payment = await api.treasury.schedule.pay(item.id, { account: item.account, method: item.method, payment_date: payDate })
      setPaid(payment)
      onPaid?.()
    } catch (e) { addToast({ message: e.message, type: 'error' }); onChanged() }
    finally { setBusy(false) }
  }
  // Fin de la saisie : la référence part sur le paiement créé (autosave, aucun
  // bouton « Enregistrer »), puis la ligne quitte la cédule.
  const finishReference = async (value) => {
    const payment = paid
    if (!payment) return
    const ref = String(value || '').trim()
    setPaid(null)
    setBusy(true)
    try {
      if (ref) await api.treasury.payments.update(payment.id, { reference: ref })
      addToast({
        message: `${item.vendor} — paiement du ${fmtDay(payment.payment_date)} créé${ref ? ` · réf. ${ref}` : ''}, il est dans « À passer à la banque »`,
        type: 'success',
        duration: 12000,
        // Pas de fenêtre de confirmation avant l'action (elle est réversible) :
        // le retour arrière est offert après coup, et laissé à l'écran assez
        // longtemps pour qu'on s'aperçoive de l'erreur.
        action: {
          label: 'Annuler',
          onClick: () => api.treasury.schedule.unpay(item.id)
            .then((out) => {
              // Retirer le paiement rouvre la facture dans QuickBooks ; quand
              // QuickBooks refuse, il faut le savoir tout de suite.
              if (out?.warning) addToast({ message: out.warning, type: 'error', duration: 12000 })
              addToast({ message: `${item.vendor} — remis dans la cédule`, type: 'info' })
              onChanged()
            })
            .catch(e => addToast({ message: e.message, type: 'error' })),
        },
      })
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setBusy(false); onChanged() }
  }
  // Revenir sur l'onglet remet le curseur dans le champ : on est parti chercher
  // le numéro, on revient pour l'écrire — pas pour re-cliquer dans la case.
  useEffect(() => {
    if (!paid) return undefined
    const refocus = () => { if (!document.hidden) refInput.current?.focus() }
    window.addEventListener('focus', refocus)
    document.addEventListener('visibilitychange', refocus)
    return () => {
      window.removeEventListener('focus', refocus)
      document.removeEventListener('visibilitychange', refocus)
    }
  }, [paid])
  // Le compte n'est qu'une intention tant que le paiement n'existe pas : gardé
  // côté page, il alimente tout de suite la projection de la carte.
  const setAccount = value => onAccountChange(item.id, value)
  const refSpec = spec(paid?.method || item.method)
  return (
    <div className={`group flex flex-wrap items-center gap-2 px-3 py-2 border-t border-slate-100 ${busy ? 'opacity-60' : ''} ${paid ? 'bg-emerald-50/40' : ''}`}
      data-testid={`schedule-item-${item.id}`}>
      {paid ? (
        <span className="shrink-0 inline-flex items-center gap-1.5 w-28 justify-center px-2 py-1.5 text-xs font-medium rounded-full border border-emerald-200 bg-emerald-100 text-emerald-700"
          data-testid={`schedule-paid-${item.id}`}>
          <CheckCircle2 size={13} /> Payé
        </span>
      ) : (
        // Le libellé nomme l'ACTION, pas l'état de la ligne. « À payer » sur un
        // bouton se lit comme une étiquette de statut ou une case à cocher de
        // sélection : on a payé par erreur trois factures d'affilée en
        // descendant la liste, dont une dont l'échéance était cinq jours plus
        // tard. Une facture ainsi « payée » quitte la cédule — donc elle
        // disparaît de la liste des choses à payer et ne se paie jamais.
        <button type="button" onClick={pay} disabled={busy}
          data-testid={`schedule-pay-${item.id}`}
          className={`shrink-0 inline-flex items-center gap-1.5 w-28 justify-center px-2 py-1.5 text-xs font-medium rounded-full border bg-white transition-colors hover:border-emerald-300 hover:text-emerald-700 ${
            early ? 'border-amber-300 text-amber-700' : 'border-slate-200 text-slate-500'}`}
          title={early
            ? `Échéance le ${fmtDay(item.due_date)} — ne cocher qu'une fois le paiement réellement fait. La facture quittera la cédule.`
            : "Ne cocher qu'une fois le paiement réellement fait : la facture quitte la cédule et passe dans « À passer à la banque »."}>
          <Circle size={13} /> J'ai payé
        </button>
      )}

      <span className="min-w-0 flex-1 flex items-center gap-1.5">
        <BillLink item={item} onChanged={onChanged} />
        {item.no_due_date && <span className="shrink-0 text-[11px] text-slate-400">(échéance inconnue)</span>}
      </span>

      <span className={`shrink-0 text-xs tabular-nums ${late ? 'text-rose-600 font-medium' : 'text-slate-500'}`}>
        {late ? 'échue le ' : 'le '}{fmtDay(item.due_date)}
      </span>

      {/* Date à laquelle le paiement sera émis : préremplie au dernier jour de
          l'échéance, modifiable si on paie plus tôt ou plus tard. */}
      {!paid && (
        <span className="shrink-0 flex items-center gap-1">
          <input type="date" value={payDate} onChange={e => setPayDate(e.target.value)}
            className={`${inputXs} w-32 tabular-nums`}
            data-testid={`schedule-pay-date-${item.id}`}
            title={payDate === suggestedPay.date
              ? `Paiement prévu le ${fmtDay(suggestedPay.date)} — dernier jour de l'échéance${
                suggestedPay.reason === 'weekend' ? " (l'échéance tombe une fin de semaine, banques fermées)"
                  : suggestedPay.reason === 'holiday' ? ` (${suggestedPay.holiday}, banques fermées)`
                    : suggestedPay.reason === 'late' ? ' (échéance déjà passée)' : ''}.`
              : `Date modifiée manuellement — proposée par défaut : ${fmtDay(suggestedPay.date)}.`} />
          {payDate !== suggestedPay.date && (
            <button type="button" onClick={() => setPayDate(suggestedPay.date)}
              data-testid={`schedule-pay-date-restore-${item.id}`}
              className="text-[11px] link-record whitespace-nowrap"
              title={`Remettre au ${fmtDay(suggestedPay.date)}`}>
              remettre à l'échéance
            </button>
          )}
        </span>
      )}

      {/* Payée à l'instant : le compte n'est plus une décision (il est écrit sur
          le paiement), la seule chose qui reste à saisir est la référence que la
          banque vient de donner. */}
      {paid ? (
        <span className="flex-1 min-w-48 flex items-center gap-2" data-testid={`schedule-reference-row-${item.id}`}>
          {/* Le n° de confirmation se lit AILLEURS (site de la banque, autre
              onglet, appli mobile) : la ligne doit donc attendre le retour, pas
              se refermer au premier blur. Un blur qui vient d'un changement
              d'onglet ou de fenêtre (le document n'a plus le focus) ne valide
              rien, et un champ encore vide non plus — seuls Entrée, un texte
              saisi puis un clic ailleurs dans la page, ou « passer » terminent. */}
          <input ref={refInput} autoFocus defaultValue={paid.reference || ''} className={`${inputXs} w-44 shrink-0`}
            title={`${refSpec.refLabel} — la ligne attend : tu peux aller chercher le numéro dans un autre onglet`}
            data-testid={`schedule-reference-${item.id}`}
            onBlur={e => {
              if (document.hidden || !document.hasFocus()) return
              if (!e.target.value.trim()) return
              finishReference(e.target.value)
            }}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.preventDefault(); finishReference('') }
              if (e.key === 'Enter') { e.preventDefault(); finishReference(e.target.value) }
            }} />
          <span className="text-[11px] leading-snug text-slate-500">
            {refSpec.refLabel} — la ligne attend, même si tu changes d'onglet.
          </span>
          <button type="button" className="shrink-0 text-[11px] text-slate-400 hover:text-slate-700 hover:underline"
            data-testid={`schedule-reference-skip-${item.id}`}
            title="Terminer sans référence — le paiement reste créé"
            onMouseDown={e => e.preventDefault()}
            onClick={() => finishReference('')}>
            Sans référence
          </button>
          <button type="button" className="shrink-0 text-[11px] text-rose-600 hover:underline"
            data-testid={`schedule-undo-${item.id}`}
            onMouseDown={e => e.preventDefault()}
            onClick={async () => {
              setPaid(null)
              setBusy(true)
              try {
                const out = await api.treasury.schedule.unpay(item.id)
                if (out?.warning) addToast({ message: out.warning, type: 'error', duration: 12000 })
              }
              catch (e) { addToast({ message: e.message, type: 'error' }) }
              finally { setBusy(false); onChanged() }
            }}>
            Annuler
          </button>
        </span>
      ) : (
        <>
          <select value={item.account} onChange={e => setAccount(e.target.value)} className={`${inputXs} w-40 shrink-0`}
            data-testid={`schedule-account-${item.id}`}
            title="Compte débité — une carte fait monter le solde projeté de la carte">
            {accounts.map(a => <option key={a.name} value={a.name}>{a.name}</option>)}
          </select>
          {item.account === cardAccount && (
            <CreditCard size={13} className="shrink-0 text-amber-500" title="Chargé sur la carte"
              data-testid={`schedule-on-card-${item.id}`} />
          )}
        </>
      )}

      <span className="shrink-0 w-28 text-right text-sm font-medium tabular-nums text-slate-800">
        {fmtCad(item.amount, item.currency)}
      </span>

      <VendorParticularites item={item} onChanged={onChanged} />
    </div>
  )
}

// Facture reportée : la raison s'enregistre au blur (autosave), la date de
// retour remet la facture dans la cédule ce jour-là.
function DeferredItem({ item, onChanged }) {
  const { addToast } = useToast()
  const [busy, setBusy] = useState(false)
  const save = async (patch) => {
    setBusy(true)
    try { await api.treasury.schedule.defer(item.id, { reason: item.defer_reason, defer_until: item.defer_until, ...patch }) }
    catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setBusy(false); onChanged() }
  }
  const resume = async () => {
    setBusy(true)
    try { await api.treasury.schedule.resume(item.id); onChanged() }
    catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setBusy(false) }
  }
  return (
    <div className={`flex flex-wrap items-center gap-2 px-3 py-2 border-t border-slate-100 ${busy ? 'opacity-60' : ''}`}
      data-testid={`schedule-deferred-${item.id}`}>
      <span className="min-w-0 flex-1 flex items-center gap-1.5 text-sm text-slate-700 truncate">
        <span className="font-medium truncate"><VendorHover variant="payment" name={item.vendor}>{item.vendor}</VendorHover></span>
        <span className="text-slate-400">·</span>
        <BillLink item={item} onChanged={onChanged} />
        <span className="shrink-0 text-slate-400">· échéance {fmtDay(item.due_date)}</span>
      </span>
      <input defaultValue={item.defer_reason || ''}
        className={`${inputXs} flex-1 min-w-48`} data-testid={`schedule-reason-${item.id}`}
        onBlur={e => { if ((e.target.value || '') !== (item.defer_reason || '')) save({ reason: e.target.value }) }} />
      <input type="date" defaultValue={item.defer_until || ''} className={`${inputXs} w-36`}
        title="Revient dans la cédule à cette date" data-testid={`schedule-until-${item.id}`}
        onBlur={e => { if ((e.target.value || '') !== (item.defer_until || '')) save({ defer_until: e.target.value || null }) }} />
      <span className="shrink-0 w-28 text-right text-sm tabular-nums text-slate-600">{fmtCad(item.amount, item.currency)}</span>
      <button type="button" onClick={resume} disabled={busy} data-testid={`schedule-resume-${item.id}`}
        className="shrink-0 inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md text-slate-400 hover:text-brand-700 hover:bg-brand-50"
        title="Remettre dans la cédule">
        <RotateCcw size={12} /> Reprendre
      </button>
    </div>
  )
}

// ── Cartes de crédit à payer ─────────────────────────────────────────────────
// Les deux Visa se paient vers le 25 et leur solde n'arrive par aucun canal
// automatique : le montant se saisit ici. Une ligne sans montant est normale —
// c'est un rappel, pas une dette chiffrée — d'où l'absence de total et le
// bouton désactivé tant que rien n'est saisi.
function CardDueRow({ due, onChanged, onPaid }) {
  const { addToast } = useToast()
  const [busy, setBusy] = useState(false)
  // Paiement qui vient d'être créé, en attente de son n° de confirmation : la
  // banque ne le donne qu'APRÈS le paiement. La ligne reste donc affichée le
  // temps de le saisir — même comportement que pour une facture fournisseur.
  const [paid, setPaid] = useState(null)
  const refInput = useRef(null)
  const [amount, setAmount] = useState(due.amount == null ? '' : String(due.amount))
  // Date proposée : le dernier jour de l'échéance, reculé au jour ouvrable
  // précédent si le 25 tombe un week-end ou un férié (même règle que le
  // formulaire de paiement).
  const suggested = payDateForDue(due.due_date).date
  const [date, setDate] = useState(due.payment_date || suggested)

  const save = async (patch) => {
    setBusy(true)
    try { await api.treasury.cardDues.update(due.id, patch) }
    catch (e) { addToast({ message: e.message, type: 'error' }); onChanged() }
    finally { setBusy(false) }
  }

  const value = Number(String(amount).replace(/\s/g, '').replace(',', '.'))
  const entered = String(amount).trim() !== '' && Number.isFinite(value) && value >= 0
  // Zéro = la carte n'a pas servi ce mois-ci. Rien n'est émis, le mois est
  // simplement classé — d'où un bouton qui dit autre chose.
  const nothingToPay = entered && value === 0

  const pay = async () => {
    setBusy(true)
    try {
      const out = await api.treasury.cardDues.pay(due.id, { amount: value, payment_date: date })
      if (nothingToPay) {
        addToast({
          message: `${due.label} — aucune dépense ce mois-ci, classée`,
          type: 'success',
          duration: 12000,
          action: {
            label: 'Annuler',
            onClick: () => api.treasury.cardDues.restore(due.id)
              .then(() => { addToast({ message: `${due.label} — remis dans la cédule`, type: 'info' }); onChanged() })
              .catch(e => addToast({ message: e.message, type: 'error' })),
          },
        })
        onChanged()
        return
      }
      // Un paiement a été émis : la ligne ne quitte la cédule qu'une fois le
      // n° de confirmation saisi (ou explicitement passé). Le fil, lui, le
      // montre tout de suite en vol.
      setPaid(out?.payment || out)
      onPaid?.()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setBusy(false) }
  }

  // Fin de la saisie : le numéro part sur le paiement créé (autosave), puis la
  // ligne quitte la cédule.
  const finishReference = async (value_) => {
    const payment = paid
    if (!payment) return
    const ref = String(value_ || '').trim()
    setPaid(null)
    setBusy(true)
    try {
      if (ref) await api.treasury.payments.update(payment.id, { reference: ref })
      addToast({
        message: `${due.label} — paiement créé${ref ? ` · n° ${ref}` : ''}, il est dans « À passer à la banque »`,
        type: 'success',
        duration: 12000,
        action: {
          label: 'Annuler',
          onClick: () => api.treasury.cardDues.unpay(due.id)
            .then(() => { addToast({ message: `${due.label} — remis dans la cédule`, type: 'info' }); onChanged() })
            .catch(e => addToast({ message: e.message, type: 'error' })),
        },
      })
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setBusy(false); onChanged() }
  }

  // Retour d'onglet : le curseur revient dans le champ du n°.
  useEffect(() => {
    if (!paid) return undefined
    const refocus = () => { if (!document.hidden) refInput.current?.focus() }
    window.addEventListener('focus', refocus)
    document.addEventListener('visibilitychange', refocus)
    return () => {
      window.removeEventListener('focus', refocus)
      document.removeEventListener('visibilitychange', refocus)
    }
  }, [paid])

  const dismiss = async () => {
    setBusy(true)
    try { await api.treasury.cardDues.dismiss(due.id); onChanged() }
    catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setBusy(false) }
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 px-3 py-2 border-t border-slate-100 ${busy ? 'opacity-60' : ''}`}
      data-testid={`card-due-${due.id}`}>
      {paid ? (
        <span className="shrink-0 inline-flex items-center gap-1.5 w-32 justify-center px-2 py-1.5 text-xs font-medium rounded-full border border-emerald-200 bg-emerald-100 text-emerald-700"
          data-testid={`card-due-paid-${due.id}`}>
          <CheckCircle2 size={13} /> Payé
        </span>
      ) : (
      <button type="button" onClick={pay} disabled={busy || !entered}
        data-testid={`card-due-pay-${due.id}`}
        className="shrink-0 inline-flex items-center gap-1.5 w-32 justify-center px-2 py-1.5 text-xs font-medium rounded-full border border-slate-200 bg-white text-slate-500 transition-colors hover:border-emerald-300 hover:text-emerald-700 disabled:opacity-40 disabled:hover:border-slate-200 disabled:hover:text-slate-500"
        title={nothingToPay
          ? "Aucune dépense ce mois-ci : rien n'est émis, la carte revient le mois prochain."
          : entered
            ? "Ne cocher qu'une fois le paiement réellement fait : la ligne passe dans « À passer à la banque »."
            : 'Saisir le solde de la carte (0 si elle n’a pas servi)'}>
        <Circle size={13} /> {nothingToPay ? 'Rien à payer' : "J'ai payé"}
      </button>
      )}

      <span className="min-w-0 flex-1 flex items-center gap-1.5">
        <CreditCard size={13} className="shrink-0 text-slate-400" />
        <span className="font-medium text-sm text-slate-800">{due.label}</span>
        <span className="text-[11px] text-slate-400 truncate">{due.card_account} → payée du {due.pay_account}</span>
      </span>

      <span className="shrink-0 text-xs tabular-nums text-slate-500">échéance le {fmtDay(due.due_date)}</span>

      {paid ? (
        <span className="flex-1 min-w-48 flex items-center gap-2" data-testid={`card-due-reference-row-${due.id}`}>
          {/* Le n° se lit sur le site de la banque : quitter l'onglet ou
              cliquer ailleurs sans rien avoir tapé ne ferme pas la ligne. */}
          <input ref={refInput} autoFocus defaultValue="" className={`${inputXs} w-44 shrink-0`} title="N° de confirmation donné par la banque"
            data-testid={`card-due-reference-${due.id}`}
            onBlur={e => {
              if (document.hidden || !document.hasFocus()) return
              if (!e.target.value.trim()) return
              finishReference(e.target.value)
            }}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.preventDefault(); finishReference('') }
              if (e.key === 'Enter') { e.preventDefault(); finishReference(e.target.value) }
            }} />
          <span className="text-[11px] leading-snug text-slate-500">N° de confirmation — la ligne attend</span>
          <button type="button" className="shrink-0 text-[11px] text-slate-400 hover:text-slate-700 hover:underline"
            data-testid={`card-due-reference-skip-${due.id}`}
            onMouseDown={e => e.preventDefault()}
            onClick={() => finishReference('')}>
            Sans n°
          </button>
        </span>
      ) : (
      <input type="date" value={date} className={`${inputXs} w-36 shrink-0`}
        data-testid={`card-due-date-${due.id}`} title="Date du paiement"
        onChange={e => setDate(e.target.value)}
        onBlur={e => { if (e.target.value !== (due.payment_date || '')) save({ payment_date: e.target.value }) }} />
      )}

      {!paid && (
      <span className="flex items-center gap-1 shrink-0">
        <input inputMode="decimal" value={amount}
          className={`${inputXs} w-28 text-right tabular-nums font-medium`}
          data-testid={`card-due-amount-${due.id}`}
          title="Solde à payer, relevé sur le compte de la carte — 0 si la carte n’a pas servi ce mois-ci"
          onChange={e => setAmount(e.target.value)}
          onBlur={() => { if (String(due.amount ?? '') !== String(entered ? value : '')) save({ amount: entered ? value : null }) }} />
        <span className="w-8 text-[11px] text-slate-400">{due.currency}</span>
      </span>
      )}

      {!paid && (
      <button type="button" onClick={dismiss} disabled={busy} data-testid={`card-due-dismiss-${due.id}`}
        className="shrink-0 p-1 rounded-md text-slate-300 hover:text-slate-600 hover:bg-slate-100"
        title="Rien à payer ce mois-ci — la carte reviendra le mois prochain">
        <X size={13} />
      </button>
      )}
    </div>
  )
}

function Section({ title, count, total, children, defaultOpen = true, testId, hint }) {
  const [open, setOpen] = useState(defaultOpen)
  if (!count) return null
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden" data-testid={testId}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-slate-50/70 text-left">
        <ChevronRight size={14} className={`text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="text-sm font-semibold text-slate-800">{title}</span>
        <span className="text-xs text-slate-400">({count})</span>
        {hint && <span className="text-[11px] text-slate-400 truncate">{hint}</span>}
        {total != null && <span className="ml-auto text-sm tabular-nums text-slate-600">{fmtCad(total)}</span>}
      </button>
      {open && children}
    </div>
  )
}

export default function PaymentSchedule({ onChanged }) {
  const { addToast } = useToast()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [accounts, setAccounts] = useState([])
  // Compte à débiter choisi à l'écran pour une facture pas encore payée : une
  // intention, pas encore un paiement — mais elle doit peser tout de suite sur
  // la projection de la carte, sinon l'alerte arrive après coup.
  const [accountOverride, setAccountOverride] = useState({})

  const load = useCallback(() => {
    setLoading(true)
    api.treasury.schedule.get()
      .then(setData)
      .catch(e => addToast({ message: e.message, type: 'error' }))
      .finally(() => setLoading(false))
  }, [addToast])
  useEffect(() => { load() }, [load])
  // Un paiement créé ou annulé ici doit apparaître tout de suite dans le fil
  // de la page (« en vol »), pas au prochain rechargement.
  const changed = useCallback(() => { load(); onChanged?.() }, [load, onChanged])

  useEffect(() => {
    api.bank.accounts()
      .then(a => setAccounts(a.filter(x => x.active !== 0).map(x => ({ name: x.name, kind: x.kind, currency: x.currency }))))
      .catch(() => setAccounts([]))
  }, [])

  const withOverride = useCallback(
    it => (accountOverride[it.id] && !it.paid ? { ...it, account: accountOverride[it.id] } : it),
    [accountOverride],
  )

  const vendors = useMemo(
    () => (data?.vendors || []).map(g => ({ ...g, items: g.items.map(withOverride) })),
    [data, withOverride],
  )

  // Le nom du compte de carte sert encore à signaler la ligne chargée sur la
  // carte ; sa projection ne s'affiche plus ici.
  const cardAccount = data?.mastercard?.account

  if (loading && !data) return <p className="py-8 text-center text-sm text-slate-400">Chargement de la cédule…</p>
  if (!data) return null

  const { week, totals, counts, today } = data

  return (
    <div className="space-y-4" data-testid="schedule-view">
      {/* Cartes de crédit : à côté des factures fournisseurs, pas dedans — elles
          n'ont ni fournisseur, ni échéance négociable, et leur montant se
          saisit à la main. */}
      {data.cards?.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden" data-testid="schedule-cards">
          <div className="px-3 py-2.5 border-b border-slate-100 bg-slate-50/70 flex items-center gap-2">
            <CreditCard size={15} className="text-brand-600" />
            <h3 className="text-sm font-semibold text-slate-800">Cartes de crédit à payer</h3>
            <span className="text-[11px] text-slate-400">
              Le solde n'est pas récupéré automatiquement — le saisir depuis le compte de la carte.
            </span>
          </div>
          {data.cards.map(c => <CardDueRow key={c.id} due={c} onChanged={changed} onPaid={onChanged} />)}
        </div>
      )}

      {/* La cédule elle-même : un bloc par fournisseur, échéance la plus proche
          en tête, ses factures dessous. */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden" data-testid="schedule-vendors">
        <div className="px-3 py-2.5 border-b border-slate-100 bg-slate-50/70">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
              <ReceiptText size={15} className="text-brand-600" /> À payer cette semaine
            </h3>
            <span className="text-xs text-slate-400">
              Cocher crée le paiement du jour dans « À passer à la banque ».
            </span>
          </div>
          {/* La règle du cycle, écrite noir sur blanc : c'est elle qui décide ce
              qui est dans la liste et ce qui attend la séance suivante. */}
          <p className="mt-1 text-[11px] leading-snug text-slate-500" data-testid="schedule-window-explainer">
            {week.off_session ? (
              <>Hors séance : seulement ce qui ne peut pas attendre le <strong className="font-medium text-slate-600">{fmtWeekday(week.pay_day)}</strong>
              {' '}(échéance jusqu'au {fmtWeekday(week.end)} inclus).</>
            ) : (
              <>Séance du <strong className="font-medium text-slate-600">{fmtWeekday(week.pay_day)}</strong> :
              {' '}échéances jusqu'au <strong className="font-medium text-slate-600">{fmtWeekday(week.end)}</strong> inclus
              {' '}— payé ce soir, passé demain.</>
            )}
          </p>
        </div>
        {vendors.map(g => (
          <div key={g.key} data-testid={`schedule-vendor-${g.key}`}>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-50/50 border-t border-slate-100">
              <span className="text-sm font-medium text-slate-700 truncate"><VendorHover variant="payment" name={g.vendor}>{g.vendor}</VendorHover></span>
              <span className="text-[11px] text-slate-400">{g.items.length} facture{g.items.length > 1 ? 's' : ''}</span>
              <span className="ml-auto text-sm tabular-nums text-slate-600">
                {fmtCad(g.total_cad)}
                {Object.entries(g.currencies).map(([c, v]) => <span key={c}> · {fmtCad(v, c)}</span>)}
              </span>
            </div>
            {g.items.map(it => (
              <ScheduleItem key={it.id} item={it} accounts={accounts} cardAccount={cardAccount} today={today}
                onChanged={changed} onPaid={onChanged} onAccountChange={(id, v) => setAccountOverride(o => ({ ...o, [id]: v }))} />
            ))}
          </div>
        ))}
        {!vendors.length && (
          <p className="py-6 px-3 text-center text-sm text-slate-400">
            Rien à payer d'ici le {fmtWeekday(week.end)} — la séance du {fmtWeekday(week.pay_day)} est à jour.
          </p>
        )}
      </div>

      {/* Pas de section « déjà payées » ici : une facture réglée quitte la
          cédule et sa suite se joue dans « À passer à la banque ». Un seul
          endroit par état — la répéter ici ne ferait que rallonger la page. */}

      {/* Sorties récurrentes de la semaine : elles tombent toutes seules, mais
          elles grèvent le même solde — les cacher fausserait la décision. */}
      <Section title="Sorties récurrentes de la semaine" count={data.recurring.length}
        total={totals.recurring_week} testId="schedule-recurring-list"
        hint="prélevées automatiquement — déjà déduites du solde après cédule">
        {data.recurring.map(o => (
          <div key={`${o.id}-${o.date}`} className="flex items-center gap-2 px-3 py-2 border-t border-slate-100 text-sm">
            <Clock size={13} className="text-slate-300 shrink-0" />
            <span className="text-slate-700">{o.label}</span>
            {!!o.variable_amount && <span className="text-[11px] text-amber-600">montant variable</span>}
            <span className="ml-auto text-xs text-slate-400">le {fmtDay(o.date)}</span>
            <span className="w-28 text-right tabular-nums text-slate-600">{fmtCad(o.amount)}</span>
          </div>
        ))}
      </Section>

      <Section title="Reportés" count={counts.deferred} total={totals.deferred_cad}
        testId="schedule-deferred-list" hint="hors cédule tant qu'ils ne sont pas repris">
        {data.deferred.map(it => <DeferredItem key={it.id} item={it} onChanged={load} />)}
      </Section>

      <Section title="Plus tard" count={counts.later} total={totals.later_cad} defaultOpen={false}
        testId="schedule-later-list" hint={`échéance à partir du ${fmtWeekday(week.cutoff)} — séance suivante`}>
        {data.later.flatMap(g => g.items).map(it => (
          <div key={it.id} className="flex items-center gap-2 px-3 py-2 border-t border-slate-100 text-sm"
            data-testid={`schedule-later-${it.id}`}>
            <span className="text-slate-700 truncate"><VendorHover variant="payment" name={it.vendor}>{it.vendor}</VendorHover></span>
            <BillLink item={it} />
            <span className="ml-auto text-xs text-slate-400">le {fmtDay(it.due_date)}</span>
            <span className="w-28 text-right tabular-nums text-slate-600">{fmtCad(it.amount, it.currency)}</span>
          </div>
        ))}
      </Section>

      {/* Retirées de la proposition : jamais en silence — c'est ce filtre qui
          empêche de payer deux fois la même dépense. */}
      <Section title="Retirées de la cédule" count={counts.excluded} defaultOpen={false}
        testId="schedule-excluded-list" hint="déjà couvertes ailleurs">
        {data.excluded.map(e => (
          <div key={e.id} className="flex items-start gap-2 px-3 py-2 border-t border-slate-100 text-sm">
            <EyeOff size={13} className="text-slate-300 shrink-0 mt-0.5" />
            <span className="min-w-0">
              <span className="text-slate-700"><VendorHover variant="payment" name={e.vendor}>{e.vendor}</VendorHover></span>
              <span className="text-slate-400"> — {e.detail}</span>
            </span>
            <span className="ml-auto w-28 text-right tabular-nums text-slate-500">{fmtCad(e.amount, e.currency)}</span>
          </div>
        ))}
      </Section>
    </div>
  )
}
