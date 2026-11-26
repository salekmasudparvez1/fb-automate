import React, { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  AlertTriangle,
  Check,
  Download,
  FileSpreadsheet,
  Film,
  Image as ImageIcon,
  Link as LinkIcon,
  Loader2,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import type { BulkImportRowPayload } from '../types';
import { formatDateOnly, formatTime12h } from '../utils/schedule';

interface BulkImportModalProps {
  isOpen: boolean;
  defaultSlotTime: string;
  apiFetch: <T>(url: string, options?: RequestInit) => Promise<T>;
  onClose: () => void;
  onImportConfirmed: (rows: BulkImportRowPayload[]) => Promise<number>;
}

function normalizeHeader(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pickColumn(record: Record<string, unknown>, keys: string[]): unknown {
  const entries = Object.entries(record);
  for (const cand of keys) {
    for (const [k, v] of entries) {
      if (normalizeHeader(k) === cand && v !== undefined && v !== null && String(v).trim() !== '') {
        return v;
      }
    }
  }
  return undefined;
}

function isSafeHttpUrl(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function inferClientMediaType(url: string): 'image' | 'video' {
  const lower = url.toLowerCase();
  if (
    lower.includes('/video/upload/') ||
    /\.(mp4|mov|webm|m4v|avi|mkv)(\?.*)?$/i.test(lower)
  ) {
    return 'video';
  }
  return 'image';
}

function parseClientPublishDate(
  rawDate: unknown,
  rawTime: unknown,
  index: number,
  defaultSlotTime: string
): { scheduledAt: string; slotTime: string; monthKey: string; validDate: boolean } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const cleanDefault = /^\d{2}:\d{2}$/.test(defaultSlotTime) ? defaultSlotTime : '09:00';
  const [defH, defM] = cleanDefault.split(':').map(Number);

  let dt: Date | null = null;
  let validDate = false;

  if (rawDate instanceof Date && !Number.isNaN(rawDate.getTime())) {
    dt = new Date(rawDate.getTime());
    validDate = true;
    if (dt.getHours() === 0 && dt.getMinutes() === 0) {
      dt.setHours(defH || 9, defM || 0, 0, 0);
    }
  } else if (typeof rawDate === 'number' && Number.isFinite(rawDate) && rawDate > 20000) {
    const parsed = XLSX.SSF.parse_date_code(rawDate);
    if (parsed && parsed.y && parsed.m && parsed.d) {
      const hasTime = (parsed.H || 0) !== 0 || (parsed.M || 0) !== 0;
      dt = new Date(
        parsed.y,
        parsed.m - 1,
        parsed.d,
        hasTime ? parsed.H : defH || 9,
        hasTime ? parsed.M : defM || 0,
        0,
        0
      );
      validDate = true;
    }
  } else if (typeof rawDate === 'string' && rawDate.trim()) {
    const str = rawDate.trim();
    const hasTime = /\d{1,2}:\d{2}/.test(str);
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      const [y, m, d] = str.split('-').map(Number);
      dt = new Date(y, (m || 1) - 1, d || 1, defH || 9, defM || 0, 0, 0);
      validDate = true;
    } else {
      const parsed = new Date(str);
      if (!Number.isNaN(parsed.getTime())) {
        dt = parsed;
        if (!hasTime) dt.setHours(defH || 9, defM || 0, 0, 0);
        validDate = true;
      }
    }
  }

  if (!dt || Number.isNaN(dt.getTime())) {
    dt = new Date();
    dt.setDate(dt.getDate() + index);
    dt.setHours(defH || 9, defM || 0, 0, 0);
  }

  const timeStr = String(rawTime ?? '').trim();
  if (/^\d{1,2}:\d{2}/.test(timeStr)) {
    const [hh, mm] = timeStr.split(':').map(Number);
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

function parseSheetRecordsClient(
  records: Record<string, unknown>[],
  defaultSlotTime: string
): BulkImportRowPayload[] {
  const rows: BulkImportRowPayload[] = [];
  records.forEach((rec, idx) => {
    const rawTitle = pickColumn(rec, ['title', 'seotitle', 'headline', 'posttitle', 'name', 'subject']);
    const rawBody = pickColumn(rec, ['description', 'seodescription', 'body', 'caption', 'content', 'text', 'message', 'postbody']);
    const rawTopic = pickColumn(rec, ['topic', 'topicname', 'category', 'series']);
    const rawStage = pickColumn(rec, ['stage', 'stagelabel', 'slotlabel', 'part']);
    const rawImage = pickColumn(rec, ['image', 'imageurl', 'photo', 'photourl', 'img', 'thumbnail']);
    const rawVideo = pickColumn(rec, ['video', 'videourl', 'clip', 'reel']);
    const rawMedia = pickColumn(rec, ['media', 'mediaurl', 'attachment']);
    const rawTags = pickColumn(rec, ['tags', 'seotags', 'hashtags', 'keywords']);
    const rawDate = pickColumn(rec, [
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
    const rawTime = pickColumn(rec, ['time', 'slottime', 'publishtime', 'posttime']);

    const seoTitle = String(rawTitle ?? '').trim().slice(0, 120);
    const seoDescription = String(rawBody ?? seoTitle).trim();
    if (!seoTitle && !seoDescription) return;

    const warnings: string[] = [];
    if (seoTitle.length > 70) warnings.push('Title exceeds 70 chars');

    let mediaType: 'none' | 'image' | 'video' = 'none';
    let mediaUrl: string | undefined;

    const vid = isSafeHttpUrl(rawVideo);
    const img = isSafeHttpUrl(rawImage);
    const gen = isSafeHttpUrl(rawMedia);

    if (vid) {
      mediaType = 'video';
      mediaUrl = vid;
    } else if (img) {
      mediaType = inferClientMediaType(img);
      mediaUrl = img;
    } else if (gen) {
      mediaType = inferClientMediaType(gen);
      mediaUrl = gen;
    } else if (String(rawVideo ?? rawImage ?? rawMedia ?? '').trim()) {
      warnings.push('Media URL ignored (must be http/https)');
    }

    const d = parseClientPublishDate(rawDate, rawTime, idx, defaultSlotTime);
    if (!d.validDate && String(rawDate ?? '').trim()) {
      warnings.push('Unrecognized publish date; defaulted sequentially');
    }

    const seoTags = String(rawTags ?? '')
      .split(/[\s,;]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => (t.startsWith('#') ? t : `#${t.replace(/^#+/, '')}`))
      .slice(0, 8);

    rows.push({
      topicName: String(rawTopic ?? (seoTitle || 'Imported Series')).trim().slice(0, 80),
      stageLabel: String(rawStage ?? '').trim() || `Imported Row #${idx + 1}`,
      seoTitle: (seoTitle || seoDescription).slice(0, 120),
      seoDescription,
      seoTags,
      mediaType,
      mediaUrl,
      slotTime: d.slotTime,
      scheduledAt: d.scheduledAt,
      monthKey: d.monthKey,
      warnings,
    });
  });

  return rows;
}

export const BulkImportModal: React.FC<BulkImportModalProps> = ({
  isOpen,
  defaultSlotTime,
  apiFetch,
  onClose,
  onImportConfirmed,
}) => {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [sourceTab, setSourceTab] = useState<'file' | 'google_sheet'>('file');
  const [sheetUrl, setSheetUrl] = useState('');
  const [sourceName, setSourceName] = useState<string>('');
  const [previewRows, setPreviewRows] = useState<BulkImportRowPayload[]>([]);
  const [isLoadingSheet, setIsLoadingSheet] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleDownloadTemplate = () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const pad = (n: number) => String(n).padStart(2, '0');
    const d1 = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())} 09:00`;
    tomorrow.setDate(tomorrow.getDate() + 1);
    const d2 = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())} 15:00`;

    const sampleData = [
      {
        Title: '5 Machine Learning Mistakes Beginners Make',
        Description:
          'Avoid data leakage, overfitting, and skipping baseline models. Here is a quick checklist before training your next pipeline.',
        Image: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
        Video: '',
        Tags: '#MachineLearning #DataScience #AI',
        'Date of Publish': d1,
        Topic: 'ML Foundations',
      },
      {
        Title: 'Quick Demo: Gradient Descent Intuition in 60s',
        Description:
          'Watch how learning rate controls convergence speed across convex and saddle surfaces.',
        Image: '',
        Video: 'https://res.cloudinary.com/demo/video/upload/dog.mp4',
        Tags: '#DeepLearning #Python #AI',
        'Date of Publish': d2,
        Topic: 'Optimization',
      },
    ];

    const ws = XLSX.utils.json_to_sheet(sampleData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Schedule');
    XLSX.writeFile(wb, 'fb-schedule-template.xlsx');
  };

  const handleFileChange = async (file: File) => {
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      const firstSheet = wb.SheetNames[0];
      if (!firstSheet) throw new Error('The uploaded workbook has no sheets.');
      const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(
        wb.Sheets[firstSheet],
        { defval: '', raw: true }
      );
      const parsed = parseSheetRecordsClient(records, defaultSlotTime);
      if (parsed.length === 0) {
        throw new Error(
          'No valid rows found. Make sure your sheet includes a Title / Description column.'
        );
      }
      setPreviewRows(parsed);
      setSourceName(`${file.name} (${firstSheet})`);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Failed to read Excel / CSV file.'
      );
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleFetchGoogleSheet = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoadingSheet(true);
    try {
      const res = await apiFetch<{
        ok: boolean;
        sheetName: string;
        rows: BulkImportRowPayload[];
      }>('/api/import/google-sheet', {
        method: 'POST',
        body: JSON.stringify({
          sheetUrl: sheetUrl.trim(),
          defaultSlotTime,
        }),
      });
      if (!res.rows || res.rows.length === 0) {
        throw new Error('The Google Sheet has no valid rows.');
      }
      setPreviewRows(res.rows);
      setSourceName(`Google Sheet · ${res.sheetName}`);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Failed to load Google Sheet.'
      );
    } finally {
      setIsLoadingSheet(false);
    }
  };

  const handleConfirmImport = async () => {
    if (previewRows.length === 0) return;
    setError(null);
    setIsImporting(true);
    try {
      await onImportConfirmed(previewRows.slice(0, 300));
      setPreviewRows([]);
      setSourceName('');
      setSheetUrl('');
      onClose();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Failed to save imported posts.'
      );
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-[2px] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-import-title"
    >
      <div className="w-full max-w-4xl bg-white border border-[#E4E6EB] rounded-2xl shadow-xl overflow-hidden max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-[#E4E6EB] shrink-0">
          <div>
            <h2
              id="bulk-import-title"
              className="font-display text-base sm:text-lg font-bold text-[#1C1E21]"
            >
              Bulk Import from Google Sheets / Excel
            </h2>
            <p className="text-xs text-[#65676B] mt-0.5">
              Expected columns: <strong>Title</strong>, Description, Image / Video URL, Tags, and Date of Publish.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close bulk import"
            className="p-1.5 text-[#65676B] hover:text-[#1C1E21] hover:bg-[#F0F2F5] rounded-lg cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 sm:p-6 space-y-4 overflow-y-auto flex-1">
          {/* Source Selector & Sample Download */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex items-center gap-1 p-1 bg-[#F0F2F5] rounded-lg">
              <button
                type="button"
                onClick={() => setSourceTab('file')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  sourceTab === 'file'
                    ? 'bg-white text-[#1877F2] font-semibold shadow-xs'
                    : 'text-[#65676B] hover:text-[#1C1E21]'
                }`}
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span>Excel / CSV File (.xlsx)</span>
              </button>
              <button
                type="button"
                onClick={() => setSourceTab('google_sheet')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  sourceTab === 'google_sheet'
                    ? 'bg-white text-[#1877F2] font-semibold shadow-xs'
                    : 'text-[#65676B] hover:text-[#1C1E21]'
                }`}
              >
                <LinkIcon className="w-3.5 h-3.5" />
                <span>Google Sheets Link</span>
              </button>
            </div>

            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#1877F2] bg-[#E7F3FF] hover:bg-[#DCEBFF] rounded-lg whitespace-nowrap cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download Sample Excel (.xlsx)</span>
            </button>
          </div>

          {sourceTab === 'file' ? (
            <div className="border-2 border-dashed border-[#CCD0D5] hover:border-[#1877F2] bg-[#F7F8FA] rounded-xl p-6 text-center transition-colors">
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFileChange(f);
                }}
              />
              <UploadCloud className="w-7 h-7 text-[#1877F2] mx-auto mb-2" />
              <div className="text-sm font-semibold text-[#1C1E21]">
                Select an Excel (.xlsx / .xls) or CSV file
              </div>
              <p className="text-xs text-[#65676B] mt-1 max-w-md mx-auto">
                Supports Title, Description/Caption, Image URL, Video URL, Tags, and Date of Publish columns in any order.
              </p>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#1877F2] hover:bg-[#166FE5] rounded-lg cursor-pointer"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span>Choose Spreadsheet File</span>
              </button>
            </div>
          ) : (
            <form onSubmit={handleFetchGoogleSheet} className="space-y-2.5 p-4 bg-[#F7F8FA] border border-[#E4E6EB] rounded-xl">
              <label className="block text-xs font-semibold text-[#1C1E21]">
                Google Sheets Share Link (set access to &ldquo;Anyone with the link can view&rdquo;)
              </label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  required
                  value={sheetUrl}
                  onChange={(e) => setSheetUrl(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit"
                  className="flex-1 px-3 py-2 text-xs font-mono bg-white border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
                />
                <button
                  type="submit"
                  disabled={isLoadingSheet}
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#1877F2] hover:bg-[#166FE5] disabled:opacity-60 rounded-lg whitespace-nowrap cursor-pointer"
                >
                  {isLoadingSheet ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Download className="w-3.5 h-3.5" />
                  )}
                  <span>{isLoadingSheet ? 'Fetching...' : 'Load Sheet'}</span>
                </button>
              </div>
            </form>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 text-xs text-red-800 bg-red-50 border border-red-200 rounded-xl">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Parsed Rows Preview Table */}
          {previewRows.length > 0 && (
            <div className="border border-[#E4E6EB] rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 bg-[#F7F8FA] border-b border-[#E4E6EB] flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-[#1C1E21]">
                  Preview: {sourceName} ·{' '}
                  <span className="font-mono tabular-nums text-[#1877F2]">
                    {previewRows.length} rows ready
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setPreviewRows([]);
                    setSourceName('');
                  }}
                  className="text-[#65676B] hover:text-red-700 font-medium cursor-pointer"
                >
                  Clear preview
                </button>
              </div>

              <div className="max-h-72 overflow-auto divide-y divide-[#E4E6EB]">
                {previewRows.map((row, idx) => (
                  <div
                    key={idx}
                    className="p-3 flex items-start justify-between gap-3 text-xs hover:bg-[#F7F8FA]"
                  >
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      {row.mediaUrl ? (
                        row.mediaType === 'video' ? (
                          <div className="w-11 h-11 rounded-lg bg-[#1C1E21] text-white flex items-center justify-center shrink-0">
                            <Film className="w-4 h-4" />
                          </div>
                        ) : (
                          <img
                            src={row.mediaUrl}
                            alt=""
                            referrerPolicy="no-referrer"
                            className="w-11 h-11 rounded-lg object-cover border border-[#E4E6EB] shrink-0"
                          />
                        )
                      ) : (
                        <div className="w-11 h-11 rounded-lg bg-[#F0F2F5] text-[#65676B] flex items-center justify-center shrink-0 font-mono text-[10px]">
                          Text
                        </div>
                      )}

                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-[#1C1E21] truncate">
                          {row.seoTitle}
                        </div>
                        <div className="text-[#65676B] line-clamp-1 mt-0.5">
                          {row.seoDescription}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                          <span className="font-mono tabular-nums text-[#1C1E21]">
                            {formatDateOnly(row.scheduledAt)} · {formatTime12h(row.slotTime)}
                          </span>
                          {row.mediaType !== 'none' && (
                            <span className="inline-flex items-center gap-1 font-medium text-[#1877F2]">
                              {row.mediaType === 'video' ? (
                                <Film className="w-3 h-3" />
                              ) : (
                                <ImageIcon className="w-3 h-3" />
                              )}
                              <span>{row.mediaType === 'video' ? 'Video' : 'Image'}</span>
                            </span>
                          )}
                          {row.seoTags.length > 0 && (
                            <span className="font-mono text-[#1877F2] truncate">
                              {row.seoTags.join(' ')}
                            </span>
                          )}
                        </div>
                        {row.warnings.length > 0 && (
                          <div className="mt-1 text-[11px] text-amber-800">
                            Note: {row.warnings.join(' · ')}
                          </div>
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        setPreviewRows((prev) => prev.filter((_, i) => i !== idx))
                      }
                      aria-label="Remove row from import"
                      className="p-1.5 text-[#65676B] hover:text-red-700 rounded-md cursor-pointer shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-5 sm:px-6 py-4 border-t border-[#E4E6EB] flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-[#1C1E21] bg-[#E4E6EB] hover:bg-[#D8DADF] rounded-lg cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isImporting || previewRows.length === 0}
            onClick={() => void handleConfirmImport()}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#1877F2] hover:bg-[#166FE5] disabled:opacity-50 rounded-lg cursor-pointer"
          >
            {isImporting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Check className="w-3.5 h-3.5" />
            )}
            <span>
              {isImporting
                ? 'Importing...'
                : `Import ${previewRows.length} Post${previewRows.length === 1 ? '' : 's'} to Schedule`}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
