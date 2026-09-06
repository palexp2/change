import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { registerFormulaFunctions } from '../services/formulaEngine.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH
  ? path.resolve(process.cwd(), process.env.DATABASE_PATH)
  : path.join(__dirname, '../../data/erp.db');

const db = new Database(dbPath);

// Performance and integrity settings
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = 10000');
db.pragma('temp_store = MEMORY');
// Allow readers to wait up to 10s when a write lock is held during sync
db.pragma('busy_timeout = 10000');
// Checkpoint every 2000 WAL pages instead of default 1000 — reduces checkpoint frequency during heavy sync
db.pragma('wal_autocheckpoint = 2000');

// Accent-insensitive search helper available in all queries
function unaccent(str) {
  if (str == null) return ''
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}
db.function('unaccent', unaccent)

// Fonctions de formule façon Airtable (SWITCH, DATEADD, MID, SUBSTITUTE…) —
// disponibles dans toutes les requêtes, notamment les expressions des champs
// calculés (kind='formula') exposés via les VUES <table>_v. Voir
// services/formulaEngine.js. N'enregistre que les noms absents de SQLite, jamais
// un agrégat (SUM/COUNT/MIN/MAX/AVG restent natifs pour les rollups).
registerFormulaFunctions(db)

// Connexion de LECTURE dédiée, à usage jetable.
//
// better-sqlite3 est synchrone : tant qu'un `stmt.iterate()` n'est pas épuisé,
// sa connexion est « busy » et TOUTE autre requête sur cette connexion lève
// « This database connection is busy executing a query ». Un endpoint qui
// streame (GET /api/bootstrap : iterate + await de contre-pression réseau)
// garde donc l'itérateur ouvert pendant plusieurs secondes — pendant lesquelles
// les écritures des autres requêtes échouaient (feuille de temps, vues,
// télémétrie…). En lui donnant sa propre connexion, la connexion principale
// reste libre.
//
// Une connexion par flux : deux snapshots simultanés ne doivent pas se marcher
// dessus. Toujours refermer dans un `finally`.
export function openReaderConnection() {
  const conn = new Database(dbPath, { readonly: true })
  conn.pragma('busy_timeout = 10000')
  conn.pragma('cache_size = 10000')
  conn.pragma('temp_store = MEMORY')
  conn.function('unaccent', unaccent)
  registerFormulaFunctions(conn)
  return conn
}

export default db;
