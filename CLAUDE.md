# ERP Orisha — Contexte agent

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
