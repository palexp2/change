import dotenv from 'dotenv'

// Le .env fait foi. Sans `override`, une clé déjà présente dans l'environnement
// gagnait : le démon pm2 garde celui du shell qui l'a lancé, et une ancienne
// OPENAI_API_KEY sans crédit masquait la bonne (extraction des factures en panne).
// Seuls les réglages propres à un processus pm2 (relais : port, rôle) restent
// prioritaires.
const PROCESS_KEYS = ['PORT', 'ERP_ROLE', 'DRAIN_MAX_MS']

export function loadEnv() {
  // Tests : le harnais (test-helpers/testEnv.js) pose DATABASE_PATH sur une DB
  // jetable ; le .env ne doit pas le ramener sur la prod.
  if (process.env.__TEST_DB_PATH) return void dotenv.config()
  const keep = Object.fromEntries(PROCESS_KEYS.filter((k) => k in process.env).map((k) => [k, process.env[k]]))
  dotenv.config({ override: true })
  Object.assign(process.env, keep)
}
