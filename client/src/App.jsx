import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth.jsx'
import { ToastProvider } from './contexts/ToastContext.jsx'
import { ConfirmProvider } from './components/ConfirmProvider.jsx'

import Login from './pages/Login.jsx'
import Setup from './pages/Setup.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Pipeline from './pages/Pipeline.jsx'
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
import Abonnements from './pages/Abonnements.jsx'
import Assemblages from './pages/Assemblages.jsx'
import ProjectDetail from './pages/ProjectDetail.jsx'
import SoumissionDetail from './pages/SoumissionDetail.jsx'
import Envois from './pages/Envois.jsx'
import EnvoisDetail from './pages/EnvoisDetail.jsx'
import Automations from './pages/Automations.jsx'
import AutomationDetail from './pages/AutomationDetail.jsx'
import Tasks from './pages/Tasks.jsx'
import Agent from './pages/Agent.jsx'
import AchatsFournisseurs from './pages/AchatsFournisseurs.jsx'
import SaleReceipts from './pages/SaleReceipts.jsx'
import JournalEntries from './pages/JournalEntries.jsx'
import StockMovements from './pages/StockMovements.jsx'
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
import CustomerPostPayment from './pages/CustomerPostPayment.jsx'

function ProtectedRoute({ children, adminOnly = false }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  if (adminOnly && user.role !== 'admin') return <Navigate to="/dashboard" replace />
  return children
}

function AppRoutes() {
  const { user } = useAuth()

  return (
    <Routes>
      <Route path="/" element={<Navigate to={user ? '/dashboard' : '/login'} replace />} />
      <Route path="/login" element={user ? <Navigate to="/dashboard" replace /> : <Login />} />
      <Route path="/setup" element={<Setup />} />
      <Route path="/customer/post-payment" element={<CustomerPostPayment />} />

      <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
      <Route path="/pipeline" element={<ProtectedRoute><Pipeline /></ProtectedRoute>} />
      <Route path="/orders" element={<ProtectedRoute><Orders /></ProtectedRoute>} />
      <Route path="/orders/:id" element={<ProtectedRoute><OrderDetail /></ProtectedRoute>} />
      <Route path="/products" element={<ProtectedRoute><Products /></ProtectedRoute>} />
      <Route path="/products/:id" element={<ProtectedRoute><ProductDetail /></ProtectedRoute>} />
      <Route path="/tasks" element={<ProtectedRoute><Tasks /></ProtectedRoute>} />
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
      <Route path="/abonnements" element={<ProtectedRoute><Abonnements /></ProtectedRoute>} />
      <Route path="/assemblages" element={<ProtectedRoute><Assemblages /></ProtectedRoute>} />
      <Route path="/soumissions/:id" element={<ProtectedRoute><SoumissionDetail /></ProtectedRoute>} />
      <Route path="/envois" element={<ProtectedRoute><Envois /></ProtectedRoute>} />
      <Route path="/envois/:id" element={<ProtectedRoute><EnvoisDetail /></ProtectedRoute>} />
      <Route path="/achats-fournisseurs" element={<ProtectedRoute><AchatsFournisseurs /></ProtectedRoute>} />
      <Route path="/depenses" element={<Navigate to="/achats-fournisseurs" replace />} />
      <Route path="/factures-fournisseurs" element={<Navigate to="/achats-fournisseurs" replace />} />
      <Route path="/sale-receipts" element={<ProtectedRoute><SaleReceipts /></ProtectedRoute>} />
      <Route path="/stripe-payouts" element={<ProtectedRoute><StripePayouts /></ProtectedRoute>} />
      <Route path="/stripe-payouts/:stripeId" element={<ProtectedRoute><StripePayoutDetail /></ProtectedRoute>} />
      <Route path="/journal-entries" element={<ProtectedRoute><JournalEntries /></ProtectedRoute>} />
      <Route path="/stock-movement" element={<ProtectedRoute><StockMovements /></ProtectedRoute>} />
      <Route path="/employees" element={<ProtectedRoute><Employees /></ProtectedRoute>} />
      <Route path="/employees/:id" element={<ProtectedRoute><EmployeeDetail /></ProtectedRoute>} />
      <Route path="/feuille-de-temps" element={<ProtectedRoute><FeuilleDeTemps /></ProtectedRoute>} />
      <Route path="/codes-activite" element={<ProtectedRoute><CodesActivite /></ProtectedRoute>} />
      <Route path="/banque-heures" element={<ProtectedRoute><BanqueHeures /></ProtectedRoute>} />
      <Route path="/paies" element={<ProtectedRoute><Paies /></ProtectedRoute>} />
      <Route path="/contacts" element={<ProtectedRoute><Contacts /></ProtectedRoute>} />
      <Route path="/contacts/:id" element={<ProtectedRoute><ContactDetail /></ProtectedRoute>} />
      <Route path="/companies" element={<ProtectedRoute><Companies /></ProtectedRoute>} />
      <Route path="/companies/:id" element={<ProtectedRoute><CompanyDetail /></ProtectedRoute>} />
      <Route path="/admin" element={<ProtectedRoute adminOnly><Admin /></ProtectedRoute>} />
      <Route path="/admin/:tab" element={<ProtectedRoute adminOnly><Admin /></ProtectedRoute>} />

      <Route path="/automations" element={<ProtectedRoute><Automations /></ProtectedRoute>} />
      <Route path="/automations/:id" element={<ProtectedRoute><AutomationDetail /></ProtectedRoute>} />
      <Route path="/agent" element={<ProtectedRoute adminOnly><Agent /></ProtectedRoute>} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <ConfirmProvider>
          <AppRoutes />
        </ConfirmProvider>
      </ToastProvider>
    </AuthProvider>
  )
}
