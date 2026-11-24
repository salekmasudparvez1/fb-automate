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
  getPool,
  initDatabase,
  serializeLog,
  serializePost,
  serializeSettings,
  type DbActivityLogRow,
  type DbPostRow,
  type DbSettingsRow,
} from './server/db.ts';
import {
  clearSessionCookie,
  createSessionToken,
  extractTokenFromRequest,
  getAllowedEmail,
  hashPassword,
  isSetupRequired,
  requireAuth,
  setSessionCookie,
  verifyPlaintextConstantTime,
  verifyScryptPassword,
  verifySessionToken,
  type AuthenticatedRequest,
} from './server/auth.ts';

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

const activePublishingIds = new Set<string>();
let nextSchedulerRunAt = new Date(Date.now() + SCHEDULER_INTERVAL_MS).toISOString();
let lastSchedulerRunAt: string | null = null;

export async function createServerApp(options: { standalone?: boolean } = {}) {
  const standalone = options.standalone ?? false;
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const server = standalone ? http.createServer(app) : null;
  const wss = server ? new WebSocketServer({ server, path: '/ws' }) : null;

  const dbBoot = await initDatabase();
  if (!dbBoot.ok) {
    console.warn('Database not ready on boot:', dbBoot.error);
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

  async function loadFullWorkspaceState() {
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
      settings: settingsRes.rows[0]
        ? serializeSettings(settingsRes.rows[0])
        : {
            facebookPageId: '',
            hasAccessToken: false,
            maskedAccessToken: '',
            autoPublishEnabled: true,
            dryRunMode: true,
            recurringTimes: ['09:00', '15:00', '18:00'],
          },
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
            const payload = await verifySessionToken(String(msg.token ?? ''));
            if (!payload) {
              ws.send(JSON.stringify({ type: 'auth:error', error: 'Invalid session token' }));
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
      const pageId = (settingsRow?.facebook_page_id || '').trim();
      const accessToken = (settingsRow?.facebook_access_token || '').trim();

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
          'success',
          'facebook',
          `[DRY RUN] ${source === 'scheduler' ? 'Auto-published' : 'Published'} "${updated.topicName}" (${updated.slotTime})`,
          `Simulated FB Post ID: ${simPostId}`
        );
        return updated;
      }

      if (!pageId || !accessToken) {
        const errMsg =
          'Missing Facebook Page ID or Access Token. Configure credentials in Page Settings or enable Dry Run mode.';
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

      const message = formatFbMessage(post);
      const graphUrl = `https://graph.facebook.com/v27.0/${encodeURIComponent(
        pageId
      )}/feed`;
      const params = new URLSearchParams();
      params.append('message', message);
      params.append('access_token', accessToken);

      const fbRes = await fetch(graphUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      const fbJson = (await fbRes.json().catch(() => ({}))) as {
        id?: string;
        error?: { message?: string };
      };

      if (!fbRes.ok || fbJson.error || !fbJson.id) {
        const errMsg =
          fbJson.error?.message ||
          `Facebook Graph API returned HTTP ${fbRes.status}`;
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
        [postId, fbJson.id]
      );
      const updated = serializePost(okRes.rows[0]);
      broadcast({ type: 'post:updated', data: updated });
      await recordLog(
        'success',
        'facebook',
        `${source === 'scheduler' ? 'Auto-published' : 'Published'} "${updated.topicName}" (${updated.slotTime}) to Facebook Page.`,
        `FB Post ID: ${fbJson.id}`
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
          } catch {
            // Error already persisted and broadcast
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
    res.json({
      ok: true,
      model: GEMINI_MODEL,
      realtimeMode: standalone ? 'websocket' : 'http-sync',
      dbConnected: dbCheck.ok,
      dbError: dbCheck.error,
    });
  });

  app.get('/api/auth/status', async (req: Request, res: Response) => {
    try {
      const { token } = extractTokenFromRequest(req);
      const session = token ? await verifySessionToken(token) : null;
      const setup = await isSetupRequired();

      return res.json({
        authenticated: Boolean(session),
        email: session?.email ?? null,
        token: session && token ? token : null,
        allowedEmail: getAllowedEmail(),
        realtimeMode: standalone ? 'websocket' : 'http-sync',
        setupRequired: setup.setupRequired,
        dbConnected: setup.dbConnected,
        dbError: setup.dbError ?? null,
      });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Auth status check failed.',
      });
    }
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    clearSessionCookie(req, res);
    return res.json({ ok: true });
  });

  app.post('/api/auth/claim', async (req: Request, res: Response) => {
    try {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
      const allowedEmail = getAllowedEmail();

      if (email !== allowedEmail) {
        return res.status(403).json({
          error: `Access denied. Only ${allowedEmail} is authorized.`,
        });
      }
      if (password.length < 8) {
        return res
          .status(400)
          .json({ error: 'Password must be at least 8 characters long.' });
      }

      if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.trim().length > 0) {
        return res.status(409).json({
          error: 'Admin password is already configured via environment secrets.',
        });
      }

      const dbCheck = await initDatabase();
      if (!dbCheck.ok) {
        return res.status(503).json({
          error:
            dbCheck.error ||
            'Database is not connected. Configure DATABASE_URL in Settings > Secrets.',
        });
      }

      const pool = getPool();
      const passwordHash = hashPassword(password);
      const insertRes = await pool.query<{ email: string }>(
        `INSERT INTO app_auth (email, password_hash)
         VALUES ($1, $2)
         ON CONFLICT (email) DO NOTHING
         RETURNING email`,
        [allowedEmail, passwordHash]
      );

      if (insertRes.rowCount === 0) {
        return res.status(409).json({
          error: 'Administrator password has already been claimed. Please sign in.',
        });
      }

      const token = await createSessionToken(allowedEmail);
      setSessionCookie(req, res, token);
      await recordLog('info', 'auth', `Administrator account claimed for ${allowedEmail}.`);
      return res.json({ token, email: allowedEmail });
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
      const allowedEmail = getAllowedEmail();

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
      }

      if (email !== allowedEmail) {
        return res.status(403).json({
          error: `Permission denied. Only ${allowedEmail} can log in.`,
        });
      }

      const envPassword = process.env.ADMIN_PASSWORD?.trim();
      if (envPassword && envPassword.length > 0) {
        const valid = verifyPlaintextConstantTime(password, envPassword);
        if (!valid) {
          return res.status(401).json({ error: 'Invalid password.' });
        }
        const token = await createSessionToken(allowedEmail);
        setSessionCookie(req, res, token);
        const dbReady = await initDatabase();
        if (dbReady.ok) {
          await recordLog('info', 'auth', `Signed in as ${allowedEmail}.`);
        }
        return res.json({ token, email: allowedEmail });
      }

      const dbCheck = await initDatabase();
      if (!dbCheck.ok) {
        return res.status(503).json({
          error:
            dbCheck.error ||
            'Database is not connected. Configure DATABASE_URL in Settings > Secrets.',
        });
      }

      const pool = getPool();
      const userRes = await pool.query<{ email: string; password_hash: string }>(
        'SELECT email, password_hash FROM app_auth WHERE email = $1 LIMIT 1',
        [allowedEmail]
      );

      if (userRes.rowCount === 0) {
        return res.status(409).json({
          error: 'Admin password has not been claimed yet. Complete first-run setup.',
        });
      }

      const valid = verifyScryptPassword(password, userRes.rows[0].password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid password.' });
      }

      const token = await createSessionToken(allowedEmail);
      setSessionCookie(req, res, token);
      await recordLog('info', 'auth', `Signed in as ${allowedEmail}.`);
      return res.json({ token, email: allowedEmail });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Login failed.',
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
      const monthKey = String(req.query.monthKey ?? '').trim();

      const result = monthKey && monthKey !== 'ALL'
        ? await pool.query<DbPostRow>(
            'SELECT * FROM scheduled_posts WHERE month_key = $1 ORDER BY scheduled_at ASC, part_number ASC',
            [monthKey]
          )
        : await pool.query<DbPostRow>(
            'SELECT * FROM scheduled_posts ORDER BY scheduled_at ASC, part_number ASC'
          );

      return res.json({ posts: result.rows.map(serializePost) });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to load posts.',
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
           seo_title, seo_description, seo_tags, slot_time, scheduled_at, status
         )
         VALUES ($1, $2, $3, 1, 1, $4, $5, $6, $7::jsonb, $8, $9::timestamptz, 'PENDING')
         RETURNING *`,
        [
          id,
          monthKey,
          topicName,
          stageLabel,
          seoTitle,
          seoDescription,
          JSON.stringify(seoTags),
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
      const status =
        req.body?.status === 'PENDING' ? 'PENDING' : existing.status;

      const updatedRes = await pool.query<DbPostRow>(
        `UPDATE scheduled_posts
         SET topic_name = $2,
             stage_label = $3,
             seo_title = $4,
             seo_description = $5,
             seo_tags = $6::jsonb,
             slot_time = $7,
             scheduled_at = $8::timestamptz,
             month_key = $9,
             status = $10,
             error_message = CASE WHEN $10 = 'PENDING' THEN NULL ELSE error_message END,
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
      return res.json({ settings: serializeSettings(result.rows[0]) });
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

      const facebookPageId =
        req.body?.facebookPageId !== undefined
          ? String(req.body.facebookPageId).trim()
          : current.facebook_page_id;

      let facebookAccessToken = current.facebook_access_token;
      if (req.body?.clearAccessToken === true) {
        facebookAccessToken = '';
      } else if (
        typeof req.body?.facebookAccessToken === 'string' &&
        req.body.facebookAccessToken.trim().length > 0
      ) {
        facebookAccessToken = req.body.facebookAccessToken.trim();
      }

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
         SET facebook_page_id = $1,
             facebook_access_token = $2,
             auto_publish_enabled = $3,
             dry_run_mode = $4,
             recurring_times = $5::jsonb,
             updated_at = NOW()
         WHERE id = 1
         RETURNING *`,
        [
          facebookPageId,
          facebookAccessToken,
          autoPublishEnabled,
          dryRunMode,
          JSON.stringify(recurringTimes),
        ]
      );

      const serialized = serializeSettings(updatedRes.rows[0]);
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
