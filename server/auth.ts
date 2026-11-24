import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { NextFunction, Request, Response } from 'express';
import {
  getPool,
  initDatabase,
  type DbAuthRow,
  type DbAuthSessionRow,
} from './db.ts';

export const REFRESH_COOKIE_NAME = 'fb_studio_rt';
export const LEGACY_COOKIE_NAMES = ['fb_autopub_refresh', 'fb_autopub_session'];

export const JWT_ISSUER = 'fb-page-studio';
export const JWT_ACCESS_AUDIENCE = 'fb-page-studio-api';
export const JWT_REFRESH_AUDIENCE = 'fb-page-studio-refresh';

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function parseDurationMs(raw: string | undefined, fallbackMs: number): number {
  if (!raw) return fallbackMs;
  const trimmed = raw.trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    return ms > 0 ? ms : fallbackMs;
  }
  const match = trimmed.match(/^(\d+)\s*(s|m|h|d)$/);
  if (!match) return fallbackMs;
  const value = Number(match[1]);
  const unit = match[2];
  if (value <= 0) return fallbackMs;
  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      return fallbackMs;
  }
}

export function getBcryptCost(): number {
  return parseBoundedInt(process.env.BCRYPT_SALT_ROUNDS, 12, 10, 15);
}

export function getAccessTokenTtlSec(): number {
  const ms = parseDurationMs(process.env.JWT_ACCESS_EXPIRES_IN, 15 * 60 * 1000);
  return Math.max(60, Math.floor(ms / 1000));
}

export function getRefreshTokenTtlMs(): number {
  return parseDurationMs(process.env.JWT_REFRESH_EXPIRES_IN, 24 * 60 * 60 * 1000);
}

export function getCookieMaxAgeSec(): number {
  const refreshSec = Math.floor(getRefreshTokenTtlMs() / 1000);
  const configuredMs = Number(process.env.COOKIE_MAX_AGE);
  if (Number.isFinite(configuredMs) && configuredMs > 0) {
    return Math.floor(configuredMs / 1000);
  }
  return refreshSec;
}

export function getRateLimitConfig(): { windowMs: number; maxAttempts: number } {
  return {
    windowMs: parseBoundedInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 900_000, 30_000, 86_400_000),
    maxAttempts: parseBoundedInt(process.env.AUTH_RATE_LIMIT_MAX, 3, 2, 20),
  };
}

export function getEnvAdminEmail(): string | null {
  const raw = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  return raw || null;
}

export function isEnvPasswordConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.trim().length > 0);
}

