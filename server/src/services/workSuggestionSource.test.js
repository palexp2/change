import '../test-helpers/testEnv.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db from '../db/database.js'
import { addSuggestion, listSuggestions } from './workSuggestions.js'

test('la revue exclut les anciennes suggestions, même dans le même domaine et la même catégorie', () => {
  // Base temporaire créée par testEnv ; aucun accès aux données de production.
  db.exec(`
    CREATE TABLE work_suggestions (
      id TEXT PRIMARY KEY, title TEXT, rationale TEXT, prompt TEXT, area TEXT,
      kind TEXT, fingerprint TEXT UNIQUE, source TEXT DEFAULT 'legacy',
      status TEXT DEFAULT 'new', work_prompt_id TEXT, deleted_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE work_prompts (id TEXT, status TEXT, space TEXT, deleted_at TEXT);
    CREATE TABLE work_suggestion_messages (suggestion_id TEXT, deleted_at TEXT);
  `)
  const old = addSuggestion({ title: 'Ancienne amélioration', prompt: 'Ancien moteur', area: 'technique' })
  const review = addSuggestion({ title: 'Nouvelle correction', prompt: 'Revue du code', area: 'technique', source: 'app_review' })
  assert.equal(old.source, 'legacy')
  assert.equal(review.source, 'app_review')
  assert.deepEqual(listSuggestions({ source: 'app_review', kind: 'chantier', status: 'new' }).map(s => s.id), [review.id])
  assert.equal(listSuggestions().length, 2, 'la vue complète conserve toutes les propositions')
  db.prepare("UPDATE work_suggestions SET status='dismissed' WHERE id=?").run(review.id)
  assert.equal(listSuggestions({ source: 'app_review', status: 'new' }).length, 0)
  assert.deepEqual(listSuggestions({ source: 'app_review', status: 'dismissed' }).map(s => s.id), [review.id])
})
