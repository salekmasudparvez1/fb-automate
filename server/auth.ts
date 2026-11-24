import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { getPool, initDatabase } from './db.ts';

const DEFAULT_ALLOWED_EMAIL = 'salekmasudparvez@gmail.com';
export const SESSION_COOKIE_NAME = 'fb_autopub_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function getAllowedEmail(): string {
  return (process.env.ADMIN_EMAIL || DEFAULT_ALLOWED_EMAIL).trim().toLowerCase();
}

let inMemoryFallbackSecret: string | null = null;
let dbCachedSecret: string | null = null;

export async function getSessionSecret(): Promise<string> {
  const envSecret = process.env.SESSION_SECRET?.trim();
  if (envSecret && envSecret.length >= 16) {
    return envSecret;
  }

  if (dbCachedSecret) {
    return dbCachedSecret;
  }

  try {
    const dbInit = await initDatabase();
    if (dbInit.ok) {
      const pool = getPool();
      const generated = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO app_meta (key, value)
         VALUES ('session_secret', $1)
         ON CONFLICT (key) DO NOTHING`,
        [generated]
      );
      const res = await pool.query<{ value: string }>(
        `SELECT value FROM app_meta WHERE key = 'session_secret' LIMIT 1`
      );
      if (res.rows[0]?.value) {
        dbCachedSecret = res.rows[0].value;
        return dbCachedSecret;
      }
    }
  } catch {
    // Fall back to process-local secret if DB isn't reachable yet
  }

  if (!inMemoryFallbackSecret) {
    inMemoryFallbackSecret = crypto.randomBytes(32).toString('hex');
  }
  return inMemoryFallbackSecret;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyScryptPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  if (!salt || !keyHex) return false;
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derivedBuf = crypto.scryptSync(password, salt, 64);
  if (keyBuf.length !== derivedBuf.length) return false;
  return crypto.timingSafeEqual(keyBuf, derivedBuf);
}

export function verifyPlaintextConstantTime(input: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export interface SessionPayload {
  email: string;
  iat: number;
  exp: number;
}

export async function createSessionToken(email: string): Promise<string> {
  const secret = await getSessionSecret();
  const now = Date.now();
  const payload: SessionPayload = {
    email: email.toLowerCase(),
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${sig}`;
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return null;

  const secret = await getSessionSecret();
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    ) as SessionPayload;
    if (!parsed.email || !parsed.exp || Date.now() > parsed.exp) {
      return null;
    }
    if (parsed.email.toLowerCase() !== getAllowedEmail()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
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

export function extractTokenFromRequest(req: Request): {
  token: string | null;
  source: 'bearer' | 'cookie' | null;
} {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice('Bearer '.length).trim();
    if (bearer) {
      return { token: bearer, source: 'bearer' };
    }
  }
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies[SESSION_COOKIE_NAME];
  if (cookieToken) {
    return { token: cookieToken, source: 'cookie' };
  }
  return { token: null, source: null };
}

function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string') {
    return proto.split(',')[0].trim().toLowerCase() === 'https';
  }
  return false;
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  const encoded = encodeURIComponent(token);
  const isHttps = isHttpsRequest(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encoded}`,
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
  ];
  if (isHttps) {
    parts.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req: Request, res: Response): void {
  const isHttps = isHttpsRequest(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
  ];
  if (isHttps) {
    parts.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

function passesCookieCsrfCheck(req: Request): boolean {
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
}> {
  if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.trim().length > 0) {
    const dbInit = await initDatabase();
    return {
      setupRequired: false,
      dbConnected: dbInit.ok,
      dbError: dbInit.error,
    };
  }

  const dbInit = await initDatabase();
  if (!dbInit.ok) {
    return {
      setupRequired: false,
      dbConnected: false,
      dbError: dbInit.error,
    };
  }

  const pool = getPool();
  const res = await pool.query<{ email: string }>(
    'SELECT email FROM app_auth WHERE email = $1 LIMIT 1',
    [getAllowedEmail()]
  );

  return {
    setupRequired: res.rowCount === 0,
    dbConnected: true,
  };
}

export interface AuthenticatedRequest extends Request {
  userEmail?: string;
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { token, source } = extractTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ error: 'Authentication required. Please sign in.' });
      return;
    }

    if (source === 'cookie' && !passesCookieCsrfCheck(req)) {
      res.status(403).json({ error: 'Cross-origin state-changing request rejected.' });
      return;
    }

    const payload = await verifySessionToken(token);
    if (!payload) {
      res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
      return;
    }

    req.userEmail = payload.email;
    next();
  } catch {
    res.status(401).json({ error: 'Authentication verification failed.' });
  }
}
