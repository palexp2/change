// Paiements et virements ÉMIS — remplace l'onglet « Pmt_Suivi » du fichier
// CTB - Suivi (une ligne par paiement, colonne Montant coloriée en vert quand
// c'est passé à la banque).
//
// À ne pas confondre avec /paiements (encaissements clients) : ici c'est
// l'argent qui SORT (ou les renflouements qui entrent au BNC).
//
// Le trou que cette page comble : entre « la facture est payée » et « l'argent est
// sorti du compte », il se passe des jours. Un virement Interac émis le samedi,
// un chèque post-daté, un renflouement Venn → BNC n'existaient nulle part dans
// l'ERP — une facture marquée « Payée » disparaissait de la projection alors que
// l'argent était encore au compte.
//
// Une seule case porte tout le sens : « passé à la banque ». Tant qu'elle est
// vide, le paiement pèse sur la projection du solde BNC. Elle se coche toute
// seule quand la transaction est retrouvée au relevé (et demain via Plaid).
//
// La saisie est guidée par le MOYEN de paiement : les informations utiles ne sont
// pas les mêmes pour un Interac (bénéficiaire + courriel + n° de confirmation),
// un transfert entre comptes (deux comptes, aucun bénéficiaire externe), un
// chèque (à l'ordre de + n° de chèque) ou un code de paiement gouvernemental.
// Un formulaire unique demandait donc soit trop, soit pas assez — et surtout ne
// disait jamais d'où l'argent sortait.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Plus, Trash2, Landmark, RefreshCw, History, Copy, ArrowRight, MoreHorizontal,
  CheckCircle2, Circle, AlertTriangle, ReceiptText, X, Search, ChevronDown, ExternalLink,
} from 'lucide-react'
import api from '../lib/api.js'
import { payDateForDue } from '../lib/bankDays.js'
// Les moyens de paiement (et les libellés qu'ils commandent) vivent à part :
// la cédule « À payer » s'en sert aussi pour nommer la référence à saisir.
import { METHOD_SPECS, METHOD_ORDER, spec } from '../lib/paymentMethods.js'
import { Layout } from '../components/Layout.jsx'
import PaymentSchedule from '../components/PaymentSchedule.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { formatRelativeTime } from '../utils/formatters.js'

const fmtCad = (n, currency = 'CAD') =>
  new Intl.NumberFormat('fr-CA', { style: 'currency', currency: currency || 'CAD' }).format(Number(n) || 0)
// Montant éditable de la liste : lisible (séparateurs de milliers, 2 décimales)
// sans symbole — parseAmount sait relire cette forme au blur.
const fmtNum = n => new Intl.NumberFormat('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0)
const fmtDay = d => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
// Avec le jour de la semaine : c'est lui qui explique une date de paiement
// avancée (« l'échéance tombe un samedi »).
const fmtDayLong = d => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '—')
const weekdayName = d => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('fr-CA', { weekday: 'long' }) : '')
const todayIso = () => new Date().toLocaleDateString('en-CA')
const parseAmount = v => Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'))

// Seul compte réellement projeté : c'est lui qui décide du sens d'un mouvement
// interne (un transfert qui l'alimente est une ENTRÉE, sinon une sortie).
const PROJECTED_ACCOUNT = 'BNC CAD'


// Comptes de repli si /bank/accounts ne répond pas : la saisie ne doit jamais
// être bloquée par l'indisponibilité de la liste des comptes.
const FALLBACK_ACCOUNTS = [
  { name: 'BNC CAD', kind: 'bank', currency: 'CAD' },
  { name: 'BNC USD', kind: 'bank', currency: 'USD' },
  { name: 'BNC Épargne', kind: 'bank', currency: 'CAD' },
  { name: 'Venn CAD', kind: 'bank', currency: 'CAD' },
  { name: 'Venn USD', kind: 'bank', currency: 'USD' },
  { name: 'Desjardins CAD', kind: 'bank', currency: 'CAD' },
  { name: 'MasterCard BNC', kind: 'card', currency: 'CAD' },
]

const inputCls = 'px-2 py-1 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400'
// Variante compacte pour les détails d'un paiement (panneau replié).
const inputXs = 'px-1.5 py-1 text-xs border border-slate-200 rounded-md w-full focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400'
// Champ de la liste : sans bordure tant qu'on ne le survole pas — la ligne se lit
// comme du texte, pas comme un formulaire (une liste de 60 paiements ne doit pas
// afficher 300 rectangles).
const cellCls = 'px-1.5 py-1 text-sm bg-transparent border border-transparent rounded-md hover:border-slate-200 focus:bg-white focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20'
const stepCls = 'text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2'

// Clé de rapprochement des noms de fournisseurs (même normalisation que côté
// serveur) : « Les Jardins d'Inverness » et « les jardins d inverness » = pareil.
const vendorKey = s => String(s || '')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '')

// Échéance d'une facture ouverte : la date d'achat sert de repli quand elle n'a
// pas d'échéance saisie (« payable à réception »).
const billDue = b => String(b?.due_date || b?.date_achat || '').slice(0, 10)

// Vue « De → Vers » d'un paiement stocké : `account` ne porte que le côté projeté,
// donc les deux côtés se lisent différemment selon le sens.
const transferSides = p => (p.direction === 'in'
  ? { from: p.counterparty_account || '', to: p.account || '' }
  : { from: p.account || '', to: p.counterparty_account || '' })

const accountOptions = (accounts, kind) => accounts
  .filter(a => !kind || kind === 'any' || a.kind === kind)
  .map(a => ({ value: a.name, label: a.name }))

// Champ étiqueté. `as="div"` pour les selects recherchables (un <label> autour du
// bouton du portail le rouvrirait au clic sur l'étiquette).
function Field({ label, hint, className = '', as = 'label', children }) {
  const Tag = as
  return (
    <Tag className={`block ${className}`}>
      <span className="block text-xs font-medium text-slate-600 mb-1">{label}</span>
      {children}
      {hint && <span className="block mt-1 text-[11px] leading-snug text-slate-400">{hint}</span>}
    </Tag>
  )
}

