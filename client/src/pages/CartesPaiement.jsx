// Cartes de paiement — registre des cartes de l'entreprise et des cartes
// personnelles que les employés avancent parfois. Les 4 derniers chiffres lus
// sur une facture désignent le compte qui a payé (compte de la carte, ou compte
// « … (rembourser à) » du porteur).
import { CreditCard } from 'lucide-react'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { PaymentCardsPanel } from '../components/PaymentCardsPanel.jsx'

export default function CartesPaiement() {
  return (
    <Layout>
      <div className="p-6">
        <PageTitle icon={CreditCard} accent="compta">Cartes de paiement</PageTitle>
        <div className="mt-5">
          <PaymentCardsPanel />
        </div>
      </div>
    </Layout>
  )
}
