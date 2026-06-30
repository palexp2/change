// Side-effect module — DOIT être importé AVANT tout module qui charge
// db/database.js ou config/secrets.js (notamment testApp.js et les routers).
//
// Pourquoi un module séparé : en ESM, le code top-level d'un module ne s'exécute
// qu'APRÈS la résolution de tous ses imports. On ne peut donc pas « poser une env
// var puis importer db » dans un même fichier. La solution est d'isoler la pose
// d'env dans ce module sans dépendances : ESM évalue les imports en profondeur,
// dans l'ordre source. testApp.js l'importe en PREMIER, garantissant que
// DATABASE_PATH/JWT_SECRET sont posés avant que database.js / secrets.js ne lisent
// process.env.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// DB SQLite jetable et isolée — JAMAIS la prod erp.db. database.js résout
// DATABASE_PATH via path.resolve(process.cwd(), …) ; un chemin absolu ignore le
// cwd. Un fichier par process (pid + uuid) pour éviter toute collision si
// plusieurs fichiers de test tournent en parallèle.
if (!process.env.__TEST_DB_PATH) {
  const p = join(tmpdir(), `erp-test-${process.pid}-${randomUUID()}.db`)
  process.env.DATABASE_PATH = p
  process.env.__TEST_DB_PATH = p
}

// secrets.js lit ces valeurs à l'import. dotenv (chargé par secrets/database) ne
// surcharge PAS une var déjà posée → ces valeurs de test gagnent sur server/.env.
// On force un JWT_SECRET de test seulement s'il n'est pas déjà fourni par
// l'environnement : signataire (makeToken) et vérificateur (requireAuth) lisent
// tous deux JWT_SECRET via config/secrets.js, donc ils restent cohérents quoi
// qu'il arrive.
process.env.JWT_SECRET ||= 'test-jwt-secret-thirty-two-characters-min-0000'

// Realtime WS désactivé — le harnais monte l'app sans serveur http long-vivant.
process.env.REALTIME_ENABLED = 'false'

export const TEST_DB_PATH = process.env.__TEST_DB_PATH
