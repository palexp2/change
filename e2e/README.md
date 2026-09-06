# Tests end-to-end

Tests Playwright qui ciblent l'instance déployée.

## Installation

```sh
cd e2e
npm install
npx playwright install chromium
```

## Exécution

```sh
ERP_PASS='...' npm test
```

Variables d'environnement :
- `ERP_URL` (défaut : `https://customer.orisha.io/erp`)
- `ERP_EMAIL` (défaut : `pap@orisha.io`)
- `ERP_PASS` (requis)
