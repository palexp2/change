// Registre des cartes de paiement : 4 derniers chiffres → compte QuickBooks payeur.
// Une carte de l'entreprise pointe sur son compte de carte ; une carte personnelle
// d'employé pointe sur son compte « … (rembourser à) ». La lecture d'une facture
// reconnaît les chiffres imprimés et pré-sélectionne ce compte à la publication.
import { useState, useEffect, useCallback } from 'react'
import { CreditCard, Plus, Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import { DataTable } from './DataTable.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'
import { Badge } from './Badge.jsx'
import { useToast } from '../contexts/ToastContext.jsx'

const inputCls = 'px-2 py-1 text-sm border border-slate-200 rounded-md w-full focus:outline-none focus:ring-2 focus:ring-brand-500/30'

export function PaymentCardsPanel() {
  const { addToast } = useToast()
  const [cards, setCards] = useState([])
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    api.paymentCards.list()
      .then(r => setCards(r.data || []))
      .catch(e => addToast(e.message, 'error'))
      .finally(() => setLoading(false))
  }, [addToast])

  useEffect(() => { load() }, [load])
  useEffect(() => { api.quickbooks.accounts().then(setAccounts).catch(() => {}) }, [])

  const accountOptions = accounts.map(a => ({ value: a.Id, label: a.Name }))

  const save = (id, patch) => api.paymentCards.update(id, patch)
    .then(row => setCards(cs => cs.map(c => (c.id === id ? row : c))))
    .catch(e => addToast(e.message, 'error'))

  const remove = (row) => {
    if (!window.confirm(`Retirer la carte ••${row.last4} ?`)) return
    api.paymentCards.delete(row.id).then(load).catch(e => addToast(e.message, 'error'))
  }

  const createCard = () => {
    api.paymentCards.create(draft)
      .then(() => { setDraft(null); load() })
      .catch(e => addToast(e.message, 'error'))
  }

  const columns = [
    { id: 'last4', field: 'last4', label: '4 chiffres', width: 110,
      render: r => <span className="font-mono">••{r.last4}</span> },
    { id: 'holder', field: 'holder', label: 'Porteur', width: 220 },
    { id: 'card_type', field: 'card_type', label: 'Type', width: 110 },
    { id: 'ownership', field: 'ownership', label: 'Appartenance', width: 130,
      render: r => <Badge color={r.ownership === 'company' ? 'blue' : 'amber'}>
        {r.ownership === 'company' ? 'Entreprise' : 'Personnelle'}</Badge> },
    { id: 'qb_account_name', field: 'qb_account_name', label: 'Compte comptable', width: 280,
      render: r => (
        <div onClick={e => e.stopPropagation()}>
          <SearchableSelect
            value={r.qb_account_id || ''}
            options={accountOptions}
            emptyOption="—"
            onChange={v => save(r.id, {
              qb_account_id: v || null,
              qb_account_name: accounts.find(a => a.Id === v)?.Name || null,
            })}
          />
        </div>
      ) },
    { id: 'active', field: 'active', label: 'Active', width: 80,
      render: r => (
        <input type="checkbox" checked={!!r.active} onClick={e => e.stopPropagation()}
          onChange={e => save(r.id, { active: e.target.checked })} />
      ) },
    { id: 'actions', field: 'id', label: '', width: 60, sortable: false,
      render: r => (
        <button onClick={e => { e.stopPropagation(); remove(r) }}
          className="p-1 text-slate-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
      ) },
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <CreditCard className="w-4 h-4" />
          Les chiffres lus sur une facture choisissent le compte qui a payé.
        </div>
        <button onClick={() => setDraft({ holder: '', card_type: '', last4: '', ownership: 'personal' })}
          data-testid="card-add"
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg">
          <Plus className="w-4 h-4" /> Ajouter
        </button>
      </div>

      {draft && (
        <div className="mb-3 flex flex-wrap items-center gap-2 p-3 border border-slate-200 rounded-lg bg-slate-50">
          <input className={`${inputCls} w-40`} value={draft.holder} data-testid="card-holder"
            onChange={e => setDraft({ ...draft, holder: e.target.value })} />
          <input className={`${inputCls} w-28`} value={draft.card_type}
            onChange={e => setDraft({ ...draft, card_type: e.target.value })} />
          <input className={`${inputCls} w-24 font-mono`} value={draft.last4} maxLength={4} data-testid="card-last4"
            onChange={e => setDraft({ ...draft, last4: e.target.value.replace(/\D/g, '') })} />
          <select className={`${inputCls} w-36`} value={draft.ownership}
            onChange={e => setDraft({ ...draft, ownership: e.target.value })}>
            <option value="personal">Personnelle</option>
            <option value="company">Entreprise</option>
          </select>
          <div className="w-64">
            <SearchableSelect value={draft.qb_account_id || ''} options={accountOptions} emptyOption="—"
              onChange={v => setDraft({ ...draft, qb_account_id: v || null, qb_account_name: accounts.find(a => a.Id === v)?.Name || null })} />
          </div>
          <button onClick={createCard} data-testid="card-save"
            className="px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg">Enregistrer</button>
          <button onClick={() => setDraft(null)} className="px-3 py-1.5 text-sm text-slate-600">Annuler</button>
        </div>
      )}

      <DataTable
        table="payment_cards"
        columns={columns}
        data={cards}
        loading={loading}
        searchFields={['holder', 'last4', 'qb_account_name']}
        height="calc(100vh - 380px)"
      />
    </div>
  )
}
