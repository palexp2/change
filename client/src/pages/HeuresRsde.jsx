import { useState, useEffect } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { fmtMoney } from '../utils/formatters.js'

// Heures R&D de l'entreprise, par mois (RH). Sortie de la feuille de temps
// (ancien bouton « Orisha »), Pierre-Alexandre, 2026-10-08.
export default function HeuresRsde() {
  return (
    <Layout>
      <div className="p-6">
        <div className="mb-6"><PageTitle>Heures RSDE</PageTitle></div>
        <RdYearTable />
      </div>
    </Layout>
  )
}

const MONTH_SHORT = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc']
const fmtH1 = (v) => v ? (Math.round(v * 10) / 10).toString().replace('.', ',') : ''
function currentFiscalYear() {
  const t = new Date()
  return t.getMonth() >= 3 ? t.getFullYear() : t.getFullYear() - 1
}

// Tableau en lecture seule : les heures R&D viennent des feuilles de temps.
function HoursCell({ value }) {
  return <span className="tabular-nums text-slate-700">{fmtH1(value)}</span>
}

function RdYearTable() {
  const [fy, setFy] = useState(currentFiscalYear)
  const [data, setData] = useState(null)
  const [project, setProject] = useState('')
  useEffect(() => {
    api.monthEnd.hoursYear(fy).then(setData).catch(() => setData({ months: [], people: [] }))
  }, [fy])

  if (!data) return null
  const months = data.months || []
  const valueOf = (cell) => {
    if (!cell) return 0
    if (!project) return cell.hours
    return Number(cell.projects?.[project]) || 0
  }
  const people = data.people || []
  const employees = people.filter(p => !p.contractor)
  const contractors = people.filter(p => p.contractor)
  const sum = (list, m) => list.reduce((s, p) => s + valueOf(p.months[m]), 0)
  const rowTotal = (p) => months.reduce((s, m) => s + valueOf(p.months[m]), 0)
  const empTotal = employees.reduce((s, p) => s + rowTotal(p), 0)
  const conTotal = contractors.reduce((s, p) => s + rowTotal(p), 0)
  const th = 'text-right px-2 py-2 font-semibold whitespace-nowrap'

  const personRow = (p) => (
    <tr key={`${p.contractor}-${p.employee_name}`} className="border-t border-slate-100">
      <td className="px-3 py-1.5 whitespace-nowrap">{p.employee_name}</td>
      {months.map(m => (
        <td key={m} className="px-2 py-1.5 text-right">
          <HoursCell value={valueOf(p.months[m])} />
        </td>
      ))}
      <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{fmtH1(rowTotal(p)) || '—'}</td>
    </tr>
  )

  return (
    <div className="card overflow-hidden" data-testid="rd-year-table">
      <div className="flex items-center gap-3 px-3 py-2.5 border-b border-slate-100 flex-wrap">
        <div className="flex items-center gap-1 text-sm">
          <button onClick={() => setFy(y => y - 1)} className="p-1 text-slate-400 hover:text-slate-600" aria-label="Année précédente"><ChevronLeft size={16} /></button>
          <span className="font-medium text-slate-700 tabular-nums">{fy}-{fy + 1}</span>
          <button onClick={() => setFy(y => y + 1)} className="p-1 text-slate-400 hover:text-slate-600" aria-label="Année suivante"><ChevronRight size={16} /></button>
        </div>
        <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs">
          {['', 'Fiabilité', 'Intelligence de contrôle'].map((p, i) => (
            <button key={p || 'all'} onClick={() => setProject(p)}
              className={`px-2.5 py-1 ${i ? 'border-l border-slate-200' : ''} ${project === p ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{p || 'Tous'}</button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-xs text-slate-500">
              <th className="text-left px-3 py-2 font-semibold">Employés</th>
              {months.map(m => <th key={m} className={th}>{MONTH_SHORT[Number(m.slice(5, 7)) - 1]}</th>)}
              <th className={th}>Total</th>
            </tr>
          </thead>
          <tbody>
            {employees.map(personRow)}
            <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
              <td className="px-3 py-1.5">Total</td>
              {months.map(m => <td key={m} className="px-2 py-1.5 text-right tabular-nums">{fmtH1(sum(employees, m))}</td>)}
              <td className="px-2 py-1.5 text-right tabular-nums">{fmtH1(empTotal) || '—'}</td>
            </tr>
            {contractors.length > 0 && (<>
              <tr><td colSpan={months.length + 2} className="px-3 pt-4 pb-1 text-xs font-semibold text-slate-500 uppercase tracking-wide">Sous-traitants</td></tr>
              {contractors.map(personRow)}
              <tr className="border-t border-slate-100 text-slate-600">
                <td className="px-3 py-1.5">Taux horaire</td>
                <td className="px-2 py-1.5 text-right"><HoursCell value={data.contractor_hourly_rate} /></td>
                <td colSpan={months.length - 1}></td>
                <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-slate-900">{fmtMoney(conTotal * (data.contractor_hourly_rate || 0))}</td>
              </tr>
            </>)}
            <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
              <td className="px-3 py-1.5">Total des heures R&amp;D</td>
              <td colSpan={months.length}></td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmtH1(empTotal + conTotal) || '—'}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