// Ligne éditable en autosave : chaque champ se sauvegarde au blur (règle de
// design ERP — aucun bouton « Enregistrer »).
//
// UNE ligne = une phrase lisible : statut · date · bénéficiaire · moyen · compte
// · montant. Tout le reste (sens, contrepartie, n° de confirmation, facture,
// note) est de la donnée de SAISIE, pas de LECTURE : elle vit derrière le
// chevron. Le bouton « passé à la banque » — l'action de la page — reste en tête
// de ligne, toujours au même endroit.
function PaymentRow({ p, accounts, onChanged, onReuse, particularites }) {
  const { addToast } = useToast()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const sp = spec(p.method)
  const save = async (field, value) => {
    if (String(p[field] ?? '') === String(value ?? '')) return
    setBusy(true)
    try { await api.treasury.payments.update(p.id, { [field]: value }); onChanged() }
    catch (e) { addToast({ message: e.message, type: 'error' }); onChanged() }
    finally { setBusy(false) }
  }
  const toggleCleared = async () => {
    setBusy(true)
    try { await api.treasury.payments.setCleared(p.id, !p.cleared_at); onChanged() }
    catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setBusy(false) }
  }
  const remove = async () => {
    setBusy(true)
    try { await api.treasury.payments.delete(p.id); onChanged() }
    catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setBusy(false) }
  }
  const cleared = !!p.cleared_at
  // Facture réglée avant son échéance et pas encore passée à la banque : à
  // vérifier. Rien d'anormal en soi (on paie parfois d'avance), mais c'est la
  // signature du clic accidentel dans la cédule.
  const notYetDue = !cleared && !!p.achat_due_date && p.achat_due_date > todayIso()
  // L'autre compte n'a de sens que pour un mouvement interne — on le montre aussi
  // dès qu'il est renseigné, pour ne jamais cacher une donnée existante.
  const showCounterparty = sp.transfer || !!p.counterparty_account
  const MethodIcon = sp.icon
  const sides = transferSides(p)
  return (
    <div className={`group border-t border-slate-100 ${busy ? 'opacity-60' : ''} ${cleared ? 'bg-emerald-50/30' : ''}`}
      data-testid={`payment-row-${p.id}`}>
      <div className="flex items-center gap-1.5 px-3 py-1">
        {/* Le bouton porte tout le sens de la page : coché = l'argent est sorti
            du compte, plus rien à projeter. Re-cliquer le remet dans la projection. */}
        <button type="button" onClick={toggleCleared} aria-pressed={cleared}
          data-testid={`payment-cleared-${p.id}`}
          className={`shrink-0 inline-flex items-center gap-1.5 w-24 justify-center px-2 py-1 text-xs font-medium rounded-full border transition-colors ${cleared
            ? 'border-emerald-200 bg-emerald-100 text-emerald-700 hover:bg-emerald-200/70'
            : 'border-slate-200 bg-white text-slate-500 hover:border-emerald-300 hover:text-emerald-700'}`}
          title={cleared
            ? `Passé à la banque${p.cleared_source === 'qb'
              ? ' · détecté dans QuickBooks (écriture compensée au compte bancaire)'
              : p.cleared_source === 'sheet'
                ? ' · coché automatiquement (retiré du fichier « Maintien du solde disponible BNC »)'
                : p.cleared_source === 'bank' || p.bank_txn_date
                  ? ` · apparié au relevé${p.bank_txn_date ? ` du ${fmtDay(p.bank_txn_date)}` : ''}`
                  : ''} — cliquer pour le remettre dans la projection`
            : 'Pas encore passé à la banque — compté dans la projection. Coché automatiquement dès que QuickBooks montre le mouvement au compte (ou que la ligne quitte le fichier de suivi) ; cliquer pour le faire à la main.'}>
          {cleared ? <CheckCircle2 size={13} className="shrink-0" /> : <Circle size={13} className="shrink-0" />}
          {/* Libellé unique « A passé », comme une case à cocher : c'est l'icône
              (cercle vide / crochet vert) et la couleur qui portent l'état, pas le
              texte. Le titre détaille l'état et la source du cochage. */}
          A passé
        </button>

        <input type="date" defaultValue={String(p.payment_date).slice(0, 10)}
          className={`${cellCls} w-32 shrink-0 text-slate-500 tabular-nums`}
          title={sp.dateLabel} onBlur={e => save('payment_date', e.target.value)} />

        <span className="flex-1 min-w-0 flex items-center gap-1.5">
          <input defaultValue={p.label || ''} className={`${cellCls} flex-1 min-w-0 font-medium text-slate-800`}
            placeholder="Fournisseur / libellé" onBlur={e => save('label', e.target.value)} />
          {/* Particularité du fournisseur : signalée tant que le paiement n'est pas
              passé — c'est en l'émettant qu'il ne faut pas l'oublier. */}
          {!cleared && particularites && (
            <span className="shrink-0 text-amber-500" title={particularites}
              data-testid={`payment-particularites-${p.id}`}>
              <AlertTriangle size={13} />
              <span className="sr-only">{particularites}</span>
            </span>
          )}
          {/* Paiement émis pour une facture qui n'est pas encore due : symptôme
              d'un faux clic dans la cédule. La facture ayant quitté la cédule,
              c'est ici — et nulle part ailleurs — que l'erreur peut se voir
              avant que la facture ne soit jamais payée. */}
          {notYetDue && (
            <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-amber-300 bg-amber-50 text-[11px] text-amber-800"
              data-testid={`payment-not-due-${p.id}`}
              title={`La facture n'est due que le ${fmtDay(p.achat_due_date)}. Si elle n'a pas encore été payée, la retirer d'ici : elle reviendra dans « À payer (cédule) ».`}>
              <AlertTriangle size={12} /> pas due avant le {fmtDay(p.achat_due_date)}
            </span>
          )}
        </span>

        {/* Moyen et compte : en lecture seule ici, éditables dans le détail — ce
            sont des repères, pas des champs qu'on retouche à chaque ligne. */}
        <span className="hidden lg:flex w-36 shrink-0 items-center gap-1.5 text-xs text-slate-400" title={sp.label}>
          <MethodIcon size={13} className="shrink-0" /><span className="truncate">{sp.label}</span>
        </span>
        <span className="hidden xl:block w-40 shrink-0 truncate text-xs text-slate-400"
          title={showCounterparty ? `${sides.from} → ${sides.to}` : `Compte : ${p.account || PROJECTED_ACCOUNT}`}>
          {showCounterparty ? `${sides.from} → ${sides.to}` : (p.account || PROJECTED_ACCOUNT)}
        </span>

        <span className="flex items-center gap-1 shrink-0">
          <input inputMode="decimal" defaultValue={fmtNum(p.amount)}
            className={`${cellCls} w-28 text-right tabular-nums font-medium ${p.direction === 'in' ? 'text-emerald-700' : 'text-slate-800'}`}
            title="Montant" onBlur={e => save('amount', parseAmount(e.target.value))} />
          <span className="w-8 text-[11px] text-slate-400">{(p.currency || 'CAD') !== 'CAD' ? p.currency : ''}</span>
        </span>

        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          data-testid={`payment-expand-${p.id}`}
          className={`shrink-0 p-1 rounded-md text-slate-300 hover:text-slate-600 hover:bg-slate-100 ${open ? 'text-slate-600' : ''}`}
          title={open ? 'Masquer le détail' : 'Détail : sens, comptes, références, note'}>
          <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {/* Actions rares : révélées au survol de la ligne, jamais dans le chemin
            du regard. */}
        <span className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <button onClick={() => onReuse(p)} className="text-slate-300 hover:text-brand-600 p-1"
            data-testid={`payment-reuse-${p.id}`}
            title="Refaire ce paiement — recopie tout sauf la date, le montant et les n° de confirmation">
            <Copy size={14} />
          </button>
          <button onClick={remove} className="text-slate-300 hover:text-rose-600 p-1" title="Supprimer">
            <Trash2 size={14} />
          </button>
        </span>
      </div>

      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-slate-100 bg-slate-50/60" data-testid={`payment-details-${p.id}`}>
          <div className="grid gap-x-3 gap-y-2 grid-cols-2 md:grid-cols-4">
            <Field as="div" label="Moyen de paiement">
              <select defaultValue={p.method || 'autre'} className={inputXs}
                onChange={e => save('method', e.target.value)}>
                {METHOD_ORDER.map(m => <option key={m} value={m}>{METHOD_SPECS[m].label}</option>)}
              </select>
            </Field>
            <Field as="div" label="Sens du mouvement">
              <select defaultValue={p.direction} className={inputXs}
                onChange={e => save('direction', e.target.value)}>
                <option value="out">Sortie</option>
                <option value="in">Entrée</option>
              </select>
            </Field>
            <Field as="div" label="Compte touché">
              <select defaultValue={p.account || PROJECTED_ACCOUNT} className={inputXs}
                title={`Seul le ${PROJECTED_ACCOUNT} entre dans la projection du solde`}
                onChange={e => save('account', e.target.value)}>
                {accounts.map(a => <option key={a.name} value={a.name}>{a.name}</option>)}
              </select>
            </Field>
            {showCounterparty && (
              <Field as="div" label="Autre compte du mouvement">
                <select defaultValue={p.counterparty_account || ''} className={inputXs}
                  data-testid={`payment-counterparty-${p.id}`}
                  onChange={e => save('counterparty_account', e.target.value || null)}>
                  <option value="">— autre compte —</option>
                  {accounts.map(a => <option key={a.name} value={a.name}>{a.name}</option>)}
                </select>
              </Field>
            )}
            {/* Bénéficiaire réel : le courriel Interac ou le nom inscrit au chèque. */}
            {(sp.recipientLabel || p.recipient) && (
              <Field label={sp.recipientLabel || 'Bénéficiaire réel'}>
                <input defaultValue={p.recipient || ''} className={inputXs}
                  data-testid={`payment-recipient-${p.id}`}
                  onBlur={e => save('recipient', e.target.value.trim() || null)} />
              </Field>
            )}
            <Field label={sp.refLabel}>
              <input defaultValue={p.reference || ''} className={inputXs}
                title={sp.refLabel} data-testid={`payment-reference-${p.id}`}
                onBlur={e => save('reference', e.target.value)} />
            </Field>
            {/* Facture réglée — deux destinations, comme dans la cédule :
                l'icône ouvre la fiche DANS l'ERP (les factures fournisseurs n'ont
                pas de page dédiée : `?id=` ouvre la fiche depuis la liste des
                achats), le NUMÉRO ouvre la facture dans QuickBooks. Pas encore
                publiée à QB : le numéro reste du texte, avec la raison. */}
            <Field as="div" label="Facture réglée">
              {p.achat_id
                ? <span className="inline-flex items-center gap-1 min-w-0">
                  <Link to={`/fournisseurs/achats?id=${p.achat_id}`} className="shrink-0 p-0.5 rounded-md text-slate-300 hover:text-brand-600 hover:bg-brand-50"
                    data-testid={`payment-bill-link-${p.id}`}
                    title={`Facture ${p.achat_vendor || ''} ${p.achat_total ? fmtCad(p.achat_total, p.currency) : ''} · ${p.achat_status || ''} — ouvrir la fiche dans l'ERP`}>
                    <ReceiptText size={12} />
                  </Link>
                  {p.bill_qb_url
                    ? <a href={p.bill_qb_url} target="_blank" rel="noreferrer"
                      className="min-w-0 inline-flex items-center gap-1 text-xs text-brand-600 hover:underline"
                      data-testid={`payment-bill-qb-${p.id}`}
                      title="Ouvrir la facture dans QuickBooks">
                      <span className="truncate">{p.invoice_number || p.achat_vendor || 'facture liée'}</span>
                      <ExternalLink size={11} className="shrink-0 opacity-60" />
                    </a>
                    : <span className="min-w-0 truncate text-xs text-slate-500"
                      data-testid={`payment-bill-qb-${p.id}`}
                      title="Pas encore publiée dans QuickBooks — rien à ouvrir">
                      {p.invoice_number || p.achat_vendor || 'facture liée'}
                    </span>}
                </span>
                : <input defaultValue={p.invoice_number || ''} className={inputXs} placeholder="N° facture"
                  data-testid={`payment-invoice-${p.id}`}
                  onBlur={e => save('invoice_number', e.target.value.trim() || null)} />}
            </Field>
            {/* Note libre mémorisée sur le profil du fournisseur : elle sera
                re-proposée au prochain paiement à son nom. */}
            <Field label="Note" className="col-span-2">
              <input defaultValue={p.notes || ''} className={inputXs}
                data-testid={`payment-notes-${p.id}`}
                title="Mémorisée sur le profil du fournisseur et re-proposée au prochain paiement"
                onBlur={e => save('notes', e.target.value.trim() || null)} />
            </Field>
          </div>
          {(!cleared && particularites) && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-amber-700">
              <AlertTriangle size={12} className="shrink-0 mt-px" /> {particularites}
            </p>
          )}
          {/* Écriture QuickBooks qui a prouvé le passage à la banque : cliquable,
              c'est la pièce justificative du cochage automatique. */}
          {p.qb_url && (
            <a href={p.qb_url} target="_blank" rel="noreferrer"
              className="mt-2 inline-block text-xs text-brand-600 hover:underline"
              data-testid={`payment-qb-link-${p.id}`}
              title="Écriture QuickBooks appariée au compte bancaire — la preuve du passage">
              Voir l'écriture QuickBooks
            </a>
          )}
        </div>
      )}
    </div>
  )
}

