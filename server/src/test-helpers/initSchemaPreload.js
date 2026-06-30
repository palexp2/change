// Side-effect module — initialise le schéma sur la DB de test AU CHARGEMENT.
//
// Pourquoi : certains services (ex. subscriptionEvents.js) préparent des
// statements SQL à l'évaluation top-level de leur module. Si ces modules sont
// importés avant que initSchema() ait tourné, le `db.prepare(... orders ...)`
// échoue avec « no such table ». En ESM, le code top-level d'un module importé
// s'exécute entièrement avant l'évaluation de l'import suivant : il suffit donc
// d'importer CE module EN PREMIER dans un fichier de test pour garantir que les
// tables existent avant tout import de routeur/service.
import './testEnv.js'
import { initSchema } from '../db/schema.js'

initSchema()
