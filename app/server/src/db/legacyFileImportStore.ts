/**
 * Which legacy JSON store files were imported into SQLite, keyed by the file
 * name and the sha256 of the exact bytes imported (`legacyJsonStoreImport.ts`).
 */
import { getDb } from "./index.ts";

export const legacyFileImportStore = {
  has(name: string, sha256: string): boolean {
    return (
      getDb()
        .prepare(
          "SELECT 1 FROM legacy_file_imports WHERE name = ? AND sha256 = ?",
        )
        .get(name, sha256) !== undefined
    );
  },

  record(name: string, sha256: string, recordCount: number): void {
    getDb()
      .prepare(
        "INSERT OR IGNORE INTO legacy_file_imports (name, sha256, record_count, imported_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run(name, sha256, recordCount, Date.now());
  },
};
