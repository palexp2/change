// Génération d'une cédule d'amortissement pour une dette à long terme.
//
// Modèle : intérêt simple périodique (taux annuel / nombre de périodes), le même
// que celui des prêteurs de l'entreprise (« taux effectif, périodes égales » côté
// Ville de Québec, capital seul côté DEC à 0 %). À chaque période :
//   intérêt = arrondi2(solde × taux annuel / périodes)
//   capital = versement − intérêt (borné au solde restant sur le dernier versement)
// Le dernier versement absorbe l'arrondi : il rembourse exactement le solde
// restant, ce qui fait tomber la cédule à 0,00 $ sans résidu.
//
// Reproduit à la cenne près les calendriers officiels (vérifié sur le calendrier
// FLI 250 k$ de la Ville de Québec et sur l'avis de versement DEC 600072453).

export const FREQUENCIES = {
  weekly: { periods: 52, label: 'Hebdomadaire' },
  biweekly: { periods: 26, label: 'Aux 2 semaines' },
  monthly: { periods: 12, label: 'Mensuelle' },
  quarterly: { periods: 4, label: 'Trimestrielle' },
}

const MAX_PAYMENTS = 600

const round2 = n => Math.round(n * 100) / 100
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Date de la n-ième occurrence après `first`. Pour les cadences mensuelles et
// trimestrielles on conserve le quantième du premier versement, borné à la fin
// du mois (un versement le 31 tombe le 30 en avril).
function occurrence(firstIso, frequency, index) {
  const [y, m, d] = firstIso.split('-').map(Number)
  if (frequency === 'weekly' || frequency === 'biweekly') {
    const step = frequency === 'weekly' ? 7 : 14
    const dt = new Date(y, m - 1, d, 12)
    dt.setDate(dt.getDate() + step * index)
    return iso(dt)
  }
  const monthStep = frequency === 'quarterly' ? 3 : 1
  const target = new Date(y, m - 1 + monthStep * index, 1, 12)
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  return iso(new Date(target.getFullYear(), target.getMonth(), Math.min(d, lastDay), 12))
}

// Versement d'une annuité classique quand l'utilisateur donne un nombre de
// versements plutôt qu'un montant.
function annuityPayment(balance, ratePerPeriod, n) {
  if (ratePerPeriod === 0) return round2(balance / n)
  return round2(balance * ratePerPeriod / (1 - Math.pow(1 + ratePerPeriod, -n)))
}

/**
 * @returns {{ rows: Array, error: string|null, totals: object }}
 * rows = [{ payment_date, principal, interest, balance_after }]
 */
export function generateSchedule({
  opening_balance,
  annual_rate = 0,
  frequency = 'monthly',
  payment_amount = null,
  n_payments = null,
  first_payment_date,
} = {}) {
  const fail = error => ({ rows: [], error, totals: null })

  const balance0 = Number(opening_balance)
  if (!Number.isFinite(balance0) || balance0 <= 0) return fail("Le solde d'ouverture doit être un montant positif")
  const rate = Number(annual_rate)
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) return fail('Le taux annuel doit être entre 0 et 100 %')
  if (!FREQUENCIES[frequency]) return fail('Fréquence invalide')
  if (!isDate(first_payment_date)) return fail('Date du premier versement invalide (AAAA-MM-JJ)')

  const count = n_payments == null || n_payments === '' ? null : Number(n_payments)
  if (count != null && (!Number.isInteger(count) || count < 1 || count > MAX_PAYMENTS)) {
    return fail(`Le nombre de versements doit être un entier entre 1 et ${MAX_PAYMENTS}`)
  }
  let payment = payment_amount == null || payment_amount === '' ? null : Number(payment_amount)
  if (payment != null && (!Number.isFinite(payment) || payment <= 0)) return fail('Le montant du versement doit être positif')
  if (payment == null && count == null) return fail('Indiquer le montant du versement ou le nombre de versements')

  const ratePerPeriod = rate / 100 / FREQUENCIES[frequency].periods
  if (payment == null) payment = annuityPayment(balance0, ratePerPeriod, count)

  // Un versement qui ne couvre pas les intérêts de la première période fait
  // gonfler la dette indéfiniment — on refuse plutôt que de boucler.
  const firstInterest = round2(balance0 * ratePerPeriod)
  if (count == null && payment <= firstInterest) {
    return fail(`Le versement (${payment.toFixed(2)} $) ne couvre pas les intérêts de la période (${firstInterest.toFixed(2)} $)`)
  }

  const rows = []
  let balance = round2(balance0)
  let i = 0
  while (balance > 0.004 && i < (count ?? MAX_PAYMENTS)) {
    const interest = round2(balance * ratePerPeriod)
    let principal = round2(payment - interest)
    const isLastByCount = count != null && i === count - 1
    // Le dernier versement absorbe aussi la dérive d'arrondi accumulée (au plus
    // 1 ¢ par période) : sans ça la cédule traîne un versement final de quelques
    // cennes que le prêteur, lui, replie dans l'avant-dernier (ex. 4 664,27 $ au
    // lieu de 4 664,11 $ + 0,16 $ sur le FLI de la Ville de Québec).
    const drift = 0.01 * (i + 2)
    if (principal >= balance || balance - principal <= drift || isLastByCount) principal = balance
    balance = round2(balance - principal)
    rows.push({
      payment_date: occurrence(first_payment_date, frequency, i),
      principal,
      interest,
      balance_after: balance,
    })
    i++
  }
  if (balance > 0.004) {
    return fail(`La cédule dépasse ${MAX_PAYMENTS} versements — augmenter le montant du versement`)
  }

  return {
    rows,
    error: null,
    totals: {
      count: rows.length,
      principal: round2(rows.reduce((s, r) => s + r.principal, 0)),
      interest: round2(rows.reduce((s, r) => s + r.interest, 0)),
      total: round2(rows.reduce((s, r) => s + r.principal + r.interest, 0)),
      first_date: rows[0]?.payment_date || null,
      last_date: rows[rows.length - 1]?.payment_date || null,
    },
  }
}
