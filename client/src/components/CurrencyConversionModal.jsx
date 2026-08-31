// Conversion de devise d'une facture — reprise dans l'ERP de l'onglet
// « USD_CAD » du Google Sheets « CTB - Suivi ».
//
// À quoi ça sert : une facture libellée en USD doit être COMPTABILISÉE en CAD.
// On saisit la facture telle qu'elle est (sous-total, TPS, TVQ) et le taux, et
// chaque ligne est convertie au même taux — la somme des lignes converties
// retombe exactement sur le total converti (colonne « Contrôle » du sheet).
// Aucun frais n'est ajouté : c'est une simple conversion.
//
// Le taux peut venir de trois sources : la Banque du Canada à la date de la
// facture (bouton), une saisie manuelle, ou le montant réellement débité en CAD
// quand la carte a converti elle-même (le taux exact s'en déduit).
//
// Ouvert depuis l'extracteur de données : bouton de l'en-tête de la liste, et
// icône à côté de « Montants » sur un document.
import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, Copy } from 'lucide-react'
import { Modal } from './Modal'
import { api } from '../lib/api'
import { computeConversion, conversionSpreadPct, parseAmount, round2 } from '../lib/currencyConversion'
import { localISODate } from '../lib/formatDate.js'

const LINES = [
  { key: 'subtotal', label: 'Facture (excluant taxes)' },
  { key: 'tps', label: 'TPS / GST' },
  { key: 'tvq', label: 'TVQ / QST / PST' },
  { key: 'otherTaxes', label: 'Autres taxes' },
]

function fmt(n, digits = 2) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return Number(n).toLocaleString('fr-CA', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

// Saisie libre : virgule OU point (« 196,14 » comme « 196.14 »), séparateurs de
// milliers tolérés. L'analyse se fait au calcul (parseAmount), pas à la frappe —
// réécrire la valeur pendant la saisie déplacerait le curseur.
function AmountInput({ value, onChange, label, testId, autoFocus = false, hint = null }) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-sm text-slate-600">
        {label}
        {hint && <span className="block text-[11px] text-slate-400">{hint}</span>}
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        autoFocus={autoFocus}
        onChange={e => onChange(e.target.value)}
        data-testid={testId}
        className="w-32 shrink-0 text-right tabular-nums text-sm border border-slate-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-brand-400"
        placeholder="0,00"
      />
    </label>
  )
}

