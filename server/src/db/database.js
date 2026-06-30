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
db.function('unaccent', (str) => {
  if (str == null) return ''
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
})

// Fonctions de formule fa\u00e7on Airtable (SWITCH, DATEADD, MID, SUBSTITUTE\u2026) \u2014
// disponibles dans toutes les requ\u00eates, notamment les expressions des champs
// calcul\u00e9s (kind='formula') expos\u00e9s via les VUES <table>_v. Voir
// services/formulaEngine.js. N'enregistre que les noms absents de SQLite, jamais
// un agr\u00e9gat (SUM/COUNT/MIN/MAX/AVG restent natifs pour les rollups).
registerFormulaFunctions(db)

export default db;
