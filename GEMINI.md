# ERP Orisha — Contexte agent

## But de l'application

App **single-tenant** dédiée aux opérations d'Orisha, entreprise d'IoT & automatisation qui conçoit, fabrique et vend directement aux clients des produits de contrôle climatique pour serres. L'ERP couvre marketing, ventes, logistique, assemblage, comptabilité, RH et dashboards. Il remplace progressivement un empilement HubSpot + Airtable + QuickBooks + Stripe — l'objectif à terme est de n'utiliser que cette app + Stripe. Les intégrations existantes sont donc des étapes transitoires, pas des dépendances permanentes.

## Stack
- **Frontend** : React + Vite, dans `client/`
- **Backend** : Node.js + Express + SQLite (better-sqlite3), dans `server/`
- **Reverse proxy** : nginx → port 3004

## Règle impérative — frontend

Après **toute modification** d'un fichier dans `client/src/`, tu dois rebuilder :

```bash
cd /home/ec2-user/erp/client && npm run build
```

Sans ce build, les changements ne sont pas visibles — Vite n'est pas en mode watch, il n'y a pas de dev server actif.

## Redémarrage serveur

Après une modification dans `server/src/`, redémarre :

```bash
pm2 restart erp-server
```

## Definition of Done — frontend

**Toute modification d'un fichier dans `client/src/` doit être testée avec Playwright avant d'être déclarée terminée.** Pas de "fait" sur la base d'un build qui passe ou d'une lecture du diff — il faut une exécution réelle dans le navigateur qui vérifie le comportement attendu.

Workflow :
1. Modifier le code dans `client/src/`
2. `cd /home/ec2-user/erp/client && npm run build`
3. Écrire ou mettre à jour un test dans `e2e/tests/` (voir tests existants pour le pattern)
4. Lancer le test contre le déployé local (`ERP_URL='http://localhost:3004/erp'`) ou prod (`https://customer.orisha.io/erp`)
5. Si tous les tests passent → travail terminé. Sinon → corriger.

### Credentials de test (compte dédié Playwright)

```
ERP_EMAIL='claude@orisha.io'
ERP_PASS='saluerlessoviets'
```

Exemple d'invocation :
```bash
cd /home/ec2-user/erp/e2e
ERP_PASS='saluerlessoviets' ERP_EMAIL='claude@orisha.io' ERP_URL='http://localhost:3004/erp' \
  node --test tests/<nom-du-test>.test.js
```

## Chemins importants
- Frontend source : `client/src/`
- Pages : `client/src/pages/`
- Composants : `client/src/components/`
- CSS global : `client/src/index.css`
- Backend routes : `server/src/routes/`
- Base de données : `server/data/erp.db`

## Structure de stockage

- `server/data/` — **DB uniquement** (erp.db)
- `server/uploads/` — **Tous les fichiers** générés ou uploadés :
  - `calls/` — enregistrements d'appels
  - `products/` — images produits
  - `bons-livraison/` — PDF bons de livraison
  - `documents/` — soumissions générées par l'app
  - `soumissions/` — soumissions legacy importées d'Airtable
  - `factures/` — PDF factures (sync Airtable)
  - `receipts/` — reçus de vente
  - `labels/` — étiquettes Novoxpress
  - `attachments/` — pièces jointes

Les chemins fichiers en DB sont **relatifs à `uploads/`** (ex: `factures/xxx.pdf`). Le chemin absolu se construit via `UPLOADS_PATH` (env var, défaut `./uploads`).

## Patterns backend

### Ordre des middlewares — Stripe webhooks
Les webhooks Stripe sont montés **avant** `express.json()` avec `express.raw({ type: 'application/json' })` pour préserver le body brut (vérification de signature). Voir `server/src/index.js` ~ligne 77. Ne pas ré-ordonner.

