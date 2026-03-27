import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth.jsx'
import { ToastProvider } from './contexts/ToastContext.jsx'
import { UndoRedoProvider } from './hooks/useUndoRedo.jsx'
import Corbeille from './pages/Corbeille.jsx'
import Notifications from './pages/Notifications.jsx'
import Interfaces from './pages/Interfaces.jsx'
import InterfaceView from './pages/InterfaceView.jsx'
import InteractionsBasePage from './pages/InteractionsBasePage.jsx'

import Login from './pages/Login.jsx'
import Setup from './pages/Setup.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Companies from './pages/Companies.jsx'
import CompanyDetail from './pages/CompanyDetail.jsx'
import Contacts from './pages/Contacts.jsx'
import ContactDetail from './pages/ContactDetail.jsx'
import Pipeline from './pages/Pipeline.jsx'
import Orders from './pages/Orders.jsx'
import OrderDetail from './pages/OrderDetail.jsx'
import Products from './pages/Products.jsx'
import ProductDetail from './pages/ProductDetail.jsx'
import Tickets from './pages/Tickets.jsx'
import Admin from './pages/Admin.jsx'
import Interactions from './pages/Interactions.jsx'
import Connectors from './pages/Connectors.jsx'
import Purchases from './pages/Purchases.jsx'
import SerialNumbers from './pages/SerialNumbers.jsx'
import Retours from './pages/Retours.jsx'
import RetourDetail from './pages/RetourDetail.jsx'
import Factures from './pages/Factures.jsx'
import Abonnements from './pages/Abonnements.jsx'
import Assemblages from './pages/Assemblages.jsx'
import ProjectDetail from './pages/ProjectDetail.jsx'
import SoumissionDetail from './pages/SoumissionDetail.jsx'
import Envois from './pages/Envois.jsx'
import EnvoisDetail from './pages/EnvoisDetail.jsx'
import TablePage from './pages/TablePage.jsx'
import Automations from './pages/Automations.jsx'
import AutomationDetail from './pages/AutomationDetail.jsx'
import Webhooks from './pages/Webhooks.jsx'
import FormView from './pages/FormView.jsx'
import Agent from './pages/Agent.jsx'

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

      <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
      <Route path="/companies" element={<ProtectedRoute><Companies /></ProtectedRoute>} />
      <Route path="/companies/:id" element={<ProtectedRoute><CompanyDetail /></ProtectedRoute>} />
      <Route path="/contacts" element={<ProtectedRoute><Contacts /></ProtectedRoute>} />
      <Route path="/contacts/:id" element={<ProtectedRoute><ContactDetail /></ProtectedRoute>} />
      <Route path="/pipeline" element={<ProtectedRoute><Pipeline /></ProtectedRoute>} />
      <Route path="/orders" element={<ProtectedRoute><Orders /></ProtectedRoute>} />
      <Route path="/orders/:id" element={<ProtectedRoute><OrderDetail /></ProtectedRoute>} />
      <Route path="/products" element={<ProtectedRoute><Products /></ProtectedRoute>} />
      <Route path="/products/:id" element={<ProtectedRoute><ProductDetail /></ProtectedRoute>} />
      <Route path="/tickets" element={<ProtectedRoute><Tickets /></ProtectedRoute>} />
      <Route path="/interactions" element={<ProtectedRoute><Interactions /></ProtectedRoute>} />
      <Route path="/connectors" element={<ProtectedRoute><Connectors /></ProtectedRoute>} />
      <Route path="/purchases" element={<ProtectedRoute><Purchases /></ProtectedRoute>} />
      <Route path="/serials" element={<ProtectedRoute><SerialNumbers /></ProtectedRoute>} />
      <Route path="/projects/:id" element={<ProtectedRoute><ProjectDetail /></ProtectedRoute>} />
      <Route path="/retours" element={<ProtectedRoute><Retours /></ProtectedRoute>} />
      <Route path="/retours/:id" element={<ProtectedRoute><RetourDetail /></ProtectedRoute>} />
      <Route path="/factures" element={<ProtectedRoute><Factures /></ProtectedRoute>} />
      <Route path="/abonnements" element={<ProtectedRoute><Abonnements /></ProtectedRoute>} />
      <Route path="/assemblages" element={<ProtectedRoute><Assemblages /></ProtectedRoute>} />
      <Route path="/soumissions/:id" element={<ProtectedRoute><SoumissionDetail /></ProtectedRoute>} />
      <Route path="/envois" element={<ProtectedRoute><Envois /></ProtectedRoute>} />
      <Route path="/envois/:id" element={<ProtectedRoute><EnvoisDetail /></ProtectedRoute>} />
      <Route path="/admin" element={<ProtectedRoute adminOnly><Admin /></ProtectedRoute>} />

      <Route path="/tables/:slug" element={<ProtectedRoute><TablePage /></ProtectedRoute>} />
      <Route path="/tables/:slug/:recordId" element={<ProtectedRoute><TablePage /></ProtectedRoute>} />

      <Route path="/automations" element={<ProtectedRoute><Automations /></ProtectedRoute>} />
      <Route path="/automations/:id" element={<ProtectedRoute><AutomationDetail /></ProtectedRoute>} />
      <Route path="/webhooks" element={<ProtectedRoute><Webhooks /></ProtectedRoute>} />
      <Route path="/tables/:slug/form/:viewId" element={<ProtectedRoute><FormView /></ProtectedRoute>} />
      <Route path="/corbeille" element={<ProtectedRoute><Corbeille /></ProtectedRoute>} />
      <Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />
      <Route path="/interfaces" element={<ProtectedRoute><Interfaces /></ProtectedRoute>} />
      <Route path="/interfaces/:id" element={<ProtectedRoute><InterfaceView /></ProtectedRoute>} />
      <Route path="/base-interactions" element={<ProtectedRoute><InteractionsBasePage /></ProtectedRoute>} />
      <Route path="/agent" element={<ProtectedRoute adminOnly><Agent /></ProtectedRoute>} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <UndoRedoProvider>
          <AppRoutes />
        </UndoRedoProvider>
      </ToastProvider>
    </AuthProvider>
  )
}