// ── Détection QuickBooks : « ces mouvements sont passés à la banque » ────────
// Le grand livre QB marque chaque écriture compensée (appariée au flux
// bancaire) ou rapprochée : c'est la preuve que l'argent est sorti du compte.
// Les appariements sûrs (nom du tiers concordant) sont cochés tout seuls ; ce
// panneau ne montre QUE ce qui demande un arbitrage humain, avec l'écriture QB
// en regard et un lien vers elle. Rien n'est appliqué sans clic.
const QB_KIND = {
  payment: {
    title: 'Paiement à confirmer',
    hint: 'Montant et date concordent, mais le nom chez QuickBooks ne confirme pas le fournisseur.',
    action: 'Marquer passé',
  },
  duplicate: {
    title: 'Doublon probable',
    hint: "QuickBooks ne connaît qu'un seul mouvement de ce montant, et il est déjà marqué passé sur un autre paiement : celui-ci est la même sortie enregistrée deux fois.",
    action: 'Retirer de la projection',
  },
  bill: {
    title: 'Facture déjà payée à la banque',
    hint: 'QuickBooks a une écriture compensée à ce fournisseur et ce montant : la facture est réglée, elle peut quitter la liste « à payer ».',
    action: 'Marquer payée',
  },
}

// Quand il n'y a rien à arbitrer — le cas normal — ce panneau ne doit pas exister
// visuellement : une seule ligne discrète suffit à dire que la vérification tourne.
// Le grand encadré n'apparaît QUE quand QuickBooks demande un avis.
// Dernier passage de la sync automatique de l'onglet Pmt_Suivi (30 min).
// Même idiome que la ligne QuickBooks juste en dessous : une phrase grise qui
// dit que ça tourne tout seul. Elle vit SOUS le titre, pas dans la barre
// d'actions — à côté du bouton, elle le faisait passer pour du texte.
function SheetSyncStatus({ status }) {
  if (!status) return null
  const last = status.last_run
  const failed = last?.status === 'error'
  const every = status.interval_minutes || 30
  const label = status.active === false
    ? 'La relecture automatique de la feuille est désactivée — seul le bouton « Synchroniser la feuille » la relit'
    : (failed
      ? `Dernière relecture automatique de la feuille en échec : ${last.error || 'erreur inconnue'}`
      : `Feuille relue automatiquement toutes les ${every} min${last?.executed_at ? ` — à jour ${formatRelativeTime(last.executed_at)}` : ''}`)
  return (
    <div data-testid="payments-sheet-sync-status"
      title={last?.summary ? `Dernier passage : ${last.summary}` : undefined}
      className={`text-xs ${failed || status.active === false ? 'text-rose-600' : 'text-slate-400'}`}>
      {label}
    </div>
  )
}