export function CurrencyConversionModal({ isOpen, onClose, receipt = null, onApplied = null }) {
  const [sourceCurrency, setSourceCurrency] = useState('USD')
  const [targetCurrency, setTargetCurrency] = useState('CAD')
  const [amounts, setAmounts] = useState({ subtotal: '', tps: '', tvq: '', otherTaxes: '' })
  const [rateInput, setRateInput] = useState('')
  const [charged, setCharged] = useState('')
  const [marketRate, setMarketRate] = useState(null)
  const [marketError, setMarketError] = useState(null)
  const [loadingRate, setLoadingRate] = useState(false)
  const [copied, setCopied] = useState(false)
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState(null)

  const receiptDate = receipt?.receipt_date ? String(receipt.receipt_date).slice(0, 10) : null

  // Pré-remplissage depuis le document ouvert (à chaque ouverture : les montants
  // ont pu changer dans la fiche entre deux consultations du calculateur).
  useEffect(() => {
    if (!isOpen) return
    setCopied(false)
    setApplyError(null)
    setCharged('')
    if (!receipt) return
    const priced = (receipt.items || []).filter(it => it && it.total != null)
    const subtotal = priced.length
      ? round2(priced.reduce((s, it) => s + (Number(it.total) || 0), 0))
      : round2(receipt.subtotal || 0)
    setAmounts({
      subtotal: subtotal ? String(subtotal) : '',
      tps: receipt.tps ? String(round2(receipt.tps)) : '',
      tvq: receipt.tvq ? String(round2(receipt.tvq)) : '',
      otherTaxes: receipt.other_taxes ? String(round2(receipt.other_taxes)) : '',
    })
    const cur = (receipt.currency || 'CAD').toUpperCase()
    setSourceCurrency(cur)
    setTargetCurrency(cur === 'CAD' ? 'USD' : 'CAD')
  }, [isOpen, receipt])

  // Taux Banque du Canada à la date de la facture : proposé par défaut, et
  // référence pour situer un taux saisi ou déduit d'un débit de carte.
  useEffect(() => {
    if (!isOpen) return
    const pairOk = (sourceCurrency === 'USD' && targetCurrency === 'CAD') || (sourceCurrency === 'CAD' && targetCurrency === 'USD')
    setMarketRate(null); setMarketError(null)
    if (!pairOk) return
    let cancelled = false
    setLoadingRate(true)
    api.fx.rate(receiptDate || localISODate())
      .then(r => {
        if (cancelled) return
        // r.rate = USD→CAD ; inversé pour CAD→USD.
        const rate = sourceCurrency === 'USD' ? r.rate : 1 / r.rate
        setMarketRate(rate)
        setRateInput(prev => (prev === '' ? String(round4(rate)) : prev))
      })
      .catch(e => { if (!cancelled) setMarketError(e.message || 'Taux indisponible') })
      .finally(() => { if (!cancelled) setLoadingRate(false) })
    return () => { cancelled = true }
  }, [isOpen, sourceCurrency, targetCurrency, receiptDate])

  const sourceTotal = useMemo(
    () => round2(LINES.reduce((s, l) => s + (parseAmount(amounts[l.key]) || 0), 0)),
    [amounts],
  )

  // Le montant débité prime sur le taux saisi : quand la carte a déjà converti,
  // c'est le seul taux exact (il inclut ce que la carte a réellement appliqué).
  const derivedFromCharged = parseAmount(charged) != null && parseAmount(charged) > 0
  const result = useMemo(
    () => computeConversion({
      ...amounts,
      total: sourceTotal,
      targetTotal: derivedFromCharged ? charged : null,
      rate: derivedFromCharged ? null : rateInput,
    }),
    [amounts, sourceTotal, charged, rateInput, derivedFromCharged],
  )

  const spread = result.ok ? conversionSpreadPct(result.rate, marketRate) : null

  const copyText = () => {
    if (!result.ok) return
    const rows = LINES
      .filter(l => parseAmount(amounts[l.key]))
      .map(l => `${l.label}\t${fmt(parseAmount(amounts[l.key]))} ${sourceCurrency}\t${fmt(result.lines[l.key])} ${targetCurrency}`)
    const text = [
      `Taux\t${result.rate.toFixed(6)}`,
      ...rows,
      `Total\t${fmt(result.sourceTotal)} ${sourceCurrency}\t${fmt(result.targetTotal)} ${targetCurrency}`,
    ].join('\n')
    navigator.clipboard?.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  // Applique la conversion au document : devise, montants et lignes d'articles
  // (chacune au même taux, le résidu d'arrondi sur la plus grosse ligne pour que
  // la somme des lignes reste égale au sous-total converti).
  const applyToReceipt = async () => {
    if (!receipt || !result.ok) return
    setApplying(true); setApplyError(null)
    try {
      const rate = result.rate
      const items = (receipt.items || [])
      const priced = items.filter(it => it && it.total != null)
      let newItems = items
      if (priced.length) {
        const converted = items.map(it => (
          it && it.total != null ? { ...it, total: round2(Number(it.total) * rate) } : it
        ))
        const sum = round2(converted.reduce((s, it) => s + (it && it.total != null ? it.total : 0), 0))
        const residual = round2(result.lines.subtotal - sum)
        if (residual !== 0) {
          let biggest = -1
          converted.forEach((it, i) => {
            if (it && it.total != null && (biggest < 0 || it.total > converted[biggest].total)) biggest = i
          })
          if (biggest >= 0) converted[biggest] = { ...converted[biggest], total: round2(converted[biggest].total + residual) }
        }
        newItems = converted
      }
      const updated = await api.saleReceipts.update(receipt.id, {
        currency: targetCurrency,
        subtotal: result.lines.subtotal,
        tps: result.lines.tps,
        tvq: result.lines.tvq,
        other_taxes: result.lines.otherTaxes,
        total: result.targetTotal,
        ...(priced.length ? { items: newItems } : {}),
      })
      onApplied?.(updated)
      onClose?.()
    } catch (e) {
      setApplyError(e.message || 'Échec de l’application')
    } finally {
      setApplying(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Conversion de devise" size="lg">
      <p className="text-xs text-slate-500 -mt-1 mb-4">
        Comptabiliser en {targetCurrency} une facture libellée en {sourceCurrency} : chaque ligne est
        convertie au même taux, et la somme retombe au cent près sur le total converti.
      </p>

      <div className="flex items-center gap-2 mb-4 text-sm">
        <CurrencyPicker value={sourceCurrency} onChange={setSourceCurrency} label="Devise de la facture" />
        <ArrowRight size={14} className="text-slate-400 mt-5" />
        <CurrencyPicker value={targetCurrency} onChange={setTargetCurrency} label="Devise de comptabilisation" />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* Saisie — la facture telle qu'elle est libellée */}
        <div className="bg-slate-50 rounded-lg p-4 space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
            Facture ({sourceCurrency})
          </h3>
          {LINES.map((l, i) => (
            <AmountInput
              key={l.key}
              label={l.label}
              value={amounts[l.key]}
              autoFocus={i === 0}
              testId={`conv-${l.key}`}
              onChange={v => setAmounts(a => ({ ...a, [l.key]: v }))}
            />
          ))}
          <div className="flex items-center justify-between pt-2 mt-2 border-t border-slate-200">
            <span className="text-sm font-medium text-slate-700">Total (incluant taxes)</span>
            <span className="text-sm font-semibold tabular-nums text-slate-900" data-testid="conv-source-total">
              {fmt(sourceTotal)}
            </span>
          </div>

          <div className="pt-3 mt-1 border-t border-slate-200 space-y-2">
            <AmountInput
              label="Taux de conversion"
              value={derivedFromCharged ? (result.ok ? String(round4(result.rate)) : '') : rateInput}
              testId="conv-rate-input"
              onChange={v => { setCharged(''); setRateInput(v) }}
              hint={derivedFromCharged ? 'déduit du montant débité' : null}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => { setCharged(''); if (marketRate != null) setRateInput(String(round4(marketRate))) }}
                disabled={marketRate == null}
                data-testid="conv-use-boc"
                className="text-[11px] text-slate-500 hover:text-slate-800 underline decoration-dotted disabled:opacity-40 disabled:no-underline"
              >
                {loadingRate
                  ? 'Taux Banque du Canada…'
                  : marketRate != null
                    ? `Taux Banque du Canada ${receiptDate ? `au ${receiptDate}` : 'du jour'} : ${marketRate.toFixed(4)}`
                    : `Taux Banque du Canada indisponible${marketError ? ` (${marketError})` : ''}`}
              </button>
            </div>
            <AmountInput
              label={`Montant débité (${targetCurrency})`}
              value={charged}
              testId="conv-charged"
              onChange={setCharged}
              hint="facultatif — si la carte a converti elle-même"
            />
          </div>
        </div>

        {/* Résultat — la facture convertie, prête à comptabiliser */}
        <div className="rounded-lg p-4 space-y-2 border border-slate-200">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
            À comptabiliser ({targetCurrency})
          </h3>
          {!result.ok ? (
            <p className="text-sm text-slate-400 py-6 text-center">{result.error}</p>
          ) : (
            <>
              <div className="flex items-baseline justify-between pb-2 mb-1 border-b border-slate-100">
                <span className="text-sm text-slate-600">Taux appliqué</span>
                <span className="text-sm font-semibold tabular-nums text-slate-900" data-testid="conv-rate">
                  {result.rate.toFixed(6)}
                </span>
              </div>
              {LINES.map(l => (
                <div key={l.key} className="flex items-center justify-between">
                  <span className="text-sm text-slate-600">{l.label}</span>
                  <span className="text-sm tabular-nums text-slate-900" data-testid={`conv-out-${l.key}`}>
                    {fmt(result.lines[l.key])}
                  </span>
                </div>
              ))}
              <div className="flex items-center justify-between pt-2 mt-2 border-t border-slate-200">
                <span className="text-sm font-medium text-slate-700">Total</span>
                <span className="text-sm font-semibold tabular-nums text-slate-900" data-testid="conv-out-total">
                  {fmt(result.targetTotal)}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Contrôle</span>
                <span className="tabular-nums">{fmt(result.control)}</span>
              </div>

              {spread != null && Math.abs(spread) >= 0.01 && (
                <p className="pt-3 mt-2 border-t border-slate-100 text-[11px] text-slate-500">
                  Écart avec le taux Banque du Canada :{' '}
                  <strong className={Math.abs(spread) >= 3 ? 'text-amber-600' : 'text-slate-600'}>
                    {spread > 0 ? '+' : ''}{fmt(spread)} %
                  </strong>
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {applyError && <p className="mt-3 text-sm text-red-600">{applyError}</p>}

      <div className="flex items-center justify-end gap-2 mt-5">
        <button
          type="button"
          onClick={copyText}
          disabled={!result.ok}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 px-3 py-1.5 rounded transition-colors"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copié' : 'Copier'}
        </button>
        {receipt && (
          <button
            type="button"
            onClick={applyToReceipt}
            disabled={!result.ok || applying}
            data-testid="conv-apply"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50 px-3 py-1.5 rounded transition-colors"
          >
            {applying ? 'Application…' : `Convertir le document en ${targetCurrency}`}
          </button>
        )}
      </div>
    </Modal>
  )
}

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000
}

const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP']

function CurrencyPicker({ value, onChange, label }) {
  return (
    <label className="flex-1">
      <span className="block text-[11px] text-slate-500 mb-1">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full text-sm border border-slate-300 rounded px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-brand-400"
      >
        {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
    </label>
  )
}
