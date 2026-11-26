import * as XLSX from 'xlsx';
import { inferMediaTypeFromUrl, validateSafeMediaUrl } from './cloudinary.ts';

export interface ParsedBulkImportRow {
  topicName: string;
  stageLabel: string;
  seoTitle: string;
  seoDescription: string;
  seoTags: string[];
  mediaType: 'none' | 'image' | 'video';
  mediaUrl?: string;
  slotTime: string;
  scheduledAt: string;
  monthKey: string;
  warnings: string[];
}

export function extractGoogleSheetExportUrl(rawInput: string): {
  ok: true;
  exportUrl: string;
  sheetId: string;
} | {
  ok: false;
  error: string;
} {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { ok: false, error: 'Paste a Google Sheets URL or Spreadsheet ID.' };
  }

  // Raw spreadsheet ID support
  if (/^[a-zA-Z0-9_-]{20,80}$/.test(trimmed)) {
    return {
      ok: true,
      sheetId: trimmed,
      exportUrl: `https://docs.google.com/spreadsheets/d/${trimmed}/export?format=xlsx`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Invalid Google Sheets URL format.' };
  }

  if (parsed.protocol !== 'https:' || parsed.hostname !== 'docs.google.com') {
    return {
      ok: false,
      error: 'Only https://docs.google.com/spreadsheets/d/... links are permitted.',
    };
  }

  const match = parsed.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]{10,80})(?:\/|$)/);
  if (!match) {
    return {
      ok: false,
      error: 'Could not locate a Google Spreadsheet ID in that URL.',
    };
  }

  const sheetId = match[1];
  const gidMatch =
    parsed.searchParams.get('gid') ||
    (parsed.hash ? parsed.hash.match(/gid=(\d+)/)?.[1] : null);

  const exportUrl = new URL(
    `https://docs.google.com/spreadsheets/d/${sheetId}/export`
  );
  exportUrl.searchParams.set('format', 'xlsx');
  if (gidMatch && /^\d+$/.test(gidMatch)) {
    exportUrl.searchParams.set('gid', gidMatch);
  }

  return {
    ok: true,
    sheetId,
    exportUrl: exportUrl.toString(),
  };
}

function normalizeHeaderKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pickField(row: Record<string, unknown>, candidates: string[]): unknown {
  const entries = Object.entries(row);
  for (const cand of candidates) {
    for (const [k, v] of entries) {
      if (normalizeHeaderKey(k) === cand && v !== undefined && v !== null && String(v).trim() !== '') {
        return v;
      }
    }
  }
  return undefined;
}

function normalizeTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((t) => String(t).trim())
      .filter(Boolean)
      .map((t) => (t.startsWith('#') ? t : `#${t.replace(/^#+/, '')}`))
      .slice(0, 8);
  }
  const str = String(raw ?? '').trim();
  if (!str) return [];
  return str
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.startsWith('#') ? t : `#${t.replace(/^#+/, '')}`))
    .slice(0, 8);
}

function parsePublishDate(
  rawDate: unknown,
  rawTime: unknown,
  fallbackIndex: number,
  defaultSlotTime: string
): { scheduledAt: string; slotTime: string; monthKey: string; validDate: boolean } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const cleanSlot = /^\d{2}:\d{2}$/.test(String(rawTime ?? '').trim())
    ? String(rawTime).trim()
    : /^\d{2}:\d{2}$/.test(defaultSlotTime)
      ? defaultSlotTime
      : '09:00';
  const [defH, defM] = cleanSlot.split(':').map(Number);

  let dt: Date | null = null;
  let hasExplicitTime = false;

  if (rawDate instanceof Date && !Number.isNaN(rawDate.getTime())) {
    dt = rawDate;
    hasExplicitTime = dt.getHours() !== 0 || dt.getMinutes() !== 0;
  } else if (typeof rawDate === 'number' && Number.isFinite(rawDate) && rawDate > 20000) {
    // Excel serial date
    const parsed = XLSX.SSF.parse_date_code(rawDate);
    if (parsed && parsed.y && parsed.m && parsed.d) {
      hasExplicitTime = (parsed.H || 0) !== 0 || (parsed.M || 0) !== 0;
      dt = new Date(
        parsed.y,
        parsed.m - 1,
        parsed.d,
        hasExplicitTime ? parsed.H : defH || 9,
        hasExplicitTime ? parsed.M : defM || 0,
        0,
        0
      );
    }
  } else if (typeof rawDate === 'string' && rawDate.trim()) {
    const str = rawDate.trim();
    hasExplicitTime = /\d{1,2}:\d{2}/.test(str);
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      const [y, m, d] = str.split('-').map(Number);
      dt = new Date(y, (m || 1) - 1, d || 1, defH || 9, defM || 0, 0, 0);
    } else {
      const candidate = new Date(str);
      if (!Number.isNaN(candidate.getTime())) {
        dt = candidate;
        if (!hasExplicitTime) {
          dt.setHours(defH || 9, defM || 0, 0, 0);
        }
      }
    }
  }

  let validDate = Boolean(dt && !Number.isNaN(dt.getTime()));
  if (!dt || Number.isNaN(dt.getTime())) {
    const base = new Date();
    base.setDate(base.getDate() + fallbackIndex);
    base.setHours(defH || 9, defM || 0, 0, 0);
    dt = base;
    validDate = false;
  }

  // Override hour/minute if explicit Time column was provided
  const rawTimeStr = String(rawTime ?? '').trim();
  if (/^\d{1,2}:\d{2}/.test(rawTimeStr)) {
    const [hh, mm] = rawTimeStr.split(':').map(Number);
    if (!Number.isNaN(hh) && !Number.isNaN(mm) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      dt.setHours(hh, mm, 0, 0);
    }
  }

  const monthKey = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`;
  const slotTime = `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;

  return {
    scheduledAt: dt.toISOString(),
    slotTime,
    monthKey,
    validDate,
  };
}