export async function resolveAuthorizedEmail(): Promise<string | null> {
  const envEmail = getEnvAdminEmail();
  if (envEmail) return envEmail;

  try {
    const dbInit = await initDatabase();
    if (!dbInit.ok) return null;
    const res = await getPool().query<{ email: string }>(
      'SELECT email FROM app_auth ORDER BY created_at ASC LIMIT 1'
    );
    return res.rows[0]?.email?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

type SecretSlot = 'access' | 'refresh' | 'cookie';

const inMemorySecrets: Partial<Record<SecretSlot, string>> = {};
const dbCachedSecrets: Partial<Record<SecretSlot, string>> = {};

const SECRET_META_KEYS: Record<SecretSlot, string> = {
  access: 'jwt_access_secret',
  refresh: 'jwt_refresh_secret',
  cookie: 'cookie_hmac_secret',
};

function getEnvSecretForSlot(slot: SecretSlot): string | null {
  let raw = '';
  if (slot === 'access') {
    raw = (
      process.env.JWT_ACCESS_SECRET ||
      process.env.JWT_SECRET ||
      process.env.SESSION_SECRET ||
      ''
    ).trim();
  } else if (slot === 'refresh') {
    raw = (process.env.JWT_REFRESH_SECRET || '').trim();
  } else {
    raw = (process.env.COOKIE_SECRET || '').trim();
  }
  return raw.length >= 16 ? raw : null;
}

async function getSecretString(slot: SecretSlot): Promise<string> {
  const envSecret = getEnvSecretForSlot(slot);
  if (envSecret) {
    return envSecret;
  }

  if (dbCachedSecrets[slot]) {
    return dbCachedSecrets[slot]!;
  }

  try {
    const dbInit = await initDatabase();
    if (dbInit.ok) {
      const pool = getPool();
      const metaKey = SECRET_META_KEYS[slot];
      const generated = crypto.randomBytes(48).toString('base64url');
      await pool.query(
        `INSERT INTO app_meta (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING`,
        [metaKey, generated]
      );
      const res = await pool.query<{ value: string }>(
        `SELECT value FROM app_meta WHERE key = $1 LIMIT 1`,
        [metaKey]
      );
      if (res.rows[0]?.value) {
        dbCachedSecrets[slot] = res.rows[0].value;
        return res.rows[0].value;
      }
    }
  } catch {
    // Fall back to process-local CSPRNG secret if DB isn't reachable yet
  }

  if (!inMemorySecrets[slot]) {
    inMemorySecrets[slot] = crypto.randomBytes(48).toString('base64url');
  }
  return inMemorySecrets[slot]!;
}

async function getJwtAccessKey(): Promise<Uint8Array> {
  const secret = await getSecretString('access');
  return new TextEncoder().encode(secret);
}

async function getJwtRefreshKey(): Promise<Uint8Array> {
  const secret = await getSecretString('refresh');
  return new TextEncoder().encode(secret);
}

export async function rotateManagedSigningSecrets(): Promise<boolean> {
  const accessLocked = Boolean(getEnvSecretForSlot('access'));
  const refreshLocked = Boolean(getEnvSecretForSlot('refresh'));
  const pool = getPool();
  let rotatedAny = false;

  if (!accessLocked) {
    const next = crypto.randomBytes(48).toString('base64url');
    await pool.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('jwt_access_secret', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [next]
    );
    dbCachedSecrets.access = next;
    delete inMemorySecrets.access;
    rotatedAny = true;
  }

  if (!refreshLocked) {
    const next = crypto.randomBytes(48).toString('base64url');
    await pool.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('jwt_refresh_secret', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [next]
    );
    dbCachedSecrets.refresh = next;
    delete inMemorySecrets.refresh;
    rotatedAny = true;
  }

  return rotatedAny;
}

export async function hashPasswordBcrypt(password: string): Promise<string> {
  return bcrypt.hash(password, getBcryptCost());
}

function verifyLegacyScryptPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  if (!salt || !keyHex) return false;
  try {
    const keyBuf = Buffer.from(keyHex, 'hex');
    const derivedBuf = crypto.scryptSync(password, salt, 64);
    if (keyBuf.length !== derivedBuf.length) return false;
    return crypto.timingSafeEqual(keyBuf, derivedBuf);
  } catch {
    return false;
  }
}

export async function verifyPasswordHash(
  password: string,
  storedHash: string
): Promise<{ valid: boolean; needsRehash: boolean }> {
  if (!storedHash) {
    return { valid: false, needsRehash: false };
  }
  const targetRounds = getBcryptCost();
  if (storedHash.startsWith('$2')) {
    const valid = await bcrypt.compare(password, storedHash);
    let needsRehash = false;
    if (valid) {
      const rounds = bcrypt.getRounds(storedHash);
      if (rounds < targetRounds) {
        needsRehash = true;
      }
    }
    return { valid, needsRehash };
  }
  const legacyValid = verifyLegacyScryptPassword(password, storedHash);
  return { valid: legacyValid, needsRehash: legacyValid };
}

export function verifyPlaintextConstantTime(input: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

let syncedEnvDigest: string | null = null;

export async function ensureEnvPasswordSyncedInDb(
  email: string,
  envPassword: string
): Promise<DbAuthRow> {
  const pool = getPool();
  const digest = sha256Hex(`${email}:${envPassword}`);
  if (syncedEnvDigest === digest) {
    const fastRes = await pool.query<DbAuthRow>(
      'SELECT * FROM app_auth WHERE email = $1 LIMIT 1',
      [email]
    );
    if (fastRes.rows[0]) {
      return fastRes.rows[0];
    }
  }

  const existingRes = await pool.query<DbAuthRow>(
    'SELECT * FROM app_auth WHERE email = $1 LIMIT 1',
    [email]
  );
  const existing = existingRes.rows[0];
  if (existing && existing.password_hash.startsWith('$2')) {
    const matches = await bcrypt.compare(envPassword, existing.password_hash);
    if (matches) {
      syncedEnvDigest = digest;
      return existing;
    }
  }
  const hashed = await hashPasswordBcrypt(envPassword);
  const upsertRes = await pool.query<DbAuthRow>(
    `INSERT INTO app_auth (email, password_hash, password_updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           password_updated_at = NOW()
     RETURNING *`,
    [email, hashed]
  );
  syncedEnvDigest = digest;
  return upsertRes.rows[0];
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function getClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim().slice(0, 64);
  }
  return (req.ip || req.socket?.remoteAddress || '').slice(0, 64);
}

export function getUserAgent(req: Request): string {
  return String(req.headers['user-agent'] || '').slice(0, 300);
}

// Configurable Rate Limiter + Lockout (defaults: 3 attempts per 15 minutes via AUTH_RATE_LIMIT_*)
const ipAttemptMap = new Map<string, { count: number; windowResetAt: number }>();

export async function checkAuthRateLimit(
  req: Request,
  emailForDbCheck?: string | null
): Promise<{ limited: boolean; retryAfterSec: number }> {
  const { windowMs, maxAttempts } = getRateLimitConfig();
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = ipAttemptMap.get(ip);

  if (entry) {
    if (entry.windowResetAt <= now) {
      ipAttemptMap.delete(ip);
    } else if (entry.count >= maxAttempts) {
      return {
        limited: true,
        retryAfterSec: Math.max(1, Math.ceil((entry.windowResetAt - now) / 1000)),
      };
    }
  }

  if (emailForDbCheck) {
    try {
      const dbInit = await initDatabase();
      if (dbInit.ok) {
        const res = await getPool().query<{
          locked_until: Date | string | null;
        }>(
          'SELECT locked_until FROM app_auth WHERE email = $1 LIMIT 1',
          [emailForDbCheck]
        );
        const lockedUntil = res.rows[0]?.locked_until;
        if (lockedUntil) {
          const lockMs = new Date(lockedUntil).getTime();
          if (lockMs > now) {
            return {
              limited: true,
              retryAfterSec: Math.max(1, Math.ceil((lockMs - now) / 1000)),
            };
          }
        }
      }
    } catch {
      // ignore DB rate check failure
    }
  }

  return { limited: false, retryAfterSec: 0 };
}

export async function recordFailedAuthAttempt(
  req: Request,
  emailForDb?: string | null
): Promise<{ attemptsRemaining: number; lockedNow: boolean }> {
  const { windowMs, maxAttempts } = getRateLimitConfig();
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = ipAttemptMap.get(ip);
  const active =
    entry && entry.windowResetAt > now
      ? entry
      : { count: 0, windowResetAt: now + windowMs };

  active.count += 1;
  ipAttemptMap.set(ip, active);
  let lockedNow = active.count >= maxAttempts;

  if (emailForDb) {
    try {
      const dbInit = await initDatabase();
      if (dbInit.ok) {
        const res = await getPool().query<{
          failed_attempts: number;
          locked_until: Date | string | null;
        }>(
          `UPDATE app_auth
           SET failed_attempts = CASE
                 WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1
                 ELSE failed_attempts + 1
               END,
               locked_until = CASE
                 WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1 ELSE failed_attempts + 1 END) >= $2
                 THEN NOW() + ($3 || ' milliseconds')::interval
                 ELSE NULL
               END
           WHERE email = $1
           RETURNING failed_attempts, locked_until`,
          [emailForDb, maxAttempts, String(windowMs)]
        );
        if (res.rows[0]) {
          const attempts = Number(res.rows[0].failed_attempts);
          lockedNow = lockedNow || Boolean(res.rows[0].locked_until);
          return {
            attemptsRemaining: Math.max(0, maxAttempts - attempts),
            lockedNow,
          };
        }
      }
    } catch {
      // ignore DB error
    }
  }

  return {
    attemptsRemaining: Math.max(0, maxAttempts - active.count),
    lockedNow,
  };
}

export async function clearFailedAuthAttempts(
  req: Request,
  email?: string | null
): Promise<void> {
  ipAttemptMap.delete(getClientIp(req));
  if (!email) return;
  try {
    await getPool().query(
      `UPDATE app_auth
       SET failed_attempts = 0,
           locked_until = NULL,
           last_login_at = NOW()
       WHERE email = $1`,
      [email]
    );
  } catch {
    // ignore
  }
}

export interface AccessJwtClaims extends JWTPayload {
  sub: string;
  jti: string;
  sid: string;
  tv: number;
  role: 'admin';
  typ: 'access';
}

export interface RefreshJwtClaims extends JWTPayload {
  sub: string;
  jti: string;
  sid: string;
  tv: number;
  fam: string;
  typ: 'refresh';
}

export interface VerifiedSession {
  email: string;
  sid: string;
  jti: string;
  tokenVersion: number;
  expiresAt: string;
  issuedAt: string;
}

async function signAccessJwt(params: {
  email: string;
  sid: string;
  jti: string;
  tokenVersion: number;
}): Promise<{ accessToken: string; expiresAt: string }> {
  const key = await getJwtAccessKey();
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + getAccessTokenTtlSec();

  const accessToken = await new SignJWT({
    sid: params.sid,
    tv: params.tokenVersion,
    role: 'admin',
    typ: 'access',
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(params.email.toLowerCase())
    .setJti(params.jti)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_ACCESS_AUDIENCE)
    .setIssuedAt(nowSec)
    .setNotBefore(nowSec)
    .setExpirationTime(expSec)
    .sign(key);

  return {
    accessToken,
    expiresAt: new Date(expSec * 1000).toISOString(),
  };
}

async function signRefreshJwt(params: {
  email: string;
  sid: string;
  jti: string;
  tokenFamily: string;
  tokenVersion: number;
}): Promise<{ refreshToken: string; refreshExpiresAt: Date }> {
  const key = await getJwtRefreshKey();
  const nowSec = Math.floor(Date.now() / 1000);
  const ttlSec = Math.max(60, Math.floor(getRefreshTokenTtlMs() / 1000));
  const expSec = nowSec + ttlSec;

  const refreshToken = await new SignJWT({
    sid: params.sid,
    tv: params.tokenVersion,
    fam: params.tokenFamily,
    typ: 'refresh',
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(params.email.toLowerCase())
    .setJti(params.jti)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_REFRESH_AUDIENCE)
    .setIssuedAt(nowSec)
    .setNotBefore(nowSec)
    .setExpirationTime(expSec)
    .sign(key);

  return {
    refreshToken,
    refreshExpiresAt: new Date(expSec * 1000),
  };
}

export async function issueSessionAndTokens(params: {
  email: string;
  tokenVersion: number;
  req: Request;
}): Promise<{
  accessToken: string;
  refreshToken: string;
  sid: string;
  jti: string;
  expiresAt: string;
  tokenVersion: number;
}> {
  const pool = getPool();
  const sid = `sess_${crypto.randomUUID()}`;
  const accessJti = crypto.randomUUID();
  const refreshJti = crypto.randomUUID();
  const tokenFamily = `fam_${crypto.randomUUID()}`;
  const normalizedEmail = params.email.toLowerCase();

  const { refreshToken, refreshExpiresAt } = await signRefreshJwt({
    email: normalizedEmail,
    sid,
    jti: refreshJti,
    tokenFamily,
    tokenVersion: params.tokenVersion,
  });

  const refreshHash = sha256Hex(refreshToken);

  await pool.query(
    `INSERT INTO auth_sessions (
       sid, email, jti, token_family, refresh_token_hash, user_agent, ip_address, expires_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
    [
      sid,
      normalizedEmail,
      accessJti,
      tokenFamily,
      refreshHash,
      getUserAgent(params.req),
      getClientIp(params.req),
      refreshExpiresAt.toISOString(),
    ]
  );

  const { accessToken, expiresAt } = await signAccessJwt({
    email: normalizedEmail,
    sid,
    jti: accessJti,
    tokenVersion: params.tokenVersion,
  });

  return {
    accessToken,
    refreshToken,
    sid,
    jti: accessJti,
    expiresAt,
    tokenVersion: params.tokenVersion,
  };
}

export type RotateRefreshResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken: string;
      sid: string;
      jti: string;
      email: string;
      expiresAt: string;
      tokenVersion: number;
    }
  | {
      ok: false;
      reuseDetected: boolean;
      email?: string;
      reason: string;
    };

export async function rotateRefreshSession(
  rawRefreshToken: string,
  req: Request
): Promise<RotateRefreshResult> {
  if (!rawRefreshToken || typeof rawRefreshToken !== 'string') {
    return { ok: false, reuseDetected: false, reason: 'Missing refresh session.' };
  }

  // First verify Refresh JWT cryptographic signature & claims using JWT_REFRESH_SECRET
  let refreshClaims: RefreshJwtClaims;
  try {
    const refreshKey = await getJwtRefreshKey();
    const { payload } = await jwtVerify(rawRefreshToken, refreshKey, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_REFRESH_AUDIENCE,
      clockTolerance: 5,
    });
    refreshClaims = payload as RefreshJwtClaims;
    if (
      refreshClaims.typ !== 'refresh' ||
      !refreshClaims.sub ||
      !refreshClaims.sid ||
      !refreshClaims.fam
    ) {
      return { ok: false, reuseDetected: false, reason: 'Invalid refresh token.' };
    }
  } catch {
    return { ok: false, reuseDetected: false, reason: 'Invalid or expired refresh token.' };
  }

  const dbInit = await initDatabase();
  if (!dbInit.ok) {
    return { ok: false, reuseDetected: false, reason: 'Service unavailable.' };
  }

  const pool = getPool();
  const hash = sha256Hex(rawRefreshToken);

  const sessionRes = await pool.query<DbAuthSessionRow>(
    'SELECT * FROM auth_sessions WHERE refresh_token_hash = $1 LIMIT 1',
    [hash]
  );
  const session = sessionRes.rows[0];

  if (!session) {
    // Valid Refresh JWT signature but hash missing from DB -> could be a rotated/replayed token!
    const fam = typeof refreshClaims.fam === 'string' ? refreshClaims.fam : '';
    if (fam) {
      const famRes = await pool.query(
        `UPDATE auth_sessions
         SET revoked_at = COALESCE(revoked_at, NOW()),
             revoked_reason = COALESCE(revoked_reason, 'refresh_token_reuse_detected')
         WHERE token_family = $1`,
        [fam]
      );
      if ((famRes.rowCount ?? 0) > 0) {
        return {
          ok: false,
          reuseDetected: true,
          email: String(refreshClaims.sub).toLowerCase(),
          reason: 'Session revoked due to token reuse detection.',
        };
      }
    }
    return { ok: false, reuseDetected: false, reason: 'Refresh session not found.' };
  }

  if (session.revoked_at !== null) {
    await pool.query(
      `UPDATE auth_sessions
       SET revoked_at = COALESCE(revoked_at, NOW()),
           revoked_reason = COALESCE(revoked_reason, 'refresh_token_reuse_detected')
       WHERE token_family = $1`,
      [session.token_family]
    );
    return {
      ok: false,
      reuseDetected: true,
      email: session.email,
      reason: 'Session revoked due to token reuse detection.',
    };
  }

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await pool.query(
      `UPDATE auth_sessions
       SET revoked_at = NOW(), revoked_reason = 'expired'
       WHERE sid = $1`,
      [session.sid]
    );
    return { ok: false, reuseDetected: false, reason: 'Refresh session expired.' };
  }

  const authorizedEmail = await resolveAuthorizedEmail();
  if (!authorizedEmail || session.email.toLowerCase() !== authorizedEmail) {
    return { ok: false, reuseDetected: false, reason: 'Unauthorized session.' };
  }

  const userRes = await pool.query<{ token_version: number }>(
    'SELECT token_version FROM app_auth WHERE email = $1 LIMIT 1',
    [session.email.toLowerCase()]
  );
  const tokenVersion = Number(userRes.rows[0]?.token_version ?? 1);
  if (typeof refreshClaims.tv === 'number' && refreshClaims.tv !== tokenVersion) {
    await pool.query(
      `UPDATE auth_sessions
       SET revoked_at = NOW(), revoked_reason = 'token_version_mismatch'
       WHERE sid = $1`,
      [session.sid]
    );
    return { ok: false, reuseDetected: false, reason: 'Session invalidated.' };
  }

  const nextAccessJti = crypto.randomUUID();
  const nextRefreshJti = crypto.randomUUID();
  const { refreshToken: nextRefreshToken, refreshExpiresAt: nextExpiresAt } =
    await signRefreshJwt({
      email: session.email.toLowerCase(),
      sid: session.sid,
      jti: nextRefreshJti,
      tokenFamily: session.token_family,
      tokenVersion,
    });
  const nextRefreshHash = sha256Hex(nextRefreshToken);

  const updateRes = await pool.query<DbAuthSessionRow>(
    `UPDATE auth_sessions
     SET jti = $2,
         refresh_token_hash = $3,
         user_agent = $4,
         ip_address = $5,
         expires_at = $6::timestamptz,
         last_used_at = NOW()
     WHERE sid = $1 AND refresh_token_hash = $7 AND revoked_at IS NULL
     RETURNING *`,
    [
      session.sid,
      nextAccessJti,
      nextRefreshHash,
      getUserAgent(req),
      getClientIp(req),
      nextExpiresAt.toISOString(),
      hash,
    ]
  );

  if (updateRes.rowCount === 0) {
    return {
      ok: false,
      reuseDetected: true,
      email: session.email,
      reason: 'Concurrent refresh token reuse detected.',
    };
  }

  const { accessToken, expiresAt } = await signAccessJwt({
    email: session.email.toLowerCase(),
    sid: session.sid,
    jti: nextAccessJti,
    tokenVersion,
  });

  return {
    ok: true,
    accessToken,
    refreshToken: nextRefreshToken,
    sid: session.sid,
    jti: nextAccessJti,
    email: session.email.toLowerCase(),
    expiresAt,
    tokenVersion,
  };
}

export async function verifyAccessJwt(token: string): Promise<VerifiedSession | null> {
  if (!token || typeof token !== 'string') return null;

  try {
    const key = await getJwtAccessKey();
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_ACCESS_AUDIENCE,
      clockTolerance: 5,
    });

    const claims = payload as AccessJwtClaims;
    const email = String(claims.sub || '').toLowerCase();
    const sid = typeof claims.sid === 'string' ? claims.sid : '';
    const jti = typeof claims.jti === 'string' ? claims.jti : '';
    const tv = typeof claims.tv === 'number' ? claims.tv : -1;

    if (!email || claims.typ !== 'access' || !sid || !jti || tv < 1) {
      return null;
    }

    const authorizedEmail = await resolveAuthorizedEmail();
    if (!authorizedEmail || email !== authorizedEmail) {
      return null;
    }

    const pool = getPool();
    const sessionCheck = await pool.query<{
      revoked_at: Date | string | null;
      expires_at: Date | string;
      token_version: number;
    }>(
      `SELECT s.revoked_at, s.expires_at, a.token_version
       FROM auth_sessions s
       JOIN app_auth a ON a.email = s.email
       WHERE s.sid = $1 AND s.email = $2
       LIMIT 1`,
      [sid, email]
    );

    const row = sessionCheck.rows[0];
    if (!row) return null;
    if (row.revoked_at !== null) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    if (Number(row.token_version) !== tv) return null;

    return {
      email,
      sid,
      jti,
      tokenVersion: tv,
      expiresAt: claims.exp ? new Date(claims.exp * 1000).toISOString() : '',
      issuedAt: claims.iat ? new Date(claims.iat * 1000).toISOString() : '',
    };
  } catch {
    return null;
  }
}

export async function revokeSessionById(
  sid: string,
  email: string,
  reason = 'user_revoked'
): Promise<boolean> {
  const pool = getPool();
  const res = await pool.query(
    `UPDATE auth_sessions
     SET revoked_at = COALESCE(revoked_at, NOW()),
         revoked_reason = COALESCE(revoked_reason, $3)
     WHERE sid = $1 AND email = $2 AND revoked_at IS NULL`,
    [sid, email.toLowerCase(), reason]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function revokeSessionByRefreshToken(
  rawRefreshToken: string,
  reason = 'user_logout'
): Promise<void> {
  if (!rawRefreshToken) return;
  try {
    const pool = getPool();
    await pool.query(
      `UPDATE auth_sessions
       SET revoked_at = COALESCE(revoked_at, NOW()),
           revoked_reason = COALESCE(revoked_reason, $2)
       WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
      [sha256Hex(rawRefreshToken), reason]
    );
  } catch {
    // ignore
  }
}

export async function revokeAllSessionsForEmail(params: {
  email: string;
  exceptSid?: string;
  bumpTokenVersion?: boolean;
  reason?: string;
}): Promise<number> {
  const pool = getPool();
  const email = params.email.toLowerCase();
  const reason = params.reason || 'revoked_all';

  if (params.bumpTokenVersion) {
    await pool.query(
      `UPDATE app_auth
       SET token_version = token_version + 1
       WHERE email = $1`,
      [email]
    );
  }

  if (params.exceptSid) {
    const res = await pool.query(
      `UPDATE auth_sessions
       SET revoked_at = COALESCE(revoked_at, NOW()),
           revoked_reason = COALESCE(revoked_reason, $3)
       WHERE email = $1 AND sid <> $2 AND revoked_at IS NULL`,
      [email, params.exceptSid, reason]
    );
    return res.rowCount ?? 0;
  }

  const res = await pool.query(
    `UPDATE auth_sessions
     SET revoked_at = COALESCE(revoked_at, NOW()),
         revoked_reason = COALESCE(revoked_reason, $2)
     WHERE email = $1 AND revoked_at IS NULL`,
    [email, reason]
  );
  return res.rowCount ?? 0;
}

// HMAC-signed Cookie Envelope using COOKIE_SECRET
async function signCookieValue(payload: string): Promise<string> {
  const cookieSecret = await getSecretString('cookie');
  const sig = crypto
    .createHmac('sha256', cookieSecret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

async function verifySignedCookieValue(signedValue: string): Promise<string | null> {
  if (!signedValue || typeof signedValue !== 'string') return null;
  const lastDot = signedValue.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const payload = signedValue.slice(0, lastDot);
  const sig = signedValue.slice(lastDot + 1);
  if (!payload || !sig) return null;

  const cookieSecret = await getSecretString('cookie');
  const expectedSig = crypto
    .createHmac('sha256', cookieSecret)
    .update(payload)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  return payload;
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}

export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice('Bearer '.length).trim();
    if (bearer) return bearer;
  }
  return null;
}

export async function extractVerifiedRefreshCookie(req: Request): Promise<string | null> {
  const cookies = parseCookies(req.headers.cookie);
  const rawCookie = cookies[REFRESH_COOKIE_NAME];
  if (!rawCookie) return null;
  return verifySignedCookieValue(rawCookie);
}

function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string') {
    return proto.split(',')[0].trim().toLowerCase() === 'https';
  }
  return false;
}

