import { Pool } from 'pg';

export interface DbPostRow {
  id: string;
  month_key: string;
  topic_name: string;
  part_number: number;
  total_parts: number;
  stage_label: string;
  seo_title: string;
  seo_description: string;
  seo_tags: string[];
  slot_time: string;
  scheduled_at: Date | string;
  status: 'PENDING' | 'POSTED' | 'FAILED';
  fb_post_id: string | null;
  published_at: Date | string | null;
  is_simulated: boolean;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface DbSettingsRow {
  id: number;
  facebook_page_id: string;
  facebook_access_token: string;
  auto_publish_enabled: boolean;
  dry_run_mode: boolean;
  recurring_times: string[];
  updated_at: Date | string;
}

export interface DbActivityLogRow {
  id: string;
  timestamp: Date | string;
  level: 'info' | 'success' | 'warning' | 'error';
  category: 'scheduler' | 'gemini' | 'facebook' | 'storage' | 'auth' | 'socket';
  message: string;
  detail: string | null;
}

let pool: Pool | null = null;
let initialized = false;
let initError: string | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not configured. Add your PostgreSQL connection string in Settings > Secrets.'
    );
  }
  const requiresSsl =
    connectionString.includes('sslmode=require') ||
    connectionString.includes('db.prisma.io') ||
    process.env.NODE_ENV === 'production';

  pool = new Pool({
    connectionString,
    ssl: requiresSsl ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err.message);
  });

  return pool;
}

export async function initDatabase(): Promise<{ ok: boolean; error?: string }> {
  if (initialized) return { ok: true };
  try {
    const db = getPool();
    await db.query(`
      CREATE TABLE IF NOT EXISTS app_auth (
        email TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS publisher_settings (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        facebook_page_id TEXT NOT NULL DEFAULT '',
        facebook_access_token TEXT NOT NULL DEFAULT '',
        auto_publish_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        dry_run_mode BOOLEAN NOT NULL DEFAULT TRUE,
        recurring_times JSONB NOT NULL DEFAULT '["09:00","15:00","18:00"]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await db.query(`
      INSERT INTO publisher_settings (id)
      VALUES (1)
      ON CONFLICT (id) DO NOTHING;
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS scheduled_posts (
        id TEXT PRIMARY KEY,
        month_key TEXT NOT NULL,
        topic_name TEXT NOT NULL,
        part_number INTEGER NOT NULL DEFAULT 1,
        total_parts INTEGER NOT NULL DEFAULT 1,
        stage_label TEXT NOT NULL DEFAULT '',
        seo_title TEXT NOT NULL,
        seo_description TEXT NOT NULL,
        seo_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        slot_time TEXT NOT NULL,
        scheduled_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'POSTED', 'FAILED')),
        fb_post_id TEXT,
        published_at TIMESTAMPTZ,
        is_simulated BOOLEAN NOT NULL DEFAULT FALSE,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status_time
      ON scheduled_posts (status, scheduled_at);
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_scheduled_posts_month
      ON scheduled_posts (month_key, scheduled_at);
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id TEXT PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        detail TEXT
      );
    `);

    initialized = true;
    initError = null;
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Database connection failed.';
    initError = msg;
    console.error('Database initialization error:', msg);
    return { ok: false, error: msg };
  }
}

export function getDbStatus(): { initialized: boolean; error: string | null } {
  return { initialized, error: initError };
}

export function serializePost(row: DbPostRow) {
  return {
    id: row.id,
    monthKey: row.month_key,
    topicName: row.topic_name,
    partNumber: Number(row.part_number),
    totalParts: Number(row.total_parts),
    stageLabel: row.stage_label,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    seoTags: Array.isArray(row.seo_tags) ? row.seo_tags : [],
    slotTime: row.slot_time,
    scheduledAt:
      row.scheduled_at instanceof Date
        ? row.scheduled_at.toISOString()
        : String(row.scheduled_at),
    status: row.status,
    fbPostId: row.fb_post_id ?? undefined,
    publishedAt: row.published_at
      ? row.published_at instanceof Date
        ? row.published_at.toISOString()
        : String(row.published_at)
      : undefined,
    isSimulated: Boolean(row.is_simulated),
    errorMessage: row.error_message ?? undefined,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at),
  };
}

export function getEnvFacebookCredentials(): {
  pageId: string;
  accessToken: string;
} {
  const pageId = (
    process.env.FACEBOOK_PAGE_ID ||
    process.env.FB_PAGE_ID ||
    process.env.FACEBOOK_ID ||
    ''
  ).trim();
  const accessToken = (
    process.env.FACEBOOK_ACCESS_TOKEN ||
    process.env.FB_ACCESS_TOKEN ||
    process.env.FACEBOOK_SECRET ||
    ''
  ).trim();
  return { pageId, accessToken };
}

export function serializeSettings(row: DbSettingsRow) {
  const { pageId, accessToken: token } = getEnvFacebookCredentials();
  const maskedToken =
    token.length > 10
      ? `${token.slice(0, 6)}••••••${token.slice(-4)}`
      : token
        ? '••••••••'
        : '';

  return {
    facebookPageId: pageId,
    hasAccessToken: token.length > 0,
    maskedAccessToken: maskedToken,
    autoPublishEnabled: Boolean(row.auto_publish_enabled),
    dryRunMode: Boolean(row.dry_run_mode),
    recurringTimes: Array.isArray(row.recurring_times)
      ? row.recurring_times
      : ['09:00', '15:00', '18:00'],
  };
}

export function serializeLog(row: DbActivityLogRow) {
  return {
    id: row.id,
    timestamp:
      row.timestamp instanceof Date
        ? row.timestamp.toISOString()
        : String(row.timestamp),
    level: row.level,
    category: row.category,
    message: row.message,
    detail: row.detail ?? undefined,
  };
}
