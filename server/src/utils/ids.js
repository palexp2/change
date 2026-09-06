import { newRecordId } from './recordId.js'

const PREFIXES = {
  table:     'tbl',
  field:     'fld',
  record:    'rec',
  view:      'viw',
  auto:      'aut',
  log:       'alg',
  version:   'ver',
  iface:     'ifc',
  page:      'pag',
  block:     'blk',
  notif:     'ntf',
  int:       'int',
  itl:       'itl',
  ita:       'ita',
  connector: 'con',
}

// Ids typés du système d'automatisations (`aut_…`, `ver_…`, `alg_…`) : même
// queue compacte que les ids d'enregistrement (cf. recordId.js), le préfixe et
// son souligné en plus.
export function newId(type) {
  const prefix = PREFIXES[type]
  if (!prefix) throw new Error(`Unknown ID type: ${type}`)
  return newRecordId(`${prefix}_`)
}