### Auth JWT — header ou query param
Middleware `requireAuth` (`server/src/middleware/auth.js`) accepte :
- `Authorization: Bearer <token>` (standard)
- `?token=<token>` en query param (pour iframes/embeds PDF)

Pour admin-only : `requireAdmin`.

### Pagination list — `limit=all`
Toutes les routes list supportent `?limit=all` pour tout charger en une requête. Côté client, utiliser `loadProgressive(loadFn, setData, setLoading)` de `client/src/lib/loadAll.js` — ne pas réimplémenter de pagination manuelle.

### OAuth connectors — refresh lock + chiffrement
- `connectors/airtable.js` et `connectors/quickbooks.js` utilisent un `refreshLock` (Promise-mutex) pour éviter les refreshes concurrents. Toute nouvelle intégration OAuth doit suivre ce pattern.
- Les tokens OAuth en DB sont chiffrés via `server/src/utils/encryption.js` avec `CONNECTOR_ENCRYPTION_KEY`. **Ne jamais changer cette clé en prod** — toutes les connexions seraient à refaire.

### Datetime — toujours ISO UTC avec suffixe Z

**Toutes les colonnes datetime en DB sont stockées en ISO 8601 UTC avec suffixe Z** (ex: `2026-04-23T18:47:10.533Z`). Convention uniforme après la migration `src/scripts/migrate-datetimes-to-utc.js`.