function QbClearPanel({ candidates, lastRun, busy, onSync, onApply }) {
  const groups = useMemo(() => {
    const by = new Map()
    for (const c of candidates) {
      if (!by.has(c.kind)) by.set(c.kind, [])
      by.get(c.kind).push(c)
    }
    return [...by.entries()]
  }, [candidates])

  const syncBtn = (
    <button onClick={onSync} disabled={busy} data-testid="qb-clear-sync"
      className="shrink-0 inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-50"
      title="Relire le grand livre QuickBooks maintenant et cocher les paiements dont le passage à la banque est confirmé">
      <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
    </button>
  )

  if (!candidates.length) {
    return (
      <div className="flex items-center gap-1 text-xs text-slate-400" data-testid="qb-clear-panel">
        <span data-testid="qb-clear-empty">
          QuickBooks coche automatiquement les paiements passés à la banque — rien à confirmer
          {lastRun?.executed_at && ` · vérifié le ${fmtDay(lastRun.executed_at)}`}
          {lastRun?.status === 'error' && <span className="text-rose-600"> (échec : {lastRun.error})</span>}
        </span>
        {syncBtn}
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50/40 overflow-hidden" data-testid="qb-clear-panel">
      <div className="px-3.5 py-2 border-b border-sky-100 flex items-center gap-2">
        <Landmark size={15} className="text-sky-600 shrink-0" />
        <h2 className="text-sm font-semibold text-slate-800">
          <span data-testid="qb-clear-count">{candidates.length}</span> mouvement(s) à confirmer selon QuickBooks
        </h2>
        <span className="ml-auto flex items-center gap-1">
          {lastRun?.executed_at && (
            <span className="text-[11px] text-slate-400">vérifié le {fmtDay(lastRun.executed_at)}</span>
          )}
          {syncBtn}
        </span>
      </div>

      <div className="divide-y divide-sky-100">
        {groups.map(([kind, list]) => (
          <div key={kind} className="px-3.5 py-2.5">
            <div className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide"
              title={QB_KIND[kind]?.hint}>
              {QB_KIND[kind]?.title || kind}
            </div>
            <div className="mt-1.5 space-y-1.5">
              {list.map(c => (
                <div key={`${kind}-${c.payment_id || c.achat_id}`}
                  data-testid={`qb-candidate-${c.payment_id || c.achat_id}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-sky-100 bg-white px-2.5 py-2 text-sm">
                  <span className="font-medium text-slate-800 truncate max-w-56">{c.label || '—'}</span>
                  <span className="tabular-nums text-slate-700">{fmtCad(c.amount)}</span>
                  <span className="text-xs text-slate-400">{fmtDay(c.date)}</span>
                  <span className="text-xs text-slate-500 flex items-center gap-1">
                    <ArrowRight size={12} className="text-slate-300" />
                    QuickBooks : {c.qb?.type || 'écriture'} du {fmtDay(c.qb?.date)}
                    {c.qb?.name ? ` · ${c.qb.name}` : ''}
                    {c.qb?.status === 'R' ? ' · rapprochée' : ' · compensée'}
                  </span>
                  {c.qb?.url && (
                    <a href={c.qb.url} target="_blank" rel="noreferrer"
                      className="text-xs text-brand-600 hover:underline">Voir dans QuickBooks</a>
                  )}
                  {c.twin && (
                    <span className="text-xs text-amber-700">
                      déjà passé le {fmtDay(c.twin.date)} sur un autre paiement
                    </span>
                  )}
                  <button onClick={() => onApply(c)} disabled={busy}
                    data-testid={`qb-apply-${c.payment_id || c.achat_id}`}
                    className="ml-auto inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">
                    <CheckCircle2 size={12} /> {QB_KIND[kind]?.action || 'Appliquer'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// Factures fournisseurs encore à payer : cliquer sur une facture pré-remplit le
// formulaire de paiement (fournisseur, montant, n° de facture, lien achat_id).
// Le triangle ambre signale une particularité du profil fournisseur.
function OpenBillsPanel({ bills, particByKey, onPick }) {
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return bills
    return bills.filter(b =>
      `${b.vendor || ''} ${b.vendor_invoice_number || ''} ${b.bill_number || ''}`.toLowerCase().includes(needle))
  }, [bills, q])
  const today = todayIso()
  const totalCad = useMemo(() => bills
    .filter(b => (b.currency || 'CAD') === 'CAD')
    .reduce((s, b) => s + (Number(b.balance_due_cad ?? b.total_cad) || 0), 0), [bills])
  return (
    <div className="w-full xl:w-80 shrink-0 rounded-xl border border-slate-200 bg-white overflow-hidden flex flex-col"
      data-testid="open-bills-panel">
      <div className="px-3 py-2.5 border-b border-slate-100 bg-slate-50/70">
        <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-2"
          title="Choisir une facture pré-remplit le paiement à gauche et la retire de la liste une fois le paiement ajouté.">
          <ReceiptText size={15} className="text-brand-600" /> Factures à payer
          {!!bills.length && <span className="text-xs font-normal text-slate-400">({bills.length})</span>}
        </h2>
        {bills.length > 5 && (
          <span className="relative block mt-2">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Fournisseur, n° de facture…"
              className={`${inputCls} w-full pl-7`} data-testid="open-bills-search" />
          </span>
        )}
      </div>
      <div className="overflow-y-auto max-h-96" data-testid="open-bills-list">
        {filtered.map(b => {
          const partic = particByKey.get(vendorKey(b.vendor))
          const due = b.due_date || b.date_achat
          const overdue = due && String(due).slice(0, 10) < today
          return (
            <button key={b.id} type="button" onClick={() => onPick(b)} data-testid={`open-bill-${b.id}`}
              className="w-full text-left px-3 py-2 border-t border-slate-100 hover:bg-brand-50/50 transition-colors"
              title={partic ? `Particularité : ${partic}` : 'Pré-remplir un paiement pour cette facture'}>
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-slate-700 flex items-center gap-1.5">
                  {partic && <AlertTriangle size={13} className="shrink-0 text-amber-500" />}
                  {b.vendor || 'Sans fournisseur'}
                </span>
                <span className="shrink-0 text-sm tabular-nums text-slate-700">
                  {fmtCad(b.balance_due_cad ?? b.total_cad, b.currency)}
                </span>
              </span>
              <span className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-slate-400">
                <span className="truncate">{b.vendor_invoice_number || b.bill_number || 'sans n°'}</span>
                <span className={`shrink-0 ${overdue ? 'text-rose-600 font-medium' : ''}`}>
                  {due ? `échéance ${fmtDay(due)}` : 'sans échéance'}
                </span>
              </span>
            </button>
          )
        })}
        {!filtered.length && (
          <p className="px-3 py-5 text-center text-sm text-slate-400 border-t border-slate-100">
            {bills.length ? 'Aucune facture ne correspond à la recherche.' : 'Aucune facture à payer — tout est réglé.'}
          </p>
        )}
      </div>
      {!!bills.length && (
        <p className="px-3 py-2 border-t border-slate-100 bg-slate-50/70 text-xs text-slate-500">
          Solde à payer (CAD) : <span className="font-medium tabular-nums text-slate-700">{fmtCad(totalCad)}</span>
        </p>
      )}
    </div>
  )
}

// Création : pas d'autosave possible (aucun id avant l'insertion) — d'où le seul
// bouton de la page.
function NewPaymentForm({ onCreated, onClose, hints, templates, accounts, bills, prefill }) {
  const { addToast } = useToast()
  const emptyForm = useCallback(() => ({
    method: 'interac',
    payment_date: todayIso(),
    label: '',
    amount: '',
    direction: 'out',
    from_account: PROJECTED_ACCOUNT,
    to_account: '',
    reference: '',
    invoice_number: '',
    notes: '',
    // Facture fournisseur sélectionnée dans « Factures à payer » : le paiement
    // créé lui sera lié (achat_id) pour qu'elle cède sa place dans la projection.
    bill: null,
  }), [])
  const [form, setForm] = useState(emptyForm)
  const [busy, setBusy] = useState(false)
  // Rappel du dernier paiement fait à ce fournisseur (note, moyen, compte).
  const [hint, setHint] = useState(null)
  // Dernière date PROPOSÉE par la page. Tant que la case affiche encore cette
  // valeur, personne n'y a touché : on peut la remplacer par une meilleure
  // proposition. Dès qu'elle en diffère, la date est une saisie manuelle et
  // devient intouchable.
  const [autoDate, setAutoDate] = useState(todayIso)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const sp = spec(form.method)

  const byKey = useMemo(() => new Map(hints.map(h => [h.key, h])), [hints])
  const accountsByName = useMemo(() => new Map(accounts.map(a => [a.name, a])), [accounts])

  // Facture ouverte la plus urgente par fournisseur : c'est elle qui date le
  // paiement quand on tape un nom au lieu de piocher dans « Factures à payer ».
  const billsByKey = useMemo(() => {
    const m = new Map()
    for (const b of bills || []) {
      const k = vendorKey(b.vendor)
      if (!k) continue
      const prev = m.get(k)
      if (!prev || billDue(b) < billDue(prev)) m.set(k, b)
    }
    return m
  }, [bills])

  // Date proposée pour un fournisseur : le dernier jour de l'échéance de sa
  // facture ouverte (veille ouvrable si les banques ferment ce jour-là), et
  // aujourd'hui seulement quand aucune échéance n'est connue.
  const suggestDate = useCallback(
    (vendor) => {
      const b = billsByKey.get(vendorKey(vendor))
      return b ? payDateForDue(billDue(b), todayIso()).date : todayIso()
    },
    [billsByKey],
  )

  // « Repartir d'un paiement déjà fait » / bouton Refaire d'une ligne : tout est
  // recopié SAUF ce qui change à chaque fois — la date (aujourd'hui), le montant
  // (souvent différent), le n° de confirmation et le n° de facture (jamais deux
  // fois le même).
  const applyTemplate = useCallback((t) => {
    if (!t) return
    const sides = transferSides(t)
    // Un moyen qui ne sait pas exprimer une entrée (chèque, code de paiement)
    // retomberait silencieusement en sortie : on bascule sur « Autre », qui laisse
    // le sens visible et modifiable. Ne concerne que des lignes historiques.
    const m = t.method || 'autre'
    const ms = spec(m)
    const method = t.direction === 'in' && !ms.transfer && !ms.sens ? 'autre' : m
    // « Aujourd'hui » n'est un défaut que faute de mieux : si ce fournisseur a
    // une facture ouverte, on repropose le dernier jour de son échéance.
    const date = suggestDate(t.label)
    setAutoDate(date)
    setForm({
      method,
      payment_date: date,
      label: t.label || '',
      amount: '',
      direction: t.direction === 'in' ? 'in' : 'out',
      from_account: sides.from || t.account || PROJECTED_ACCOUNT,
      to_account: sides.to || '',
      reference: '',
      invoice_number: '',
      notes: t.notes || '',
      bill: null,
    })
    // Le fournisseur du modèle peut porter une particularité : on la ressort
    // aussi quand on « refait » un paiement, pas seulement à la frappe du nom.
    setHint(byKey.get(vendorKey(t.label)) || null)
  }, [byKey, suggestDate])

  // « Payer cette facture » depuis le panneau Factures à payer : fournisseur,
  // montant (solde dû), n° de facture et DATE viennent de la facture ; le moyen,
  // le compte et la note viennent de la mémoire du fournisseur
  // (dernier paiement, puis profil). Objectif : plus rien à saisir sauf le n° de
  // confirmation, que seule la banque connaît une fois le paiement émis.
  const applyBill = useCallback((bill) => {
    if (!bill) return
    const h = byKey.get(vendorKey(bill.vendor)) || null
    const cur = bill.currency || 'CAD'
    // Compte à débiter, du plus sûr au plus générique : ce qu'on a réellement
    // fait la dernière fois → ce que le profil fournisseur note (« Master »,
    // « Venn USD »…) → n'importe quel compte de la bonne devise.
    const hintedAccount = h?.account && h.direction !== 'in'
      && (accountsByName.get(h.account)?.currency || 'CAD') === cur ? h.account : null
    const profileAccount = h?.account_by_currency?.[cur] || null
    const currencyAccount = accounts.find(a => a.kind === 'bank' && (a.currency || 'CAD') === cur)?.name
    const account = hintedAccount || profileAccount || currencyAccount || PROJECTED_ACCOUNT
    // Un mouvement interne (transfert, carte) ne règle pas une facture : on
    // retombe sur l'Interac, le moyen par défaut pour payer un fournisseur. Et
    // un fournisseur payé PAR carte de crédit ne peut pas l'être en Interac (le
    // moyen n'accepte que des comptes bancaires) : c'est « Autre ».
    const hintedMethod = h?.method && !spec(h.method).transfer && h.direction !== 'in' ? h.method : 'interac'
    const method = accountsByName.get(account)?.kind === 'card' ? 'autre' : hintedMethod
    // On paie au DERNIER jour de l'échéance — et la veille ouvrable si les
    // banques sont fermées ce jour-là (fin de semaine, férié).
    const date = payDateForDue(billDue(bill), todayIso()).date
    setAutoDate(date)
    setForm({
      method,
      payment_date: date,
      label: bill.vendor || '',
      amount: String(Number(bill.balance_due_cad ?? bill.total_cad) || ''),
      direction: 'out',
      from_account: account,
      to_account: '',
      reference: '',
      invoice_number: bill.vendor_invoice_number || bill.bill_number || '',
      notes: h?.note || '',
      bill,
    })
    setHint(h)
  }, [byKey, accounts, accountsByName])

  // Le parent pousse un modèle (ou une facture à payer) via un compteur :
  // `seq` change → on applique.
  const lastSeq = useRef(0)
  useEffect(() => {
    if (!prefill || prefill.seq === lastSeq.current) return
    lastSeq.current = prefill.seq
    if (prefill.bill) applyBill(prefill.bill)
    else applyTemplate(prefill.payment)
  }, [prefill, applyTemplate, applyBill])

  // Saisie du bénéficiaire → on ressort ce qu'on a fait la dernière fois. Les
  // champs déjà remplis à la main ne sont jamais écrasés ; ce qui vient de la
  // suggestion précédente, lui, se met à jour (on a changé de fournisseur).
  const onLabelChange = (value) => {
    const next = byKey.get(vendorKey(value)) || null
    // La date suit le fournisseur comme le reste : dès que le nom saisi désigne
    // une facture ouverte, on propose le dernier jour de son échéance. Une date
    // déjà corrigée à la main est conservée telle quelle.
    const date = suggestDate(value)
    setAutoDate(date)
    setForm(f => {
      // Encore la valeur suggérée par le fournisseur précédent (ou la valeur par
      // défaut) = pas une saisie manuelle, donc remplaçable sans rien perdre.
      const free = (formField, hintField, dflt) => (hint
        ? String(f[formField] ?? '') === String(hint[hintField] ?? '')
        : String(f[formField] ?? '') === dflt)
      return {
        ...f,
        label: value,
        payment_date: f.payment_date === autoDate ? date : f.payment_date,
        // Changer de fournisseur délie la facture sélectionnée : lier le paiement
        // de B à une facture de A ferait disparaître la mauvaise facture de la
        // projection.
        bill: f.bill && vendorKey(value) !== vendorKey(f.bill.vendor) ? null : f.bill,
        notes: free('notes', 'note', '') ? (next?.note || '') : f.notes,
        method: next?.method && free('method', 'method', 'interac') ? next.method : f.method,
        // Le compte mémorisé est le côté PROJETÉ du dernier paiement : il ne dit
        // d'où l'argent est parti que si c'était une sortie.
        from_account: next?.account && next.direction !== 'in' && free('from_account', 'account', PROJECTED_ACCOUNT)
          ? next.account : f.from_account,
      }
    })
    setHint(next)
  }

  // Traduction saisie → stockage. La saisie est toujours orientée « d'où sort
  // l'argent → où il va » ; le stockage garde le côté projeté dans
  // `account` + `direction` et l'autre côté dans `counterparty_account`, seule
  // forme que la projection sait lire.
  const payload = useMemo(() => {
    const s = spec(form.method)
    let account = form.from_account
    let counterparty = null
    let direction = s.sens ? (form.direction === 'in' ? 'in' : 'out') : 'out'
    if (s.transfer) {
      const to = form.to_account
      if (to && to === PROJECTED_ACCOUNT && form.from_account !== PROJECTED_ACCOUNT) {
        account = to; counterparty = form.from_account; direction = 'in'
      } else { account = form.from_account; counterparty = to || null; direction = 'out' }
    }
    // Un mouvement interne se nomme tout seul : « De → Vers » pour un transfert,
    // le nom de la carte pour un paiement de carte.
    const autoLabel = s.transfer && form.to_account
      ? (form.method === 'carte' ? form.to_account : `${form.from_account} → ${form.to_account}`)
      : ''
    return {
      payment_date: form.payment_date,
      label: form.label.trim() || autoLabel,
      amount: parseAmount(form.amount),
      direction,
      account,
      counterparty_account: counterparty,
      currency: accountsByName.get(account)?.currency || 'CAD',
      method: form.method,
      reference: form.reference.trim() || null,
      invoice_number: s.invoice ? (form.invoice_number.trim() || null) : null,
      notes: form.notes.trim() || null,
      // Lien vers la facture réglée : elle sort de « Factures à payer » et cède
      // sa place au paiement dans la projection (anti double-compte).
      achat_id: s.invoice && form.bill ? form.bill.id : null,
    }
  }, [form, accountsByName])

  // Pourquoi la date de paiement est celle-là. La règle est invisible sans ça :
  // on paie au dernier jour de l'échéance, sauf si les banques ferment ce
  // jour-là. Modifiable à la main — d'où le lien de retour à la date proposée.
  // Facture qui DATE le paiement : celle choisie dans le panneau, sinon la plus
  // urgente des factures ouvertes du fournisseur saisi à la main.
  const dateBill = form.bill || billsByKey.get(vendorKey(form.label)) || null
  const billPay = useMemo(
    () => (dateBill ? payDateForDue(billDue(dateBill), todayIso()) : null),
    [dateBill],
  )
  const payDateNote = billPay && {
    due: `Payé le dernier jour de l'échéance : ${fmtDayLong(billPay.date)}.`,
    weekend: `L'échéance tombe un ${weekdayName(billPay.due)} — banques fermées : payé le ${fmtDayLong(billPay.date)}.`,
    holiday: `L'échéance est un jour férié (${billPay.holiday}) — banques fermées : payé le ${fmtDayLong(billPay.date)}.`,
    late: `Échéance dépassée : payé dès aujourd'hui, ${fmtDayLong(billPay.date)}.`,
    none: `Facture sans échéance : payé aujourd'hui, ${fmtDayLong(billPay.date)}.`,
  }[billPay.reason]

  // Libellés orientés selon le sens : « compte d'où part le virement » devient
  // « compte qui reçoit le virement » quand l'argent entre.
  const incoming = !!sp.sens && form.direction === 'in'
  const accountLabel = sp.transfer ? sp.fromLabel : ((incoming && sp.accountLabelIn) || sp.accountLabel)
  const payeeLabel = (incoming && sp.payeeLabelIn) || sp.payeeLabel

  const submit = async () => {
    if (!(payload.amount > 0)) { addToast({ message: 'Montant invalide', type: 'error' }); return }
    if (!payload.label) { addToast({ message: sp.transfer ? 'Choisis les deux comptes' : `« ${payeeLabel} » est requis`, type: 'error' }); return }
    if (sp.transfer && payload.counterparty_account === payload.account) {
      addToast({ message: 'Les deux comptes doivent être différents', type: 'error' }); return
    }
    setBusy(true)
    try {
      await api.treasury.payments.create(payload)
      // Le moyen, les comptes et la note restent : on enchaîne souvent plusieurs
      // paiements de même forme. Seuls les identifiants uniques sont vidés — et
      // la facture liée, qui est réglée.
      setForm(f => ({ ...f, amount: '', reference: '', invoice_number: '', bill: null }))
      addToast({ message: 'Paiement ajouté — compté dans la projection', type: 'success' })
      onCreated()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setBusy(false) }
  }

  const cur = payload.currency
  const summary = payload.amount > 0 && payload.label
    ? (payload.direction === 'in'
      ? <>
        <strong className="tabular-nums text-emerald-700">{fmtCad(payload.amount, cur)}</strong> entrent dans{' '}
        <strong>{payload.account}</strong> en provenance de <strong>{payload.counterparty_account || payload.label}</strong>{' '}
        — {sp.label.toLowerCase()} du {fmtDay(payload.payment_date)}.
      </>
      : <>
        <strong className="tabular-nums text-rose-600">{fmtCad(payload.amount, cur)}</strong> sortent de{' '}
        <strong>{payload.account}</strong> vers <strong>{payload.counterparty_account || payload.label}</strong>{' '}
        — {sp.label.toLowerCase()} du {fmtDay(payload.payment_date)}.
      </>)
    : null

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden" data-testid="payment-new-form">
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 border-b border-slate-100 bg-slate-50/70">
        <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
          <Plus size={15} className="text-brand-600" /> Nouveau paiement
        </h2>
        {/* La mémoire de la page : chaque paiement passé est un modèle réutilisable.
            Choisir un modèle remplit tout sauf date / montant / n° de confirmation. */}
        <div className="w-full sm:w-72 sm:ml-auto">
          <SearchableSelect
            value=""
            options={templates}
            onChange={key => applyTemplate(templates.find(t => t.key === key))}
            getOptionValue={t => t.key}
            getOptionLabel={t => `${t.label} · ${spec(t.method).label}`}
            filterOption={(t, q) => `${t.label} ${spec(t.method).label} ${t.account} ${t.counterparty_account || ''} ${t.notes || ''}`.toLowerCase().includes(q)}
            renderOption={t => (
              <span className="flex items-center justify-between gap-2">
                <span className="truncate">
                  <span className="font-medium text-slate-700">{t.label}</span>
                  <span className="text-slate-400"> · {spec(t.method).label}</span>
                </span>
                <span className="shrink-0 text-slate-400 tabular-nums">{fmtCad(t.last_amount, t.currency)}</span>
              </span>
            )}
            placeholder={templates.length ? "Repartir d'un paiement déjà fait…" : 'Aucun paiement passé'}
            searchPlaceholder="Bénéficiaire, moyen, compte…"
            className={`${inputCls} w-full bg-white`}
            size="sm"
            disabled={!templates.length}
            testId="payment-template-picker"
          />
        </div>
        {onClose && (
          <button type="button" onClick={onClose} data-testid="payment-new-close"
            className="shrink-0 p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            title="Fermer la saisie">
            <X size={15} />
          </button>
        )}
      </div>

      <div className="p-4 space-y-4">
        {/* Facture sélectionnée dans « Factures à payer » : le paiement créé lui
            sera lié. Déliable d'un clic si on a pioché la mauvaise. */}
        {form.bill && (
          <div className="flex items-start justify-between gap-2 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2 text-sm text-slate-700"
            data-testid="payment-linked-bill">
            <span className="flex items-start gap-2 min-w-0">
              <ReceiptText size={15} className="shrink-0 mt-0.5 text-brand-600" />
              <span>
                Règle la facture <strong>{form.bill.vendor_invoice_number || form.bill.bill_number || 'sans n°'}</strong> de{' '}
                <strong>{form.bill.vendor}</strong> — {fmtCad(form.bill.balance_due_cad ?? form.bill.total_cad, form.bill.currency)}
                {form.bill.due_date ? <> · échéance {fmtDay(form.bill.due_date)}</> : null}.
                {/* La date retenue et sa raison : c'est la seule case du
                    formulaire dont la valeur ne se lit pas sur la facture. */}
                <span className="block mt-0.5 text-xs text-slate-500" data-testid="payment-pay-date-note">
                  {payDateNote}
                  {form.payment_date !== billPay.date && (
                    <>
                      {' '}<button type="button" onClick={() => set('payment_date', billPay.date)}
                        data-testid="payment-pay-date-restore"
                        className="text-brand-600 underline hover:text-brand-700">
                        remettre au {fmtDay(billPay.date)}
                      </button>
                    </>
                  )}
                </span>
              </span>
            </span>
            <button type="button" onClick={() => set('bill', null)} data-testid="payment-linked-bill-unlink"
              className="shrink-0 text-slate-400 hover:text-rose-600 p-0.5" title="Délier la facture">
              <X size={14} />
            </button>
          </div>
        )}

        {/* 1 — le moyen commande tout le reste du formulaire. */}
        <div>
          <p className={stepCls}>Moyen de paiement</p>
          <div className="flex flex-wrap gap-2" data-testid="payment-method-picker">
            {METHOD_ORDER.map(m => {
              const Icon = METHOD_SPECS[m].icon
              const active = form.method === m
              return (
                <button key={m} type="button" onClick={() => set('method', m)}
                  data-testid={`payment-method-${m}`} aria-pressed={active}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition-colors ${active
                    ? 'border-brand-500 bg-brand-50 text-brand-700 font-medium'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                  <Icon size={14} /> {METHOD_SPECS[m].label}
                </button>
              )
            })}
          </div>
          <p className="mt-2 text-xs text-slate-500" data-testid="payment-method-hint">{sp.hint}</p>
        </div>

        {/* 2 — la question qui manquait : d'où l'argent sort, et vers qui. */}
        <div>
          <p className={stepCls}>{sp.transfer ? "D'où vers où ?" : (incoming ? "D'où vient l'argent, et où entre-t-il ?" : "D'où sort l'argent, et vers qui ?")}</p>
          <div className="flex flex-wrap items-start gap-3">
            {/* Le sens vient en premier : il retourne les libellés des deux champs
                suivants (« compte d'où part » ↔ « compte qui reçoit »). */}
            {sp.sens && (
              <Field as="div" label="Sens du mouvement" className="w-40">
                <select value={form.direction} onChange={e => set('direction', e.target.value)} className={`${inputCls} w-full`}
                  data-testid="payment-new-direction">
                  <option value="out">Sortie d'argent</option>
                  <option value="in">Entrée d'argent</option>
                </select>
              </Field>
            )}
            <Field as="div" label={accountLabel} className="w-56">
              <SearchableSelect
                value={form.from_account}
                options={accountOptions(accounts, sp.transfer ? sp.fromKind : sp.accountKind)}
                onChange={v => set('from_account', v)}
                className={`${inputCls} w-full bg-white`} size="sm"
                searchPlaceholder="Compte…" testId="payment-new-from-account"
              />
            </Field>
            <ArrowRight size={16} className={`text-slate-300 mt-7 shrink-0 ${incoming ? 'rotate-180' : ''}`} />
            {sp.transfer ? (
              <>
                <Field as="div" label={sp.toLabel} className="w-56"
                  hint={form.to_account === PROJECTED_ACCOUNT ? `Argent qui ENTRE au ${PROJECTED_ACCOUNT}` : undefined}>
                  <SearchableSelect
                    value={form.to_account}
                    options={accountOptions(accounts, sp.toKind)}
                    onChange={v => set('to_account', v)}
                    placeholder="Choisir…"
                    className={`${inputCls} w-full bg-white`} size="sm"
                    searchPlaceholder="Compte…" testId="payment-new-to-account"
                  />
                </Field>
                {/* Un mouvement interne se nomme tout seul ; le libellé ne sert
                    qu'à coller au relevé quand la banque l'écrit autrement. */}
                <Field label="Libellé au relevé (facultatif)" className="flex-1 min-w-52">
                  <input value={form.label} onChange={e => set('label', e.target.value)}
                    placeholder={payload.label || 'Nommé automatiquement'}
                    className={`${inputCls} w-full`} data-testid="payment-new-transfer-label" />
                </Field>
              </>
            ) : (
              <Field label={payeeLabel} className="flex-1 min-w-56">
                {/* Le datalist filtre à la frappe (règle « dropdown recherchable ») :
                    il liste les fournisseurs déjà payés + ceux dont le profil porte
                    une note de paiement. */}
                <input value={form.label} onChange={e => onLabelChange(e.target.value)} placeholder={sp.payeePlaceholder}
                  list="payment-vendor-hints" autoComplete="off"
                  className={`${inputCls} w-full`} data-testid="payment-new-label" />
                <datalist id="payment-vendor-hints">
                  {hints.map(h => <option key={h.key} value={h.name}>{h.note || ''}</option>)}
                </datalist>
              </Field>
            )}
          </div>
          {hint && (hint.note || hint.last_date) && (
            <p className="mt-2 text-xs text-slate-500" data-testid="payment-vendor-hint">
              <History size={12} className="inline-block mr-1 -mt-0.5 text-slate-400" />
              {hint.source === 'profile'
                ? <>Note de paiement du profil <span className="font-medium text-slate-600">{hint.name}</span></>
                : <>Dernier paiement à <span className="font-medium text-slate-600">{hint.name}</span>{hint.last_date ? ` le ${fmtDay(hint.last_date)}` : ''}</>}
              {hint.note && <> : « {hint.note} »</>}
              {' — '}rempli automatiquement, modifiable.
            </p>
          )}
          {/* Particularité du profil fournisseur (« inscrire le n° de document
              comme réponse »…) : impossible à rater au moment de payer. */}
          {hint?.particularites && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
              data-testid="payment-vendor-particularites">
              <AlertTriangle size={15} className="shrink-0 mt-0.5 text-amber-500" />
              <span className="min-w-0">
                <span className="font-semibold">À savoir pour payer {hint.name}</span> : {hint.particularites}
                {' '}
                <Link to="/fournisseurs" className="text-amber-700 underline hover:text-amber-900 whitespace-nowrap">
                  voir le profil
                </Link>
              </span>
            </div>
          )}
        </div>

        {/* 3 — ce qui change d'un paiement à l'autre. */}
        <div>
          <p className={stepCls}>Montant, date et références</p>
          <div className="flex flex-wrap items-start gap-3">
            <Field label={`Montant${cur !== 'CAD' ? ` (${cur})` : ''}`} className="w-32">
              <input inputMode="decimal" value={form.amount} onChange={e => set('amount', e.target.value)}
                className={`${inputCls} w-full text-right tabular-nums`} data-testid="payment-new-amount" />
            </Field>
            <Field label={sp.dateLabel} className="w-44">
              <input type="date" value={form.payment_date} onChange={e => set('payment_date', e.target.value)}
                className={`${inputCls} w-full`} data-testid="payment-new-date" />
            </Field>
            <Field label={sp.refLabel} className="w-52">
              <input value={form.reference} onChange={e => set('reference', e.target.value)}
                placeholder={sp.refPlaceholder || ''} className={`${inputCls} w-full`}
                data-testid="payment-new-reference" />
            </Field>
            {sp.invoice && (
              <Field label="N° de facture réglée" className="w-40">
                <input value={form.invoice_number} onChange={e => set('invoice_number', e.target.value)}
                  title="Facultatif — sert à retrouver la facture payée."
                  className={`${inputCls} w-full`} data-testid="payment-new-invoice" />
              </Field>
            )}
            <Field label="Note" className="flex-1 min-w-48">
              <input value={form.notes} onChange={e => set('notes', e.target.value)}
                placeholder="Ex. payé par Antoine, loyer d'août…"
                title="Mémorisée sur le profil du fournisseur et re-proposée au prochain paiement."
                className={`${inputCls} w-full`} data-testid="payment-new-notes" />
            </Field>
          </div>
          {/* Fournisseur tapé à la main : la date proposée vient quand même de
              son échéance — on dit laquelle, sinon elle paraît sortie de nulle
              part. (Facture choisie dans le panneau : l'explication est déjà
              dans l'encadré du haut.) */}
          {!form.bill && billPay && (
            <p className="mt-2 text-xs text-slate-500" data-testid="payment-date-hint">
              Facture <strong className="font-medium">{dateBill.vendor_invoice_number || dateBill.bill_number || 'sans n°'}</strong>
              {' '}de {dateBill.vendor} — {payDateNote}
              {form.payment_date !== billPay.date && (
                <>
                  {' '}<button type="button" onClick={() => set('payment_date', billPay.date)}
                    data-testid="payment-date-hint-restore"
                    className="text-brand-600 underline hover:text-brand-700">
                    remettre au {fmtDay(billPay.date)}
                  </button>
                </>
              )}
            </p>
          )}
        </div>

        {/* Relecture en une phrase avant d'enregistrer : c'est là qu'une erreur de
            compte ou de sens se voit. */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-100">
          <p className="text-sm text-slate-600" data-testid="payment-new-summary">
            {summary || (
              <span className="text-slate-400">
                Complète le montant et {sp.transfer ? 'les deux comptes' : `« ${payeeLabel.toLowerCase()} »`} pour voir le résumé.
              </span>
            )}
          </p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => { setForm(emptyForm()); setHint(null); setAutoDate(todayIso()) }}
              className="px-2.5 py-1.5 text-sm text-slate-500 hover:text-slate-700" data-testid="payment-new-reset">
              Vider
            </button>
            <button onClick={submit} disabled={busy} data-testid="payment-new-save"
              className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
              <Plus size={14} /> Ajouter le paiement
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Menu « ⋯ » des actions rares (imports, appariement manuel) : présentes mais
// hors du chemin du regard.
function PageMenu({ items }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="relative">
      <button type="button" onClick={() => setOpen(o => !o)} data-testid="payments-more-menu"
        aria-expanded={open} title="Autres actions"
        className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50">
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <span className="absolute right-0 top-9 z-30 w-64 rounded-xl border border-slate-200 bg-white shadow-lg py-1"
            data-testid="payments-more-menu-panel">
            {items.map(it => (
              <button key={it.label} type="button" disabled={it.disabled}
                data-testid={it.testId}
                onClick={() => { setOpen(false); it.onClick() }} title={it.title}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                {it.icon} {it.label}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  )
}

export default function PaiementsEmis() {
  const { addToast } = useToast()
  // Onglet piloté par l'URL (?onglet=) : partageable, et le sous-menu de la
  // sidebar peut y sauter même quand la page est déjà affichée.
  const [params, setParams] = useSearchParams()
  // 'cedule' = la sous-vue « À payer » : ce qu'on décide de payer cette semaine
  // (factures ouvertes), avant que ça devienne un paiement émis.
  const TAB_KEYS = ['cedule', 'pending', 'cleared', 'all']
  const tab = TAB_KEYS.includes(params.get('onglet')) ? params.get('onglet') : 'pending'
  const setTab = (v) => setParams({ onglet: v }, { replace: true })
  const [rows, setRows] = useState([])
  // Mémoire par fournisseur (dernière note / moyen / compte) : chargée une fois,
  // rafraîchie après chaque ajout puisqu'un nouveau paiement l'enrichit.
  const [hints, setHints] = useState([])
  // Modèles = formes de paiement déjà utilisées, rejouables d'un clic.
  const [templates, setTemplates] = useState([])
  const [bankAccounts, setBankAccounts] = useState([])
  const [prefill, setPrefill] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  // La saisie est une ACTION, pas la page : repliée par défaut, elle s'ouvre au
  // clic sur « Nouveau paiement », en refaisant un paiement, ou en piochant une
  // facture à payer. Sans ça, la liste — le vrai contenu — démarrait sous la
  // ligne de flottaison.
  const [formOpen, setFormOpen] = useState(false)

  const load = useCallback(() => {
    if (tab === 'cedule') { setLoading(false); return }
    setLoading(true)
    api.treasury.payments.list({ status: tab, limit: tab === 'all' ? 500 : 300 })
      .then(setRows).catch(e => addToast({ message: e.message, type: 'error' }))
      .finally(() => setLoading(false))
  }, [tab, addToast])
  useEffect(() => { load() }, [load])

  const loadMemory = useCallback(() => {
    api.treasury.payments.vendorHints().then(setHints).catch(() => setHints([]))
    api.treasury.payments.templates().then(setTemplates).catch(() => setTemplates([]))
  }, [])
  useEffect(() => { loadMemory() }, [loadMemory])

  // Factures fournisseurs encore à payer : rechargées après chaque ajout — une
  // facture réglée (liée par achat_id) sort de la liste.
  const [bills, setBills] = useState([])
  const loadBills = useCallback(() => {
    api.treasury.payments.openBills().then(setBills).catch(() => setBills([]))
  }, [])
  useEffect(() => { loadBills() }, [loadBills])

  // Détection QuickBooks du « passé à la banque ». Au chargement on lit l'état
  // de la dernière vérification (horaire) — pas d'appel à QuickBooks : les
  // candidats à confirmer y sont déjà. Le bouton relit le grand livre.
  const [qb, setQb] = useState({ candidates: [], last_run: null, active: false })
  const [qbBusy, setQbBusy] = useState(false)
  const loadQb = useCallback(() => {
    api.treasury.payments.qbClearStatus().then(setQb).catch(() => {})
  }, [])
  useEffect(() => { loadQb() }, [loadQb])

  // Particularités par fournisseur (clé normalisée) : triangle ambre dans le
  // panneau des factures + rappel sur les paiements pas encore passés.
  const particByKey = useMemo(
    () => new Map(hints.filter(h => h.particularites).map(h => [h.key, h.particularites])),
    [hints],
  )

  useEffect(() => {
    api.bank.accounts()
      .then(a => setBankAccounts(a.filter(x => x.active !== 0).map(x => ({ name: x.name, kind: x.kind, currency: x.currency }))))
      .catch(() => setBankAccounts([]))
  }, [])
  const accounts = useMemo(() => (bankAccounts.length ? bankAccounts : FALLBACK_ACCOUNTS), [bankAccounts])

  // « Refaire ce paiement » depuis une ligne : on remonte le modèle au formulaire
  // (compteur pour que deux clics sur la même ligne fonctionnent).
  const reuse = useCallback((p) => {
    setPrefill(prev => ({ seq: (prev?.seq || 0) + 1, payment: p }))
    setFormOpen(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  // « Payer cette facture » depuis le panneau : même mécanique, mais c'est la
  // facture qui pré-remplit le formulaire (et le paiement créé lui sera lié).
  const pickBill = useCallback((b) => {
    setPrefill(prev => ({ seq: (prev?.seq || 0) + 1, bill: b }))
    setFormOpen(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  // Effet net de ce qui reste à passer sur le compte projeté : c'est le chiffre
  // qui explique un écart entre le solde vu à la banque et le solde disponible.
  const pendingTotal = useMemo(() => rows
    .filter(p => !p.cleared_at && (p.account || PROJECTED_ACCOUNT) === PROJECTED_ACCOUNT && (p.currency || 'CAD') === 'CAD')
    .reduce((s, p) => s + (p.direction === 'in' ? Number(p.amount) : -Number(p.amount)), 0), [rows])

  const run = async (fn, msg) => {
    setBusy(true)
    try { const r = await fn(); addToast({ message: msg(r), type: 'success' }); load() }
    catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setBusy(false) }
  }

  // Relit l'onglet Pmt_Suivi du fichier « CTB - Suivi » : ce que Charles y ajoute
  // (paiement émis, virement) doit pouvoir descendre dans « À passer à la banque »
  // sans attendre. L'import est idempotent (clé naturelle par ligne), donc le
  // bouton est rejouable sans risque de doublon ; il recharge aussi les factures
  // à payer puisqu'une ligne du fichier peut en régler une.
  // La sync tourne aussi toute seule (toutes les 30 min, automation
  // sys_pmt_suivi_sheet) : on affiche le dernier passage pour que le bouton se
  // lise comme « forcer maintenant », pas comme « la seule façon de le faire ».
  const [sheetStatus, setSheetStatus] = useState(null)
  const loadSheetStatus = useCallback(() => {
    api.treasury.payments.sheetStatus().then(setSheetStatus).catch(() => {})
  }, [])
  useEffect(() => { loadSheetStatus() }, [loadSheetStatus])

  const [sheetBusy, setSheetBusy] = useState(false)
  const syncSheet = async () => {
    setSheetBusy(true)
    try {
      const r = await api.treasury.payments.importSheet()
      addToast({
        message: (r.created || r.updated)
          ? `Feuille synchronisée : ${r.created} paiement(s) ajouté(s), ${r.updated} mis à jour`
          : 'Feuille synchronisée : rien de nouveau',
        type: 'success',
      })
      load(); loadBills(); loadSheetStatus()
    } catch (e) { addToast({ message: e.message, type: 'error' }); loadSheetStatus() }
    finally { setSheetBusy(false) }
  }

  // Relit le grand livre QuickBooks : coche ce qui est sûr, remonte le reste.
  const syncQb = async () => {
    setQbBusy(true)
    try {
      const r = await api.treasury.payments.qbClear()
      const done = (r.applied || []).length
      addToast({
        message: done
          ? `${done} paiement(s) marqué(s) passé(s) à la banque · ${(r.candidates || []).length} à confirmer`
          : ((r.candidates || []).length
            ? `${r.candidates.length} correspondance(s) à confirmer`
            : 'Rien de nouveau : QuickBooks et les paiements émis concordent'),
        type: 'success',
      })
      setQb(prev => ({ ...prev, candidates: r.candidates || [], last_run: { status: 'success', executed_at: new Date().toISOString() } }))
      load(); loadBills()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setQbBusy(false) }
  }

  // Confirmation d'un candidat : le serveur re-vérifie auprès de QuickBooks
  // avant de cocher (on ne coche jamais sur la seule foi de l'id affiché).
  const applyQb = async (c) => {
    setQbBusy(true)
    try {
      const r = await api.treasury.payments.qbClearApply(
        c.kind === 'bill' ? { achatIds: [c.achat_id] } : { paymentIds: [c.payment_id] })
      if ((r.applied || []).length) {
        addToast({ message: `${c.label || 'Mouvement'} : marqué passé à la banque`, type: 'success' })
        setQb(prev => ({
          ...prev,
          candidates: prev.candidates.filter(x => (x.payment_id || x.achat_id) !== (c.payment_id || c.achat_id)),
        }))
      } else {
        addToast({ message: 'QuickBooks ne confirme plus ce mouvement — rien n\'a été coché', type: 'error' })
        loadQb()
      }
      load(); loadBills()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setQbBusy(false) }
  }

  return (
    <Layout>
      <div className="max-w-7xl mx-auto px-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-slate-900 flex items-center gap-2">
              <Landmark size={18} className="text-brand-600" /> Paiements et virements émis
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Tant qu'un paiement n'est pas passé à la banque, il pèse sur la{' '}
              <Link to="/comptabilite" className="text-brand-600 hover:underline">projection du solde</Link>.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {tab !== 'cedule' && (
              <button onClick={() => setFormOpen(o => !o)} data-testid="payment-new-toggle" aria-expanded={formOpen}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg">
                <Plus size={15} /> Nouveau paiement
                {!!bills.length && (
                  <span className="px-1.5 rounded-full bg-white/25 text-[11px] tabular-nums"
                    title={`${bills.length} facture(s) fournisseur encore à payer`}>{bills.length}</span>
                )}
              </button>
            )}
            {/* La feuille se relit toute seule aux 30 min, mais ce bouton reste
                la porte manuelle : demande explicite de Charles, il doit se voir
                comme un bouton (fond blanc, bordure franche, libellé TOUJOURS
                affiché) et rester dans la barre d'actions de tous les onglets.
                Ne pas le repasser en bouton fantôme ni le mettre dans « ⋯ ». */}
            <button onClick={syncSheet} disabled={sheetBusy} data-testid="payments-sync-sheet"
              title={`Relire maintenant l'onglet Pmt_Suivi du fichier « CTB - Suivi » et reprendre les paiements ajoutés dans le fichier${
                sheetStatus?.active === false
                  ? " — la relecture automatique est DÉSACTIVÉE (page Automations)"
                  : ` — sans attendre la relecture automatique (toutes les ${sheetStatus?.interval_minutes || 30} minutes)`
              }`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 shadow-sm hover:bg-slate-50 hover:border-slate-400 rounded-lg disabled:opacity-50">
              <RefreshCw size={14} className={sheetBusy ? 'animate-spin' : ''} />
              <span>{sheetBusy ? 'Synchronisation…' : 'Synchroniser la feuille'}</span>
            </button>
            <PageMenu items={[
              {
                label: 'Apparier au relevé bancaire',
                testId: 'payments-auto-clear',
                icon: <Landmark size={14} className="text-slate-400" />,
                disabled: busy,
                title: 'Apparier les paiements en attente au relevé bancaire importé',
                onClick: () => run(() => api.treasury.payments.autoClear(PROJECTED_ACCOUNT), r => `${r.cleared} paiement(s) retrouvé(s) au relevé`),
              },
            ]} />
          </div>
        </div>

        {/* Ce que QuickBooks dit passé à la banque et qui demande un arbitrage.
            Rien à confirmer = une seule ligne grise : le cas normal ne doit rien
            coûter à lire. Juste au-dessus, la même forme pour la relecture
            automatique de la feuille (état, pas action). */}
        <div className="mt-3 space-y-1">
          <SheetSyncStatus status={sheetStatus} />
          <QbClearPanel candidates={qb.candidates} lastRun={qb.last_run} busy={qbBusy}
            onSync={syncQb} onApply={applyQb} />
        </div>

        {/* Formulaire + factures à payer côte à côte : on pioche une facture à
            droite, le formulaire se remplit à gauche. Empilés sur petit écran.
            Masqués dans la cédule : là-bas, cocher une facture EST la saisie. */}
        {tab !== 'cedule' && formOpen && (
          <div className="mt-3 flex flex-col xl:flex-row items-start gap-4">
            <div className="flex-1 min-w-0 w-full">
              <NewPaymentForm hints={hints} templates={templates} accounts={accounts} bills={bills} prefill={prefill}
                onClose={() => setFormOpen(false)}
                onCreated={() => { load(); loadMemory(); loadBills() }} />
            </div>
            <OpenBillsPanel bills={bills} particByKey={particByKey} onPick={pickBill} />
          </div>
        )}

        <div className="flex items-center gap-1 mt-4 mb-3 border-b border-slate-200">
          {[{ v: 'cedule', label: 'À payer (cédule)' }, { v: 'pending', label: 'À passer à la banque' }, { v: 'cleared', label: 'Passés' }, { v: 'all', label: 'Tous' }].map(t => (
            <button key={t.v} onClick={() => setTab(t.v)} data-testid={`payments-tab-${t.v}`}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${tab === t.v ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
              {t.label}
            </button>
          ))}
          {tab === 'pending' && !!rows.length && (
            <span className="ml-auto text-sm text-slate-500 pb-2" data-testid="payments-pending-total">
              Effet net sur le {PROJECTED_ACCOUNT} :{' '}
              <span className={`tabular-nums font-medium ${pendingTotal < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{fmtCad(pendingTotal)}</span>
            </span>
          )}
        </div>

        {/* Cédule de la semaine : les factures à payer, pas encore des paiements. */}
        {tab === 'cedule' && <PaymentSchedule />}

        {/* Une ligne par paiement, lisible d'un coup d'œil ; le détail de saisie
            s'ouvre à la demande sous la ligne. */}
        {tab !== 'cedule' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          {!!rows.length && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50/70 text-[11px] font-medium uppercase tracking-wide text-slate-400">
              <span className="w-24 shrink-0 text-center">Statut</span>
              <span className="w-32 shrink-0 pl-1.5">Date</span>
              <span className="flex-1 min-w-0 pl-1.5">Bénéficiaire</span>
              <span className="hidden lg:block w-36 shrink-0">Moyen</span>
              <span className="hidden xl:block w-40 shrink-0">Compte</span>
              <span className="flex items-center gap-1 shrink-0">
                <span className="w-28 text-right pr-1.5">Montant</span>
                <span className="w-8" />
              </span>
              <span className="w-[22px] shrink-0" />
              <span className="w-[52px] shrink-0" />
            </div>
          )}
          {rows.map(p => (
            <PaymentRow key={p.id} p={p} accounts={accounts} onChanged={load} onReuse={reuse}
              particularites={particByKey.get(vendorKey(p.label))} />
          ))}
          {!loading && !rows.length && (
            <p className="py-6 px-3 text-center text-sm text-slate-400">
              {tab === 'pending' ? 'Tout est passé à la banque.' : 'Aucun paiement.'}
            </p>
          )}
          {loading && <p className="py-6 px-3 text-center text-sm text-slate-400">Chargement…</p>}
        </div>
        )}
      </div>
    </Layout>
  )
}
