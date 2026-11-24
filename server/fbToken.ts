import crypto from 'crypto';
import { getEnvFacebookCredentials, getPool, initDatabase } from './db.ts';

function deriveEncryptionKey(): Buffer {
  const material =
    process.env.COOKIE_SECRET ||
    process.env.JWT_ACCESS_SECRET ||
    process.env.SESSION_SECRET ||
    process.env.DATABASE_URL ||
    process.env.ADMIN_PASSWORD ||
    'fb-page-studio-local-key';
  return crypto.createHash('sha256').update(material).digest();
}

function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptSecret(payload: string): string | null {
  try {
    const parts = payload.split('.');
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], 'base64url');
    const tag = Buffer.from(parts[1], 'base64url');
    const data = Buffer.from(parts[2], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function getFacebookAppCredentials(): {
  appId: string;
  appSecret: string;
} {
  return {
    appId: (process.env.FACEBOOK_APP_ID || process.env.FB_APP_ID || '').trim(),
    appSecret: (process.env.FACEBOOK_APP_SECRET || process.env.FB_APP_SECRET || '').trim(),
  };
}

export function isFacebookTokenError(
  fbError: { code?: number; error_subcode?: number; message?: string } | undefined,
  httpStatus?: number
): boolean {
  if (!fbError && httpStatus !== 401) return false;
  if (fbError?.code === 190 || fbError?.error_subcode === 463 || fbError?.error_subcode === 467) {
    return true;
  }
  const msg = String(fbError?.message || '');
  return /error validating access token|session has expired|token.*expired|invalid oauth access token/i.test(
    msg
  );
}

export async function savePermanentPageToken(params: {
  pageId: string;
  sourceToken: string;
  permanentPageToken: string;
  expiresLabel?: string;
}): Promise<void> {
  const dbInit = await initDatabase();
  if (!dbInit.ok) return;
  const pool = getPool();
  const encrypted = encryptSecret(params.permanentPageToken);
  const sourceHash = sha256(params.sourceToken);
  const expiresLabel = params.expiresLabel || 'never';

  const entries: Array<[string, string]> = [
    ['fb_permanent_page_id', params.pageId],
    ['fb_permanent_page_token_enc', encrypted],
    ['fb_source_token_sha', sourceHash],
    ['fb_token_expires_label', expiresLabel],
    ['fb_token_error_notice', ''],
  ];

  for (const [k, v] of entries) {
    await pool.query(
      `INSERT INTO app_meta (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [k, v]
    );
  }
}

export async function setFacebookTokenErrorNotice(message: string | null): Promise<void> {
  try {
    const dbInit = await initDatabase();
    if (!dbInit.ok) return;
    await getPool().query(
      `INSERT INTO app_meta (key, value)
       VALUES ('fb_token_error_notice', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [message || '']
    );
  } catch {
    // ignore
  }
}

export async function markTokenPausedForSha(tokenUsed: string | null): Promise<void> {
  try {
    const dbInit = await initDatabase();
    if (!dbInit.ok) return;
    const tokenSha = tokenUsed ? sha256(tokenUsed) : '';
    await getPool().query(
      `INSERT INTO app_meta (key, value)
       VALUES ('fb_paused_token_sha', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [tokenSha]
    );
  } catch {
    // ignore
  }
}

export async function reconcileEnvTokenRecovery(): Promise<boolean> {
  try {
    const dbInit = await initDatabase();
    if (!dbInit.ok) return false;
    const pool = getPool();
    const res = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM app_meta
       WHERE key IN ('fb_paused_token_sha', 'fb_token_error_notice', 'fb_source_token_sha')`
    );
    const map = new Map(res.rows.map((r) => [r.key, r.value]));
    const pausedSha = (map.get('fb_paused_token_sha') || '').trim();
    const errorNotice = (map.get('fb_token_error_notice') || '').trim();
    const { accessToken: envToken } = getEnvFacebookCredentials();

    if (!envToken) return false;
    const envSha = sha256(envToken);

    // If a pause happened on an older env token and the operator updated FACEBOOK_ACCESS_TOKEN,
    // automatically clear the expiry notice and re-enable auto_publish_enabled.
    if (pausedSha && envSha !== pausedSha) {
      await pool.query(
        `INSERT INTO app_meta (key, value)
         VALUES ('fb_token_error_notice', ''), ('fb_paused_token_sha', '')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
      );
      if (errorNotice || pausedSha) {
        await pool.query(
          `UPDATE publisher_settings
           SET auto_publish_enabled = TRUE,
               updated_at = NOW()
           WHERE id = 1`
        );
      }
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export async function getFacebookTokenMetaStatus(): Promise<{
  hasPermanentStoredToken: boolean;
  expiresLabel: string | null;
  tokenErrorNotice: string | null;
  hasAppCredentials: boolean;
}> {
  const { appId, appSecret } = getFacebookAppCredentials();
  const hasAppCredentials = Boolean(appId && appSecret);
  const envCreds = getEnvFacebookCredentials();

  try {
    const dbInit = await initDatabase();
    if (!dbInit.ok) {
      return {
        hasPermanentStoredToken: false,
        expiresLabel: null,
        tokenErrorNotice: null,
        hasAppCredentials,
      };
    }

    const res = await getPool().query<{ key: string; value: string }>(
      `SELECT key, value FROM app_meta
       WHERE key IN (
         'fb_permanent_page_id',
         'fb_permanent_page_token_enc',
         'fb_source_token_sha',
         'fb_token_expires_label',
         'fb_token_error_notice'
       )`
    );
    const map = new Map(res.rows.map((r) => [r.key, r.value]));
    const storedPageId = map.get('fb_permanent_page_id') || '';
    const storedSourceSha = map.get('fb_source_token_sha') || '';
    const storedEnc = map.get('fb_permanent_page_token_enc') || '';
    const envSha = envCreds.accessToken ? sha256(envCreds.accessToken) : '';

    const isMatchingEnv =
      Boolean(storedEnc) &&
      storedPageId === envCreds.pageId &&
      (!envSha || storedSourceSha === envSha);

    const noticeRaw = (map.get('fb_token_error_notice') || '').trim();

    return {
      hasPermanentStoredToken: isMatchingEnv,
      expiresLabel: isMatchingEnv ? map.get('fb_token_expires_label') || 'never' : null,
      tokenErrorNotice: noticeRaw || null,
      hasAppCredentials,
    };
  } catch {
    return {
      hasPermanentStoredToken: false,
      expiresLabel: null,
      tokenErrorNotice: null,
      hasAppCredentials,
    };
  }
}

export async function resolveEffectiveEnvFacebookCredentials(): Promise<{
  pageId: string;
  accessToken: string;
  usedStoredPermanent: boolean;
}> {
  const { pageId, accessToken: envToken } = getEnvFacebookCredentials();
  if (!pageId) {
    return { pageId: '', accessToken: envToken, usedStoredPermanent: false };
  }

  try {
    const dbInit = await initDatabase();
    if (dbInit.ok) {
      const res = await getPool().query<{ key: string; value: string }>(
        `SELECT key, value FROM app_meta
         WHERE key IN ('fb_permanent_page_id', 'fb_permanent_page_token_enc', 'fb_source_token_sha')`
      );
      const map = new Map(res.rows.map((r) => [r.key, r.value]));
      const storedPageId = map.get('fb_permanent_page_id') || '';
      const storedEnc = map.get('fb_permanent_page_token_enc') || '';
      const storedSha = map.get('fb_source_token_sha') || '';
      const currentEnvSha = envToken ? sha256(envToken) : '';

      if (
        storedEnc &&
        storedPageId === pageId &&
        (!currentEnvSha || storedSha === currentEnvSha)
      ) {
        const decrypted = decryptSecret(storedEnc);
        if (decrypted) {
          return {
            pageId,
            accessToken: decrypted,
            usedStoredPermanent: true,
          };
        }
      }
    }
  } catch {
    // ignore DB lookup issues and fall back to env token
  }

  return { pageId, accessToken: envToken, usedStoredPermanent: false };
}

export async function exchangeForPermanentPageToken(
  configuredPageId: string,
  shortOrUserToken: string
): Promise<
  | {
      ok: true;
      permanentPageToken: string;
      pageId: string;
      pageName: string;
      expiresLabel: string;
    }
  | { ok: false; error: string }
> {
  const { appId, appSecret } = getFacebookAppCredentials();
  if (!appId || !appSecret) {
    return {
      ok: false,
      error:
        'FACEBOOK_APP_ID and FACEBOOK_APP_SECRET are required in Secrets to exchange a short-lived token into a never-expiring Page Access Token.',
    };
  }

  // Step 1: Exchange short-lived user token -> 60-day long-lived user token
  const exchangeUrl = new URL('https://graph.facebook.com/v27.0/oauth/access_token');
  exchangeUrl.searchParams.set('grant_type', 'fb_exchange_token');
  exchangeUrl.searchParams.set('client_id', appId);
  exchangeUrl.searchParams.set('client_secret', appSecret);
  exchangeUrl.searchParams.set('fb_exchange_token', shortOrUserToken);

  const exchangeRes = await fetch(exchangeUrl.toString());
  const exchangeJson = (await exchangeRes.json().catch(() => ({}))) as {
    access_token?: string;
    error?: { message?: string };
  };

  if (!exchangeRes.ok || exchangeJson.error || !exchangeJson.access_token) {
    return {
      ok: false,
      error:
        exchangeJson.error?.message ||
        `Failed to exchange Facebook token (HTTP ${exchangeRes.status}). Check FACEBOOK_APP_ID / FACEBOOK_APP_SECRET and ensure your current token has not already expired.`,
    };
  }

  // Step 2: Fetch /me/accounts with long-lived user token -> yields a NEVER-EXPIRING Page Access Token
  const accountsRes = await fetch(
    `https://graph.facebook.com/v27.0/me/accounts?fields=id,name,access_token&limit=50&access_token=${encodeURIComponent(
      exchangeJson.access_token
    )}`
  );
  const accountsJson = (await accountsRes.json().catch(() => ({}))) as {
    data?: Array<{ id: string; name?: string; access_token?: string }>;
    error?: { message?: string };
  };

  if (!accountsRes.ok || accountsJson.error || !Array.isArray(accountsJson.data)) {
    return {
      ok: false,
      error:
        accountsJson.error?.message ||
        'Could not fetch managed Facebook Pages after long-lived token exchange.',
    };
  }

  const matched = accountsJson.data.find((p) => p.id === configuredPageId);
  if (!matched || !matched.access_token) {
    const avail = accountsJson.data.map((p) => `${p.name || p.id} (${p.id})`).join(', ');
    return {
      ok: false,
      error: `Page ID ${configuredPageId} not found in /me/accounts.${
        avail ? ` Managed Pages: ${avail}` : ''
      }`,
    };
  }

  await savePermanentPageToken({
    pageId: matched.id,
    sourceToken: shortOrUserToken,
    permanentPageToken: matched.access_token,
    expiresLabel: 'never',
  });

  return {
    ok: true,
    permanentPageToken: matched.access_token,
    pageId: matched.id,
    pageName: matched.name || matched.id,
    expiresLabel: 'never',
  };
}