function isEmbeddedIframeRequest(req: Request): boolean {
  const dest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  return dest === 'iframe' || site === 'cross-site';
}

function resolveCookieAttributes(req: Request): string[] {
  const httpOnly = process.env.COOKIE_HTTP_ONLY !== 'false';
  const envSecure = process.env.COOKIE_SECURE !== 'false';
  const isHttps = isHttpsRequest(req);
  const useSecure = isHttps && envSecure;

  const rawSameSite = (process.env.COOKIE_SAME_SITE || 'strict').trim().toLowerCase();
  const attrs: string[] = ['Path=/'];
  if (httpOnly) {
    attrs.push('HttpOnly');
  }

  if (useSecure) {
    attrs.push('Secure');
    if (isEmbeddedIframeRequest(req) || rawSameSite === 'none') {
      attrs.push('SameSite=None', 'Partitioned');
    } else if (rawSameSite === 'lax') {
      attrs.push('SameSite=Lax');
    } else {
      attrs.push('SameSite=Strict');
    }
  } else {
    attrs.push('SameSite=Lax');
  }

  return attrs;
}

export async function setRefreshCookie(
  req: Request,
  res: Response,
  refreshToken: string
): Promise<void> {
  const signedCookie = await signCookieValue(refreshToken);
  const maxAgeSec = getCookieMaxAgeSec();
  const encoded = encodeURIComponent(signedCookie);
  const attrs = resolveCookieAttributes(req);
  res.setHeader(
    'Set-Cookie',
    [`${REFRESH_COOKIE_NAME}=${encoded}`, `Max-Age=${maxAgeSec}`, ...attrs].join('; ')
  );
}