export function parseWorkbookBufferToRows(
  buffer: Buffer,
  defaultSlotTime = '09:00'
): {
  sheetName: string;
  rows: ParsedBulkImportRow[];
  skippedCount: number;
} {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0] || 'Sheet1';
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return { sheetName, rows: [], skippedCount: 0 };
  }

  const rawRecords = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: true,
  });

  const rows: ParsedBulkImportRow[] = [];
  let skippedCount = 0;

  rawRecords.forEach((record, index) => {
    const rawTitle = pickField(record, [
      'title',
      'seotitle',
      'headline',
      'posttitle',
      'name',
      'subject',
    ]);
    const rawBody = pickField(record, [
      'description',
      'seodescription',
      'body',
      'caption',
      'content',
      'text',
      'message',
      'postbody',
    ]);
    const rawTopic = pickField(record, ['topic', 'topicname', 'category', 'series']);
    const rawStage = pickField(record, ['stage', 'stagelabel', 'slotlabel', 'part']);
    const rawImage = pickField(record, [
      'image',
      'imageurl',
      'photo',
      'photourl',
      'img',
      'thumbnail',
    ]);
    const rawVideo = pickField(record, ['video', 'videourl', 'clip', 'reel']);
    const rawGenericMedia = pickField(record, ['media', 'mediaurl', 'attachment']);
    const rawTags = pickField(record, ['tags', 'seotags', 'hashtags', 'keywords']);
    const rawDate = pickField(record, [
      'dateofpublish',
      'dateofpubshil',
      'publishdate',
      'publisheddate',
      'scheduledat',
      'scheduleddate',
      'date',
      'publishat',
      'datetime',
    ]);
    const rawTime = pickField(record, ['time', 'slottime', 'publishtime', 'posttime']);

    const seoTitle = String(rawTitle ?? '').trim().slice(0, 120);
    const seoDescription = String(rawBody ?? seoTitle).trim();
    if (!seoTitle && !seoDescription) {
      skippedCount += 1;
      return;
    }

    const warnings: string[] = [];
    if (seoTitle.length > 70) {
      warnings.push('Title exceeds 70 chars');
    }

    let mediaType: 'none' | 'image' | 'video' = 'none';
    let mediaUrl: string | undefined;

    const videoCandidate = validateSafeMediaUrl(rawVideo);
    const imageCandidate = validateSafeMediaUrl(rawImage);
    const genericCandidate = validateSafeMediaUrl(rawGenericMedia);

    if (videoCandidate) {
      mediaType = 'video';
      mediaUrl = videoCandidate;
    } else if (imageCandidate) {
      mediaType = inferMediaTypeFromUrl(imageCandidate);
      mediaUrl = imageCandidate;
    } else if (genericCandidate) {
      mediaType = inferMediaTypeFromUrl(genericCandidate);
      mediaUrl = genericCandidate;
    } else if (String(rawVideo ?? rawImage ?? rawGenericMedia ?? '').trim()) {
      warnings.push('Media URL skipped (must start with http:// or https://)');
    }

    const dateInfo = parsePublishDate(rawDate, rawTime, index, defaultSlotTime);
    if (!dateInfo.validDate && String(rawDate ?? '').trim()) {
      warnings.push('Unrecognized publish date; defaulted sequentially');
    }

    const tags = normalizeTags(rawTags);
    const topicName = String(rawTopic ?? (seoTitle || 'Imported Series')).trim().slice(0, 80);
    const stageLabel =
      String(rawStage ?? '').trim() || `Imported Row #${index + 1}`;

    rows.push({
      topicName,
      stageLabel,
      seoTitle: (seoTitle || seoDescription).slice(0, 120),
      seoDescription,
      seoTags: tags,
      mediaType,
      mediaUrl,
      slotTime: dateInfo.slotTime,
      scheduledAt: dateInfo.scheduledAt,
      monthKey: dateInfo.monthKey,
      warnings,
    });
  });

  return { sheetName, rows, skippedCount };
}
