import type { Database } from "bun:sqlite";

/** Strip current storage features from a test database seeded with legacy
 * signatures, including derived structures that reference newer columns. */
export function useFormat3Schema(db: Database): void {
  db.exec(`
    DROP TRIGGER context_policy_insert;
    DROP TRIGGER context_policy_take;
    DROP TABLE context_turn_policies;
    ALTER TABLE items DROP COLUMN external_source;
    ALTER TABLE entries DROP COLUMN external_source;
    ALTER TABLE items DROP COLUMN policy_metadata;
    ALTER TABLE channels DROP COLUMN policy;
    UPDATE meta SET value = '3' WHERE key = 'formatVersion';
  `);
}
