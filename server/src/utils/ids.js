import { randomUUID } from 'crypto'

const PREFIXES = {
  table:     'tbl',
  field:     'fld',
  record:    'rec',
  view:      'viw',
  auto:      'aut',
  log:       'alg',
  iface:     'ifc',
  page:      'pag',
  block:     'blk',
  webhook:   'wbh',
  notif:     'ntf',
  int:       'int',
  itl:       'itl',
  ita:       'ita',
  connector: 'con',
}

export function newId(type) {
  const prefix = PREFIXES[type]
  if (!prefix) throw new Error(`Unknown ID type: ${type}`)
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}
