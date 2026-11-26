import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Type } from '@google/genai';
import {
  getDbStatus,
  getEnvFacebookCredentials,
  getPool,
  initDatabase,
  serializeLog,
  serializePost,
  serializeSettings,
  type DbActivityLogRow,
  type DbAuthRow,
  type DbAuthSessionRow,
  type DbPostRow,
  type DbSettingsRow,
} from './server/db.ts';
import {
  checkAuthRateLimit,
  clearFailedAuthAttempts,
  clearRefreshCookie,
  ensureEnvPasswordSyncedInDb,
  extractBearerToken,
  extractVerifiedRefreshCookie,
  getAccessTokenTtlSec,
  getBcryptCost,
  getEnvAdminEmail,
  getRefreshTokenTtlMs,
  hashPasswordBcrypt,
  isEnvPasswordConfigured,
  isSetupRequired,
  issueSessionAndTokens,
  passesCookieCsrfCheck,
  recordFailedAuthAttempt,
  requireAuth,
  resolveAuthorizedEmail,
  revokeAllSessionsForEmail,
  revokeSessionById,
  revokeSessionByRefreshToken,
  rotateManagedSigningSecrets,
  rotateRefreshSession,
  setRefreshCookie,
  verifyAccessJwt,
  verifyPasswordHash,
  verifyPlaintextConstantTime,
  type AuthenticatedRequest,
} from './server/auth.ts';
import {
  exchangeForPermanentPageToken,
  getFacebookAppCredentials,
  getFacebookTokenMetaStatus,
  isFacebookTokenError,
  markTokenPausedForSha,
  reconcileEnvTokenRecovery,
  resolveEffectiveEnvFacebookCredentials,
  setFacebookTokenErrorNotice,
} from './server/fbToken.ts';
import {
  createCloudinaryUploadSignature,
  getCloudinaryPublicStatus,
  validateSafeMediaUrl,
} from './server/cloudinary.ts';
import {
  extractGoogleSheetExportUrl,
  parseWorkbookBufferToRows,
} from './server/sheetImport.ts';
import { buildMl30DayCurriculumPosts } from './server/mlCurriculum.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const GEMINI_MODEL = 'gemini-4-hydrogen';
const SCHEDULER_INTERVAL_MS = 15000;

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Please check the Settings > Secrets panel.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function sanitizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => String(tag).trim())
    .filter(Boolean)
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag.replace(/\s+/g, '')}`))
    .slice(0, 5);
}

function clampTitle(title: unknown): string {
  const text = String(title ?? '').trim();
  if (text.length <= 70) return text;
  return `${text.slice(0, 67).trimEnd()}...`;
}

function formatFbMessage(post: {
  seoTitle: string;
  seoDescription: string;
  seoTags: string[];
}): string {
  const tagsLine = post.seoTags
    .map((t) => (t.startsWith('#') ? t : `#${t.replace(/^#+/, '')}`))
    .join(' ');
  return `${post.seoTitle}\n\n${post.seoDescription}\n\n${tagsLine}`.trim();
}

const STAGE_GUIDE: Record<number, string> = {
  1: 'Theme & Introduction: Hook-driven conceptual breakdown, why it matters, and intuitive mental model.',
  2: 'Easy Example: Clean, beginner-friendly practical code or concrete walkthrough example.',
  3: 'Advanced Application: Production-grade, complex real-world implementation.',
  4: 'Exceptions & Edge Cases: Tricky edge cases, common bugs/exceptions, and specialized use cases.',
  5: 'Optimization & Best Practices: Performance tuning, gotchas, and actionable pro tips.',
};

interface AuthedSocket extends WebSocket {
  isAuthenticated?: boolean;
  userEmail?: string;
}

type ResolvedFacebookTarget =
  | {
      ok: true;
      effectivePageId: string;
      effectiveToken: string;
      pageName: string;
      pageLink: string;
      isPublished: boolean;
      isPageToken: boolean;
      resolvedViaAccounts: boolean;
      permanentExchanged?: boolean;
      tokenOwnerId: string;
      tokenOwnerName: string | null;
      availablePages: Array<{ id: string; name: string }>;
      warnings: string[];
    }
  | {
      ok: false;
      error: string;
      tokenExpired?: boolean;
      availablePages?: Array<{ id: string; name: string }>;
    };

class FacebookTokenExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FacebookTokenExpiredError';
  }
}

async function resolveFacebookTarget(
  configuredPageId: string,
  configuredToken: string
): Promise<ResolvedFacebookTarget> {
  const meRes = await fetch(
    `https://graph.facebook.com/v27.0/me?fields=id,name&access_token=${encodeURIComponent(configuredToken)}`
  );
  const meJson = (await meRes.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    error?: { code?: number; error_subcode?: number; message?: string };
  };

  if (!meRes.ok || meJson.error || !meJson.id) {
    const expired = isFacebookTokenError(meJson.error, meRes.status);
    return {
      ok: false,
      tokenExpired: expired,
      error:
        meJson.error?.message ||
        `Invalid FACEBOOK_ACCESS_TOKEN (HTTP ${meRes.status}).`,
    };
  }

  // Probe /me/accounts to detect whether configuredToken is a User Token or Page Token
  const accountsRes = await fetch(
    `https://graph.facebook.com/v27.0/me/accounts?fields=id,name,access_token,link,is_published&limit=50&access_token=${encodeURIComponent(configuredToken)}`
  );
  const accountsJson = (await accountsRes.json().catch(() => ({}))) as {
    data?: Array<{
      id: string;
      name?: string;
      access_token?: string;
      link?: string;
      is_published?: boolean;
    }>;
    error?: { code?: number; error_subcode?: number; message?: string };
  };

  if (accountsRes.ok && Array.isArray(accountsJson.data)) {
    const availablePages = accountsJson.data.map((p) => ({
      id: p.id,
      name: p.name || p.id,
    }));
    const matched = accountsJson.data.find((p) => p.id === configuredPageId);

    if (matched) {
      if (!matched.access_token) {
        return {
          ok: false,
          error: `Found Page "${matched.name || matched.id}", but Facebook did not return a Page Access Token. Re-generate the token with pages_manage_posts, pages_read_engagement, and pages_show_list.`,
          availablePages,
        };
      }

      // Automatically upgrade short-lived User Token -> Never-Expiring Page Token if App credentials exist
      const appCreds = getFacebookAppCredentials();
      if (appCreds.appId && appCreds.appSecret) {
        const exchanged = await exchangeForPermanentPageToken(
          configuredPageId,
          configuredToken
        );
        if (exchanged.ok) {
          const warnings: string[] = [];
          if (matched.is_published === false) {
            warnings.push('Your Facebook Page is currently set to Unpublished.');
          }
          return {
            ok: true,
            effectivePageId: matched.id,
            effectiveToken: exchanged.permanentPageToken,
            pageName: matched.name || matched.id,
            pageLink: matched.link || `https://www.facebook.com/${matched.id}`,
            isPublished: matched.is_published !== false,
            isPageToken: true,
            resolvedViaAccounts: true,
            permanentExchanged: true,
            tokenOwnerId: meJson.id,
            tokenOwnerName: meJson.name || null,
            availablePages,
            warnings,
          };
        }
      }

      const warnings: string[] = [
        `Resolved Page Access Token from a User Token. To prevent 2-hour session expiry, set FACEBOOK_APP_ID + FACEBOOK_APP_SECRET in Secrets for automatic never-expiring token exchange (or store a permanent Page Token directly in FACEBOOK_ACCESS_TOKEN).`,
      ];
      if (matched.is_published === false) {
        warnings.push('Your Facebook Page is currently set to Unpublished.');
      }
      return {
        ok: true,
        effectivePageId: matched.id,
        effectiveToken: matched.access_token,
        pageName: matched.name || matched.id,
        pageLink: matched.link || `https://www.facebook.com/${matched.id}`,
        isPublished: matched.is_published !== false,
        isPageToken: true,
        resolvedViaAccounts: true,
        permanentExchanged: false,
        tokenOwnerId: meJson.id,
        tokenOwnerName: meJson.name || null,
        availablePages,
        warnings,
      };
    }

    const pagesHint =
      availablePages.length > 0
        ? ` Pages managed by your token: ${availablePages.map((p) => `${p.name} (${p.id})`).join(', ')}.`
        : ' No Facebook Pages were returned under /me/accounts — ensure you selected a Page in Graph API Explorer and granted pages_show_list + pages_manage_posts + pages_read_engagement.';

    if (configuredPageId === meJson.id) {
      return {
        ok: false,
        error: `FACEBOOK_PAGE_ID (${configuredPageId}) is your personal Facebook User ID ("${meJson.name || meJson.id}"), not a Facebook Page ID. Facebook does not allow API posting to personal profiles.${pagesHint}`,
        availablePages,
      };
    }

    return {
      ok: false,
      error: `FACEBOOK_PAGE_ID (${configuredPageId}) was not found among the Pages accessible to this User Token.${pagesHint}`,
      availablePages,
    };
  }

  // configuredToken is a Page Access Token (or page-scoped): meJson.id IS the token's Page ID
  if (meJson.id !== configuredPageId) {
    return {
      ok: false,
      error: `Mismatch: FACEBOOK_ACCESS_TOKEN belongs to "${meJson.name || meJson.id}" (ID: ${meJson.id}), which does not match FACEBOOK_PAGE_ID (${configuredPageId}). Set FACEBOOK_PAGE_ID=${meJson.id} in Settings > Secrets (or generate a Page token for ${configuredPageId}).`,
      availablePages: [{ id: meJson.id, name: meJson.name || meJson.id }],
    };
  }

  const pageRes = await fetch(
    `https://graph.facebook.com/v27.0/${encodeURIComponent(configuredPageId)}?fields=id,name,link,is_published&access_token=${encodeURIComponent(configuredToken)}`
  );
  const pageJson = (await pageRes.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    link?: string;
    is_published?: boolean;
    error?: { message?: string };
  };

  if (!pageRes.ok || pageJson.error || !pageJson.id) {
    return {
      ok: false,
      error:
        pageJson.error?.message ||
        `Unable to load Facebook Page ${configuredPageId} (HTTP ${pageRes.status}). Verify it is a Facebook Page ID (not a profile/App ID) and has pages_manage_posts + pages_read_engagement.`,
    };
  }

  const warnings: string[] = [];
  if (pageJson.is_published === false) {
    warnings.push('Your Facebook Page itself is currently set to Unpublished.');
  }

  return {
    ok: true,
    effectivePageId: pageJson.id,
    effectiveToken: configuredToken,
    pageName: pageJson.name || pageJson.id,
    pageLink: pageJson.link || `https://www.facebook.com/${pageJson.id}`,
    isPublished: pageJson.is_published !== false,
    isPageToken: true,
    resolvedViaAccounts: false,
    tokenOwnerId: meJson.id,
    tokenOwnerName: meJson.name || null,
    availablePages: [{ id: pageJson.id, name: pageJson.name || pageJson.id }],
    warnings,
  };
}

