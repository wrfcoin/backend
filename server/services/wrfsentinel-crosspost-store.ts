import { executeQuery } from '../../database/connection.js';

export type CrossPostKind = 'social' | 'report';

export interface CrossPostCreateInput {
  kind: CrossPostKind;
  principal: string;
  author: string;
  content: string;
  title?: string;
  summary?: string;
  category?: string;
  location: { lat: number; lng: number };
  severity: string;
  tags: string[];
  metrics: Record<string, unknown>;
  mediaUrls: string[];
  expiresAt?: string;
  validFrom?: string;
  validUntil?: string;
  idempotencyKey?: string;
}

export interface CrossPostRecord extends CrossPostCreateInput {
  id: string;
  source: 'wrfsentinel';
  sourceType: 'crisis_platform';
  createdAt: string;
}

export interface CrossPostStore {
  create(input: CrossPostCreateInput): Promise<CrossPostRecord>;
}

class PostgresCrossPostStore implements CrossPostStore {
  private schemaPromise: Promise<void> | null = null;

  async create(input: CrossPostCreateInput): Promise<CrossPostRecord> {
    await this.ensureSchema();
    const result = await executeQuery(
      `INSERT INTO wrfsentinel_crossposts (
         kind, principal, author, content, title, summary, category, location,
         severity, tags, metrics, media_urls, expires_at, valid_from,
         valid_until, idempotency_key
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb,
         $12::jsonb, $13, $14, $15, $16
       )
       ON CONFLICT (principal, idempotency_key)
         WHERE idempotency_key IS NOT NULL
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING
         id, kind, principal, author, content, title, summary, category,
         location, severity, tags, metrics, media_urls, expires_at, valid_from,
         valid_until, idempotency_key, created_at`,
      [
        input.kind,
        input.principal,
        input.author,
        input.content,
        input.title ?? null,
        input.summary ?? null,
        input.category ?? null,
        JSON.stringify(input.location),
        input.severity,
        JSON.stringify(input.tags),
        JSON.stringify(input.metrics),
        JSON.stringify(input.mediaUrls),
        input.expiresAt ?? null,
        input.validFrom ?? null,
        input.validUntil ?? null,
        input.idempotencyKey ?? null,
      ]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Cross-post insert returned no record');
    }

    return {
      id: String(row.id),
      kind: row.kind as CrossPostKind,
      principal: String(row.principal),
      author: String(row.author),
      content: String(row.content),
      title: row.title ? String(row.title) : undefined,
      summary: row.summary ? String(row.summary) : undefined,
      category: row.category ? String(row.category) : undefined,
      location: row.location as { lat: number; lng: number },
      severity: String(row.severity),
      tags: row.tags as string[],
      metrics: row.metrics as Record<string, unknown>,
      mediaUrls: row.media_urls as string[],
      expiresAt: toIso(row.expires_at),
      validFrom: toIso(row.valid_from),
      validUntil: toIso(row.valid_until),
      idempotencyKey: row.idempotency_key
        ? String(row.idempotency_key)
        : undefined,
      source: 'wrfsentinel',
      sourceType: 'crisis_platform',
      createdAt: toIso(row.created_at) as string,
    };
  }

  private ensureSchema(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.createSchema().catch(error => {
        this.schemaPromise = null;
        throw error;
      });
    }
    return this.schemaPromise;
  }

  private async createSchema(): Promise<void> {
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS wrfsentinel_crossposts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind text NOT NULL CHECK (kind IN ('social', 'report')),
        principal text NOT NULL,
        author text NOT NULL,
        content text NOT NULL,
        title text,
        summary text,
        category text,
        location jsonb NOT NULL,
        severity text NOT NULL,
        tags jsonb NOT NULL DEFAULT '[]'::jsonb,
        metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
        media_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
        expires_at timestamptz,
        valid_from timestamptz,
        valid_until timestamptz,
        idempotency_key text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await executeQuery(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        wrfsentinel_crossposts_principal_idempotency_idx
      ON wrfsentinel_crossposts (principal, idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);
    await executeQuery(`
      CREATE INDEX IF NOT EXISTS wrfsentinel_crossposts_created_at_idx
      ON wrfsentinel_crossposts (created_at DESC)
    `);
  }
}

function toIso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

export const wrfsentinelCrossPostStore = new PostgresCrossPostStore();
