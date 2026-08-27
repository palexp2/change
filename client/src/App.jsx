import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom'
import { useEffect } from 'react'
import { AuthProvider, useAuth } from './lib/auth.jsx'
import { NavPrefsProvider } from './lib/navPrefs.jsx'
import { DecimalPrefsProvider } from './lib/decimalPrefs.jsx'
import { notifyNavigation } from './lib/pageLoadTracker.js'
import { useTrackRecentVisit } from './lib/useRecentRecords.js'
import { startDataSync, stopDataSync, isDataSyncStarted } from './lib/dataSync.js'
import { inspectStore } from './lib/dataStore.js'
import { ToastProvider } from './contexts/ToastContext.jsx'
import { ConfirmProvider } from './components/ConfirmProvider.jsx'
import { UndoSendProvider } from './components/UndoSendProvider.jsx'
import { TravauxQuickProvider } from './components/TravauxQuickPanel.jsx'
import ServerOfflineOverlay from './components/ServerOfflineOverlay.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { useFavicon } from './hooks/useFavicon.js'
import { legacyFinanceTarget } from './lib/financeSections.js'

import Login from './pages/Login.jsx'
import Setup from './pages/Setup.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Pipeline from './pages/Pipeline.jsx'
import ProjectFields from './pages/ProjectFields.jsx'
import Orders from './pages/Orders.jsx'
import OrderDetail from './pages/OrderDetail.jsx'
import Products from './pages/Products.jsx'
import ProductDetail from './pages/ProductDetail.jsx'
import Tickets from './pages/Tickets.jsx'
import TicketDetail from './pages/TicketDetail.jsx'
import Admin from './pages/Admin.jsx'
import Interactions from './pages/Interactions.jsx'
import Connectors from './pages/Connectors.jsx'
import Purchases from './pages/Purchases.jsx'
import PurchaseDetail from './pages/PurchaseDetail.jsx'
import SerialNumbers from './pages/SerialNumbers.jsx'
import SerialDetail from './pages/SerialDetail.jsx'
import SerialAccountingRules from './pages/SerialAccountingRules.jsx'
import Retours from './pages/Retours.jsx'
import RetourDetail from './pages/RetourDetail.jsx'
import Factures from './pages/Factures.jsx'
import FactureDetail from './pages/FactureDetail.jsx'
import Paiements from './pages/Paiements.jsx'
import PaiementsEmis from './pages/PaiementsEmis.jsx'
import ItemsVendus from './pages/ItemsVendus.jsx'
import Abonnements from './pages/Abonnements.jsx'
import AbonnementMouvements from './pages/AbonnementMouvements.jsx'
import Assemblages from './pages/Assemblages.jsx'
import PrioriteAssemblage from './pages/PrioriteAssemblage.jsx'
import ProjectDetail from './pages/ProjectDetail.jsx'
import SoumissionDetail from './pages/SoumissionDetail.jsx'
import Envois from './pages/Envois.jsx'
import EnvoisDetail from './pages/EnvoisDetail.jsx'
import Automations from './pages/Automations.jsx'
import AutomationDetail from './pages/AutomationDetail.jsx'
import Tasks from './pages/Tasks.jsx'
import RelanceQualification from './pages/RelanceQualification.jsx'
import QualificationCall from './pages/QualificationCall.jsx'
import Agent from './pages/Agent.jsx'
import AchatsFournisseurs from './pages/AchatsFournisseurs.jsx'
import VendorSubscriptions from './pages/VendorSubscriptions.jsx'
import VendorProfiles from './pages/VendorProfiles.jsx'
import PrepaidAccounts from './pages/PrepaidAccounts.jsx'
import DriveInventory from './pages/DriveInventory.jsx'
import FinDeMois from './pages/FinDeMois.jsx'
import Travaux from './pages/Travaux.jsx'
import DettesLT from './pages/DettesLT.jsx'
import InvoiceCollection from './pages/InvoiceCollection.jsx'
import MarketingBudget from './pages/MarketingBudget.jsx'
import InstagramProspects from './pages/InstagramProspects.jsx'
import ComptaDashboard from './pages/ComptaDashboard.jsx'
import SaleReceipts from './pages/SaleReceipts.jsx'
import SaleReceiptDetail from './pages/SaleReceiptDetail.jsx'
import JournalEntries from './pages/JournalEntries.jsx'
import StockMovements from './pages/StockMovements.jsx'
import RapprochementBancaire from './pages/RapprochementBancaire.jsx'
import Employees from './pages/Employees.jsx'
import EmployeeDetail from './pages/EmployeeDetail.jsx'
import FeuilleDeTemps from './pages/FeuilleDeTemps.jsx'
import CodesActivite from './pages/CodesActivite.jsx'
import BanqueHeures from './pages/BanqueHeures.jsx'
import Paies from './pages/Paies.jsx'
import Contacts from './pages/Contacts.jsx'
import ContactDetail from './pages/ContactDetail.jsx'
import Companies from './pages/Companies.jsx'
import CompanyDetail from './pages/CompanyDetail.jsx'
import StripePayouts from './pages/StripePayouts.jsx'
import StripePayoutDetail from './pages/StripePayoutDetail.jsx'
import DirectDepositDetail from './pages/DirectDepositDetail.jsx'
import CustomerPostPayment from './pages/CustomerPostPayment.jsx'
import TicketSurvey from './pages/TicketSurvey.jsx'
import DiscoveryForms from './pages/DiscoveryForms.jsx'
import PublicFiles from './pages/PublicFiles.jsx'
import Settings from './pages/Settings.jsx'
import ActivityFeed from './pages/ActivityFeed.jsx'
import Changelog from './pages/Changelog.jsx'
import Architecture from './pages/Architecture.jsx'

