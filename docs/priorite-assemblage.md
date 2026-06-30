# Projet — Page « Priorité d'assemblage »

> Aide-mémoire vivant. Mis à jour au fur et à mesure du grill-me / de l'implémentation.
> Dernière mise à jour : 2026-06-05

## Vision

Nouvelle page opérationnelle **« Priorité d'assemblage »** — un *dashboard d'action* (distinct du Dashboard analytique existant). Pensée pour usage **tactile / touch screen** : grosses boîtes, gros boutons, éléments plus gros que la normale pour lisibilité. C'est une **checklist de travail** : l'opérateur traite les items un par un, peut **reporter (snooze)** un item à plus tard (demain / semaine prochaine) pour qu'il disparaisse temporairement de la liste.

L'idée d'origine (« pièces à acheter avec snooze ») devient **l'étape 4** de cette page.

## Les 5 étapes (boîtes)

1. **Signature des documents** — soumissions à faire signer
2. **Réception de pièces** — POs en attente de réception
3. **Commande « à envoyer »** — commandes/envois prêts à expédier
4. **Commande de pièces** — produits sous le seuil de stock à racheter (= idée d'origine + snooze)
5. **Production** — assemblages/fabrication à faire

> ⚠️ **Ordre d'affichage du dashboard (2026-06-05)** : Production et Commande de pièces ont été **interchangées** dans l'UI à la demande. La page affiche donc, de haut en bas : 1 Signature · 2 Réception · 3 Commande « à envoyer » · **4 Production** · **5 Commande de pièces**. Les sections de spéc ci-dessous gardent leur identité conceptuelle (Commande de pièces = ex-étape 4, Production = ex-étape 5) ; seuls le numéro de badge et la position dans le dashboard ont été permutés. Côté code : `step-4` = Production, `step-5` = Commande de pièces.

## Décisions verrouillées

- [x] **Source liste « à acheter » (étape 4)** = produits en **bas de stock** (`stock_qty <= min_stock AND min_stock > 0`), alimentée **automatiquement**. (Réponse : A)
- [x] **Emplacement** = **page dédiée** dans le menu, séparée de l'Inventaire. (Réponse : A)
- [x] **Format** = dashboard tactile, 5 grosses boîtes-étapes, gros boutons, gros texte.
- [x] **Mécanique commune** = checklist « un par un » + possibilité de **reporter/snooze** un item à plus tard.

## Décisions à prendre (par étape)

### Étape 1 — Signature des documents ✅ SPÉCIFIÉE
- **Type** : simple **lanceur externe** (pas de données internes, pas de liste, pas de compteur — pour l'instant).
- **Contenu de la boîte** : titre « Signature des documents » + un gros bouton « Ouvrir dans Airtable ».
- **Action** : ouvre une page Airtable externe dans un **nouvel onglet** (`target="_blank"`, `rel="noopener noreferrer"`).
- **URL** : `https://airtable.com/appN2odudZaQ43RMd/pagnWxI3F0YUNus6q?FbxG7=b%3AWzAsWyJtY2pKVCIsMTAsWyJyZWNFd212V2VhWFgzQUt4bCJdXSxbImZIcjF2Iiw2LFsicmVjRXdtdldlYVhYM0FLeGwiXSwickE1VjYiXV0`
- **Évolution future possible** : remplacer par une vraie liste interne (signatures clients de soumissions) plus tard. Hors scope v1.

### Étape 2 — Réception de pièces ✅ SPÉCIFIÉE
- **Type** : lanceur externe, **deux gros boutons** (pas de liste interne).
- **Bouton 1 — « Achats »** → `https://airtable.com/appB4Fehk9jYd4s4B/pagxklhkFUYRiaGVV?YDWGE=sfs60Jc1OhB4jds8M`
- **Bouton 2 — « Retour client »** → `https://airtable.com/appB4Fehk9jYd4s4B/pagMJlhZxK69fulf5?MeTpM=sfsUhPqlbLR4ZFobG`
- Tous deux : nouvel onglet (`target="_blank"`, `rel="noopener noreferrer"`).

### Étape 3 — Commande « à envoyer » ✅ SPÉCIFIÉE (partiel — reste : contenu des lignes)
- **Type** : **vraie liste interne** dans la boîte (commandes), pas un simple bouton.
- **Au clic d'une commande** : ouvre `/orders/:id` **directement en mode expédition** (prêt à scanner).
  - ⚠️ TÂCHE TECHNIQUE : le mode expédition est aujourd'hui un `useState` local non deep-linkable (`OrderDetail.jsx:899`, bouton `:1194`). Il faut **ajouter le support d'un query param** (ex. `/orders/:id?mode=expedition`) qui initialise `expeditionMode=true` au montage (via `useSearchParams`). Sans ça, le clic atterrit en vue commerciale et oblige un 2e clic.
- **Filtre** : afficher toutes les commandes **sauf** `En attente`, `Envoyé`, `Envoyé aujourd'hui`, `Gel d'envois`, `Drop ship seulement`.
- **Group by `status`, dans cet ordre** :
  0. `ERREUR SYSTÈME` (tout en haut, style rouge — anomalie prioritaire)
  1. `Tout est dans la boite`
  2. `Tous les items sont disponibles`
  3. `Partiellement envoyé`
  4. `JWT-config`
  5. `Commande vide`
  6. `Items à fabriquer ou à acheter` (bas de liste — pas prêtes à scanner, visibles pour anticiper)
- **Contenu de chaque ligne** (gros, lisible tactile) :
  - **N° de commande** (gros, en avant)
  - **Nom du client / entreprise**
  - **Nombre d'items** (« X items ») + **progression de prélèvement** (`fulfilled_qty` / `qty` total)
  - **Tuile « Abonnement »** : affiche `Oui`/`Non` selon `orders.is_subscription` (1/0). Couleur : neutre (à préciser au besoin).
  - **Tuile « Urgent »** : tuile **bleue** avec le texte littéral « Urgent », affichée seulement quand la commande est urgente.
- **Définition « Urgent »** : basé sur le champ `orders.priority` (TEXT libre, `schema.js:124`). HYPOTHÈSE : urgent quand `priority` normalisé `=== 'urgent'`. ⚠️ à confirmer si une autre valeur est utilisée.
- **Tri** :
  - Urgentes **épinglées en tête de leur propre groupe de statut** (PAS de groupe Urgent séparé — elles restent dans leur groupe).
  - Sous les urgentes, le reste du groupe est trié **par date de commande FIFO (plus ancienne d'abord)**.
- **Champs/route à fournir côté serveur** pour la liste : `order_number`, `company_name`, nb items + total `fulfilled_qty`/`qty`, `is_subscription`, `priority`, `status`, `order_date`. (Probablement un nouvel endpoint dédié ou un param sur `/api/orders`.)
- **Snooze** : à décider — voir si on l'applique aussi ici ou seulement à l'étape 4.

### Étape 4 — Commande de pièces ✅ IMPLÉMENTÉE (2026-06-05)

> **Statut implémentation** : backend + front + e2e faits.
> - Backend : `POST /api/purchases` (réf. auto `LIA-ERP-n`, transaction), colonnes `products.supplier_link` (sync Airtable « Lien fournisseur ») + `products.purchase_snooze_until` (ajout au whitelist PUT). Sync `syncPieces()` mappe `supplier_link` (313/586 remplis).
> - Front : boîte étape 4 dans `PrioriteAssemblage.jsx` — liste active (Acheté + bas-stock + aucun achat ouvert + non reporté), mini-formulaire « Commander » (modale avec avertissement « interne ERP, PAS Airtable »), « Reporter » (Demain / Sem. prochaine), section repliable « Reportés (N) » avec annulation.
> - e2e : `e2e/tests/priorite-assemblage.test.js` couvre Reporter + Commander (création LIA-ERP vérifiée via API + cleanup). 7/7 pass.
> - ⚠️ Reste hors-scope : push éventuel des achats ERP→Airtable (voir TODO AIRTABLE plus bas).

**Spécification détaillée (référence) :**
- **Périmètre liste** : produits **bas de stock** (`stock_qty <= min_stock AND min_stock > 0`) **ET `procurement_type = 'Acheté'`** uniquement. (`Fabriqué` → étape 5, `Drop ship` → exclu.)
- **Ne PAS toucher** au flux purchase-order existant (`/products/:id/purchase-order/*`) — fonctionnalité distincte.
- **Action au clic d'une pièce** : ouvre un mini-formulaire avec :
  - champ **« Quantité commandée »**
  - champ **« Note »**
  - bouton **« Créer »** → soumet un **achat** (enregistrement `purchases`, `status='Commandé'`).
- **Stockage de l'achat = table interne `purchases`** (décision B). Implique :
  - ⚠️ TÂCHE : ajouter une route **`POST /api/purchases`** (n'existe pas — table alimentée par sync Airtable seulement aujourd'hui).
  - ⚠️ TÂCHE : **génération auto du numéro côté serveur**. Nomenclature ERP propre : **`LIA-ERP-1`, `LIA-ERP-2`, …** (préfixe `LIA-ERP-` + séquence **globale** incrémentale, **sans padding**). Le segment `ERP` distingue volontairement les achats internes des `LIA-xxx` d'Airtable (œil + filtre). Génération : `MAX(seq)` des `reference LIKE 'LIA-ERP-%'` + 1 (robuste aux trous), stocké dans `purchases.reference`.
  - Champs auto-remplis à la création : `product_id`, `supplier` (depuis le produit), `order_date` = maintenant (ISO UTC Z), `status='Commandé'`, `reference=LIA-xxx`, `qty_ordered` = saisi, `notes` = saisi. (`unit_cost` depuis le produit ? à confirmer.)
  - L'achat créé alimentera l'**étape 2 « Réception »** quand celle-ci deviendra interne (aujourd'hui elle pointe vers Airtable).
  - ⚠️ **Message d'avertissement dans l'UI** (dans le mini-formulaire de création / au moment du « Créer ») : indiquer clairement que **« Cet achat est créé en interne dans l'ERP, PAS dans Airtable »** — pour éviter toute confusion pendant la période de transition où les deux coexistent.
- **🔗 TODO AIRTABLE** : « LIA-xxx » est une convention **Airtable**, absente du code. Quand on reliera l'ERP ↔ Airtable, **revérifier ce point** : faut-il pousser/synchroniser ces achats créés dans l'ERP vers Airtable (et la numérotation LIA doit-elle rester cohérente avec celle d'Airtable) ? À trancher à l'étape « linker ERP ↔ Airtable ».
- **Sortie de liste après création d'achat** (décision A) : la pièce **disparaît** de l'étape 4 dès qu'un achat **ouvert** existe (`purchases.status` ∈ `Commandé` / `Reçu partiellement` pour ce `product_id`). Filtre liste = *bas de stock ET `procurement_type='Acheté'` ET aucun achat ouvert*. La pièce ne revient à l'étape 4 que si, après réception, elle est encore sous le seuil. Le `purchases` ouvert sert de marqueur « déjà traité » (pas de champ supplémentaire requis).
- **Mécanique snooze (report)** :
  - Au clic sur une pièce (ou via un bouton dédié sur la ligne), deux options de report : **« Demain »** et **« Semaine prochaine »**. Pas de date custom.
  - **« Demain »** = réapparaît demain (échéance = demain 00:00, heure locale Montréal → stocker en ISO UTC Z).
  - **« Semaine prochaine »** = réapparaît **lundi prochain** (début de la semaine de travail suivante).
  - **Item reporté** : disparaît de la **liste active**, mais reste dans une **section repliable « Reportés (N) »** en bas de la boîte étape 4, avec possibilité d'**annuler le report** (le ramener immédiatement dans la liste active).
  - **Réapparition** : automatique quand l'échéance est passée (`snooze_until <= now`).
  - **Stockage (décision technique)** : nouvelle colonne sur `products`, ex. **`purchase_snooze_until TEXT`** (datetime ISO UTC Z, nullable), ajoutée via `ALTER TABLE ... try/catch` dans `schema.js` (pattern additif idempotent). Single-tenant → pas besoin de scoper par user. Annuler le report = remettre la colonne à `NULL`.
  - Filtre liste active **complet** = *bas de stock* ET *`procurement_type='Acheté'`* ET *aucun achat ouvert* ET *(`purchase_snooze_until IS NULL` OU `purchase_snooze_until <= now`)*.
  - ⚠️ TÂCHE : route pour poser/annuler le snooze (ex. `PATCH /api/products/:id` acceptant `purchase_snooze_until`, ou endpoint dédié).
  - **Portée du snooze** : **étape 4 uniquement** (décision A, Q4.9). Les étapes 1-3-5 restent des listes « live » sans report pour l'instant.
- **Contenu de chaque ligne (pièce)** — gros, tactile :
  - **Image** produit (vignette) + **nom** (`name_fr`) + **SKU**
  - **Stock actuel vs seuil** (ex. « 2 / 5 », manque en évidence)
  - **Qté suggérée** (`order_qty`, pré-remplit le champ « Quantité commandée » du formulaire)
  - **Fournisseur** (`supplier`)
  - **Lien fournisseur (externe)** : bouton ouvrant une **URL externe** (nouvel onglet, `target="_blank"`) vers le portail/site de commande du fournisseur.
    - ⚠️ TÂCHE : ce champ **n'existe pas** aujourd'hui sur `products`. Ajouter une colonne **`supplier_link TEXT`** (`ALTER TABLE products ADD COLUMN supplier_link TEXT` try/catch dans `schema.js`).
    - **Source = sync Airtable** : le champ « Lien fournisseur » **existe dans Airtable** et doit être **synchronisé** vers `supplier_link` (PAS saisi à la main dans l'ERP). Affiché comme bouton externe dans la ligne étape 4 (caché si vide).
    - **Câblage sync** : le sync produits = **`syncPieces()`** dans `server/src/services/airtable.js` (~L548-664), field_map configurable stocké en DB dans **`airtable_module_config`** (`module='pieces'`, colonne `field_map` JSON). TÂCHES :
      1. ajouter `supplier_link` au `fieldMap` (candidats auto-map : `'lien fournisseur'`, `'lien'`, `'url fournisseur'`, `'lien d'achat'`),
      2. ajouter la colonne aux requêtes **INSERT** (~L647) et **UPDATE** (~L643) de `syncPieces()`,
      3. mettre à jour le `field_map` persisté en DB si déjà figé (sinon l'auto-map ne s'applique qu'au 1er sync).
      - ⚠️ Confirmer le **nom exact** du champ dans Airtable pour le mapping.
  - **2 actions tactiles** : **« Commander »** (mini-formulaire qté/note/Créer) et **« Reporter »** (Demain / Semaine prochaine).
- **ÉTAPE 4 : SPÉC COMPLÈTE ✅**

### Étape 5 — Production ✅ SPÉCIFIÉE
- **Périmètre liste** : produits **`procurement_type = 'Fabriqué'` uniquement** (≠ étape 4 qui est `Acheté` uniquement — les deux étapes sont gérées **séparément**, mécaniques distinctes).
- **Type** : **liste 100 % passive / lecture seule**. Indication de « ce qu'il y a à produire ». **Aucune action** : pas de clic, pas de bouton « Produire », pas de création d'assemblage, pas de mouvement de stock, **pas de snooze**, **pas de navigation** vers la fiche.
- **Décisions verrouillées** :
  - [x] Source = produits Fabriqué **en manque** (décision : champs Airtable produits-finis, PAS le low-stock générique `stock_qty/min_stock` de l'étape 4).
  - [x] Lecture seule, 100 % passive (aucune affordance).
  - [x] Tri = `Status d'assemblage` **ASC**.
  - [x] Inclusion = seulement les produits en manque (`manque > 0`).
- **Filtre liste** : `procurement_type = 'Fabriqué'` **ET** manque > 0, où
  **`manque = « Seuil min. produits fini » − « Quantité sera disponible »`** (deux champs Airtable).
- **Tri** : **`ORDER BY status_assemblage ASC`** — le champ Airtable **« Status d'assemblage »** est un **pourcentage** (ex. 90 %). **Bas % = manque le plus = priorité haute → en tête.** Les presque-complets descendent. (Nulls en dernier.)
- **Contenu de chaque ligne** (gros, tactile, sans interaction) :
  - **Image** produit (vignette) + **nom** (`name_fr`) + **SKU**
  - **Manque à produire** = `« Seuil min. produits fini » − « Quantité sera disponible »`, mis en évidence
  - **Nombre possible à produire** = champ Airtable **« nombre de produit possible »** (combien on peut assembler avec les composants en stock)
  - **Badge « Status d'assemblage » (%)** — affiché comme indicateur de priorité (= clé de tri)
- **En-tête de la boîte** : **compteur** = nombre de produits Fabriqué actuellement en manque (taille de la liste).
- **Route serveur** : **AUCUNE nouvelle route**. Les 4 champs sont des colonnes `products` déjà synchronisées et la route liste `GET /api/products` fait `SELECT * FROM products` (`products.js:95`) → elle les renvoie déjà. La boîte étape 5 **réutilise `api.products.list()`** (avec `loadProgressive`, `limit=all`) puis **filtre + trie côté client** :
  - filtre : `procurement_type === 'Fabriqué'` ET `finished_min_stock != null` ET `projected_available_qty != null` ET `(finished_min_stock − projected_available_qty) > 0`
  - tri : `assembly_status` ASC (nulls en dernier)
  - (décision révisée 2026-06-05 : un endpoint dédié était superflu puisque tout est déjà en colonnes synchronisées.)
- **✅ SYNC FAIT & VÉRIFIÉ (2026-06-05)** — one-way Airtable → ERP dans `syncPieces()` (`server/src/services/airtable.js`). 4 champs Airtable → 4 colonnes `products` (noms Airtable **confirmés** par sync réel sur 496 pièces) :
  | Champ Airtable (nom EXACT confirmé) | Colonne `products` | Type | Couverture |
  |---|---|---|---|
  | **« Statut d'assemblage »** (≠ "Status") | `assembly_status` | REAL | ~27 (Fabriqué seulement) |
  | **« Seuil min. produits finis »** (finis au pluriel) | `finished_min_stock` | INTEGER | 495/586 |
  | **« Quantité sera disponible »** | `projected_available_qty` | INTEGER | 496/586 |
  | **« Nombre de produits possibles »** | `producible_qty` | INTEGER | 494/586 |
  - Implémentation : (1) colonnes ajoutées via `ALTER TABLE … try/catch` dans `schema.js` (~L1547) ; (2) auto-map + **backfill robuste** (`probe()`) qui re-sonde tant que non trouvé, car Airtable omet les champs vides ; (3) ajoutées aux requêtes INSERT/UPDATE ; (4) le `field_map` mergé est **re-persisté en DB à chaque sync** (`UPDATE … SET field_map=?`) → pas d'édition manuelle de la DB, self-healing.
  - ⚠️ **`assembly_status` est une FRACTION 0–1** (ex. `0.9` = 90 %, `0.666` = 66 %), PAS un entier 0–100 → la boîte front devra afficher `assembly_status × 100`. Le tri ASC donne bien le plus en manque en tête.
- **Note** : `manque` est calculé côté serveur (`finished_min_stock − projected_available_qty`) — pas synchronisé séparément. Requête étape 5 validée :
  `WHERE procurement_type='Fabriqué' AND finished_min_stock IS NOT NULL AND projected_available_qty IS NOT NULL AND (finished_min_stock − projected_available_qty) > 0 ORDER BY assembly_status ASC` (nulls en dernier).
- **ÉTAPE 5 : SPÉC COMPLÈTE ✅**

## Carte des données (existant)

| Étape | Table | Champ statut | Valeurs « à traiter » | Route serveur | API client | Page existante |
|---|---|---|---|---|---|---|
| 1. Signature | `soumissions` | `status` | `'Envoyée'` (en attente signature) | `GET /api/documents/soumissions` | `api.documents.soumissions.list()` | `Soumissions.jsx` (pas dans le menu) |
| 2. Réception | `purchases` | `status` | `'Commandé'`, `'Reçu partiellement'` | `GET /api/purchases?status=` | `api.purchases.list()` | `Purchases.jsx` |
| 3. Envoi | `shipments` / `orders` | `status` | shipment `'À envoyer'` / order `'Tout est dans la boite'` | `GET /api/shipments`, `/api/orders` | `api.shipments.list()`, `api.orders.list()` | `Envois.jsx`, `Orders.jsx` |
| 4. Commande pièces | `products` | `stock_qty <= min_stock` | `low_stock=true`, `procurement_type IN ('Acheté')` | `GET /api/products?low_stock=true` | `api.products.list()` | `Products.jsx` |
| 5. Production | `assemblages` + `products` | `procurement_type='Fabriqué'` | produits fabriqués à produire | `GET /api/projets/assemblages` | `api.assemblages.list()` | `Assemblages.jsx` |

### Enums statuts utiles (verbatim)
- `soumissions.status` : `Brouillon`, `Envoyée`, `Acceptée`, `Refusée`, `Expirée`
- `purchases.status` : `Commandé`, `Reçu partiellement`, `Reçu`, `Annulé`
- `shipments.status` : `À envoyer`, `Envoyé`
- `orders.status` : `Commande vide`, `Gel d'envois`, `En attente`, `Items à fabriquer ou à acheter`, `Tous les items sont disponibles`, `Tout est dans la boite`, `Partiellement envoyé`, `Drop ship seulement`, `JWT-config`, `Envoyé aujourd'hui`, `Envoyé`, `ERREUR SYSTÈME`
- `products.procurement_type` : `Acheté`, `Fabriqué`, `Drop ship`

## Branchement technique (page neuve)

- Créer `client/src/pages/PrioriteAssemblage.jsx`
- Router : `client/src/App.jsx` → `<Route path="/priorite-assemblage" element={<ProtectedRoute><PrioriteAssemblage/></ProtectedRoute>} />`
- Menu : `client/src/components/Layout.jsx` (groupes existants : Envois, Inventaire…)
- Build obligatoire après modif client : `cd client && npm run build`
- Test Playwright obligatoire avant « fait » (voir CLAUDE.md)

## Mécanique snooze (à spécifier précisément étape par étape)

- Idée : champ `snooze_until` (datetime UTC ISO Z) sur l'entité concernée. Si `snooze_until > now`, l'item est masqué de la checklist jusqu'à échéance.
- À décider : par étape, ou modèle commun ? Stockage (colonne par table vs table générique `snoozes(entity_type, entity_id, until)`) ? Options de report (demain / semaine prochaine / date custom) ? Per-user (single-tenant → global suffit) ?

## Journal de progression

- 2026-06-04 — Cadrage initial. Décisions verrouillées (source liste, emplacement, format). Carte des données établie. Démarrage du grill sur l'étape 1.
- 2026-06-05 — Grill étape 5 (Production) terminé → **SPÉC COMPLÈTE**. Décisions : liste 100 % passive (lecture seule, aucune action ni snooze) ; périmètre `Fabriqué` uniquement (séparé de l'étape 4 `Acheté`) ; filtre/inclusion = manque > 0 où `manque = « Seuil min. produits fini » − « Quantité sera disponible »` ; tri `Status d'assemblage` ASC (bas % = priorité) ; ligne = image+nom+SKU, manque, nombre possible, badge % ; compteur d'en-tête ; endpoint dédié ; 4 nouveaux champs Airtable à synchroniser dans `syncPieces()` (noms exacts à confirmer). **Toutes les étapes 1-5 sont désormais spécifiées.**
- 2026-06-05 — **Boîtes repliables.** Chaque `StepBox` a une flèche (chevron) à droite + titre cliquable qui plie/déplie son corps (déplié par défaut, état local par boîte). testid `step-N-collapse`. e2e : test collapse/expand ajouté (9/9 pass).
- 2026-06-05 — **Production ⇄ Commande de pièces interchangées dans le dashboard** : affichage 1·2·3·**4 Production**·**5 Commande de pièces** ; `step-4`=Production, `step-5`=Commande de pièces. testids des tests mis à jour.
- 2026-06-05 — **Étape 4 implémentée (backend + front + e2e).** Backend : `POST /api/purchases` avec réf. auto `LIA-ERP-n` (séquence globale, transaction) ; colonnes `products.supplier_link` (sync Airtable « Lien fournisseur », 313/586) + `products.purchase_snooze_until` (whitelist PUT). Front : boîte étape 4 (liste active Acheté+bas-stock+sans achat ouvert+non reporté, modale « Commander » avec avertissement interne-ERP, « Reporter » Demain/Sem. prochaine, section repliable « Reportés »). e2e : 8/8 pass (Reporter, Commander→création LIA-ERP vérifiée API + cleanup). Reste : étape 3.
- 2026-06-05 — **Front : page créée + étapes 1, 2, 5 implémentées.** `client/src/pages/PrioriteAssemblage.jsx` (route `/priorite-assemblage` dans `App.jsx`, menu top-level `ListChecks` dans `Layout.jsx`). Layout tactile : 5 boîtes-étapes empilées (en-tête numéro+icône+titre+compteur). Étape 1 = lanceur Airtable ; étape 2 = 2 lanceurs (Achats / Retour client) ; étapes 3 & 4 = placeholders « à venir » ; **étape 5 = liste production lecture seule** (réutilise `api.products.list({limit:'all'})`, filtre `Fabriqué`+manque>0, tri `assembly_status` ASC, affiche image+nom+SKU, manque, possible, badge `%` = `assembly_status×100`). Build OK, lint OK, **e2e `e2e/tests/priorite-assemblage.test.js` : 4/4 pass** (menu→page, 5 boîtes, lanceurs externes noopener, liste prod + compteur + tri ASC). Reste : étapes 3 & 4 (backend + front).
- 2026-06-05 — **Sync étape 5 implémenté & vérifié** (one-way Airtable → ERP). 4 colonnes ajoutées à `products` + mapping dans `syncPieces()` ; sync réel OK sur 496 pièces. Noms Airtable confirmés : `Statut d'assemblage` (pas "Status"), `Seuil min. produits finis` (pluriel), `Quantité sera disponible`, `Nombre de produits possibles`. Découverte : `assembly_status` est une fraction 0–1 (afficher ×100 au front). Décision révisée : **pas d'endpoint dédié** — `GET /api/products` fait `SELECT *` donc renvoie déjà les 4 colonnes ; l'étape 5 filtre/trie côté client. Reste à faire pour l'étape 5 : **la boîte front** dans `PrioriteAssemblage.jsx`.
