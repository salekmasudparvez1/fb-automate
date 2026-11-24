import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { getPool, initDatabase } from './db.ts';

const DEFAULT_ALLOWED_EMAIL = 'salekmasudparvez@gmail.com';

export function getAllowedEmail(): string {
  return (process.env.ADMIN_EMAIL || DEFAULT_ALLOWED_EMAIL).trim().toLowerCase();
}

const SESSION_SECRET =
  process.env.SESSION_SECRET?.trim() || crypto.randomBytes(32).toString('hex');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

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

export function createSessionToken(email: string): string {
  const now = Date.now();
  const payload: SessionPayload = {
    email: email.toLowerCase(),
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${sig}`;
}

export function verifySessionToken(token: string): SessionPayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return null;

  const expectedSig = crypto
    .createHmac('sha256', SESSION_SECRET)
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

export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required. Please sign in.' });
    return;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  const payload = verifySessionToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
    return;
  }
  req.userEmail = payload.email;
  next();
}
