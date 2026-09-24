# Trusted, short-lived database broker. User JavaScript is never evaluated here.
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

IDENT = re.compile(r'^[a-z_][a-z0-9_]*$', re.I)

def update(db, request):
    table, record_id, patch = request['args']
    if table not in request['tables'] or not IDENT.fullmatch(table):
        raise ValueError('update(): table non autorisée')
    if not isinstance(record_id, str) or not record_id or len(record_id) > 128:
        raise ValueError('update(): id requis')
    if not isinstance(patch, dict) or len(patch) > 64:
        raise ValueError('update(): patch invalide')
    if not patch:
        return 0
    columns = {col[1] for col in db.execute('PRAGMA table_info(' + table + ')')}
    protected = set()
    if not request.get('allowTriggerWrite'):
        for (raw,) in db.execute("SELECT trigger_config FROM automations WHERE kind='field_rule' AND active=1 AND deleted_at IS NULL"):
            try:
                config = json.loads(raw or '{}')
                if config.get('erp_table') == table:
                    protected.add(config.get('column'))
            except (ValueError, AttributeError):
                pass
    for key in patch:
        if key == 'id':
            raise ValueError('update(): la colonne id est immuable')
        if not IDENT.fullmatch(key) or key not in columns:
            raise ValueError('update(): colonne inexistante ' + table + '.' + key)
        if key in protected:
            raise ValueError('update(): colonne-déclencheur protégée (garde anti-cycle)')
    values = [json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v for v in patch.values()]
    cursor = db.execute('UPDATE ' + table + ' SET ' + ', '.join(key + '=?' for key in patch) + ' WHERE id=?', values + [record_id])
    db.commit()
    return cursor.rowcount

def query(db, request):
    sql = request['args'][0]
    params = request['args'][1] if len(request['args']) > 1 else []
    if not isinstance(sql, str) or len(sql) > 65536 or not sql.lstrip().upper().startswith('SELECT'):
        raise ValueError('query() accepte uniquement les requêtes SELECT')
    if not isinstance(params, list) or len(params) > 100:
        raise ValueError('Paramètres SQL invalides')
    allowed = set(request['tables'])
    def authorize(action, arg1, arg2, database, source):
        if action == sqlite3.SQLITE_SELECT:
            return sqlite3.SQLITE_OK
        if action == sqlite3.SQLITE_READ:
            return sqlite3.SQLITE_OK if database == 'main' and arg1 in allowed else sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_FUNCTION:
            return sqlite3.SQLITE_DENY if arg2.lower() in ('load_extension', 'readfile', 'writefile') else sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY
    db.set_authorizer(authorize)
    cursor = db.execute(sql, params)
    columns = [col[0] for col in cursor.description]
    rows = cursor.fetchmany(1001)
    if len(rows) > 1000:
        raise ValueError('query(): maximum 1000 lignes ; utilisez LIMIT')
    return [dict(zip(columns, row)) for row in rows]

try:
    request = json.loads(sys.stdin.buffer.read(131073))
    read_only = request['method'] == 'query'
    uri = Path(sys.argv[1]).resolve().as_uri() + ('?mode=ro' if read_only else '?mode=rw')
    db = sqlite3.connect(uri, uri=True, timeout=0.25)
    db.execute('PRAGMA foreign_keys=ON')
    if read_only:
        db.execute('PRAGMA query_only=ON')
    db.execute('PRAGMA temp_store=MEMORY')
    db.execute('PRAGMA cache_size=-2048')
    deadline = time.monotonic() + 1.0
    db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
    value = query(db, request) if read_only else update(db, request)
    output = json.dumps({'value': value}, ensure_ascii=True)
    if len(output) > 1048576:
        raise ValueError('Résultat SQL trop volumineux')
    print(output)
except Exception as error:
    print(json.dumps({'error': str(error)[:500]}))
