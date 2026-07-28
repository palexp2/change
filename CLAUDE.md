# ERP Orisha — Contexte agent

## But de l'application

App **single-tenant** dédiée aux opérations d'Orisha, entreprise d'IoT & automatisation qui conçoit, fabrique et vend directement aux clients des produits de contrôle climatique pour serres. L'ERP couvre marketing, ventes, logistique, assemblage, comptabilité, RH et dashboards.

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

### Datetime — toujours ISO UTC avec suffixe Z

**Toutes les colonnes datetime en DB sont stockées en ISO 8601 UTC avec suffixe Z** (ex: `2026-04-23T18:47:10.533Z`).

- **En SQL** : utiliser `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` (pas `datetime('now')` qui produit l'ancien format espace-séparé). Les DEFAULTs des tables existantes ont été mis à jour. Les modificateurs classiques marchent : `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')`.
- **En Node** : utiliser `new Date().toISOString()` — jamais `.toLocaleString()`, `.replace('T', ' ')` ni autres transformations qui retirent le Z.
- **À la réception** : les routes qui acceptent un timestamp externe (ex: `/api/calls/ftp-ingest` depuis Cube ARC, qui envoie du naïf local Montréal) doivent le normaliser via `normalizeToUtcIso(value)` de `server/src/utils/datetime.js`.
- **Colonnes date-only** (`YYYY-MM-DD`, ex: `document_date`, `due_date`, `receipt_date`) : intouchées — ce sont des dates métier sans composante horaire.

**Pourquoi** : mélanger du naïf local (sans Z) et du UTC (avec Z) cassait les comparaisons de chaînes (tris, filtres, bornes `WHERE col >= date`) puisque V8 parse les naïfs selon le fuseau du navigateur alors que SQLite les compare lexicographiquement.

### Logging des syncs
Tous les sync doivent être tracées :
- `logSync(module, trigger, { status, modified, error, durationMs })` → table `sync_log`
- `logSystemRun(...)` → table `system_runs` (macros système)

Voir `server/src/services/syncLog.js` et `syncState.js`.

### Validation
Pas de Zod/Joi — chaque route valide manuellement. Réponses d'erreur uniformes : `res.status(4xx).json({ error: 'message' })`. Toujours valider côté serveur, ne pas dépendre du front.

### Soft deletes
Toutes les tables doivent utiliser `deleted_at`, filtrer `WHERE deleted_at IS NULL` et faire `UPDATE ... SET deleted_at = datetime('now')` plutôt qu'un `DELETE`.

## Patterns frontend

### Règle de design — dropdowns avec recherche
Tout dropdown / menu de sélection susceptible d'offrir **plus de 10 options** doit inclure une zone de recherche (input avec filtrage live des options). Voir `FieldSelect` dans `client/src/components/FilterRow.jsx` ou `FieldsPanel` / `GroupPanel` dans `ViewToolbar.jsx` pour le pattern de référence. 

### Règle de design — autosave partout
Tout champ éditable doit sauvegarder automatiquement (on blur ou debounce ~500ms) via un `PATCH` sur la route concernée. **Pas de bouton "Enregistrer"** dans les formulaires de détail (pages `*Detail.jsx`, panneaux d'édition, modales d'édition de ligne existante). L'état de sauvegarde doit être visible (ex. spinner discret, toast d'erreur en cas d'échec réseau) mais ne doit pas bloquer l'utilisateur. Exceptions admises uniquement quand l'autosave serait impraticable : création d'un nouvel enregistrement (formulaire "Nouveau X" qui n'a pas encore d'`id`), actions destructrices/transactionnelles (envoi de facture, soumission de paie, paiement Stripe), formulaires multi-étapes où les champs s'influencent mutuellement. Dans ces cas, documenter la raison en commentaire à côté du bouton.

### Règle de design — champs référence (FK)
Tout champ qui référence un record dans une fiche détaillée (pas dans un tableau) d'une autre table (ex. `company_id`, `contact_id`, `product_id`, `assigned_to`…) doit offrir **deux affordances** côté UI :
1. **Sélection** via un picker recherchable (liste des records de la table cible, avec recherche — voir règle "dropdowns avec recherche" si >10 options).
2. **Navigation** : le record sélectionné s'affiche comme lien cliquable qui ouvre la fiche détail correspondante (`/companies/:id`, `/contacts/:id`, `/products/:id`, etc.). Pas de simple label texte.

S'applique aux formulaires, aux fiches détail, et aux colonnes de `DataTable` affichant des noms de records liés (`company_name`, `contact_name`, `product_name`…). Pour ces colonnes, utiliser un `render` custom qui produit un `<Link>` vers la fiche cible.

### Règle de design — interface la plus smooth possible avec une grande attention aux détails. Prendre exemple sur l'interface d'Airtable.

### Règle de design - Codebase clean et minimaliste réutilisant le plus possible de composantes.

### Règle de design - La visibilité sur les actions effectuées en side effect est primordiale ; il doit y avoir un endroit où l'utilisateur peut visualiser l'historique des déclenchements de side effect, activer / désactiver les side effect et modifier le code des side effect manuellement directement dans l'interface. Ex.: de side effect: lorsqu'une commande liée à une facture est liée à un envoi, publier une écriture de journal sur QB. L'utilisateur doit aussi pouvoir modifier les triggers de ces side effects basés sur des valeurs de la base de données. Autre exemple: envoyer une notification sur un canal Slack lorsqu'un projet est fermé et gagné. Pas besoin de code d'idempotance, l'utilisateur pourra le coder au besoin à l'aide d'un champ personnalisé.

### Règle de design - Champs personnalisés

L'utilisateur doit pouvoir créer des champs personnalisés de différents types dans chaque table. Les types sont les suivants: 
- Number avec choix du nombre de décimales affiché de 0 à 5
- Text
- Currency
- Link to another table avec le choix one to one ou one to many
- URL (devient cliquable lorsque lien valide)
- Created by
- Last modified by
- Created time
- Single select (configurable avec ajout, retrait, renommer et choix de couleur pour chacun des choix + possibilité d'ajouter un choix par défaut et d'alphabésifier les choix).
- Last modified by
- Lookup d'un champ dans une table liée
- Rollup d'un champ dans une table liée
- Formule avec les fonctions suivantes: 
ABS, AND, ARRAYCOMPACT, ARRAYFLATTEN, ARRAYJOIN, ARRAYUNIQUE, AVERAGE, BLANK, CEILING, CONCATENATE, COUNT, COUNTA, COUNTALL, CREATED_TIME, DATEADD, DATEDIFF, DATETIME_DIFF, DATETIME_FORMAT, DATETIME_PARSE, DAY, EVEN, EXP, FIND, FLOOR, FROMUNIXTIMESTAMP, HOUR, IF, IS_BEFORE, IS_SAME, ISAFTER, LAST_MODIFIED_TIME, LEFT, LEN, LOG, LOWER, MAX, MID, MIN, MINUTE, MOD, MONTH, NOT, NOW, ODD, OR, PI, POWER, RECORD_ID, REPLACE, RIGHT, ROUND, ROUNDDOWN, ROUNDUP, SEARCH, SECOND, SQRT, SUBSTITUTE, SUM, SWITCH, T, TIMESTAMPTOTEXT, TODAY, TRIM, TRUE, UPPER, VALUE, WEEKDAY, WEEKNUM, YEAR

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

## Limites auto-imposées

- **Ne jamais modifier `server/.env`** sans demander.
- **Ne jamais toucher `server/data/erp.db` directement** (sqlite3 CLI, UPDATE hors API) — passer par les routes serveur.
- **Ne jamais éditer `agent-tasks.json` à la main** — le système d'agent s'en sert, écriture atomique.
- **Ne pas push sur `main`** sans confirmation explicite — `main` = prod (déployé via `deploy.sh`).
- **Ne pas lancer `npm run dev` du client** — conflit avec nginx, le workflow est toujours build.
