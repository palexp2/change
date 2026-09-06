import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom'
import { useEffect, useRef } from 'react'
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
import RecordRoutePanel from './components/RecordRoutePanel.jsx'
import { FeedbackFab } from './components/FeedbackFab.jsx'
import { useFavicon } from './hooks/useFavicon.js'
import { legacyFinanceTarget } from './lib/financeSections.js'
import { PEEK_ROUTES, matchPeekRoute, canOpenRecord } from './lib/recordPeekRoutes.jsx'

import Login from './pages/Login.jsx'
import Setup from './pages/Setup.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Pipeline from './pages/Pipeline.jsx'
import FieldConfig, { AirtableFieldsRedirect } from './pages/FieldConfig.jsx'
import Orders from './pages/Orders.jsx'
import Products from './pages/Products.jsx'
import Tickets from './pages/Tickets.jsx'
import Interactions from './pages/Interactions.jsx'
import Connectors from './pages/Connectors.jsx'
import Purchases from './pages/Purchases.jsx'
import SerialNumbers from './pages/SerialNumbers.jsx'
import SerialAccountingRules from './pages/SerialAccountingRules.jsx'
import Retours from './pages/Retours.jsx'
import Factures from './pages/Factures.jsx'
import Paiements from './pages/Paiements.jsx'
import PaiementsEmis from './pages/PaiementsEmis.jsx'
import ItemsVendus from './pages/ItemsVendus.jsx'
import Abonnements from './pages/Abonnements.jsx'
import AbonnementMouvements from './pages/AbonnementMouvements.jsx'
import Assemblages from './pages/Assemblages.jsx'
import PrioriteAssemblage from './pages/PrioriteAssemblage.jsx'
import Envois from './pages/Envois.jsx'
import Automations from './pages/Automations.jsx'
import AutomationDetail from './pages/AutomationDetail.jsx'
import Tasks from './pages/Tasks.jsx'
import RelanceQualification from './pages/RelanceQualification.jsx'
import QualificationCall from './pages/QualificationCall.jsx'
import AchatsFournisseurs from './pages/AchatsFournisseurs.jsx'
import VendorSubscriptions from './pages/VendorSubscriptions.jsx'
import VendorProfiles from './pages/VendorProfiles.jsx'
import PrepaidAccounts from './pages/PrepaidAccounts.jsx'
import DriveInventory from './pages/DriveInventory.jsx'
import TestsAntoine from './pages/TestsAntoine.jsx'
import FinDeMois from './pages/FinDeMois.jsx'
import Travaux from './pages/Travaux.jsx'
import DettesLT from './pages/DettesLT.jsx'
import MarketingBudget from './pages/MarketingBudget.jsx'
import InstagramProspects from './pages/InstagramProspects.jsx'
import ComptaDashboard from './pages/ComptaDashboard.jsx'
import SaleReceipts from './pages/SaleReceipts.jsx'
import JournalEntries from './pages/JournalEntries.jsx'
import StockMovements from './pages/StockMovements.jsx'
import RapprochementBancaire from './pages/RapprochementBancaire.jsx'
import Employees from './pages/Employees.jsx'
import FeuilleDeTemps from './pages/FeuilleDeTemps.jsx'
import CodesActivite from './pages/CodesActivite.jsx'
import BanqueHeures from './pages/BanqueHeures.jsx'
import Paies from './pages/Paies.jsx'
import Contacts from './pages/Contacts.jsx'
import Companies from './pages/Companies.jsx'
import StripePayouts from './pages/StripePayouts.jsx'
import CustomerPostPayment from './pages/CustomerPostPayment.jsx'
import TicketSurvey from './pages/TicketSurvey.jsx'
import DiscoveryForms from './pages/DiscoveryForms.jsx'
import PublicFiles from './pages/PublicFiles.jsx'
import Parametres, { AdminRedirect } from './pages/Parametres.jsx'
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

