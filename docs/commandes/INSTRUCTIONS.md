# Instructions — Domaine Commandes (Orders)

> Doc de référence pour toute requête touchant aux **commandes**.
> Déclenché via le slash command `/commandes` (voir `.claude/commands/commandes.md`).
> Ce doc **complète** le `CLAUDE.md` racine — il ne le remplace pas. En cas de doute, le `CLAUDE.md` racine fait foi.

---

## 1. Glossaire & vocabulaire

| FR | EN / sens dans le code |
|---|---|
| Commande | Order (table `orders`, route `/api/orders`) |
| Ligne de commande | Order item (`order_items`, routes `/api/orders/:id/items`) |
| Envoi | Shipment (livraison client, `/api/orders/:id/shipments`) |
| Bon de livraison | Delivery slip (`/api/orders/:id/bon-livraison`) |
| Statut | Status (`PATCH /api/orders/:id/status`) |
| Rachat | Buy-back d'abonnement déclenché par une commande (`rescanRachatForCompany`) |
| Central controllers | Contrôleurs centraux liés à la commande (`getCentralControllers`) |
| Docs d'installation | Generated install docs (`POST /api/orders/:id/generate-installation-docs`) |
| Scan | Scan d'items / réception (`POST /api/orders/:id/scan`) |

---

## 2. Chemins clés du domaine

### Frontend (`client/src/`)
- `pages/Orders.jsx` — liste des commandes (rendue via `DataTable`).
- `pages/OrderDetail.jsx` — fiche détail (le gros du domaine ~1400 lignes : items, envois, statut, notes autosave, central controllers, docs d'installation, bouton Novoxpress).
- Colonnes de table : déclarées dans `lib/tableDefs.js` (`TABLE_COLUMN_META`, table `orders`).
- Appels API : `lib/api.js`.

### Backend (`server/src/`)
- `routes/orders.js` — toutes les routes commandes. Endpoints actuels :
  - `GET /lookup` · `GET /` · `GET /:id` · `POST /` · `PUT /:id`
  - `PATCH /:id/status`
  - `POST /:id/shipments`
  - Items : `POST /:id/items` · `PATCH /:id/items/reorder` · `PATCH /:id/items/:itemId` · `POST /:id/items/:itemId/duplicate` · `DELETE /:id/items/:itemId`
  - `POST /:id/scan`
  - `POST /:id/generate-installation-docs`
  - `POST /:id/bon-livraison`
  - `DELETE /:id`
- Realtime : `services/realtimeEmitters.js` (`emitOrder`, `emitOrderItem`) — à émettre après toute mutation.
- Soft delete : table `orders` utilise `deleted_at` → filtrer `WHERE o.deleted_at IS NULL`, supprimer via `UPDATE ... SET deleted_at`.
- Effets liés : `services/subscriptionEvents.js` (`rescanRachatForCompany`), `utils/centralController.js`.

---

## 3. Checklist de vérification (OBLIGATOIRE)

Il n'y a plus de suite de tests end-to-end dans le repo. La vérification passe par le build, le lint et les tests unitaires serveur.

### Workflow
1. **Modifier** le code (`client/src/...` et/ou `server/src/routes/orders.js`).
2. **Build client** si `client/src/` touché :
   ```bash
   cd /home/ec2-user/erp/client && npm run build
   ```
3. **Restart serveur** si `server/src/` touché :
   ```bash
   pm2 restart erp-server
   ```
4. **Lint** :
   ```bash
   cd /home/ec2-user/erp/client && npm run lint
   cd /home/ec2-user/erp/server && npm run lint
   ```

### Tests serveur unitaires (si logique pure ajoutée)
Si tu ajoutes une fonction de calcul/validation testable sans navigateur :
```bash
cd /home/ec2-user/erp/server && npm test
```
Créer un `*.test.js` à côté du module (pattern `node:test`).

### Règles de propreté (DB de dev = DB de prod)
- Ne créer aucun record de test jetable dans la DB ; si c'est inévitable, le supprimer immédiatement via l'API admin (`DELETE /api/orders/:id`).
- **Restauration** : si une vérification modifie une **config/préférence existante** (vue DataTable, statut par défaut, permissions, réglage admin…), remettre la valeur d'origine.
- **Jamais** de script de purge en masse de la DB commité.

### Side effects commandes → confirmer dans l'UI
Une action commande qui déclenche un side effect doit afficher une **modale de confirmation** listant chaque effet avant exécution. Pour les commandes, surveiller notamment :
- Envoi d'email (confirmation client, docs d'installation).
- Création/expédition Novoxpress (étiquette, envoi).
- Génération + envoi de bon de livraison / facture.
- Déclenchement de rachat d'abonnement (`rescanRachatForCompany`).
- Suppression de commande (soft delete) ou d'items.

---

## 4. Rappels patterns (hérités du CLAUDE.md racine)
- **Autosave partout** : pas de bouton "Enregistrer" sur `OrderDetail.jsx` (sauf création/action transactionnelle).
- **DataTable** : `Orders.jsx` passe par `DataTable` — pas de tableau HTML brut.
- **Champs FK** (`company_id`, `product_id`, `contact_id`) : picker recherchable **+** lien cliquable vers la fiche.
- **Datetime** : ISO UTC avec `Z` (`strftime('%Y-%m-%dT%H:%M:%fZ','now')` en SQL, `new Date().toISOString()` en Node).
- **Realtime** : émettre `emitOrder` / `emitOrderItem` après mutation ; invalider le cache prefetch avant re-fetch (cf. mémoire `gotcha_prefetch_cache_blocks_realtime_refetch`).