export function clearRefreshCookie(req: Request, res: Response): void {
  const attrs = resolveCookieAttributes(req);
  const buildCleared = (name: string) =>
    [`${name}=`, 'Max-Age=0', ...attrs].join('; ');
  res.setHeader('Set-Cookie', [
    buildCleared(REFRESH_COOKIE_NAME),
    ...LEGACY_COOKIE_NAMES.map(buildCleared),
  ]);
}

export function passesCookieCsrfCheck(req: Request): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())) {
    return true;
  }
  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return true;
  }
  const origin = req.headers.origin;
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '')
    .toString()
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (origin && host) {
    try {
      const originHost = new URL(origin).host.toLowerCase();
      return originHost === host;
    } catch {
      return false;
    }
  }
  return false;
}

export async function isSetupRequired(): Promise<{
  setupRequired: boolean;
  dbConnected: boolean;
  dbError?: string;
  passwordStoredInDb: boolean;
  envPasswordOverride: boolean;
}> {
  const envOverride = isEnvPasswordConfigured();
  const dbInit = await initDatabase();

  if (!dbInit.ok) {
    return {
      setupRequired: false,
      dbConnected: false,
      dbError: dbInit.error,
      passwordStoredInDb: false,
      envPasswordOverride: envOverride,
    };
  }

  const authorizedEmail = await resolveAuthorizedEmail();
  if (!authorizedEmail) {
    return {
      setupRequired: true,
      dbConnected: true,
      passwordStoredInDb: false,
      envPasswordOverride: envOverride,
    };
  }

  if (envOverride && process.env.ADMIN_PASSWORD) {
    await ensureEnvPasswordSyncedInDb(authorizedEmail, process.env.ADMIN_PASSWORD.trim());
    return {
      setupRequired: false,
      dbConnected: true,
      passwordStoredInDb: true,
      envPasswordOverride: true,
    };
  }

  const pool = getPool();
  const res = await pool.query<{ email: string }>(
    'SELECT email FROM app_auth WHERE email = $1 LIMIT 1',
    [authorizedEmail]
  );

  return {
    setupRequired: res.rowCount === 0,
    dbConnected: true,
    passwordStoredInDb: (res.rowCount ?? 0) > 0,
    envPasswordOverride: false,
  };
}

export interface AuthenticatedRequest extends Request {
  userEmail?: string;
  sessionId?: string;
  tokenJti?: string;
  tokenVersion?: number;
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const bearerToken = extractBearerToken(req);
    if (!bearerToken) {
      res.status(401).json({ error: 'Authentication required. Please sign in.' });
      return;
    }

    const session = await verifyAccessJwt(bearerToken);
    if (!session) {
      res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
      return;
    }

    req.userEmail = session.email;
    req.sessionId = session.sid;
    req.tokenJti = session.jti;
    req.tokenVersion = session.tokenVersion;
    next();
  } catch {
    res.status(401).json({ error: 'Authentication verification failed.' });
  }
}