- **En SQL** : utiliser `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` (pas `datetime('now')` qui produit l'ancien format espace-séparé). Les DEFAULTs des tables existantes ont été mis à jour. Les modificateurs classiques marchent : `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')`.
- **En Node** : utiliser `new Date().toISOString()` — jamais `.toLocaleString()`, `.replace('T', ' ')` ni autres transformations qui retirent le Z.
- **À la réception** : les routes qui acceptent un timestamp externe (ex: `/api/calls/ftp-ingest` depuis Cube ARC, qui envoie du naïf local Montréal) doivent le normaliser via `normalizeToUtcIso(value)` de `server/src/utils/datetime.js`.
- **Colonnes date-only** (`YYYY-MM-DD`, ex: `document_date`, `due_date`, `receipt_date`) : intouchées — ce sont des dates métier sans composante horaire.

**Pourquoi** : mélanger du naïf local (sans Z) et du UTC (avec Z) cassait les comparaisons de chaînes (tris, filtres, bornes `WHERE col >= date`) puisque V8 parse les naïfs selon le fuseau du navigateur alors que SQLite les compare lexicographiquement.

### Logging des syncs
Opérations durables (Airtable, Stripe, HubSpot, Gmail…) doivent être tracées :
- `logSync(module, trigger, { status, modified, error, durationMs })` → table `sync_log`
- `logSystemRun(...)` → table `system_runs` (macros système)

Voir `server/src/services/syncLog.js` et `syncState.js`.

### Validation
Pas de Zod/Joi — chaque route valide manuellement. Réponses d'erreur uniformes : `res.status(4xx).json({ error: 'message' })`. Toujours valider côté serveur, ne pas dépendre du front.

### Soft deletes
Certaines tables (notamment `tasks`) utilisent `deleted_at` — dans ce cas, filtrer `WHERE deleted_at IS NULL` et faire `UPDATE ... SET deleted_at = datetime('now')` plutôt qu'un `DELETE`. Vérifier la table dans `server/src/db/schema.js` avant.

## Patterns frontend

### DataTable — métadonnées centralisées
Les tables utilisent `TABLE_COLUMN_META` dans `client/src/lib/tableDefs.js` (labels, types, filtrage, tri, groupage, visibilité). Ajouter une colonne =
1. La retourner côté serveur
2. L'ajouter à `TABLE_COLUMN_META` dans `tableDefs.js`
3. (Optionnel) render custom dans `DataTable`

Le composant `DataTable` gère automatiquement filtrage/tri/groupage.

### Règle de design — dropdowns avec recherche
Tout dropdown / menu de sélection susceptible d'offrir **plus de 10 options** doit inclure une zone de recherche (input avec filtrage live des options). S'applique aux `<select>` remplacés par des composants custom, aux listes de filtres, de champs, de colonnes, d'utilisateurs, de produits, etc. Voir `FieldSelect` dans `client/src/components/FilterRow.jsx` ou `FieldsPanel` / `GroupPanel` dans `ViewToolbar.jsx` pour le pattern de référence.

### Règle de design — tableaux via `DataTable`
Toute page qui affiche des données sous forme de tableau **doit** utiliser le composant `DataTable` (`client/src/components/DataTable.jsx`) afin d'hériter automatiquement de : vues réordonnables, recherche, filtres, tri, groupage, visibilité/largeur/ordre des colonnes, persistance par utilisateur. Pas de tableau HTML brut ni de réimplémentation locale de ces fonctionnalités. Pages de référence : `Orders.jsx`, `Retours.jsx`, `Factures.jsx`, `Tasks.jsx`. Pour ajouter une nouvelle page tableau : déclarer les colonnes dans `TABLE_COLUMN_META` (`tableDefs.js`), charger les données avec `loadProgressive`, et rendre via `<DataTable table="..." columns={...} data={...} searchFields={[...]} />`.

### Règle de design — autosave partout
Tout champ éditable doit sauvegarder automatiquement (on blur ou debounce ~500ms) via un `PATCH` sur la route concernée. **Pas de bouton "Enregistrer"** dans les formulaires de détail (pages `*Detail.jsx`, panneaux d'édition, modales d'édition de ligne existante). L'état de sauvegarde doit être visible (ex. spinner discret, toast d'erreur en cas d'échec réseau) mais ne doit pas bloquer l'utilisateur. Exceptions admises uniquement quand l'autosave serait impraticable : création d'un nouvel enregistrement (formulaire "Nouveau X" qui n'a pas encore d'`id`), actions destructrices/transactionnelles (envoi de facture, soumission de paie, paiement Stripe), formulaires multi-étapes où les champs s'influencent mutuellement. Dans ces cas, documenter la raison en commentaire à côté du bouton.

### Règle de design — champs référence (FK)
Tout champ qui référence un record d'une autre table (ex. `company_id`, `contact_id`, `product_id`, `assigned_to`…) doit offrir **deux affordances** côté UI :
1. **Sélection** via un picker recherchable (liste des records de la table cible, avec recherche — voir règle "dropdowns avec recherche" si >10 options).
2. **Navigation** : le record sélectionné s'affiche comme lien cliquable qui ouvre la fiche détail correspondante (`/companies/:id`, `/contacts/:id`, `/products/:id`, etc.). Pas de simple label texte.

S'applique aux formulaires, aux fiches détail, et aux colonnes de `DataTable` affichant des noms de records liés (`company_name`, `contact_name`, `product_name`…). Pour ces colonnes, utiliser un `render` custom qui produit un `<Link>` vers la fiche cible.

## Agent tasks (système interne)

Les tâches de l'agent ERP sont persistées dans `agent-tasks.json` à la racine du projet (écriture atomique `.tmp` + rename). Un sous-process agent peut créer des sous-tâches via `POST /api/agent/tasks/internal` avec header `X-Agent-Secret: $AGENT_INTERNAL_SECRET` — cet endpoint **n'est pas protégé par JWT**.

## Variables d'environnement critiques

Définies dans `server/.env` (pas de `.env.example` — demander si une variable manque). Les plus load-bearing :
- `JWT_SECRET` — signature des tokens auth
- `CONNECTOR_ENCRYPTION_KEY` — chiffrement des tokens OAuth en DB
- `AGENT_INTERNAL_SECRET` — auth endpoint agent interne
- `AIRTABLE_CLIENT_ID/SECRET`, `QB_CLIENT_ID/SECRET`, `STRIPE_*`, `GOOGLE_CLIENT_ID/SECRET`, `HUBSPOT_*` — OAuth intégrations
- `OPENAI_API_KEY`, `POSTMARK_API_KEY`, `FTP_INGEST_SECRET` — services externes
- `UPLOADS_PATH` — racine des fichiers uploadés (défaut `./uploads`)

## Commandes utiles

| But | Commande |
|---|---|
| Rebuild frontend | `cd client && npm run build` |
| Redémarrer serveur | `pm2 restart erp-server` |
| Logs serveur (stream) | `pm2 logs erp-server` |
| Logs fichier | `~/.pm2/logs/erp-server-{out,error}.log` |
| Lint serveur | `cd server && npm run lint` |
| Lint client | `cd client && npm run lint` |
| Tests unitaires serveur | `cd server && npm test` (node --test) |
| Tests E2E Playwright | `cd e2e && ERP_PASS=... npm test` (cible le déployé, voir `e2e/README.md`) |
| Déploiement complet | `./deploy.sh` (git pull + build + pm2 restart) |

**Attention** : `cd client && npm run dev` lance Vite en mode dev — **ne pas l'utiliser**, le projet tourne uniquement via build + nginx sur le port 3004.

## Déploiement

- Script canonique : `/home/ec2-user/erp/deploy.sh` (pull `main` → build client → `pm2 restart erp-server`)
- Le repo est cloné **directement sur le serveur de prod** — dev et prod partagent l'environnement. Les modifs locales sont visibles immédiatement après build/restart.
- E2E tests ciblent `https://customer.orisha.io/erp`.