// Route de diagnostic : lève volontairement une erreur de rendu pour vérifier
// que l'ErrorBoundary global affiche bien son fallback (au lieu d'un écran
// blanc). Inoffensive — protégée par auth admin et jamais liée dans le menu.
function CrashTest() {
  throw new Error('Crash test volontaire (route /__boom) — vérifie l\'ErrorBoundary')
}

// Compat : /finance/<section> (première version de l'Espace finance, qui avait
// une page d'accueil à rail) → la page pleine largeur correspondante.
function LegacyFinanceRedirect() {
  const { '*': rest } = useParams()
  return <Navigate to={legacyFinanceTarget(rest)} replace />
}

function ProtectedRoute({ children, adminOnly = false, hrOnly = false }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  if (adminOnly && user.role !== 'admin') return <Navigate to="/dashboard" replace />
  if (hrOnly && !['admin', 'rh'].includes(user.role)) return <Navigate to="/dashboard" replace />
  return children
}

function AppRoutes() {
  const { user } = useAuth()
  const location = useLocation()
  useFavicon()
  useTrackRecentVisit()

  useEffect(() => {
    notifyNavigation(location.pathname + location.search)
  }, [location.pathname, location.search])

  // Cache global : bootstrap au login, arrêt au logout. Voir lib/dataSync.js.
  useEffect(() => {
    if (user && !isDataSyncStarted()) {
      startDataSync().catch((err) => console.error('[App] dataSync failed to start:', err))
      // Expose un helper de debug en console.
      if (typeof window !== 'undefined') window.__erpStore = inspectStore
    } else if (!user && isDataSyncStarted()) {
      stopDataSync()
    }
  }, [user])

  // Page d'accueil par défaut, personnalisable par utilisateur.
  // pap@orisha.io (id ci-dessous) atterrit sur /agent ; tout le monde sur /dashboard.
  // On cible par id car le JWT ne porte pas l'email (payload = { id, role, name }).
  const PAP_USER_ID = '5637ebf2-74e8-4245-9f1e-64d80b53b216'
  const homePath = user?.id === PAP_USER_ID ? '/agent' : '/dashboard'

  return (
    // key={location.pathname} : remonte le boundary à chaque navigation, ce qui
    // efface automatiquement un état d'erreur quand l'utilisateur change de page.
    <ErrorBoundary key={location.pathname}>
    <Routes>
      <Route path="/" element={<Navigate to={user ? homePath : '/login'} replace />} />
      <Route path="/login" element={user ? <Navigate to={homePath} replace /> : <Login />} />
      <Route path="/setup" element={<Setup />} />
      <Route path="/customer/post-payment" element={<CustomerPostPayment />} />
      {/* Lien public court vers le formulaire de découverte technique — accessible sans login. */}
      <Route path="/d/:token" element={<CustomerPostPayment />} />
      {/* Sondage de satisfaction envoyé par SMS — public, le jeton est le secret. */}
      <Route path="/s/:token" element={<TicketSurvey />} />

      <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
      <Route path="/dashboard/:section" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
      <Route path="/pipeline" element={<ProtectedRoute><Pipeline /></ProtectedRoute>} />
      <Route path="/projects/fields" element={<ProtectedRoute adminOnly><ProjectFields /></ProtectedRoute>} />
      {/* Contrôle des champs Airtable généralisé à tous les modules synchronisés
          (contacts, companies, pieces, orders, achats, envois…). Même page que
          /projects/fields, paramétrée par :module. */}
      <Route path="/airtable/fields/:module" element={<ProtectedRoute adminOnly><ProjectFields /></ProtectedRoute>} />
      <Route path="/orders" element={<ProtectedRoute><Orders /></ProtectedRoute>} />
      <Route path="/orders/:id" element={<ProtectedRoute><OrderDetail /></ProtectedRoute>} />
      <Route path="/products" element={<ProtectedRoute><Products /></ProtectedRoute>} />
      <Route path="/products/:id" element={<ProtectedRoute><ProductDetail /></ProtectedRoute>} />
      <Route path="/tasks" element={<ProtectedRoute><Tasks /></ProtectedRoute>} />
      <Route path="/relance-qualification" element={<ProtectedRoute><RelanceQualification /></ProtectedRoute>} />
      <Route path="/qualification-call" element={<ProtectedRoute><QualificationCall /></ProtectedRoute>} />
      <Route path="/discovery-forms" element={<ProtectedRoute><DiscoveryForms /></ProtectedRoute>} />
      <Route path="/tickets" element={<ProtectedRoute><Tickets /></ProtectedRoute>} />
      <Route path="/tickets/:id" element={<ProtectedRoute><TicketDetail /></ProtectedRoute>} />
      <Route path="/interactions" element={<ProtectedRoute><Interactions /></ProtectedRoute>} />
      <Route path="/connectors" element={<ProtectedRoute><Connectors /></ProtectedRoute>} />
      <Route path="/purchases" element={<ProtectedRoute><Purchases /></ProtectedRoute>} />
      <Route path="/purchases/:id" element={<ProtectedRoute><PurchaseDetail /></ProtectedRoute>} />
      <Route path="/serials" element={<ProtectedRoute><SerialNumbers /></ProtectedRoute>} />
      <Route path="/serials/:id" element={<ProtectedRoute><SerialDetail /></ProtectedRoute>} />
      <Route path="/comptabilite/regles-serials" element={<ProtectedRoute adminOnly><SerialAccountingRules /></ProtectedRoute>} />
      <Route path="/projects/:id" element={<ProtectedRoute><ProjectDetail /></ProtectedRoute>} />
      <Route path="/retours" element={<ProtectedRoute><Retours /></ProtectedRoute>} />
      <Route path="/retours/:id" element={<ProtectedRoute><RetourDetail /></ProtectedRoute>} />
      <Route path="/factures" element={<ProtectedRoute><Factures /></ProtectedRoute>} />
      <Route path="/factures/:id" element={<ProtectedRoute><FactureDetail /></ProtectedRoute>} />
      <Route path="/paiements" element={<ProtectedRoute><Paiements /></ProtectedRoute>} />
      {/* Paiements ÉMIS (remplace l'onglet Pmt_Suivi) — distinct de /paiements (encaissements clients) */}
      <Route path="/paiements-emis" element={<ProtectedRoute><PaiementsEmis /></ProtectedRoute>} />
      <Route path="/items-vendus" element={<ProtectedRoute><ItemsVendus /></ProtectedRoute>} />
      <Route path="/abonnements" element={<ProtectedRoute><Abonnements /></ProtectedRoute>} />
      <Route path="/abonnements/mouvements" element={<ProtectedRoute><AbonnementMouvements /></ProtectedRoute>} />
      <Route path="/assemblages" element={<ProtectedRoute><Assemblages /></ProtectedRoute>} />
      <Route path="/priorite-assemblage" element={<ProtectedRoute><PrioriteAssemblage /></ProtectedRoute>} />
      <Route path="/soumissions/:id" element={<ProtectedRoute><SoumissionDetail /></ProtectedRoute>} />
      <Route path="/envois" element={<ProtectedRoute><Envois /></ProtectedRoute>} />
      <Route path="/envois/:id" element={<ProtectedRoute><EnvoisDetail /></ProtectedRoute>} />
      <Route path="/fournisseurs" element={<ProtectedRoute><VendorProfiles /></ProtectedRoute>} />
      <Route path="/fournisseurs/achats" element={<ProtectedRoute><AchatsFournisseurs /></ProtectedRoute>} />
      <Route path="/fournisseurs/abonnements" element={<ProtectedRoute><VendorSubscriptions /></ProtectedRoute>} />
      <Route path="/achats-fournisseurs" element={<Navigate to="/fournisseurs/achats" replace />} />
      <Route path="/abonnements-fournisseurs" element={<Navigate to="/fournisseurs/abonnements" replace />} />
      <Route path="/comptes-prepayes" element={<ProtectedRoute><PrepaidAccounts /></ProtectedRoute>} />
      <Route path="/inventaire-drive" element={<ProtectedRoute><DriveInventory /></ProtectedRoute>} />
      <Route path="/fin-de-mois" element={<ProtectedRoute><FinDeMois /></ProtectedRoute>} />
      <Route path="/travaux" element={<ProtectedRoute><Travaux /></ProtectedRoute>} />
      <Route path="/dettes-lt" element={<ProtectedRoute><DettesLT /></ProtectedRoute>} />
      <Route path="/collecte-factures" element={<ProtectedRoute><InvoiceCollection /></ProtectedRoute>} />
      <Route path="/budget-marketing" element={<ProtectedRoute><MarketingBudget /></ProtectedRoute>} />
      <Route path="/prospects-instagram" element={<ProtectedRoute><InstagramProspects /></ProtectedRoute>} />
      {/* Douanes (ASFC) : le suivi CARM est devenu un onglet des Comptes prépayés
          — c'est un compte prépayé comme un autre. L'ancienne URL suit. */}
      <Route path="/douanes" element={<Navigate to="/comptes-prepayes?onglet=douanes" replace />} />
      <Route path="/comptabilite" element={<ProtectedRoute><ComptaDashboard /></ProtectedRoute>} />
      {/* Espace finance : plus de page d'accueil — l'entrée de menu déploie ses
          sections au survol et mène droit aux pages ci-dessus. Les anciennes
          URLs /finance/<section> redirigent vers la page correspondante. */}
      <Route path="/finance/*" element={<ProtectedRoute><LegacyFinanceRedirect /></ProtectedRoute>} />
      <Route path="/depenses" element={<Navigate to="/fournisseurs/achats" replace />} />
      <Route path="/factures-fournisseurs" element={<Navigate to="/fournisseurs/achats" replace />} />
      <Route path="/sale-receipts" element={<ProtectedRoute><SaleReceipts /></ProtectedRoute>} />
      <Route path="/sale-receipts/:id" element={<ProtectedRoute><SaleReceiptDetail /></ProtectedRoute>} />
      <Route path="/stripe-payouts" element={<ProtectedRoute><StripePayouts /></ProtectedRoute>} />
      <Route path="/stripe-payouts/:stripeId" element={<ProtectedRoute><StripePayoutDetail /></ProtectedRoute>} />
      <Route path="/depots-directs/:id" element={<ProtectedRoute><DirectDepositDetail /></ProtectedRoute>} />
      <Route path="/journal-entries" element={<ProtectedRoute><JournalEntries /></ProtectedRoute>} />
      <Route path="/stock-movement" element={<ProtectedRoute><StockMovements /></ProtectedRoute>} />
      <Route path="/rapprochement" element={<ProtectedRoute><RapprochementBancaire /></ProtectedRoute>} />
      <Route path="/employees" element={<ProtectedRoute hrOnly><Employees /></ProtectedRoute>} />
      <Route path="/employees/:id" element={<ProtectedRoute hrOnly><EmployeeDetail /></ProtectedRoute>} />
      <Route path="/feuille-de-temps" element={<ProtectedRoute><FeuilleDeTemps /></ProtectedRoute>} />
      <Route path="/codes-activite" element={<ProtectedRoute hrOnly><CodesActivite /></ProtectedRoute>} />
      <Route path="/banque-heures" element={<ProtectedRoute><BanqueHeures /></ProtectedRoute>} />
      <Route path="/paies" element={<ProtectedRoute><Paies /></ProtectedRoute>} />
      <Route path="/contacts" element={<ProtectedRoute><Contacts /></ProtectedRoute>} />
      <Route path="/contacts/:id" element={<ProtectedRoute><ContactDetail /></ProtectedRoute>} />
      <Route path="/companies" element={<ProtectedRoute><Companies /></ProtectedRoute>} />
      <Route path="/companies/:id" element={<ProtectedRoute><CompanyDetail /></ProtectedRoute>} />
      <Route path="/admin" element={<ProtectedRoute adminOnly><Admin /></ProtectedRoute>} />
      <Route path="/admin/:tab" element={<ProtectedRoute adminOnly><Admin /></ProtectedRoute>} />

      <Route path="/public-files" element={<ProtectedRoute><PublicFiles /></ProtectedRoute>} />
      <Route path="/activity" element={<ProtectedRoute adminOnly><ActivityFeed /></ProtectedRoute>} />
      <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
      <Route path="/changelog" element={<ProtectedRoute><Changelog /></ProtectedRoute>} />
      <Route path="/architecture" element={<ProtectedRoute adminOnly><Architecture /></ProtectedRoute>} />
      <Route path="/automations" element={<ProtectedRoute><Automations /></ProtectedRoute>} />
      <Route path="/automations/:id" element={<ProtectedRoute><AutomationDetail /></ProtectedRoute>} />
      <Route path="/agent" element={<ProtectedRoute><Agent /></ProtectedRoute>} />
      {/* File de prompts propre à la section Agent — même page que /travaux, mais
          liste distincte (space='agent') ; suggestions et idées partagées. */}
      <Route path="/agent/travaux" element={<ProtectedRoute><Travaux space="agent" /></ProtectedRoute>} />

      <Route path="/__boom" element={<ProtectedRoute adminOnly><CrashTest /></ProtectedRoute>} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </ErrorBoundary>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <NavPrefsProvider>
        <DecimalPrefsProvider>
          <ToastProvider>
            <ConfirmProvider>
              <UndoSendProvider>
                {/* File de travaux joignable de partout (bouton de la barre de
                    gauche + ⌘/Ctrl + /) : monté ici, au-dessus des routes, pour
                    survivre à la navigation — Layout, lui, est remonté à chaque page. */}
                <TravauxQuickProvider>
                  <AppRoutes />
                </TravauxQuickProvider>
                <ServerOfflineOverlay />
              </UndoSendProvider>
            </ConfirmProvider>
          </ToastProvider>
        </DecimalPrefsProvider>
      </NavPrefsProvider>
    </AuthProvider>
  )
}