const activePublishingIds = new Set<string>();
let nextSchedulerRunAt = new Date(Date.now() + SCHEDULER_INTERVAL_MS).toISOString();
let lastSchedulerRunAt: string | null = null;

export async function createServerApp(options: { standalone?: boolean } = {}) {
  const standalone = options.standalone ?? false;
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const allowedCorsOrigins = new Set<string>();
  const rawCorsOrigins = (process.env.CORS_ORIGIN || '').split(',');
  for (const item of rawCorsOrigins) {
    const trimmed = item.trim().replace(/\/+$/, '');
    if (trimmed) allowedCorsOrigins.add(trimmed);
  }
  if (process.env.APP_URL) {
    try {
      allowedCorsOrigins.add(new URL(process.env.APP_URL).origin);
    } catch {
      // ignore invalid APP_URL
    }
  }

  // Security headers + strict CORS enforcement (no wildcard on authenticated endpoints)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    const originHeader = req.headers.origin;
    if (originHeader) {
      const normalizedOrigin = originHeader.trim().replace(/\/+$/, '');
      const requestHost = (req.headers['x-forwarded-host'] || req.headers.host || '')
        .toString()
        .split(',')[0]
        .trim()
        .toLowerCase();
      let isSameHost = false;
      try {
        isSameHost = new URL(normalizedOrigin).host.toLowerCase() === requestHost;
      } catch {
        isSameHost = false;
      }

      if (allowedCorsOrigins.has(normalizedOrigin) || isSameHost) {
        res.setHeader('Access-Control-Allow-Origin', normalizedOrigin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, Authorization, X-Requested-With'
        );
        res.setHeader(
          'Access-Control-Allow-Methods',
          'GET, POST, PUT, PATCH, DELETE, OPTIONS'
        );
      } else if (req.path.startsWith('/api/')) {
        res.status(403).json({ error: 'CORS origin not allowed.' });
        return;
      }
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '2mb' }));

  const server = standalone ? http.createServer(app) : null;
  const wss = server ? new WebSocketServer({ server, path: '/ws' }) : null;

  const dbBoot = await initDatabase();
  if (!dbBoot.ok) {
    console.warn('Database not ready on boot:', dbBoot.error);
  }

  async function seedMlMonthCurriculum(opts: {
    startDate?: string;
    timezoneOffsetMinutes?: number;
    onlyIfEmpty?: boolean;
  } = {}): Promise<ReturnType<typeof serializePost>[]> {
    const dbReady = await initDatabase();
    if (!dbReady.ok) {
      throw new Error(dbReady.error || 'Database unavailable.');
    }
    const pool = getPool();

    if (opts.onlyIfEmpty) {
      const metaRes = await pool.query<{ value: string }>(
        `SELECT value FROM app_meta WHERE key = 'ml_month_seeded' LIMIT 1`
      );
      const countRes = await pool.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM scheduled_posts`
      );
      if (metaRes.rows[0]?.value === 'true' || (countRes.rows[0]?.cnt ?? 0) > 0) {
        return [];
      }
    }

    const startDate =
      opts.startDate?.trim() || new Date().toISOString().slice(0, 10);
    const [startY, startM, startD] = startDate.split('-').map(Number);
    // timezoneOffsetMinutes matches JS Date.getTimezoneOffset() (e.g. 480 for PST -08:00, -360 for +06:00)
    const offsetMin =
      typeof opts.timezoneOffsetMinutes === 'number' && !Number.isNaN(opts.timezoneOffsetMinutes)
        ? opts.timezoneOffsetMinutes
        : 480;

    const curriculum = buildMl30DayCurriculumPosts();
    const insertedPosts: ReturnType<typeof serializePost>[] = [];

    for (const item of curriculum) {
      const [hh, mm] = item.slotTime.split(':').map(Number);
      // Compute UTC timestamp representing local YYYY-MM-DD HH:mm in caller's offset
      const utcMs =
        Date.UTC(
          startY || 2026,
          (startM || 11) - 1,
          (startD || 24) + (item.dayNumber - 1),
          hh || 9,
          mm || 0,
          0,
          0
        ) +
        offsetMin * 60_000;

      const scheduledDate = new Date(utcMs);
      const localDateForMonth = new Date(utcMs - offsetMin * 60_000);
      const monthKey = `${localDateForMonth.getUTCFullYear()}-${String(
        localDateForMonth.getUTCMonth() + 1
      ).padStart(2, '0')}`;

      const id = makeId('post');
      const res = await pool.query<DbPostRow>(
        `INSERT INTO scheduled_posts (
           id, month_key, topic_name, part_number, total_parts, stage_label,
           seo_title, seo_description, seo_tags, slot_time, scheduled_at, status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::timestamptz, 'PENDING')
         RETURNING *`,
        [
          id,
          monthKey,
          item.topicName,
          item.partNumber,
          item.totalParts,
          item.stageLabel,
          item.seoTitle,
          item.seoDescription,
          JSON.stringify(item.seoTags),
          item.slotTime,
          scheduledDate.toISOString(),
        ]
      );
      if (res.rows[0]) {
        insertedPosts.push(serializePost(res.rows[0]));
      }
    }

    await pool.query(
      `UPDATE publisher_settings
       SET recurring_times = '["09:00","15:00","18:00"]'::jsonb,
           updated_at = NOW()
       WHERE id = 1`
    );

    await pool.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('ml_month_seeded', 'true')
       ON CONFLICT (key) DO UPDATE SET value = 'true'`
    );

    if (insertedPosts.length > 0) {
      broadcast({ type: 'posts:bulk_created', data: insertedPosts });
      await recordLog(
        'success',
        'storage',
        `Scheduled 30-day Machine Learning (Beginner to Advanced) series: ${insertedPosts.length} posts (3/day at 09:00, 15:00, 18:00).`,
        `Start date: ${startDate}`
      );
    }

    return insertedPosts;
  }

  if (dbBoot.ok) {
    await seedMlMonthCurriculum({ onlyIfEmpty: true }).catch((err) => {
      console.warn('Initial ML curriculum seed skipped:', err);
    });
  }

  function broadcast(event: { type: string; data?: unknown }) {
    if (!wss) return;
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      const sock = client as AuthedSocket;
      if (sock.isAuthenticated && sock.readyState === WebSocket.OPEN) {
        sock.send(payload);
      }
    }
  }

  async function recordLog(
    level: DbActivityLogRow['level'],
    category: DbActivityLogRow['category'],
    message: string,
    detail?: string
  ) {
    try {
      const pool = getPool();
      const id = makeId('log');
      const res = await pool.query<DbActivityLogRow>(
        `INSERT INTO activity_logs (id, level, category, message, detail)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [id, level, category, message, detail ?? null]
      );
      if (res.rows[0]) {
        broadcast({ type: 'activity:logged', data: serializeLog(res.rows[0]) });
      }
    } catch (err) {
      console.error('Failed to persist activity log:', err);
    }
  }

  async function buildSerializedSettings(row?: DbSettingsRow) {
    const envCreds = getEnvFacebookCredentials();
    const tokenStatus = await getFacebookTokenMetaStatus();
    const base = row
      ? serializeSettings(row)
      : {
          facebookPageId: envCreds.pageId,
          hasAccessToken: envCreds.accessToken.length > 0,
          maskedAccessToken: envCreds.accessToken
            ? envCreds.accessToken.length > 10
              ? `${envCreds.accessToken.slice(0, 6)}••••••${envCreds.accessToken.slice(-4)}`
              : '••••••••'
            : '',
          autoPublishEnabled: true,
          dryRunMode: true,
          recurringTimes: ['09:00', '15:00', '18:00'],
        };
    return {
      ...base,
      tokenStatus,
      mediaConfig: getCloudinaryPublicStatus(),
    };
  }

  async function loadFullWorkspaceState() {
    await reconcileEnvTokenRecovery();
    const pool = getPool();
    const [postsRes, settingsRes, logsRes] = await Promise.all([
      pool.query<DbPostRow>(
        'SELECT * FROM scheduled_posts ORDER BY scheduled_at ASC, part_number ASC'
      ),
      pool.query<DbSettingsRow>(
        'SELECT * FROM publisher_settings WHERE id = 1 LIMIT 1'
      ),
      pool.query<DbActivityLogRow>(
        'SELECT * FROM activity_logs ORDER BY timestamp DESC LIMIT 150'
      ),
    ]);

    return {
      posts: postsRes.rows.map(serializePost),
      settings: await buildSerializedSettings(settingsRes.rows[0]),
      logs: logsRes.rows.map(serializeLog),
      scheduler: {
        intervalSeconds: SCHEDULER_INTERVAL_MS / 1000,
        lastRunAt: lastSchedulerRunAt,
        nextRunAt: nextSchedulerRunAt,
      },
    };
  }

  if (wss) {
    wss.on('connection', (ws: AuthedSocket) => {
      ws.isAuthenticated = false;

      const authTimeout = setTimeout(() => {
        if (!ws.isAuthenticated && ws.readyState === WebSocket.OPEN) {
          ws.close(4001, 'Authentication timeout');
        }
      }, 8000);

      ws.on('message', async (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string; token?: string };
          if (msg.type === 'auth') {
            const payload = await verifyAccessJwt(String(msg.token ?? ''));
            if (!payload) {
              ws.send(JSON.stringify({ type: 'auth:error', error: 'Invalid or expired JWT' }));
              ws.close(4001, 'Unauthorized');
              return;
            }
            clearTimeout(authTimeout);
            ws.isAuthenticated = true;
            ws.userEmail = payload.email;

            const dbCheck = await initDatabase();
            if (!dbCheck.ok) {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  error: dbCheck.error || 'Database unavailable',
                })
              );
              return;
            }

            const state = await loadFullWorkspaceState();
            ws.send(JSON.stringify({ type: 'init', data: state }));
          } else if (msg.type === 'ping' && ws.isAuthenticated) {
            ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          }
        } catch {
          // Ignore malformed messages
        }
      });

      ws.on('close', () => {
        clearTimeout(authTimeout);
      });
    });
  }

  async function publishPostById(
    postId: string,
    source: 'manual' | 'scheduler'
  ): Promise<ReturnType<typeof serializePost>> {
    if (activePublishingIds.has(postId)) {
      throw new Error('Publish already in progress for this post.');
    }
    activePublishingIds.add(postId);

    try {
      const pool = getPool();
      const postRes = await pool.query<DbPostRow>(
        'SELECT * FROM scheduled_posts WHERE id = $1 LIMIT 1',
        [postId]
      );
      const row = postRes.rows[0];
      if (!row) {
        throw new Error('Scheduled post not found.');
      }
      const post = serializePost(row);

      const settingsRes = await pool.query<DbSettingsRow>(
        'SELECT * FROM publisher_settings WHERE id = 1 LIMIT 1'
      );
      const settingsRow = settingsRes.rows[0];
      const isDryRun = settingsRow ? Boolean(settingsRow.dry_run_mode) : true;
      const { pageId, accessToken } = await resolveEffectiveEnvFacebookCredentials();

      if (isDryRun) {
        const simPage = pageId || 'sim_page';
        const simPostId = `${simPage}_${Date.now()}`;
        const updatedRes = await pool.query<DbPostRow>(
          `UPDATE scheduled_posts
           SET status = 'POSTED',
               fb_post_id = $2,
               published_at = NOW(),
               is_simulated = TRUE,
               error_message = NULL,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [postId, simPostId]
        );
        const updated = serializePost(updatedRes.rows[0]);
        broadcast({ type: 'post:updated', data: updated });
        await recordLog(
          'warning',
          'facebook',
          `[DRY RUN / NOT ON FB] ${source === 'scheduler' ? 'Simulated auto-publish' : 'Simulated publish'} for "${updated.topicName}" (${updated.slotTime}). Turn OFF Dry Run to post live.`,
          `Simulated ID: ${simPostId}`
        );
        return updated;
      }

      if (!pageId || !accessToken) {
        const errMsg =
          'Missing FACEBOOK_PAGE_ID or FACEBOOK_ACCESS_TOKEN in server environment secrets. Add them in Settings > Secrets.';
        const failRes = await pool.query<DbPostRow>(
          `UPDATE scheduled_posts
           SET status = 'FAILED',
               error_message = $2,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [postId, errMsg]
        );
        const failed = serializePost(failRes.rows[0]);
        broadcast({ type: 'post:updated', data: failed });
        await recordLog(
          'error',
          'facebook',
          `Failed ${source} publish for "${failed.topicName}" (${failed.slotTime})`,
          errMsg
        );
        throw new Error(errMsg);
      }

      const handleTokenExpiryPause = async (expiredMessage: string) => {
        const friendly = `${expiredMessage} Auto-publish paused and posts kept PENDING so your queue does not fail while you are away. Update FACEBOOK_ACCESS_TOKEN in Secrets (or configure FACEBOOK_APP_ID & FACEBOOK_APP_SECRET for a never-expiring Page Token).`;
        await markTokenPausedForSha(getEnvFacebookCredentials().accessToken || accessToken);
        await setFacebookTokenErrorNotice(friendly);
        const pausedRes = await pool.query<DbSettingsRow>(
          `UPDATE publisher_settings
           SET auto_publish_enabled = FALSE,
               updated_at = NOW()
           WHERE id = 1
           RETURNING *`
        );
        const serializedSettings = await buildSerializedSettings(pausedRes.rows[0]);
        broadcast({ type: 'settings:updated', data: serializedSettings });
        await recordLog(
          'warning',
          'facebook',
          'Facebook Access Token expired — paused auto-publish and preserved PENDING queue.',
          expiredMessage
        );
        throw new FacebookTokenExpiredError(friendly);
      };

      const resolved = await resolveFacebookTarget(pageId, accessToken);
      if (!resolved.ok) {
        if (resolved.tokenExpired) {
          await handleTokenExpiryPause(resolved.error);
        }
        const failRes = await pool.query<DbPostRow>(
          `UPDATE scheduled_posts
           SET status = 'FAILED',
               error_message = $2,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [postId, resolved.error]
        );
        const failed = serializePost(failRes.rows[0]);
        broadcast({ type: 'post:updated', data: failed });
        await recordLog(
          'error',
          'facebook',
          `Facebook check failed for "${failed.topicName}" (${failed.slotTime})`,
          resolved.error
        );
        throw new Error(resolved.error);
      }

      const message = formatFbMessage(post);
      const safeMediaUrl =
        post.mediaType !== 'none' ? validateSafeMediaUrl(post.mediaUrl) : null;

      let graphUrl = `https://graph.facebook.com/v27.0/${encodeURIComponent(
        resolved.effectivePageId
      )}/feed`;
      const params = new URLSearchParams();
      params.append('published', 'true');
      params.append('access_token', resolved.effectiveToken);

      if (post.mediaType === 'image' && safeMediaUrl) {
        graphUrl = `https://graph.facebook.com/v27.0/${encodeURIComponent(
          resolved.effectivePageId
        )}/photos`;
        params.append('url', safeMediaUrl);
        params.append('caption', message);
      } else if (post.mediaType === 'video' && safeMediaUrl) {
        graphUrl = `https://graph-video.facebook.com/v27.0/${encodeURIComponent(
          resolved.effectivePageId
        )}/videos`;
        params.append('file_url', safeMediaUrl);
        params.append('title', post.seoTitle.slice(0, 120));
        params.append('description', message);
      } else {
        params.append('message', message);
      }

      const fbRes = await fetch(graphUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      const fbJson = (await fbRes.json().catch(() => ({}))) as {
        id?: string;
        post_id?: string;
        error?: { code?: number; error_subcode?: number; message?: string };
      };

      const publishedFbId = fbJson.post_id || fbJson.id;

      if (!fbRes.ok || fbJson.error || !publishedFbId) {
        let errMsg =
          fbJson.error?.message ||
          `Facebook Graph API returned HTTP ${fbRes.status}`;
        if (isFacebookTokenError(fbJson.error, fbRes.status)) {
          await handleTokenExpiryPause(errMsg);
        }
        if (errMsg.includes('Unsupported post request')) {
          errMsg = `${errMsg} — Check that FACEBOOK_PAGE_ID (${resolved.effectivePageId}) is a Facebook Page ID (not a personal profile or App ID) and the token has pages_manage_posts + pages_read_engagement permissions.`;
        }
        const failRes = await pool.query<DbPostRow>(
          `UPDATE scheduled_posts
           SET status = 'FAILED',
               error_message = $2,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [postId, errMsg]
        );
        const failed = serializePost(failRes.rows[0]);
        broadcast({ type: 'post:updated', data: failed });
        await recordLog(
          'error',
          'facebook',
          `Facebook Graph API failed for "${failed.topicName}" (${failed.slotTime})`,
          errMsg
        );
        throw new Error(errMsg);
      }

      // Successful live publish clears any previous token expiration banner
      await setFacebookTokenErrorNotice('');

      const okRes = await pool.query<DbPostRow>(
        `UPDATE scheduled_posts
         SET status = 'POSTED',
             fb_post_id = $2,
             published_at = NOW(),
             is_simulated = FALSE,
             error_message = NULL,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [postId, publishedFbId]
      );
      const updated = serializePost(okRes.rows[0]);
      broadcast({ type: 'post:updated', data: updated });
      await recordLog(
        'success',
        'facebook',
        `${source === 'scheduler' ? 'Auto-published' : 'Published'} ${
          post.mediaType === 'image'
            ? 'photo post'
            : post.mediaType === 'video'
              ? 'video post'
              : 'post'
        } "${updated.topicName}" (${updated.slotTime}) to Facebook Page.`,
        `FB Post ID: ${publishedFbId}`
      );
      return updated;
    } finally {
      activePublishingIds.delete(postId);
    }
  }

  async function runBackgroundScheduler(trigger: 'auto' | 'manual') {
    lastSchedulerRunAt = new Date().toISOString();
    nextSchedulerRunAt = new Date(Date.now() + SCHEDULER_INTERVAL_MS).toISOString();

    const dbReady = await initDatabase();
    if (!dbReady.ok) return;

    try {
      const tokenRecovered = await reconcileEnvTokenRecovery();
      if (tokenRecovered) {
        await recordLog(
          'success',
          'facebook',
          'Detected updated FACEBOOK_ACCESS_TOKEN in server environment — cleared expiry notice and resumed Auto-Publish.'
        );
      }
      const pool = getPool();
      const settingsRes = await pool.query<DbSettingsRow>(
        'SELECT * FROM publisher_settings WHERE id = 1 LIMIT 1'
      );
      const settings = settingsRes.rows[0];
      const autoEnabled = settings ? Boolean(settings.auto_publish_enabled) : true;

      broadcast({
        type: 'scheduler:tick',
        data: {
          intervalSeconds: SCHEDULER_INTERVAL_MS / 1000,
          lastRunAt: lastSchedulerRunAt,
          nextRunAt: nextSchedulerRunAt,
          autoPublishEnabled: autoEnabled,
        },
      });

      if (trigger === 'auto' && !autoEnabled) {
        return;
      }

      const dueRes = await pool.query<DbPostRow>(
        `SELECT * FROM scheduled_posts
         WHERE status = 'PENDING' AND scheduled_at <= NOW()
         ORDER BY scheduled_at ASC, part_number ASC
         LIMIT 10`
      );

      if (dueRes.rows.length === 0) {
        if (trigger === 'manual') {
          await recordLog(
            'info',
            'scheduler',
            'Manual background check complete: no due PENDING posts found.'
          );
        }
        return;
      }

      await recordLog(
        'info',
        'scheduler',
        `Background scheduler triggered for ${dueRes.rows.length} due post${dueRes.rows.length > 1 ? 's' : ''}.`
      );

      for (const row of dueRes.rows) {
        if (!activePublishingIds.has(row.id)) {
          try {
            await publishPostById(row.id, 'scheduler');
          } catch (err) {
            if (err instanceof FacebookTokenExpiredError) {
              // Stop batch immediately so remaining due posts stay PENDING
              break;
            }
            // Other errors already persisted and broadcast
          }
        }
      }
    } catch (err) {
      console.error('Background scheduler loop error:', err);
    }
  }

  if (standalone) {
    setInterval(() => {
      void runBackgroundScheduler('auto');
    }, SCHEDULER_INTERVAL_MS);
  }

  // ---------------- Public Auth & Health Routes ----------------

  app.get('/api/health', async (_req: Request, res: Response) => {
    const dbCheck = await initDatabase();
    let scheduledPostsCount = 0;
    if (dbCheck.ok) {
      try {
        const countRes = await getPool().query<{ cnt: number }>(
          'SELECT COUNT(*)::int AS cnt FROM scheduled_posts'
        );
        scheduledPostsCount = countRes.rows[0]?.cnt ?? 0;
      } catch {
        // ignore count error on health check
      }
    }
    res.json({
      ok: true,
      model: GEMINI_MODEL,
      realtimeMode: standalone ? 'websocket' : 'http-sync',
      dbConnected: dbCheck.ok,
      dbError: dbCheck.error,
      scheduledPostsCount,
    });
  });

  app.get('/api/auth/status', async (req: Request, res: Response) => {
    try {
      const setup = await isSetupRequired();
      const bearerToken = extractBearerToken(req);
      let session = bearerToken ? await verifyAccessJwt(bearerToken) : null;
      let activeToken: string | null = session && bearerToken ? bearerToken : null;

      // If no active Bearer JWT was sent, transparently rotate from HMAC-signed HttpOnly refresh cookie
      if (!session && setup.dbConnected) {
        const refreshToken = await extractVerifiedRefreshCookie(req);
        if (refreshToken) {
          const rotated = await rotateRefreshSession(refreshToken, req);
          if (rotated.ok) {
            await setRefreshCookie(req, res, rotated.refreshToken);
            activeToken = rotated.accessToken;
            session = {
              email: rotated.email,
              sid: rotated.sid,
              jti: rotated.jti,
              tokenVersion: rotated.tokenVersion,
              expiresAt: rotated.expiresAt,
              issuedAt: new Date().toISOString(),
            };
          } else {
            if (rotated.reuseDetected) {
              await recordLog(
                'warning',
                'auth',
                'Security alert: refresh token reuse detected. Session family revoked.'
              );
            }
            clearRefreshCookie(req, res);
          }
        }
      }

      return res.json({
        authenticated: Boolean(session),
        email: session?.email ?? null,
        token: activeToken,
        expiresAt: session?.expiresAt ?? null,
        sid: session?.sid ?? null,
        jtiPrefix: session?.jti ? session.jti.slice(0, 8) : null,
        tokenVersion: session?.tokenVersion ?? null,
        realtimeMode: standalone ? 'websocket' : 'http-sync',
        setupRequired: setup.setupRequired,
        dbConnected: setup.dbConnected,
        dbError: setup.dbConnected ? null : 'Service unavailable.',
      });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Auth status check failed.',
      });
    }
  });

  app.post('/api/auth/refresh', async (req: Request, res: Response) => {
    try {
      if (!passesCookieCsrfCheck(req)) {
        return res.status(403).json({ error: 'Cross-origin refresh request rejected.' });
      }
      const rateLimit = await checkAuthRateLimit(req);
      if (rateLimit.limited) {
        return res.status(429).json({
          error: `Too many requests. Try again in ${rateLimit.retryAfterSec}s.`,
          retryAfterSec: rateLimit.retryAfterSec,
        });
      }

      const refreshToken = await extractVerifiedRefreshCookie(req);
      if (!refreshToken) {
        return res.status(401).json({ error: 'Refresh session missing. Please sign in again.' });
      }

      const rotated = await rotateRefreshSession(refreshToken, req);
      if (!rotated.ok) {
        clearRefreshCookie(req, res);
        await recordFailedAuthAttempt(req);
        if (rotated.reuseDetected) {
          await recordLog(
            'warning',
            'auth',
            'Security alert: refresh token reuse detected. Session family revoked.'
          );
        }
        return res.status(401).json({ error: rotated.reason });
      }

      await setRefreshCookie(req, res, rotated.refreshToken);
      return res.json({
        token: rotated.accessToken,
        email: rotated.email,
        expiresAt: rotated.expiresAt,
        sid: rotated.sid,
        jtiPrefix: rotated.jti.slice(0, 8),
        tokenVersion: rotated.tokenVersion,
      });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to refresh session.',
      });
    }
  });

  app.post('/api/auth/logout', async (req: Request, res: Response) => {
    const refreshToken = await extractVerifiedRefreshCookie(req);
    const bearer = extractBearerToken(req);

    if (refreshToken && !passesCookieCsrfCheck(req)) {
      return res.status(403).json({ error: 'Cross-origin logout request rejected.' });
    }

    if (refreshToken) {
      await revokeSessionByRefreshToken(refreshToken, 'user_logout');
    }
    if (bearer) {
      const session = await verifyAccessJwt(bearer);
      if (session) {
        await revokeSessionById(session.sid, session.email, 'user_logout');
      }
    }

    clearRefreshCookie(req, res);
    return res.json({ ok: true });
  });

  app.post('/api/auth/claim', async (req: Request, res: Response) => {
    try {
      const rateLimit = await checkAuthRateLimit(req);
      if (rateLimit.limited) {
        return res.status(429).json({
          error: `Too many setup attempts. Try again in ${rateLimit.retryAfterSec}s.`,
          retryAfterSec: rateLimit.retryAfterSec,
        });
      }

      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
      const envAdminEmail = getEnvAdminEmail();

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Valid email address is required.' });
      }
      if (envAdminEmail && email !== envAdminEmail) {
        await recordFailedAuthAttempt(req);
        return res.status(403).json({
          error: 'This email is not authorized for administrator setup.',
        });
      }
      if (password.length < 8) {
        return res
          .status(400)
          .json({ error: 'Password must be at least 8 characters long.' });
      }

      const envPassword = process.env.ADMIN_PASSWORD?.trim();
      if (envPassword && envPassword.length > 0 && envAdminEmail) {
        return res.status(409).json({
          error: 'Admin credentials are already configured via environment secrets.',
        });
      }
      if (envPassword && envPassword.length > 0 && !verifyPlaintextConstantTime(password, envPassword)) {
        await recordFailedAuthAttempt(req);
        return res.status(403).json({
          error: 'Password must match the configured environment administrator password.',
        });
      }

      const dbCheck = await initDatabase();
      if (!dbCheck.ok) {
        return res.status(503).json({
          error: 'Service temporarily unavailable. Please try again later.',
        });
      }

      const pool = getPool();
      const passwordHash = await hashPasswordBcrypt(password);
      // Atomic single-administrator claim: succeeds only when app_auth has zero existing rows
      const insertRes = await pool.query<DbAuthRow>(
        `INSERT INTO app_auth (email, password_hash, token_version, password_updated_at)
         SELECT $1, $2, 1, NOW()
         WHERE NOT EXISTS (SELECT 1 FROM app_auth)
         RETURNING *`,
        [email, passwordHash]
      );

      if (insertRes.rowCount === 0) {
        return res.status(409).json({
          error: 'Administrator account has already been claimed. Please sign in.',
        });
      }

      const authRow = insertRes.rows[0];
      await clearFailedAuthAttempts(req, email);
      const issued = await issueSessionAndTokens({
        email,
        tokenVersion: Number(authRow.token_version || 1),
        req,
      });

      await setRefreshCookie(req, res, issued.refreshToken);
      await recordLog('success', 'auth', 'Administrator account claimed.');
      return res.json({
        token: issued.accessToken,
        email,
        expiresAt: issued.expiresAt,
        sid: issued.sid,
        jtiPrefix: issued.jti.slice(0, 8),
        tokenVersion: issued.tokenVersion,
      });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to claim admin account.',
      });
    }
  });

  app.post('/api/auth/login', async (req: Request, res: Response) => {
    try {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
      }

      const authorizedEmail = await resolveAuthorizedEmail();
      const rateLimit = await checkAuthRateLimit(req, authorizedEmail);
      if (rateLimit.limited) {
        return res.status(429).json({
          error: `Too many failed sign-in attempts. Try again in ${rateLimit.retryAfterSec}s.`,
          retryAfterSec: rateLimit.retryAfterSec,
        });
      }

      const dbCheck = await initDatabase();
      if (!dbCheck.ok) {
        return res.status(503).json({
          error: 'Service temporarily unavailable. Please try again later.',
        });
      }

      if (!authorizedEmail) {
        return res.status(409).json({
          error: 'Administrator account has not been set up yet.',
        });
      }

      if (email !== authorizedEmail) {
        const failState = await recordFailedAuthAttempt(req, authorizedEmail);
        return res.status(401).json({
          error: failState.lockedNow
            ? 'Invalid email or password. Account temporarily locked.'
            : 'Invalid email or password.',
        });
      }

      const envPassword = process.env.ADMIN_PASSWORD?.trim();
      let tokenVersion = 1;

      if (envPassword && envPassword.length > 0) {
        const syncedRow = await ensureEnvPasswordSyncedInDb(authorizedEmail, envPassword);
        const valid = verifyPlaintextConstantTime(password, envPassword);
        if (!valid) {
          const failState = await recordFailedAuthAttempt(req, authorizedEmail);
          await recordLog(
            'warning',
            'auth',
            'Failed login attempt.',
            failState.lockedNow ? 'Rate limit lockout triggered.' : undefined
          );
          return res.status(401).json({
            error: failState.lockedNow
              ? 'Invalid email or password. Account temporarily locked.'
              : 'Invalid email or password.',
          });
        }
        tokenVersion = Number(syncedRow.token_version || 1);
      } else {
        const pool = getPool();
        const userRes = await pool.query<DbAuthRow>(
          'SELECT * FROM app_auth WHERE email = $1 LIMIT 1',
          [authorizedEmail]
        );

        if (userRes.rowCount === 0) {
          return res.status(409).json({
            error: 'Admin password has not been claimed yet. Complete first-run setup.',
          });
        }

        const userRow = userRes.rows[0];
        const check = await verifyPasswordHash(password, userRow.password_hash);
        if (!check.valid) {
          const failState = await recordFailedAuthAttempt(req, authorizedEmail);
          await recordLog(
            'warning',
            'auth',
            'Failed login attempt.',
            failState.lockedNow ? 'Rate limit lockout triggered.' : undefined
          );
          return res.status(401).json({
            error: failState.lockedNow
              ? 'Invalid email or password. Account temporarily locked.'
              : 'Invalid email or password.',
          });
        }

        if (check.needsRehash) {
          const upgradedHash = await hashPasswordBcrypt(password);
          await pool.query(
            `UPDATE app_auth
             SET password_hash = $2, password_updated_at = NOW()
             WHERE email = $1`,
            [authorizedEmail, upgradedHash]
          );
        }

        tokenVersion = Number(userRow.token_version || 1);
      }

      await clearFailedAuthAttempts(req, authorizedEmail);
      const issued = await issueSessionAndTokens({
        email: authorizedEmail,
        tokenVersion,
        req,
      });

      await setRefreshCookie(req, res, issued.refreshToken);
      await recordLog(
        'success',
        'auth',
        `Signed in (session token ${issued.jti.slice(0, 8)}).`
      );
      return res.json({
        token: issued.accessToken,
        email: authorizedEmail,
        expiresAt: issued.expiresAt,
        sid: issued.sid,
        jtiPrefix: issued.jti.slice(0, 8),
        tokenVersion: issued.tokenVersion,
      });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Login failed.',
      });
    }
  });

  app.get('/api/auth/sessions', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const dbCheck = await initDatabase();
      if (!dbCheck.ok) {
        return res.status(503).json({ error: dbCheck.error });
      }
      const pool = getPool();
      const [sessionsRes, authRes] = await Promise.all([
        pool.query<DbAuthSessionRow>(
          `SELECT sid, email, jti, token_family, user_agent, ip_address, expires_at, revoked_at, last_used_at, created_at
           FROM auth_sessions
           WHERE email = $1 AND revoked_at IS NULL AND expires_at > NOW()
           ORDER BY last_used_at DESC
           LIMIT 25`,
          [req.userEmail]
        ),
        pool.query<DbAuthRow>(
          `SELECT email, token_version, last_login_at, password_updated_at, created_at
           FROM app_auth
           WHERE email = $1 LIMIT 1`,
          [req.userEmail]
        ),
      ]);

      const authRow = authRes.rows[0];
      return res.json({
        sessions: sessionsRes.rows.map((s) => ({
          sid: s.sid,
          jtiPrefix: s.jti.slice(0, 8),
          userAgent: s.user_agent || 'Unknown client',
          ipAddress: s.ip_address || 'Unknown',
          createdAt:
            s.created_at instanceof Date ? s.created_at.toISOString() : String(s.created_at),
          lastUsedAt:
            s.last_used_at instanceof Date
              ? s.last_used_at.toISOString()
              : String(s.last_used_at),
          expiresAt:
            s.expires_at instanceof Date ? s.expires_at.toISOString() : String(s.expires_at),
          isCurrent: s.sid === req.sessionId,
        })),
        security: {
          passwordAlgorithm: `cost-${getBcryptCost()}`,
          passwordStoredInDb: Boolean(authRow),
          envPasswordOverride: isEnvPasswordConfigured(),
          jwtAlgorithm: 'HS256',
          accessTtlMinutes: Math.max(1, Math.round(getAccessTokenTtlSec() / 60)),
          refreshTtlDays: Math.max(1, Math.round(getRefreshTokenTtlMs() / 86_400_000)),
          tokenVersion: authRow ? Number(authRow.token_version) : 1,
          lastLoginAt: authRow?.last_login_at
            ? new Date(authRow.last_login_at).toISOString()
            : null,
          passwordUpdatedAt: authRow?.password_updated_at
            ? new Date(authRow.password_updated_at).toISOString()
            : null,
        },
      });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to list active sessions.',
      });
    }
  });

  app.delete('/api/auth/sessions/:sid', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const sid = String(req.params.sid || '').trim();
      if (!sid) {
        return res.status(400).json({ error: 'Session ID is required.' });
      }
      const revoked = await revokeSessionById(sid, req.userEmail!, 'admin_revoked');
      if (!revoked) {
        return res.status(404).json({ error: 'Active session not found.' });
      }
      await recordLog('warning', 'auth', `Revoked active session ${sid.slice(0, 13)}...`);
      return res.json({ ok: true, revokedCurrent: sid === req.sessionId });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to revoke session.',
      });
    }
  });

  app.post('/api/auth/revoke-all', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const includeCurrent = Boolean(req.body?.includeCurrent);
      const count = await revokeAllSessionsForEmail({
        email: req.userEmail!,
        exceptSid: includeCurrent ? undefined : req.sessionId,
        bumpTokenVersion: includeCurrent,
        reason: includeCurrent ? 'emergency_revoke_all' : 'revoke_other_sessions',
      });

      let rotatedKey = false;
      if (includeCurrent) {
        rotatedKey = await rotateManagedSigningSecrets().catch(() => false);
        clearRefreshCookie(req, res);
      }

      await recordLog(
        'warning',
        'auth',
        includeCurrent
          ? `Revoked ALL ${count} sessions${rotatedKey ? ' and rotated managed signing keys' : ''}.`
          : `Revoked ${count} other active session${count === 1 ? '' : 's'}.`
      );
      return res.json({ ok: true, revokedCount: count, signedOutCurrent: includeCurrent });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to revoke sessions.',
      });
    }
  });

  app.post('/api/auth/change-password', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (isEnvPasswordConfigured()) {
        return res.status(409).json({
          error:
            'Administrator password is managed by server environment configuration.',
        });
      }

      const currentPassword = String(req.body?.currentPassword ?? '');
      const newPassword = String(req.body?.newPassword ?? '');

      if (!currentPassword || !newPassword) {
        return res
          .status(400)
          .json({ error: 'Current password and new password are required.' });
      }
      if (newPassword.length < 8) {
        return res
          .status(400)
          .json({ error: 'New password must be at least 8 characters long.' });
      }
      if (newPassword === currentPassword) {
        return res
          .status(400)
          .json({ error: 'New password must differ from current password.' });
      }

      const pool = getPool();
      const userRes = await pool.query<DbAuthRow>(
        'SELECT * FROM app_auth WHERE email = $1 LIMIT 1',
        [req.userEmail]
      );
      const userRow = userRes.rows[0];
      if (!userRow) {
        return res.status(404).json({ error: 'Admin account record not found.' });
      }

      const check = await verifyPasswordHash(currentPassword, userRow.password_hash);
      if (!check.valid) {
        return res.status(401).json({ error: 'Current password is incorrect.' });
      }

      const nextHash = await hashPasswordBcrypt(newPassword);
      const updateRes = await pool.query<DbAuthRow>(
        `UPDATE app_auth
         SET password_hash = $2,
             token_version = token_version + 1,
             password_updated_at = NOW()
         WHERE email = $1
         RETURNING *`,
        [req.userEmail, nextHash]
      );

      const nextVersion = Number(updateRes.rows[0]?.token_version || 2);
      await revokeAllSessionsForEmail({
        email: req.userEmail!,
        bumpTokenVersion: false,
        reason: 'password_changed',
      });

      const issued = await issueSessionAndTokens({
        email: req.userEmail!,
        tokenVersion: nextVersion,
        req,
      });

      await setRefreshCookie(req, res, issued.refreshToken);
      await recordLog(
        'success',
        'auth',
        `Admin password updated; token revision bumped to v${nextVersion} and previous sessions revoked.`
      );

      return res.json({
        ok: true,
        token: issued.accessToken,
        email: req.userEmail,
        expiresAt: issued.expiresAt,
        sid: issued.sid,
        jtiPrefix: issued.jti.slice(0, 8),
        tokenVersion: issued.tokenVersion,
      });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to change password.',
      });
    }
  });

  // ---------------- Protected API Routes ----------------

  app.get('/api/posts', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const dbCheck = await initDatabase();
      if (!dbCheck.ok) {
        return res.status(503).json({ error: dbCheck.error });
      }
      const pool = getPool();

      const monthKey = String(req.query.monthKey ?? 'ALL').trim();
      const statusFilter = String(req.query.status ?? 'ALL').trim().toUpperCase();
      const search = String(req.query.search ?? '').trim();
      const sortParam = String(req.query.sort ?? 'asc').trim().toLowerCase();
      const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
      const limit = Math.max(5, Math.min(100, Math.floor(Number(req.query.limit) || 15)));

      const monthConditions: string[] = [];
      const monthParams: string[] = [];

      if (monthKey && monthKey !== 'ALL') {
        monthParams.push(monthKey);
        monthConditions.push(`month_key = $${monthParams.length}`);
      }

      const monthWhereSql =
        monthConditions.length > 0 ? `WHERE ${monthConditions.join(' AND ')}` : '';

      const itemConditions = [...monthConditions];
      const itemParams: Array<string | number> = [...monthParams];

      if (statusFilter === 'PENDING' || statusFilter === 'POSTED' || statusFilter === 'FAILED') {
        itemParams.push(statusFilter);
        itemConditions.push(`status = $${itemParams.length}`);
      }

      if (search) {
        itemParams.push(`%${search}%`);
        const pIdx = itemParams.length;
        itemConditions.push(
          `(topic_name ILIKE $${pIdx} OR stage_label ILIKE $${pIdx} OR seo_title ILIKE $${pIdx} OR seo_description ILIKE $${pIdx} OR COALESCE(fb_post_id, '') ILIKE $${pIdx} OR seo_tags::text ILIKE $${pIdx})`
        );
      }

      const itemWhereSql =
        itemConditions.length > 0 ? `WHERE ${itemConditions.join(' AND ')}` : '';

      const orderBySql =
        sortParam === 'desc'
          ? 'ORDER BY scheduled_at DESC, part_number DESC'
          : sortParam === 'updated'
            ? 'ORDER BY updated_at DESC, scheduled_at ASC'
            : 'ORDER BY scheduled_at ASC, part_number ASC';

      const [countsRes, totalRes, monthsRes] = await Promise.all([
        pool.query<{
          total: number;
          pending: number;
          posted: number;
          simulated: number;
          failed: number;
        }>(
          `SELECT
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
             COUNT(*) FILTER (WHERE status = 'POSTED')::int AS posted,
             COUNT(*) FILTER (WHERE status = 'POSTED' AND is_simulated = TRUE)::int AS simulated,
             COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed
           FROM scheduled_posts
           ${monthWhereSql}`,
          monthParams
        ),
        pool.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt FROM scheduled_posts ${itemWhereSql}`,
          itemParams
        ),
        pool.query<{ month_key: string }>(
          `SELECT DISTINCT month_key FROM scheduled_posts ORDER BY month_key ASC`
        ),
      ]);

      const totalItems = Number(totalRes.rows[0]?.cnt ?? 0);
      const totalPages = Math.max(1, Math.ceil(totalItems / limit));
      const safePage = Math.min(page, totalPages);
      const offset = (safePage - 1) * limit;

      const rowsRes = await pool.query<DbPostRow>(
        `SELECT * FROM scheduled_posts
         ${itemWhereSql}
         ${orderBySql}
         LIMIT $${itemParams.length + 1}
         OFFSET $${itemParams.length + 2}`,
        [...itemParams, limit, offset]
      );

      const c = countsRes.rows[0];
      return res.json({
        posts: rowsRes.rows.map(serializePost),
        pagination: {
          page: safePage,
          limit,
          totalItems,
          totalPages,
          hasNextPage: safePage < totalPages,
          hasPrevPage: safePage > 1,
        },
        counts: {
          all: Number(c?.total ?? 0),
          pending: Number(c?.pending ?? 0),
          posted: Number(c?.posted ?? 0),
          simulated: Number(c?.simulated ?? 0),
          failed: Number(c?.failed ?? 0),
        },
        availableMonths: monthsRes.rows.map((r) => r.month_key),
      });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to load posts.',
      });
    }
  });

  app.post('/api/posts/requeue-failed', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const dbCheck = await initDatabase();
      if (!dbCheck.ok) {
        return res.status(503).json({ error: dbCheck.error });
      }
      const pool = getPool();
      const updatedRes = await pool.query<DbPostRow>(
        `UPDATE scheduled_posts
         SET status = 'PENDING',
             error_message = NULL,
             updated_at = NOW()
         WHERE status = 'FAILED'
         RETURNING *`
      );
      const requeued = updatedRes.rows.map(serializePost);
      if (requeued.length > 0) {
        broadcast({ type: 'posts:bulk_updated', data: requeued });
        await recordLog(
          'info',
          'scheduler',
          `Re-queued ${requeued.length} previously failed post${requeued.length === 1 ? '' : 's'} back to PENDING.`
        );
      }
      return res.json({ count: requeued.length, posts: requeued });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to re-queue failed posts.',
      });
    }
  });

  app.post('/api/posts', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const dbCheck = await initDatabase();
      if (!dbCheck.ok) {
        return res.status(503).json({ error: dbCheck.error });
      }
      const topicName = String(req.body?.topicName ?? '').trim();
      const seoTitle = clampTitle(req.body?.seoTitle);
      const seoDescription = String(req.body?.seoDescription ?? '').trim();
      const seoTags = sanitizeTags(req.body?.seoTags);
      const slotTime = String(req.body?.slotTime ?? '09:00').trim();
      const scheduledAt = String(req.body?.scheduledAt ?? '').trim();
      const monthKey = String(req.body?.monthKey ?? '').trim();
      const stageLabel = String(req.body?.stageLabel ?? 'Custom Scheduled Post').trim();
      const rawMediaType = String(req.body?.mediaType ?? 'none').trim();
      const mediaUrl = validateSafeMediaUrl(req.body?.mediaUrl);
      const mediaType: 'none' | 'image' | 'video' =
        mediaUrl && (rawMediaType === 'image' || rawMediaType === 'video')
          ? rawMediaType
          : 'none';
      const mediaPublicId =
        mediaType !== 'none' && typeof req.body?.mediaPublicId === 'string'
          ? req.body.mediaPublicId.trim() || null
          : null;

      if (!topicName || !seoTitle || !seoDescription || !scheduledAt || !monthKey) {
        return res.status(400).json({
          error:
            'topicName, seoTitle, seoDescription, scheduledAt, and monthKey are required.',
        });
      }

      const pool = getPool();
      const id = makeId('post');
      const result = await pool.query<DbPostRow>(
        `INSERT INTO scheduled_posts (
           id, month_key, topic_name, part_number, total_parts, stage_label,
           seo_title, seo_description, seo_tags, media_type, media_url, media_public_id,
           slot_time, scheduled_at, status
         )
         VALUES ($1, $2, $3, 1, 1, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::timestamptz, 'PENDING')
         RETURNING *`,
        [
          id,
          monthKey,
          topicName,
          stageLabel,
          seoTitle,
          seoDescription,
          JSON.stringify(seoTags),
          mediaType,
          mediaType === 'none' ? null : mediaUrl,
          mediaPublicId,
          slotTime,
          scheduledAt,
        ]
      );

      const created = serializePost(result.rows[0]);
      broadcast({ type: 'post:created', data: created });
      await recordLog(
        'info',
        'storage',
        `Added scheduled post "${created.topicName}" (${created.slotTime}) to table.`
      );
      return res.status(201).json({ post: created });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to create post.',
      });
    }
  });

  app.post('/api/posts/bulk-import', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const dbCheck = await initDatabase();
      if (!dbCheck.ok) {
        return res.status(503).json({ error: dbCheck.error });
      }
      const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      if (rawRows.length === 0 || rawRows.length > 300) {
        return res.status(400).json({
          error: 'Bulk import requires between 1 and 300 rows.',
        });
      }

      const pool = getPool();
      const inserted: ReturnType<typeof serializePost>[] = [];

      for (let i = 0; i < rawRows.length; i += 1) {
        const item = rawRows[i] || {};
        const seoTitle = clampTitle(item.seoTitle || item.topicName || `Imported Post #${i + 1}`);
        const seoDescription = String(item.seoDescription ?? seoTitle).trim();
        const topicName = String(item.topicName || seoTitle).trim().slice(0, 80) || 'Imported Series';
        const stageLabel = String(item.stageLabel || `Imported Row #${i + 1}`).trim();
        const seoTags = sanitizeTags(item.seoTags);
        const slotTime = String(item.slotTime ?? '09:00').trim() || '09:00';
        const scheduledAt = String(item.scheduledAt ?? new Date().toISOString()).trim();
        const monthKey = String(item.monthKey ?? scheduledAt.slice(0, 7)).trim();
        const mediaUrl = validateSafeMediaUrl(item.mediaUrl);
        const mediaType: 'none' | 'image' | 'video' =
          mediaUrl && (item.mediaType === 'image' || item.mediaType === 'video')
            ? item.mediaType
            : 'none';

        if (!seoTitle || !scheduledAt || !monthKey) continue;

        const id = makeId('post');
        const rowRes = await pool.query<DbPostRow>(
          `INSERT INTO scheduled_posts (
             id, month_key, topic_name, part_number, total_parts, stage_label,
             seo_title, seo_description, seo_tags, media_type, media_url,
             slot_time, scheduled_at, status
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13::timestamptz, 'PENDING')
           RETURNING *`,
          [
            id,
            monthKey,
            topicName,
            i + 1,
            rawRows.length,
            stageLabel,
            seoTitle,
            seoDescription,
            JSON.stringify(seoTags),
            mediaType,
            mediaType === 'none' ? null : mediaUrl,
            slotTime,
            scheduledAt,
          ]
        );
        if (rowRes.rows[0]) {
          inserted.push(serializePost(rowRes.rows[0]));
        }
      }

      if (inserted.length > 0) {
        broadcast({ type: 'posts:bulk_created', data: inserted });
        await recordLog(
          'success',
          'storage',
          `Bulk imported ${inserted.length} scheduled posts from Excel / Google Sheet into PostgreSQL.`
        );
      }

      return res.status(201).json({ count: inserted.length, posts: inserted });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Bulk import failed.',
      });
    }
  });

  app.patch('/api/posts/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = String(req.params.id);
      const pool = getPool();
      const existingRes = await pool.query<DbPostRow>(
        'SELECT * FROM scheduled_posts WHERE id = $1 LIMIT 1',
        [id]
      );
      if (!existingRes.rows[0]) {
        return res.status(404).json({ error: 'Post not found.' });
      }
      const existing = serializePost(existingRes.rows[0]);

      const topicName =
        req.body?.topicName !== undefined
          ? String(req.body.topicName).trim() || existing.topicName
          : existing.topicName;
      const stageLabel =
        req.body?.stageLabel !== undefined
          ? String(req.body.stageLabel).trim()
          : existing.stageLabel;
      const seoTitle =
        req.body?.seoTitle !== undefined
          ? String(req.body.seoTitle).trim() || existing.seoTitle
          : existing.seoTitle;
      const seoDescription =
        req.body?.seoDescription !== undefined
          ? String(req.body.seoDescription).trim()
          : existing.seoDescription;
      const seoTags =
        req.body?.seoTags !== undefined
          ? sanitizeTags(req.body.seoTags)
          : existing.seoTags;
      const slotTime =
        req.body?.slotTime !== undefined
          ? String(req.body.slotTime).trim() || existing.slotTime
          : existing.slotTime;
      const scheduledAt =
        req.body?.scheduledAt !== undefined
          ? String(req.body.scheduledAt).trim() || existing.scheduledAt
          : existing.scheduledAt;
      const monthKey =
        req.body?.monthKey !== undefined
          ? String(req.body.monthKey).trim() || existing.monthKey
          : existing.monthKey;

      let mediaType: 'none' | 'image' | 'video' = existing.mediaType;
      let mediaUrl: string | null = existing.mediaUrl ?? null;
      let mediaPublicId: string | null = existing.mediaPublicId ?? null;

      if (req.body?.mediaType !== undefined || req.body?.mediaUrl !== undefined) {
        const nextType = String(req.body?.mediaType ?? existing.mediaType).trim();
        const nextUrl =
          req.body?.mediaUrl !== undefined
            ? validateSafeMediaUrl(req.body.mediaUrl)
            : existing.mediaUrl ?? null;
        if (nextType === 'none' || !nextUrl) {
          mediaType = 'none';
          mediaUrl = null;
          mediaPublicId = null;
        } else if (nextType === 'image' || nextType === 'video') {
          mediaType = nextType;
          mediaUrl = nextUrl;
          mediaPublicId =
            typeof req.body?.mediaPublicId === 'string'
              ? req.body.mediaPublicId.trim() || null
              : existing.mediaPublicId ?? null;
        }
      }

      const scheduleEdited =
        scheduledAt !== existing.scheduledAt || slotTime !== existing.slotTime;
      const status =
        req.body?.status === 'PENDING' ||
        (existing.status === 'FAILED' && scheduleEdited)
          ? 'PENDING'
          : existing.status;

      const updatedRes = await pool.query<DbPostRow>(
        `UPDATE scheduled_posts
         SET topic_name = $2,
             stage_label = $3,
             seo_title = $4,
             seo_description = $5,
             seo_tags = $6::jsonb,
             media_type = $7,
             media_url = $8,
             media_public_id = $9,
             slot_time = $10,
             scheduled_at = $11::timestamptz,
             month_key = $12,
             status = $13,
             error_message = CASE WHEN $13 = 'PENDING' THEN NULL ELSE error_message END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          topicName,
          stageLabel,
          seoTitle,
          seoDescription,
          JSON.stringify(seoTags),
          mediaType,
          mediaUrl,
          mediaPublicId,
          slotTime,
          scheduledAt,
          monthKey,
          status,
        ]
      );

      const updated = serializePost(updatedRes.rows[0]);
      broadcast({ type: 'post:updated', data: updated });
      await recordLog(
        'info',
        'storage',
        `Updated post "${updated.topicName}" (${updated.slotTime}).`
      );
      return res.json({ post: updated });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to update post.',
      });
    }
  });

  app.delete('/api/posts/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = String(req.params.id);
      const pool = getPool();
      const delRes = await pool.query<DbPostRow>(
        'DELETE FROM scheduled_posts WHERE id = $1 RETURNING *',
        [id]
      );
      if (!delRes.rows[0]) {
        return res.status(404).json({ error: 'Post not found.' });
      }
      broadcast({ type: 'post:deleted', data: { id } });
      await recordLog(
        'warning',
        'storage',
        `Deleted scheduled post "${delRes.rows[0].topic_name}" (${delRes.rows[0].slot_time}).`
      );
      return res.json({ deletedId: id });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to delete post.',
      });
    }
  });

  app.post('/api/posts/:id/publish', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const updated = await publishPostById(String(req.params.id), 'manual');
      return res.json({ post: updated });
    } catch (err: unknown) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Publish failed.',
      });
    }
  });

  app.post('/api/posts/apply-recurring-times', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
      if (updates.length === 0) {
        return res.status(400).json({ error: 'No schedule updates provided.' });
      }

      const pool = getPool();
      const updatedPosts: ReturnType<typeof serializePost>[] = [];

      for (const item of updates) {
        const id = String(item?.id ?? '').trim();
        const slotTime = String(item?.slotTime ?? '').trim();
        const scheduledAt = String(item?.scheduledAt ?? '').trim();
        const monthKey = String(item?.monthKey ?? '').trim();
        if (!id || !slotTime || !scheduledAt || !monthKey) continue;

        const r = await pool.query<DbPostRow>(
          `UPDATE scheduled_posts
           SET slot_time = $2,
               scheduled_at = $3::timestamptz,
               month_key = $4,
               updated_at = NOW()
           WHERE id = $1 AND status = 'PENDING'
           RETURNING *`,
          [id, slotTime, scheduledAt, monthKey]
        );
        if (r.rows[0]) {
          updatedPosts.push(serializePost(r.rows[0]));
        }
      }

      if (updatedPosts.length > 0) {
        broadcast({ type: 'posts:bulk_updated', data: updatedPosts });
        await recordLog(
          'info',
          'scheduler',
          `Re-applied recurring daily time slots across ${updatedPosts.length} PENDING posts.`
        );
      }

      return res.json({ posts: updatedPosts });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to apply recurring slots.',
      });
    }
  });

  app.post('/api/posts/seed-ml-month', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const startDate =
        typeof req.body?.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.startDate)
          ? req.body.startDate
          : undefined;
      const timezoneOffsetMinutes =
        typeof req.body?.timezoneOffsetMinutes === 'number'
          ? req.body.timezoneOffsetMinutes
          : undefined;

      const created = await seedMlMonthCurriculum({
        startDate,
        timezoneOffsetMinutes,
        onlyIfEmpty: false,
      });

      return res.json({ posts: created, count: created.length });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to seed ML curriculum.',
      });
    }
  });

  app.post('/api/gemini/generate-monthly', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const dbCheck = await initDatabase();
      if (!dbCheck.ok) {
        return res.status(503).json({ error: dbCheck.error });
      }

      const themeOrTopic = String(req.body?.themeOrTopic ?? '').trim();
      const topicMode = req.body?.topicMode === 'custom_list' ? 'custom_list' : 'theme';
      const customTopics = Array.isArray(req.body?.customTopics)
        ? req.body.customTopics.map((t: unknown) => String(t).trim()).filter(Boolean)
        : [];
      const slots = Array.isArray(req.body?.slots) ? req.body.slots : [];

      if (!themeOrTopic && customTopics.length === 0) {
        return res.status(400).json({ error: 'Provide a topic theme or custom topics list.' });
      }
      if (slots.length === 0 || slots.length > 93) {
        return res.status(400).json({
          error: 'Schedule slots must contain between 1 and 93 entries.',
        });
      }

      const ai = getGeminiClient();
      const pool = getPool();
      const createdPosts: ReturnType<typeof serializePost>[] = [];

      await recordLog(
        'info',
        'gemini',
        `Generating ${slots.length} scheduled SEO posts with Gemini 4 Flash...`
      );

      const BATCH_SIZE = 8;
      const totalCount = slots.length;

      for (let start = 0; start < slots.length; start += BATCH_SIZE) {
        const chunk = slots.slice(start, start + BATCH_SIZE);
        const slotDescriptions = chunk
          .map((s: { slotTime?: string; dateLabel?: string; dayIndex?: number }, idx: number) => {
            const globalIndex = start + idx;
            const stageNum = (globalIndex % 5) + 1;
            const specificTopic =
              topicMode === 'custom_list' && customTopics.length > 0
                ? customTopics[globalIndex % customTopics.length]
                : themeOrTopic;
            return `Item ${idx + 1} (Global #${globalIndex + 1}/${totalCount}): Date=${s.dateLabel || ''}, Time=${s.slotTime || '09:00'}, Topic="${specificTopic}", SuggestedStage="${STAGE_GUIDE[stageNum]}"`;
          })
          .join('\n');

        const response = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: `Generate ${chunk.length} distinct, high-engagement Facebook Page SEO posts for these exact scheduled slots:\n${slotDescriptions}`,
          config: {
            systemInstruction: `You are a senior technical content strategist and Facebook Page growth writer.
Return a JSON array of exactly ${chunk.length} objects matching the items in order.
For each post:
- topicName: Clear, specific sub-topic title for that slot (e.g., if given a broad theme, choose a concrete sub-topic appropriate for that day/time slot).
- stageLabel: Concise stage label (e.g., "Morning Core Concept", "Afternoon Walkthrough", "Evening Pro Tip", or "Part X: ...").
- seoTitle: High-CTR headline strictly under 70 characters.
- seoDescription: Well-formatted Facebook post body with clean spacing, practical examples/bullet points, and an engaging CTA question.
- seoTags: Array of 4 to 5 targeted hashtags starting with #.`,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  topicName: { type: Type.STRING },
                  stageLabel: { type: Type.STRING },
                  seoTitle: { type: Type.STRING },
                  seoDescription: { type: Type.STRING },
                  seoTags: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                },
                required: [
                  'topicName',
                  'stageLabel',
                  'seoTitle',
                  'seoDescription',
                  'seoTags',
                ],
              },
            },
          },
        });

        const parsed = JSON.parse((response.text ?? '[]').trim());
        if (!Array.isArray(parsed) || parsed.length === 0) {
          throw new Error('Gemini returned an empty batch.');
        }

        const batchInserted: ReturnType<typeof serializePost>[] = [];
        for (let i = 0; i < chunk.length; i++) {
          const slot = chunk[i] as {
            monthKey: string;
            slotTime: string;
            scheduledAt: string;
          };
          const item = parsed[i] || parsed[parsed.length - 1];
          const globalIndex = start + i;
          const id = makeId('post');

          const insertRes = await pool.query<DbPostRow>(
            `INSERT INTO scheduled_posts (
               id, month_key, topic_name, part_number, total_parts, stage_label,
               seo_title, seo_description, seo_tags, slot_time, scheduled_at, status
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::timestamptz, 'PENDING')
             RETURNING *`,
            [
              id,
              String(slot.monthKey),
              String(item.topicName || themeOrTopic).trim(),
              globalIndex + 1,
              totalCount,
              String(item.stageLabel || `Slot ${slot.slotTime}`).trim(),
              clampTitle(item.seoTitle),
              String(item.seoDescription ?? '').trim(),
              JSON.stringify(sanitizeTags(item.seoTags)),
              String(slot.slotTime),
              String(slot.scheduledAt),
            ]
          );
          if (insertRes.rows[0]) {
            const serialized = serializePost(insertRes.rows[0]);
            batchInserted.push(serialized);
            createdPosts.push(serialized);
          }
        }

        if (batchInserted.length > 0) {
          broadcast({ type: 'posts:bulk_created', data: batchInserted });
        }
      }

      await recordLog(
        'success',
        'gemini',
        `Saved ${createdPosts.length} monthly scheduled posts to PostgreSQL.`
      );

      return res.json({ posts: createdPosts });
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Failed to generate monthly schedule.';
      await recordLog('error', 'gemini', 'Monthly generation failed.', msg);
      return res.status(500).json({ error: msg });
    }
  });

  app.post('/api/gemini/regenerate-part', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = String(req.body?.id ?? '').trim();
      if (!id) {
        return res.status(400).json({ error: 'Post id is required.' });
      }
      const pool = getPool();
      const existingRes = await pool.query<DbPostRow>(
        'SELECT * FROM scheduled_posts WHERE id = $1 LIMIT 1',
        [id]
      );
      if (!existingRes.rows[0]) {
        return res.status(404).json({ error: 'Post not found.' });
      }
      const post = serializePost(existingRes.rows[0]);
      const ai = getGeminiClient();

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: `Regenerate this scheduled Facebook post for "${post.topicName}" (scheduled slot ${post.slotTime}, stage "${post.stageLabel}").
Create a fresh angle and stronger hook distinct from: "${post.seoTitle}".`,
        config: {
          systemInstruction: `Return a single Facebook SEO post JSON object.
- seoTitle must be strictly under 70 characters.
- seoDescription must have clean spacing, practical examples/bullets, and a CTA question.
- seoTags must have 4 to 5 #Hashtags.`,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              stageLabel: { type: Type.STRING },
              seoTitle: { type: Type.STRING },
              seoDescription: { type: Type.STRING },
              seoTags: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
            },
            required: ['stageLabel', 'seoTitle', 'seoDescription', 'seoTags'],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '{}').trim());
      const updatedRes = await pool.query<DbPostRow>(
        `UPDATE scheduled_posts
         SET stage_label = $2,
             seo_title = $3,
             seo_description = $4,
             seo_tags = $5::jsonb,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          String(parsed.stageLabel || post.stageLabel).trim(),
          clampTitle(parsed.seoTitle),
          String(parsed.seoDescription ?? '').trim(),
          JSON.stringify(sanitizeTags(parsed.seoTags)),
        ]
      );

      const updated = serializePost(updatedRes.rows[0]);
      broadcast({ type: 'post:updated', data: updated });
      await recordLog(
        'success',
        'gemini',
        `Regenerated content for "${updated.topicName}" (${updated.slotTime}).`,
        updated.seoTitle
      );
      return res.json({ post: updated });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to regenerate post.';
      return res.status(500).json({ error: msg });
    }
  });

  app.get('/api/settings', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const dbCheck = await initDatabase();
      if (!dbCheck.ok) {
        return res.status(503).json({ error: dbCheck.error });
      }
      const pool = getPool();
      const result = await pool.query<DbSettingsRow>(
        'SELECT * FROM publisher_settings WHERE id = 1 LIMIT 1'
      );
      return res.json({ settings: await buildSerializedSettings(result.rows[0]) });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to load settings.',
      });
    }
  });

  app.put('/api/settings', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const dbCheck = await initDatabase();
      if (!dbCheck.ok) {
        return res.status(503).json({ error: dbCheck.error });
      }
      const pool = getPool();
      const currentRes = await pool.query<DbSettingsRow>(
        'SELECT * FROM publisher_settings WHERE id = 1 LIMIT 1'
      );
      const current = currentRes.rows[0];

      const autoPublishEnabled =
        req.body?.autoPublishEnabled !== undefined
          ? Boolean(req.body.autoPublishEnabled)
          : current.auto_publish_enabled;

      const dryRunMode =
        req.body?.dryRunMode !== undefined
          ? Boolean(req.body.dryRunMode)
          : current.dry_run_mode;

      let recurringTimes = Array.isArray(current.recurring_times)
        ? current.recurring_times
        : ['09:00', '15:00', '18:00'];

      if (Array.isArray(req.body?.recurringTimes)) {
        const cleaned = Array.from(
          new Set(
            req.body.recurringTimes
              .map((t: unknown) => String(t).trim())
              .filter((t: string) => /^\d{2}:\d{2}$/.test(t))
          )
        ).sort() as string[];
        if (cleaned.length > 0) {
          recurringTimes = cleaned;
        }
      }

      const updatedRes = await pool.query<DbSettingsRow>(
        `UPDATE publisher_settings
         SET auto_publish_enabled = $1,
             dry_run_mode = $2,
             recurring_times = $3::jsonb,
             updated_at = NOW()
         WHERE id = 1
         RETURNING *`,
        [autoPublishEnabled, dryRunMode, JSON.stringify(recurringTimes)]
      );

      if (autoPublishEnabled) {
        await setFacebookTokenErrorNotice('');
        await markTokenPausedForSha('');
      }

      const serialized = await buildSerializedSettings(updatedRes.rows[0]);
      broadcast({ type: 'settings:updated', data: serialized });
      await recordLog(
        'info',
        'storage',
        `Settings saved (Auto-Publish: ${serialized.autoPublishEnabled ? 'ON' : 'OFF'}, Dry Run: ${serialized.dryRunMode ? 'ON' : 'OFF'}, Slots: ${serialized.recurringTimes.join(', ')}).`
      );
      return res.json({ settings: serialized });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to update settings.',
      });
    }
  });

  app.post('/api/facebook/verify', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const { pageId, accessToken } = await resolveEffectiveEnvFacebookCredentials();

      if (!pageId || !accessToken) {
        return res.status(400).json({
          error:
            'FACEBOOK_PAGE_ID and FACEBOOK_ACCESS_TOKEN are not configured in server environment secrets (Settings > Secrets).',
        });
      }

      const resolved = await resolveFacebookTarget(pageId, accessToken);
      if (!resolved.ok) {
        if (resolved.tokenExpired) {
          await markTokenPausedForSha(getEnvFacebookCredentials().accessToken || accessToken);
          await setFacebookTokenErrorNotice(resolved.error);
        }
        return res.status(400).json({
          error: resolved.error,
          tokenExpired: Boolean(resolved.tokenExpired),
          availablePages: resolved.availablePages ?? [],
        });
      }

      await setFacebookTokenErrorNotice('');
      await markTokenPausedForSha('');
      await getPool().query(
        `UPDATE publisher_settings
         SET auto_publish_enabled = TRUE,
             updated_at = NOW()
         WHERE id = 1 AND auto_publish_enabled = FALSE`
      );
      const updatedSettings = await buildSerializedSettings(
        (
          await getPool().query<DbSettingsRow>(
            'SELECT * FROM publisher_settings WHERE id = 1 LIMIT 1'
          )
        ).rows[0]
      );
      broadcast({ type: 'settings:updated', data: updatedSettings });

      return res.json({
        ok: true,
        pageId: resolved.effectivePageId,
        pageName: resolved.pageName,
        pageLink: resolved.pageLink,
        isPublished: resolved.isPublished,
        isPageToken: resolved.isPageToken,
        resolvedViaAccounts: resolved.resolvedViaAccounts,
        permanentExchanged: Boolean(resolved.permanentExchanged),
        tokenOwnerName: resolved.tokenOwnerName,
        availablePages: resolved.availablePages,
        warnings: resolved.warnings,
      });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Facebook verification failed.',
      });
    }
  });

  app.post('/api/facebook/exchange-token', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { pageId, accessToken: envToken } = getEnvFacebookCredentials();
      const inputToken = String(req.body?.shortLivedToken ?? '').trim() || envToken;

      if (!pageId || !inputToken) {
        return res.status(400).json({
          error:
            'Provide a valid short-lived Facebook User Token (or set FACEBOOK_PAGE_ID and FACEBOOK_ACCESS_TOKEN in Secrets).',
        });
      }

      const exchanged = await exchangeForPermanentPageToken(pageId, inputToken);
      if (!exchanged.ok) {
        return res.status(400).json({ error: exchanged.error });
      }

      await markTokenPausedForSha('');
      const resumedRes = await getPool().query<DbSettingsRow>(
        `UPDATE publisher_settings
         SET auto_publish_enabled = TRUE,
             updated_at = NOW()
         WHERE id = 1
         RETURNING *`
      );
      const settingsRow = resumedRes.rows[0];
      const serialized = await buildSerializedSettings(settingsRow);
      broadcast({ type: 'settings:updated', data: serialized });

      await recordLog(
        'success',
        'facebook',
        `Exchanged and stored encrypted permanent Page Access Token for "${exchanged.pageName}" and resumed Auto-Publish.`
      );

      return res.json({
        ok: true,
        pageId: exchanged.pageId,
        pageName: exchanged.pageName,
        expiresLabel: exchanged.expiresLabel,
        settings: serialized,
      });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to exchange Facebook token.',
      });
    }
  });

  app.get('/api/logs', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const pool = getPool();
      const result = await pool.query<DbActivityLogRow>(
        'SELECT * FROM activity_logs ORDER BY timestamp DESC LIMIT 150'
      );
      return res.json({ logs: result.rows.map(serializeLog) });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to load activity logs.',
      });
    }
  });

  app.delete('/api/logs', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const pool = getPool();
      await pool.query('DELETE FROM activity_logs');
      broadcast({ type: 'activity:cleared' });
      return res.json({ ok: true });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to clear activity logs.',
      });
    }
  });

  app.get('/api/sync', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const dbCheck = await initDatabase();
      if (!dbCheck.ok) {
        return res.status(503).json({ error: dbCheck.error });
      }
      const state = await loadFullWorkspaceState();
      return res.json(state);
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to sync workspace state.',
      });
    }
  });

  app.post('/api/scheduler/run', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const trigger = req.body?.trigger === 'auto' ? 'auto' : 'manual';
    await runBackgroundScheduler(trigger);
    return res.json({
      ok: true,
      lastRunAt: lastSchedulerRunAt,
      nextRunAt: nextSchedulerRunAt,
    });
  });

  // External / Vercel Cron trigger (protected by CRON_SECRET header) for unattended serverless deployments
  const handleCronScheduler = async (req: Request, res: Response) => {
    const expectedSecret = (process.env.CRON_SECRET || '').trim();
    if (!expectedSecret) {
      return res.status(503).json({
        error: 'CRON_SECRET environment variable is not configured on the server.',
      });
    }

    const authHeader = String(req.headers.authorization || '');
    const bearerSecret = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : '';
    const headerSecret = String(req.headers['x-cron-secret'] || '').trim();
    const provided = bearerSecret || headerSecret;

    const expectedBuf = Buffer.from(expectedSecret, 'utf8');
    const providedBuf = Buffer.from(provided, 'utf8');
    if (
      providedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, expectedBuf)
    ) {
      return res.status(401).json({ error: 'Unauthorized cron invocation.' });
    }

    await runBackgroundScheduler('auto');
    return res.json({
      ok: true,
      lastRunAt: lastSchedulerRunAt,
      nextRunAt: nextSchedulerRunAt,
    });
  };

  app.post('/api/media/signature', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const resourceType =
        req.body?.resourceType === 'video' ? 'video' : 'image';
      const signed = createCloudinaryUploadSignature(resourceType);
      return res.json(signed);
    } catch (err: unknown) {
      return res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to generate Cloudinary upload signature.',
      });
    }
  });

  app.post('/api/import/google-sheet', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const sheetUrl = String(req.body?.sheetUrl ?? '').trim();
      const defaultSlotTime = String(req.body?.defaultSlotTime ?? '09:00').trim();
      const extracted = extractGoogleSheetExportUrl(sheetUrl);
      if (!extracted.ok) {
        return res.status(400).json({ error: extracted.error });
      }

      const fetchRes = await fetch(extracted.exportUrl, {
        headers: {
          Accept:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/octet-stream',
        },
        redirect: 'follow',
      });

      if (!fetchRes.ok) {
        return res.status(400).json({
          error: `Could not download Google Sheet (HTTP ${fetchRes.status}). Make sure sharing is set to "Anyone with the link can view", or export as .xlsx and upload the file directly.`,
        });
      }

      const contentType = fetchRes.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        return res.status(400).json({
          error:
            'Google Sheet returned a sign-in HTML page. Set Google Sheet sharing to "Anyone with the link (Viewer)" or download it as .xlsx and upload it.',
        });
      }

      const arrayBuf = await fetchRes.arrayBuffer();
      const parsed = parseWorkbookBufferToRows(
        Buffer.from(arrayBuf),
        defaultSlotTime
      );
      return res.json({
        ok: true,
        sheetId: extracted.sheetId,
        sheetName: parsed.sheetName,
        rows: parsed.rows,
        skippedCount: parsed.skippedCount,
      });
    } catch (err: unknown) {
      return res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to fetch Google Sheet.',
      });
    }
  });

  app.get('/api/cron/scheduler', handleCronScheduler);
  app.post('/api/cron/scheduler', handleCronScheduler);

  // ---------------- Static / Vite Middleware (Standalone Only) ----------------

  if (standalone && server) {
    if (process.env.NODE_ENV === 'production') {
      const distPath = path.resolve(__dirname, 'dist');
      if (fs.existsSync(distPath)) {
        app.use(express.static(distPath));
        app.get('/{*splat}', (_req: Request, res: Response) => {
          res.sendFile(path.join(distPath, 'index.html'));
        });
      }
    } else {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    }

    server.listen(PORT, '0.0.0.0', () => {
      console.log(
        `FB Series Auto-Publisher server + WebSocket running on http://0.0.0.0:${PORT}`
      );
    });
  }

  void getDbStatus();
  return app;
}

if (!process.env.VERCEL) {
  createServerApp({ standalone: true }).catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
