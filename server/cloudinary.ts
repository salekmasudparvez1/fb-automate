import crypto from 'crypto';

export function getCloudinaryConfig(): {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
} {
  return {
    cloudName: (process.env.CLOUDINARY_CLOUD_NAME || '').trim(),
    apiKey: (process.env.CLOUDINARY_API_KEY || '').trim(),
    apiSecret: (process.env.CLOUDINARY_API_SECRET || '').trim(),
  };
}

export function isCloudinaryConfigured(): boolean {
  const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();
  return Boolean(cloudName && apiKey && apiSecret);
}

export function getCloudinaryPublicStatus(): {
  configured: boolean;
  cloudName: string;
  maskedApiKey: string;
} {
  const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();
  const maskedApiKey =
    apiKey.length > 6
      ? `${apiKey.slice(0, 4)}••••${apiKey.slice(-2)}`
      : apiKey
        ? '••••••'
        : '';
  return {
    configured: Boolean(cloudName && apiKey && apiSecret),
    cloudName,
    maskedApiKey,
  };
}

export function createCloudinaryUploadSignature(
  resourceType: 'image' | 'video'
): {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  folder: string;
  signature: string;
  resourceType: 'image' | 'video';
} {
  const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      'Cloudinary credentials are not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in Secrets.'
    );
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'fb_page_studio';
  // Cloudinary requires alphabetical sorting of signed parameters + apiSecret
  const toSign = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash('sha1').update(toSign).digest('hex');

  return {
    cloudName,
    apiKey,
    timestamp,
    folder,
    signature,
    resourceType,
  };
}

export function validateSafeMediaUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function inferMediaTypeFromUrl(url: string): 'image' | 'video' {
  const lower = url.toLowerCase();
  if (
    lower.includes('/video/upload/') ||
    /\.(mp4|mov|webm|m4v|avi|mkv)(\?.*)?$/i.test(lower)
  ) {
    return 'video';
  }
  return 'image';
}
