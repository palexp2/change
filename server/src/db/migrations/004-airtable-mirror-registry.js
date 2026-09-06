/**
 * 004 — Le registre du miroir Airtable : deux tables pour en remplacer neuf.
 *
 * Aujourd'hui la description du miroir est éparpillée dans NEUF tables, plus
 * 206 clés codées en dur dans le code des fonctions de sync :
 *
 *   airtable_sync_config          base + table + field_map de companies/contacts
 *   airtable_orders_config        idem pour orders/order_items
 *   airtable_projets_config       idem pour projects
 *   airtable_module_config        idem pour les 19 autres modules
 *   airtable_field_defs           ancêtre du registre de champs (866 lignes, morte)
 *   airtable_field_mappings       champ Airtable → colonne ERP
 *   airtable_frozen_columns       « ne pas écraser cette colonne »
 *   airtable_field_directions     sens de sync par champ
 *   airtable_writeback_guard      garde anti-écho (reste : c'est de l'état, pas de la config)
 *
 * Le sens de sync, le gel d'une colonne et le mapping d'un champ sont trois
 * tables distinctes alors que ce sont trois facettes d'une même décision :
 * « ce champ, dans quel sens ? ». D'où deux tables seulement — une ligne par
 * table Airtable, une ligne par champ Airtable — et un état explicite sur
 * chacune. Le gel devient « direction=push », l'import désactivé devient
 * « state=excluded ».
 *
 * Ce que la migration fait : créer les tables, vides. Elle ne remplit RIEN.
 * Le remplissage a besoin des métadonnées Airtable (types et ids de champs),
 * donc d'un appel réseau — il vit dans services/airtableMirrorRegistry.js et se
 * déclenche à la demande, jamais dans le chemin de démarrage.
 *
 * Ce que la migration ne fait pas non plus : changer le comportement du sync.
 * Les neuf tables restent la référence tant que le moteur unique (palier 3) ne
 * lit pas le registre. Ce palier rend la description du miroir VISIBLE et
 * MESURABLE ; le palier suivant la rend EXÉCUTABLE.
 */

export const id = '004-airtable-mirror-registry'
export const description = 'Crée airtable_mirrors et airtable_field_map (registre unique du miroir), vides'

export function up(db) {
  db.exec(`
    -- Une ligne par table Airtable, mirroirée ou non. Le contrat exige qu'AUCUNE
    -- table ne reste dans un troisième état « on n'y a jamais pensé » : d'où
    -- 'undecided', qui est un état déclaré et comptable, et non une absence.
    CREATE TABLE IF NOT EXISTS airtable_mirrors (
      id             TEXT PRIMARY KEY,            -- 'orders', 'envois', 'paies'…
      base_id        TEXT NOT NULL,
      table_id       TEXT NOT NULL,
      airtable_name  TEXT,                        -- rafraîchi depuis les métadonnées
      erp_table      TEXT,                        -- NULL si non mirroirée
      status         TEXT NOT NULL DEFAULT 'undecided'
                     CHECK (status IN ('mirrored','paused','excluded','undecided')),
      exclude_reason TEXT,                        -- attendu si status='excluded'
      -- Ordre de dépendance, en données plutôt qu'en constante : remplace
      -- MODULE_SYNC_PRIORITY codé en dur dans services/airtableWebhooks.js.
      -- JSON d'ids de miroirs à synchroniser avant celui-ci.
      depends_on     TEXT NOT NULL DEFAULT '[]',
      purge_orphans  INTEGER NOT NULL DEFAULT 1,
      -- Provenance de la décision. Le remplissage automatique ne touche jamais
      -- une ligne posée par un humain ('user') : sans ça, le prochain
      -- rafraîchissement écraserait silencieusement un arbitrage.
      decided_by     TEXT,                        -- 'backfill' | 'user' | NULL
      decided_at     TEXT,
      last_synced_at TEXT,
      last_audited_at TEXT,
      audit_divergences INTEGER,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (base_id, table_id)
    );

    CREATE INDEX IF NOT EXISTS idx_airtable_mirrors_status ON airtable_mirrors(status);
    CREATE INDEX IF NOT EXISTS idx_airtable_mirrors_erp_table ON airtable_mirrors(erp_table);

    -- Une ligne par champ Airtable d'une table mirroirée ou en pause.
    --
    -- « state » porte la décision, et 'core' est la dette : un champ alimenté par
    -- un field_map codé en dur, donc réglable nulle part et non auditable (sa
    -- transformation vit dans le code du module). C'est ce compteur que le
    -- palier 3 doit ramener à zéro.
    --
    --   mirrored  mappé sur une colonne ERP, valeur vérifiable
    --   core      alimenté par le field_map codé en dur — à reprendre
    --   excluded  décision prise de ne pas l'importer (raison obligatoire)
    --   unmapped  aucune décision — le compteur qui doit tomber à zéro
    --   broken    mapping présent mais colonne ERP absente
    CREATE TABLE IF NOT EXISTS airtable_field_map (
      id             TEXT PRIMARY KEY,
      mirror_id      TEXT NOT NULL REFERENCES airtable_mirrors(id) ON DELETE CASCADE,
      field_id       TEXT,                        -- 'fld…' réel ; NULL si le champ a disparu
      field_name     TEXT NOT NULL,
      airtable_type  TEXT,                        -- singleSelect, rollup, formula…
      erp_column     TEXT,                        -- NULL tant que non mappé
      -- Rôle, qui décide du chemin d'écriture ET de l'auditabilité :
      --   scalar     valeur simple, comparable
      --   link       record lié (recIds ↔ uuid ERP) — jamais comparable tel quel
      --   attachment pièce jointe recopiée localement — jamais comparable
      --   computed   formula/rollup/lookup/autoNumber — lecture seule côté Airtable
      role           TEXT NOT NULL DEFAULT 'scalar'
                     CHECK (role IN ('scalar','link','attachment','computed')),
      link_target    TEXT,                        -- table ERP cible d'un champ lien
      direction      TEXT NOT NULL DEFAULT 'pull'
                     CHECK (direction IN ('pull','push','both','none')),
      state          TEXT NOT NULL DEFAULT 'unmapped'
                     CHECK (state IN ('mirrored','core','excluded','unmapped','broken')),
      exclude_reason TEXT,
      transform      TEXT,                        -- nom d'un transform enregistré
      -- Clé logique du field_map cœur (ex. 'company', 'status') quand state='core'.
      -- C'est l'information qui manque pour reprendre le mapping sans relire le code.
      core_key       TEXT,
      decided_by     TEXT,                        -- 'backfill' | 'user' | NULL
      decided_at     TEXT,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- Un champ Airtable n'apparaît qu'une fois par miroir. L'unicité porte sur le
    -- NOM et non sur field_id : field_id est NULL pour les mappings orphelins
    -- (les fantômes 'webhook_*'), et plusieurs NULL passeraient l'unicité.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_airtable_field_map_field
      ON airtable_field_map(mirror_id, field_name);
    CREATE INDEX IF NOT EXISTS idx_airtable_field_map_state ON airtable_field_map(state);
    CREATE INDEX IF NOT EXISTS idx_airtable_field_map_column
      ON airtable_field_map(mirror_id, erp_column);
  `)
}
