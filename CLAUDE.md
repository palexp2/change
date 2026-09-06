# ERP Orisha — Contexte agent

## But de l'application

App **single-tenant** dédiée aux opérations d'Orisha, entreprise d'IoT & automatisation qui conçoit, fabrique et vend directement aux clients des produits de contrôle climatique pour serres. L'ERP couvre marketing, ventes, logistique, assemblage, comptabilité, RH et dashboards.

## Stack
- **Frontend** : React + Vite, dans `client/`
- **Backend** : Node.js + Express + SQLite (better-sqlite3), dans `server/`
- **Reverse proxy** : nginx → port 3004 pour l'API et les routes dynamiques ;
  **le frontend statique est servi par nginx lui-même** depuis `client/dist`
  (racine `client/web`, un lien `erp → ../dist`). Node ne sert plus la coquille
  de la page : mono-thread, il la faisait attendre derrière tout ce qu'il avait
  en cours (mesuré : 4,78 s pour un index.html de 1,6 ko).
  Les préfixes encore proxiés vers Express : `/erp/api/`, `/erp/ws`, `/erp/p/`,
  `/erp/pay`. **Toute nouvelle route montée sous `/erp/` dans
  `server/src/index.js` doit recevoir sa `location` nginx**, sinon elle tombe
  dans le fallback SPA et renvoie index.html.

## Règle impérative — frontend

Affiche le moins de texte possible au péril d'être moins clair, ce n'est pas grave.

Après **toute modification** d'un fichier dans `client/src/`, tu dois rebuilder :

```bash
cd /home/ec2-user/erp/client && npm run build
```

Sans ce build, les changements ne sont pas visibles — Vite n'est pas en mode watch, il n'y a pas de dev server actif.

## Règle impérative — journal des nouveautés

**Toute modification de `client/src/**` ou `server/src/**` doit être accompagnée d'une nouvelle entrée dans `client/src/data/changelog.json`** (affiché sur `/changelog`). L'entrée est rédigée pour l'utilisateur : ce qui change dans l'app, pas quel fichier a bougé.

Format d'une entrée (à ajouter en tête de `entries`) :

```json
{ "date": "YYYY-MM-DD", "title": "Titre court", "category": "Comptabilité",
  "requester": "Prénom Nom",
  "changes": [ { "type": "new|improved|fixed", "text": "…" } ] }
```

`requester` est optionnel : le nom de la personne qui a demandé le changement (colonne « Demandé par » sur `/changelog`). À renseigner quand le brief le donne (« Signalement utilisateur (par X) »). Sans lui, le serveur tente de déduire le demandeur de la demande traitée le même jour.

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

## Patterns backend

### Ordre des middlewares — Stripe webhooks
Les webhooks Stripe sont montés **avant** `express.json()` avec `express.raw({ type: 'application/json' })` pour préserver le body brut (vérification de signature). Voir `server/src/index.js` ~ligne 77. Ne pas ré-ordonner.

### Auth JWT — header ou query param
Middleware `requireAuth` (`server/src/middleware/auth.js`) accepte :
- `Authorization: Bearer <token>` (standard)
- `?token=<token>` en query param (pour iframes/embeds PDF)

Pour admin-only : `requireAdmin`.

## Patterns frontend

### Règle de design — une fiche ne s'affiche QUE dans un panneau latéral

Un enregistrement se consulte toujours en side-peek, jamais en pleine page. L'invariant est tenu par le routage, pas par la discipline :

