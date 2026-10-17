import { forwardRef, useEffect, useState } from 'react'

// Remplaçants de <input type="date"> et <input type="datetime-local"> : les
// sélecteurs natifs suivent la langue du navigateur (« 10/16/2026, 02:05 PM »
// en anglais). Ici, texte AAAA-MM-JJ [HH:MM] partout ; un clic ouvre le
// calendrier de l'app (data-date-picker, cf. DatePickerHost).
// Même contrat qu'un input natif : `value` ou `defaultValue`, `onChange(e)` /
// `onBlur(e)` avec `e.target.value` au format natif (YYYY-MM-DD,
// YYYY-MM-DDTHH:MM). onChange ne part qu'avec une valeur complète et valide
// (ou vide) ; au blur, une saisie invalide revient à la dernière valeur valide.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/

export function isValidIsoDate(s) {
  if (!ISO_DATE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

// Texte saisi → valeur native, '' si vide, null si invalide.
const parseDate = s => (s === '' ? '' : isValidIsoDate(s) ? s : null)
function parseDateTime(s) {
  if (s === '') return ''
  const m = s.match(ISO_DATETIME)
  if (!m || !isValidIsoDate(m[1]) || Number(m[2]) > 23 || Number(m[3]) > 59) return null
  return `${m[1]}T${m[2].padStart(2, '0')}:${m[3]}`
}

const nativeEvent = (e, value) => ({ target: { value, name: e.target.name }, currentTarget: e.currentTarget, nativeEvent: e.nativeEvent })

function makeInput({ toText, parse, width, picker }) {
  return forwardRef(function IsoInput({ value, defaultValue, onChange, onBlur, onKeyDown, className = 'input', ...rest }, ref) {
    const controlled = value !== undefined
    const external = toText(controlled ? value : defaultValue)
    const [local, setLocal] = useState(external)
    useEffect(() => { if (controlled) setLocal(external) }, [controlled, external])
    const [lastValid, setLastValid] = useState(external)
    useEffect(() => { setLastValid(external) }, [external])

    const change = e => {
      const text = e.target.value
      setLocal(text)
      const v = parse(text.trim())
      if (v == null) return
      setLastValid(toText(v))
      onChange?.(nativeEvent(e, v))
    }
    const blur = e => {
      let v = parse(local.trim())
      if (v == null) { v = parse(lastValid) ?? ''; setLocal(lastValid) }
      onBlur?.(nativeEvent(e, v))
    }
    return (
      <input
        ref={ref}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        size={width}
        {...(picker ? { 'data-date-picker': '' } : {})}
        value={local}
        onChange={change}
        onBlur={blur}
        onKeyDown={e => { if (e.key === 'Enter' && !onKeyDown) e.currentTarget.blur(); onKeyDown?.(e) }}
        className={`${className} tabular-nums`}
        {...rest}
      />
    )
  })
}

export const DateInput = makeInput({
  toText: v => (v == null ? '' : String(v).slice(0, 10)),
  parse: parseDate,
  width: 10,
  picker: true,
})

export const DateTimeInput = makeInput({
  toText: v => (v == null ? '' : String(v).slice(0, 16).replace('T', ' ')),
  parse: parseDateTime,
  width: 16,
  picker: false,
})

export default DateInput