## Migrations DB

Pas de système de migration formel. Toute la DDL vit dans `server/src/db/schema.js` et suit un pattern **additif et idempotent**, exécuté à chaque démarrage :

```js
db.exec(`CREATE TABLE IF NOT EXISTS foo (...)`)
try { db.exec(`ALTER TABLE foo ADD COLUMN bar TEXT`) } catch {}
```

Pour ajouter un champ : ajouter l'`ALTER TABLE ... try/catch` dans `schema.js`, ne **jamais** modifier la DB à la main avec `sqlite3`.

## Processus PM2 associés

- `erp-server` — API principale (port interne → nginx)
- `ftp-arc` — ingestion FTP (Novoxpress, factures fournisseurs, etc.)
- `stripeBillingPortal` — portail Stripe dédié
- `troubleshoot-server` — outil diagnostic interne

Toucher à un autre process que `erp-server` → demander confirmation.

## Glossaire domaine (FR ↔ EN)

Le code mixe français et anglais. Correspondances utiles :

| FR | EN / sens |
|---|---|
| Soumission | Quote / estimate |
| Envoi | Shipment (livraison client) |
| Retour | Return / RMA |
| Achat / Facture fournisseur | Purchase / vendor invoice |
| Assemblage | Bundle / kit |
| Abonnement | Subscription (Stripe) |
| Paie | Payroll |
| Dépense | Expense |
| Reçu de vente | Sale receipt |
| Bon de livraison | Delivery slip |

## Convention commits

Format libre descriptif (pas de conventional commits). Tag `[agent]` en préfixe pour les changements liés au système d'agent autonome. FR ou EN selon le contexte. Garder les messages informatifs sur le *pourquoi*.

## Limites auto-imposées

- **Ne jamais modifier `server/.env`** sans demander.
- **Ne jamais toucher `server/data/erp.db` directement** (sqlite3 CLI, UPDATE hors API) — passer par les routes serveur.
- **Ne jamais éditer `agent-tasks.json` à la main** — le système d'agent s'en sert, écriture atomique.
- **Ne pas push sur `main`** sans confirmation explicite — `main` = prod (déployé via `deploy.sh`).
- **Ne pas lancer `npm run dev` du client** — conflit avec nginx, le workflow est toujours build.