- `client/src/lib/recordPeekRoutes.jsx` est LE registre des fiches (`/<ressource>/<id>` → page `*Detail.jsx`, largeur, liste d'origine, garde de rôle).
- `App.jsx` ne monte **aucune** route de fiche : quand l'URL est celle d'un enregistrement, il rend la page de fond (celle d'où l'on vient, sinon la liste d'origine) et superpose `components/RecordRoutePanel.jsx`.
- Les pages `*Detail.jsx` n'importent plus `Layout` — leur `shell()` est l'identité. Elles reçoivent `recordId` (jamais `useParams` en pratique) et `onClose`.

Pour rendre une nouvelle table consultable : ajouter une entrée au registre, rendre la page détail embarquable (`{ recordId, onClose }`, pas de `Layout`). Ne pas ajouter de `<Route>` de fiche.

### Deux types de DataTable — lecture, ou manipulable

Par défaut un `DataTable` est une table de **lecture** (voir, trier, filtrer, ouvrir la fiche) : les enregistrements naissent et meurent ailleurs (bouton « Ajouter » + formulaire, page dédiée…).

Passer une instance de `RecordOps` (`client/src/lib/recordOps.js`) en prop `recordOps` fait basculer la table dans son **second type, manipulable** :
- clic droit sur une ligne → menu « Dupliquer » / « Supprimer » l'enregistrement ;
- « + » sous la dernière ligne → création **en ligne**, sans formulaire ; avec `onCellEdit`, le curseur ouvre la première cellule éditable de la ligne neuve.

La classe ne porte que le contrat (opérations + libellés + garde-fou de confirmation) ; la page fournit `create` / `duplicate` / `remove` et rafraîchit son état. Exemple de référence : le tableau « Articles » de la fiche Commande (`pages/OrderDetail.jsx`, `itemOps`). Une colonne peut aussi fournir son propre éditeur de cellule via `renderEditor({ row, col, commit, cancel })` — c'est ainsi que la cellule « Produit » offre une liste recherchable du catalogue.

### Règle de design — dropdowns avec recherche

### Règle de design — autosave partout

### Règle de design — champs référence (FK)
Tout champ qui référence un record dans une fiche détaillée (pas dans un tableau) d'une autre table (ex. `company_id`, `contact_id`, `product_id`, `assigned_to`…) doit offrir **deux affordances** côté UI :
1. **Sélection** via un picker recherchable (liste des records de la table cible, avec recherche — voir règle "dropdowns avec recherche" si >10 options).
2. **Navigation** : le record sélectionné s'affiche comme lien cliquable qui ouvre la fiche détail correspondante (`/companies/:id`, `/contacts/:id`, `/products/:id`, etc.). Pas de simple label texte.

S'applique aux formulaires, aux fiches détail, et aux colonnes de `DataTable` affichant des noms de records liés (`company_name`, `contact_name`, `product_name`…). Pour ces colonnes, utiliser un `render` custom qui produit un `<Link>` vers la fiche cible.


### Règle de design - La visibilité sur les actions effectuées en side effect est primordiale ; il doit y avoir un endroit où l'utilisateur peut visualiser l'historique des déclenchements de side effect, activer / désactiver les side effect et modifier le code des side effect manuellement directement dans l'interface. Ex.: de side effect: lorsqu'une commande liée à une facture est liée à un envoi, publier une écriture de journal sur QB. L'utilisateur doit aussi pouvoir modifier les triggers de ces side effects basés sur des valeurs de la base de données. Autre exemple: envoyer une notification sur un canal Slack lorsqu'un projet est fermé et gagné. Pas besoin de code d'idempotance, l'utilisateur pourra le coder au besoin à l'aide d'un champ personnalisé.

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
| Déploiement complet | `./deploy.sh` (git pull + build/restart **si les sources ont changé**) |
| Déploiement forcé | `./deploy.sh --rebuild` (ignore les empreintes) |

**Attention** : `cd client && npm run dev` lance Vite en mode dev — **ne pas l'utiliser**, le projet tourne uniquement via build + nginx sur le port 3004.

## Déploiement

- Script canonique : `/home/ec2-user/erp/deploy.sh` (pull `main` → build client → `pm2 restart erp-server`)
- Lancé **toutes les heures par cron**. Il ne travaille que si quelque chose a
  changé : une empreinte de `client/**` et une de `server/**` sont comparées à
  celles du dernier déploiement (`.deploy-fingerprints`). Le build ne part que si
  `client/` a bougé, le redémarrage que si `server/` a bougé — un cycle à vide ne
  dérange plus personne (avant : ~50 s de lenteurs et ~4 s d'indisponibilité par
  heure, pour rien). `--rebuild` force les deux.
- Le build va dans `client/.dist-build` puis bascule par renommage, et tourne en
  `nice -n 19` : il ne réécrit plus `dist` en place (nginx y sert la page) et ne
  vole plus le CPU au serveur. Il prend ~43 s au lieu de ~18 s, c'est voulu.
  L'ancien build est gardé un cycle dans `client/dist.prev`.
- Le repo est cloné **directement sur le serveur de prod** — dev et prod partagent l'environnement. Les modifs locales sont visibles immédiatement après build/restart.

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

## Limites auto-imposées

- **Ne jamais modifier `server/.env`** sans demander.
- **Ne jamais toucher `server/data/erp.db` directement** (sqlite3 CLI, UPDATE hors API) — passer par les routes serveur.
- **Ne jamais éditer `agent-tasks.json` à la main** — le système d'agent s'en sert, écriture atomique.
- **Ne pas push sur `main`** sans confirmation explicite — `main` = prod (déployé via `deploy.sh`).
- **Ne pas lancer `npm run dev` du client** — conflit avec nginx, le workflow est toujours build.