// Identité « page » d'une URL, utilisée comme clé de remontage. Certains
// segments ne désignent pas une autre page mais une ancre dans la page courante
// (les sections du dashboard : /dashboard/couts-expedition). On les ignore pour
// que la navigation vers une ancre ne remonte pas la page.
const ANCHOR_ROUTE_PREFIXES = ['/dashboard/']
function pageKey(pathname) {
  const prefix = ANCHOR_ROUTE_PREFIXES.find(p => pathname.startsWith(p))
  return prefix ? prefix.slice(0, -1) : pathname
}

function ProtectedRoute({ children, adminOnly = false, hrOnly = false }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  if (adminOnly && user.role !== 'admin') return <Navigate to="/dashboard" replace />
  if (hrOnly && !['admin', 'rh'].includes(user.role)) return <Navigate to="/dashboard" replace />
  return children
}

// Formulaire de découverte technique — page publique (le client la remplit sans
// compte), donc montée hors Layout : la bulle « Modifier le système » n'y était
// pas. Quand une session ERP est ouverte dans le navigateur, c'est un employé de
// Boréal qui regarde le formulaire : on superpose la bulle pour qu'il puisse
// demander un changement AU formulaire depuis le formulaire. Le client, lui, ne
// voit jamais rien.
function DiscoveryFormPage() {
  const { user } = useAuth()
  return (
    <>
      <CustomerPostPayment />
      {user && <FeedbackFab contextRecord="Formulaire de découverte technique (client)" />}
    </>
  )
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
  const homePath = user?.id === PAP_USER_ID ? '/travaux' : '/dashboard'

  // ── Fiches : toujours en panneau, jamais en pleine page ───────────────────
  // Aucune route ne monte de fiche : quand l'URL courante est celle d'un
  // enregistrement (/orders/<id>, /contacts/<id>…), on rend la page de FOND
  // (celle d'où l'on vient) et on superpose le panneau latéral. Un lien collé
  // ou un rechargement n'a pas de page d'où venir : le fond est alors la liste
  // d'origine de la ressource. Résultat : la fiche pleine page n'existe plus
  // comme état possible de l'app, quel que soit le chemin d'arrivée.
  const recordMatch = matchPeekRoute(location.pathname)
  const recordDef = recordMatch ? PEEK_ROUTES[recordMatch.resource] : null
  const backgroundRef = useRef(null)
  if (!recordMatch) backgroundRef.current = location
  // Fermer le panneau = revenir en arrière quand on venait d'une page de l'app,
  // sinon retomber sur la liste (pas d'historique à remonter).
  const canGoBack = !!backgroundRef.current
  const background = recordMatch
    ? (backgroundRef.current || {
      pathname: recordDef?.list || homePath, search: '', hash: '', state: null, key: 'record-background',
    })
    : null

  return (
    // key={pageKey(...)} : remonte le boundary quand on change réellement de
    // page (ce qui repart d'un conteneur de scroll neuf, en haut). Les segments
    // qui ne sont qu'une ancre dans la page courante — /dashboard/:section — ne
    // changent pas la clé : sinon cliquer une section du dashboard détruisait
    // toute la page et renvoyait le scroll en haut.
    // resetKey : efface l'état d'erreur même sur ces navigations internes.
    // La clé suit la page de FOND : ouvrir/fermer une fiche en panneau ne doit
    // pas remonter (ni recharger, ni faire remonter le scroll de) la page
    // dessous.
    <ErrorBoundary key={pageKey((background || location).pathname)} resetKey={location.pathname}>
    <>
    <Routes location={background || undefined}>
      <Route path="/" element={<Navigate to={user ? homePath : '/login'} replace />} />
      <Route path="/login" element={user ? <Navigate to={homePath} replace /> : <Login />} />
      <Route path="/setup" element={<Setup />} />
      <Route path="/customer/post-payment" element={<DiscoveryFormPage />} />
      {/* Lien public court vers le formulaire de découverte technique — accessible sans login. */}
      <Route path="/d/:token" element={<DiscoveryFormPage />} />
      {/* Sondage de satisfaction envoyé par SMS — public, le jeton est le secret. */}
      <Route path="/s/:token" element={<TicketSurvey />} />

      <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
      <Route path="/dashboard/:section" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
      <Route path="/pipeline" element={<ProtectedRoute><Pipeline /></ProtectedRoute>} />
      <Route path="/projects/fields" element={<ProtectedRoute adminOnly><AirtableFieldsRedirect /></ProtectedRoute>} />
      {/* Anciennes URL du contrôle des champs Airtable : redirigées vers
          l'onglet correspondant de /champs/:table, où cette interface est
          maintenant fusionnée avec la configuration des champs. */}
      <Route path="/airtable/fields/:module" element={<ProtectedRoute adminOnly><AirtableFieldsRedirect /></ProtectedRoute>} />
      <Route path="/champs/:table" element={<ProtectedRoute><FieldConfig /></ProtectedRoute>} />
      <Route path="/orders" element={<ProtectedRoute><Orders /></ProtectedRoute>} />
      <Route path="/products" element={<ProtectedRoute><Products /></ProtectedRoute>} />
      <Route path="/tasks" element={<ProtectedRoute><Tasks /></ProtectedRoute>} />
      <Route path="/relance-qualification" element={<ProtectedRoute><RelanceQualification /></ProtectedRoute>} />
      <Route path="/qualification-call" element={<ProtectedRoute><QualificationCall /></ProtectedRoute>} />
      <Route path="/discovery-forms" element={<ProtectedRoute><DiscoveryForms /></ProtectedRoute>} />
      <Route path="/tickets" element={<ProtectedRoute><Tickets /></ProtectedRoute>} />
      <Route path="/interactions" element={<ProtectedRoute><Interactions /></ProtectedRoute>} />
      <Route path="/connectors" element={<ProtectedRoute><Connectors /></ProtectedRoute>} />
      <Route path="/purchases" element={<ProtectedRoute><Purchases /></ProtectedRoute>} />
      <Route path="/serials" element={<ProtectedRoute><SerialNumbers /></ProtectedRoute>} />
      <Route path="/comptabilite/regles-serials" element={<ProtectedRoute adminOnly><SerialAccountingRules /></ProtectedRoute>} />
      <Route path="/retours" element={<ProtectedRoute><Retours /></ProtectedRoute>} />
      <Route path="/factures" element={<ProtectedRoute><Factures /></ProtectedRoute>} />
      <Route path="/paiements" element={<ProtectedRoute><Paiements /></ProtectedRoute>} />
      {/* Paiements ÉMIS (remplace l'onglet Pmt_Suivi) — distinct de /paiements (encaissements clients) */}
      <Route path="/paiements-emis" element={<ProtectedRoute><PaiementsEmis /></ProtectedRoute>} />
      <Route path="/items-vendus" element={<ProtectedRoute><ItemsVendus /></ProtectedRoute>} />
      <Route path="/abonnements" element={<ProtectedRoute><Abonnements /></ProtectedRoute>} />
      <Route path="/abonnements/mouvements" element={<ProtectedRoute><AbonnementMouvements /></ProtectedRoute>} />
      <Route path="/assemblages" element={<ProtectedRoute><Assemblages /></ProtectedRoute>} />
      <Route path="/priorite-assemblage" element={<ProtectedRoute><PrioriteAssemblage /></ProtectedRoute>} />
      <Route path="/envois" element={<ProtectedRoute><Envois /></ProtectedRoute>} />
      <Route path="/fournisseurs" element={<ProtectedRoute><VendorProfiles /></ProtectedRoute>} />
      <Route path="/fournisseurs/achats" element={<ProtectedRoute><AchatsFournisseurs /></ProtectedRoute>} />
      <Route path="/fournisseurs/abonnements" element={<ProtectedRoute><VendorSubscriptions /></ProtectedRoute>} />
      <Route path="/achats-fournisseurs" element={<Navigate to="/fournisseurs/achats" replace />} />
      <Route path="/abonnements-fournisseurs" element={<Navigate to="/fournisseurs/abonnements" replace />} />
      <Route path="/comptes-prepayes" element={<ProtectedRoute><PrepaidAccounts /></ProtectedRoute>} />
      <Route path="/inventaire-drive" element={<ProtectedRoute><DriveInventory /></ProtectedRoute>} />
      <Route path="/tests-antoine" element={<ProtectedRoute><TestsAntoine /></ProtectedRoute>} />
      <Route path="/fin-de-mois" element={<ProtectedRoute><FinDeMois /></ProtectedRoute>} />
      <Route path="/travaux" element={<ProtectedRoute><Travaux /></ProtectedRoute>} />
      <Route path="/dettes-lt" element={<ProtectedRoute><DettesLT /></ProtectedRoute>} />
      {/* Devenue un onglet d'Extraction de données (SaleReceipts) : la route reste pour ne pas casser les signets. */}
      <Route path="/collecte-factures" element={<Navigate to="/sale-receipts?onglet=collecte" replace />} />
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
      <Route path="/stripe-payouts" element={<ProtectedRoute><StripePayouts /></ProtectedRoute>} />
      <Route path="/journal-entries" element={<ProtectedRoute><JournalEntries /></ProtectedRoute>} />
      <Route path="/stock-movement" element={<ProtectedRoute><StockMovements /></ProtectedRoute>} />
      <Route path="/rapprochement" element={<ProtectedRoute><RapprochementBancaire /></ProtectedRoute>} />
      <Route path="/employees" element={<ProtectedRoute hrOnly><Employees /></ProtectedRoute>} />
      <Route path="/feuille-de-temps" element={<ProtectedRoute><FeuilleDeTemps /></ProtectedRoute>} />
      <Route path="/codes-activite" element={<ProtectedRoute hrOnly><CodesActivite /></ProtectedRoute>} />
      <Route path="/banque-heures" element={<ProtectedRoute><BanqueHeures /></ProtectedRoute>} />
      <Route path="/paies" element={<ProtectedRoute><Paies /></ProtectedRoute>} />
      <Route path="/contacts" element={<ProtectedRoute><Contacts /></ProtectedRoute>} />
      <Route path="/companies" element={<ProtectedRoute><Companies /></ProtectedRoute>} />
      {/* L'admin est devenu la partie « Administration » des Paramètres. */}
      <Route path="/admin" element={<AdminRedirect />} />
      <Route path="/admin/:tab" element={<AdminRedirect />} />

      <Route path="/public-files" element={<ProtectedRoute><PublicFiles /></ProtectedRoute>} />
      <Route path="/activity" element={<ProtectedRoute adminOnly><ActivityFeed /></ProtectedRoute>} />
      <Route path="/parametres" element={<ProtectedRoute><Parametres /></ProtectedRoute>} />
      <Route path="/parametres/:section" element={<ProtectedRoute><Parametres /></ProtectedRoute>} />
      <Route path="/settings" element={<Navigate to="/parametres" replace />} />
      <Route path="/changelog" element={<ProtectedRoute><Changelog /></ProtectedRoute>} />
      <Route path="/architecture" element={<ProtectedRoute adminOnly><Architecture /></ProtectedRoute>} />
      <Route path="/automations" element={<ProtectedRoute><Automations /></ProtectedRoute>} />
      <Route path="/automations/:id" element={<ProtectedRoute><AutomationDetail /></ProtectedRoute>} />
      <Route path="/__boom" element={<ProtectedRoute adminOnly><CrashTest /></ProtectedRoute>} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    {/* La fiche de l'enregistrement pointé par l'URL, par-dessus la page de
        fond. Les gardes de rôle de la liste s'appliquent (RH, admin). */}
    {recordMatch && canOpenRecord(user, recordDef) && (
      <RecordRoutePanel key={recordMatch.path} match={recordMatch} canGoBack={canGoBack} />
    )}
    </>
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
