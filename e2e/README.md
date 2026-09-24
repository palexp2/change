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

## Règle : hooks dans un `describe()`

Sous Node 18, un `before`/`after` au **premier niveau** du fichier n'est joué qu'une
fois la boucle d'événements vide. Un navigateur ouvert la garde pleine : `after()` ne
ferme jamais le navigateur et le test pend indéfiniment (deux tâches Codex figées
1 h 30 le 2026-09-22). Tout le corps du fichier va dans un `describe('…', () => { … })`.
