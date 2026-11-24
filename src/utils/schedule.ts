import type { ScheduledPost } from '../types';

export function getCurrentMonthKey(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

export function getDaysInMonth(monthKey: string): number {
  const [year, month] = monthKey.split('-').map(Number);
  if (!year || !month) return 30;
  return new Date(year, month, 0).getDate();
}

export function formatTime12h(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(hour12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${period}`;
}

export function formatMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number);
  if (!year || !month) return monthKey;
  const date = new Date(year, month - 1, 1);
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function formatDateTimeDisplay(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateOnly(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function formatShortTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function isoToLocalDateTimeInput(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function localDateTimeInputToIso(localInput: string): string {
  const date = new Date(localInput);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

export function buildLocalSlotIso(
  year: number,
  monthZeroBased: number,
  day: number,
  hhmm: string
): { monthKey: string; scheduledAt: string; dateLabel: string } {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(year, monthZeroBased, day, h || 9, m || 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  const monthKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const dateLabel = `${monthKey}-${pad(d.getDate())}`;
  return {
    monthKey,
    scheduledAt: d.toISOString(),
    dateLabel,
  };
}

export interface GeneratedSlot {
  monthKey: string;
  dateLabel: string;
  slotTime: string;
  scheduledAt: string;
  dayIndex: number;
  slotIndex: number;
}

export function buildMonthlySlots(params: {
  monthKey: string;
  startDay: number;
  daysCount: number;
  recurringTimes: string[];
  maxSlots?: number;
}): GeneratedSlot[] {
  const [year, month] = params.monthKey.split('-').map(Number);
  const sortedTimes = [...params.recurringTimes].sort();
  if (!year || !month || sortedTimes.length === 0) return [];

  const result: GeneratedSlot[] = [];
  const cap = params.maxSlots ?? 93;

  for (let dOffset = 0; dOffset < params.daysCount; dOffset++) {
    for (let sIdx = 0; sIdx < sortedTimes.length; sIdx++) {
      if (result.length >= cap) return result;
      const slotTime = sortedTimes[sIdx];
      const built = buildLocalSlotIso(
        year,
        month - 1,
        params.startDay + dOffset,
        slotTime
      );
      result.push({
        monthKey: built.monthKey,
        dateLabel: built.dateLabel,
        slotTime,
        scheduledAt: built.scheduledAt,
        dayIndex: dOffset,
        slotIndex: sIdx,
      });
    }
  }

  return result;
}

export function recomputePendingSlots(
  pendingPosts: ScheduledPost[],
  recurringTimes: string[]
): Array<{ id: string; slotTime: string; scheduledAt: string; monthKey: string }> {
  const sortedTimes = [...recurringTimes].sort();
  if (pendingPosts.length === 0 || sortedTimes.length === 0) return [];

  const sortedPosts = [...pendingPosts].sort(
    (a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
  );

  const firstDate = new Date(sortedPosts[0].scheduledAt);
  const baseYear = firstDate.getFullYear();
  const baseMonth = firstDate.getMonth();
  const baseDay = firstDate.getDate();

  return sortedPosts.map((post, idx) => {
    const dayOffset = Math.floor(idx / sortedTimes.length);
    const slotTime = sortedTimes[idx % sortedTimes.length];
    const built = buildLocalSlotIso(baseYear, baseMonth, baseDay + dayOffset, slotTime);
    return {
      id: post.id,
      slotTime,
      scheduledAt: built.scheduledAt,
      monthKey: built.monthKey,
    };
  });
}

export function formatFacebookMessage(
  post: Pick<ScheduledPost, 'seoTitle' | 'seoDescription' | 'seoTags'>
): string {
  const tagsLine = post.seoTags
    .map((t) => (t.startsWith('#') ? t : `#${t.replace(/^#+/, '')}`))
    .join(' ');
  return `${post.seoTitle}\n\n${post.seoDescription}\n\n${tagsLine}`.trim();
}
