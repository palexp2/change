import { crudRouter } from '../utils/crudRouter.js'
import { RECORD_REGISTRY } from '../db/recordRegistry.js'

// Journal des problèmes d'opérations — CRUD pur, piloté par le registre
// (db/recordRegistry.js, migration 047). Aucun side-effect : ce qui doit se
// déclencher sur un problème (alerte Slack, billet…) passe par une automation
// configurable, pas par cette route.
export default crudRouter(RECORD_REGISTRY.ops_issues)
