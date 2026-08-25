import { describe, expect, it } from 'vitest';
import { checksumOf, listMigrations, renderMigration } from '../src/migrate.js';

describe('migration files', () => {
  it('lists migrations in order with unique 4-digit ordinals', async () => {
    const files = await listMigrations(undefined, { embeddingDim: 768 });
    expect(files.length).toBeGreaterThanOrEqual(7);
    const names = files.map((f) => f.name);
    expect([...names].sort()).toEqual(names);
    for (const f of files) {
      expect(f.name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      expect(f.sql.length).toBeGreaterThan(0);
      expect(f.checksum).toHaveLength(64);
    }
  });

  it('substitutes the embedding dimension and leaves no placeholders behind', async () => {
    const files = await listMigrations(undefined, { embeddingDim: 512 });
    const joined = files.map((f) => f.sql).join('\n');
    expect(joined).toContain('vector(512)');
    expect(joined).not.toContain('{{EMBEDDING_DIM}}');
  });

  it('renderMigration only replaces the known placeholder', () => {
    const sql = 'CREATE TABLE t (v vector({{EMBEDDING_DIM}}), note text);';
    expect(renderMigration(sql, { embeddingDim: 768 })).toBe(
      'CREATE TABLE t (v vector(768), note text);',
    );
  });

  it('checksum changes when the rendered dimension changes', () => {
    const sql = 'CREATE TABLE t (v vector({{EMBEDDING_DIM}}));';
    const a = checksumOf(renderMigration(sql, { embeddingDim: 768 }));
    const b = checksumOf(renderMigration(sql, { embeddingDim: 1024 }));
    expect(a).not.toBe(b);
  });
});
