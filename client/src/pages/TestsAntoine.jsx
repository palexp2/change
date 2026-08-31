// Tests – Antoine : import MAPAQ des exploitations agricoles en serre.
//
// Sens unique (externe → ERP) et déclenchement manuel — aucune sync planifiée.
// Le rapport est un APERÇU : rien n'est écrit tant qu'on n'a pas coché des
// lignes et cliqué « Créer les prospects sélectionnés ». Les entrées classées
// « déjà existante » ne sont jamais créées ni mises à jour côté serveur : une
// fiche enrichie à la main n'est pas écrasée.
import { useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { FlaskConical, RefreshCw, Upload, Sprout, AlertTriangle, UserPlus } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { useToast } from '../contexts/ToastContext.jsx'

const CATEGORY_META = {
  nouvelle: { label: 'Nouvelle', color: 'green' },
  doublon: { label: 'Doublon probable', color: 'amber' },
  existante: { label: 'Déjà existante', color: 'gray' },
}

const inputCls = 'px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400'

const COLUMNS = [
  {
    id: 'category_label', field: 'category_label', label: 'Classement', width: 160,
    render: row => {
      const meta = CATEGORY_META[row.category] || CATEGORY_META.nouvelle
      return <Badge color={meta.color}>{meta.label}</Badge>
    },
  },
  { id: 'name', field: 'name', label: 'Exploitation (MAPAQ)', width: 260 },
  { id: 'address', field: 'address', label: 'Adresse', width: 240 },
  { id: 'city', field: 'city', label: 'Municipalité', width: 150 },
  { id: 'region', field: 'region', label: 'Région', width: 150 },
  { id: 'production', field: 'production', label: 'Production', width: 180 },
  {
    id: 'match_company_name', field: 'match_company_name', label: 'Correspondance ERP', width: 240,
    // Règle « champs référence » : le record apparié est un lien vers sa fiche.
    render: row => (row.match_company_id
      ? <Link to={`/companies/${row.match_company_id}`} className="text-brand-600 hover:underline"
          onClick={e => e.stopPropagation()}>{row.match_company_name}</Link>
      : <span className="text-slate-400">—</span>),
  },
  {
    id: 'match_score', field: 'match_score', label: 'Score', width: 90, align: 'right',
    render: row => (row.match_score == null ? <span className="text-slate-400">—</span> : `${row.match_score} %`),
  },
]

export default function TestsAntoine() {
  const { addToast } = useToast()
  const [region, setRegion] = useState('')
  const [csv, setCsv] = useState('')
  const [fileName, setFileName] = useState('')
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const fileRef = useRef(null)

  const runPreview = useCallback(async (csvText = csv) => {
    setLoading(true)
    try {
      const r = await api.mapaq.preview({ region: region.trim() || null, csv: csvText || null })
      setReport(r)
      if (!r.source?.available && !r.entries.length) {
        addToast(r.source?.reason || 'Aucune donnée disponible', 'error')
      }
    } catch (e) {
      addToast(e.message || "L'aperçu a échoué", 'error')
    } finally {
      setLoading(false)
    }
  }, [csv, region, addToast])

  const onFile = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    setCsv(text)
    setFileName(file.name)
    runPreview(text)
  }, [runPreview])

  const createSelected = useCallback(async (refs) => {
    const entries = (report?.entries || []).filter(x => refs.includes(x.ref))
    if (!entries.length) return
    setCreating(true)
    try {
      const r = await api.mapaq.createProspects(entries.map(x => ({
        ref: x.ref, name: x.name, address: x.address, city: x.city,
        postal_code: x.postal_code, region: x.region, production: x.production,
        phone: x.phone, email: x.email, website: x.website,
      })))
      const skipped = r.skipped?.length || 0
      addToast(
        `${r.created.length} prospect(s) créé(s)${skipped ? ` — ${skipped} ignoré(s) (déjà dans l'ERP)` : ''}`,
        r.created.length ? 'success' : 'info',
      )
      await runPreview()
    } catch (e) {
      addToast(e.message || 'La création a échoué', 'error')
    } finally {
      setCreating(false)
    }
  }, [report, addToast, runPreview])

  // `category` porte le classement (nouvelle / doublon / existante) ; la
  // catégorie de production MAPAQ vit dans `production`, pour ne pas les
  // confondre. `id` double `ref` : le DataTable s'en sert pour la sélection.
  const rows = (report?.entries || []).map(e => ({ ...e, id: e.ref }))

  const c = report?.counts

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <PageTitle icon={FlaskConical} accent="compta">Tests – Antoine</PageTitle>
            <p className="text-xs text-slate-500 mt-2 max-w-3xl">
              Import du registre des <strong>exploitations agricoles en serre</strong> du MAPAQ, en
              <strong> mode aperçu</strong> : chaque entrée est rapprochée des entreprises de l'ERP et classée
              « nouvelle », « doublon probable » ou « déjà existante ». <strong>Rien n'est écrit</strong> avant
              d'avoir coché des lignes et cliqué « Créer les prospects sélectionnés ». Sens unique, déclenchement
              manuel.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <input className={`${inputCls} w-44`} placeholder="Région (optionnel)" value={region}
              data-testid="mapaq-region" onChange={e => setRegion(e.target.value)} />
            <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" className="hidden"
              data-testid="mapaq-file" onChange={onFile} />
            <button onClick={() => fileRef.current?.click()} data-testid="mapaq-upload"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg">
              <Upload className="w-4 h-4" /> Fichier MAPAQ
            </button>
            <button onClick={() => runPreview()} disabled={loading} data-testid="mapaq-run"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              {loading ? 'Analyse…' : "Lancer l'aperçu"}
            </button>
          </div>
        </div>

        {/* Zone de collage : le registre MAPAQ n'étant pas publié sur Données
            Québec, coller le CSV reste le chemin qui donne des lignes. */}
        <details className="mb-4 text-sm" data-testid="mapaq-paste-block">
          <summary className="cursor-pointer text-slate-600 hover:text-slate-900 select-none">
            Coller le contenu CSV du MAPAQ {fileName && <span className="text-slate-400">— {fileName}</span>}
          </summary>
          <textarea
            className={`${inputCls} mt-2 w-full font-mono text-xs`} rows={5} value={csv}
            data-testid="mapaq-csv"
            placeholder="Nom de l'exploitation;Adresse;Municipalité;Région;Catégorie de production"
            onChange={e => { setCsv(e.target.value); setFileName('') }}
          />
        </details>

        {report && (
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs" data-testid="mapaq-source">
            <Badge color={report.source?.available ? 'green' : 'red'}>
              {report.source?.available ? 'Source disponible' : 'Source indisponible'}
            </Badge>
            <span className="text-slate-600">{report.source?.label}</span>
            {!report.source?.available && report.source?.reason && (
              <span className="text-slate-500">— {report.source.reason}</span>
            )}
          </div>
        )}

        {report?.warnings?.length > 0 && (
          <div className="mb-4 space-y-1" data-testid="mapaq-warnings">
            {report.warnings.map((w, i) => (
              <div key={i} className="flex items-start gap-1.5 text-xs text-amber-700">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> <span>{w}</span>
              </div>
            ))}
          </div>
        )}

        {c && (
          <div className="mb-4 flex flex-wrap gap-2 text-xs" data-testid="mapaq-counts">
            <span className="px-2 py-1 rounded-md bg-slate-100 text-slate-700">
              {c.greenhouse} en serre / {c.total_source} lignes source
            </span>
            <span className="px-2 py-1 rounded-md bg-green-50 text-green-700" data-testid="mapaq-count-nouvelle">
              {c.nouvelle} nouvelle(s)
            </span>
            <span className="px-2 py-1 rounded-md bg-amber-50 text-amber-700" data-testid="mapaq-count-doublon">
              {c.doublon} doublon(s) probable(s)
            </span>
            <span className="px-2 py-1 rounded-md bg-slate-100 text-slate-600" data-testid="mapaq-count-existante">
              {c.existante} déjà existante(s)
            </span>
          </div>
        )}

        <DataTable
          table="mapaq_import"
          columns={COLUMNS}
          data={rows}
          loading={loading}
          rowKey="ref"
          searchFields={['name', 'city', 'region', 'match_company_name']}
          bulkDeleteAlways
          bulkActions={[{
            key: 'create-prospects',
            label: 'Créer les prospects sélectionnés',
            icon: UserPlus,
            busyLabel: 'Création…',
            onClick: createSelected,
          }]}
          height="calc(100vh - 420px)"
          emptyState={{
            icon: Sprout,
            title: 'Aucun aperçu',
            description: report
              ? "Aucune exploitation en serre à proposer pour cette source. Fournir le fichier CSV du MAPAQ ci-dessus."
              : "Lancer l'aperçu ou fournir le fichier CSV du MAPAQ pour voir les exploitations en serre à rapprocher.",
          }}
        />
        {creating && <div className="mt-2 text-xs text-slate-500">Création des prospects en cours…</div>}
      </div>
    </Layout>
  )
}
