import React, { useMemo, useState } from 'react';
import {
  BookOpen,
  Calendar,
  Clock,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  X,
  AlertCircle,
} from 'lucide-react';
import {
  buildMonthlySlots,
  formatTime12h,
  getCurrentMonthKey,
  getDaysInMonth,
} from '../utils/schedule';

interface MonthlyPlannerPanelProps {
  recurringTimes: string[];
  pendingCount: number;
  isGenerating: boolean;
  isApplyingSlots: boolean;
  isSeedingMl: boolean;
  errorMessage: string | null;
  onUpdateRecurringTimes: (times: string[]) => Promise<void>;
  onApplySlotsToPending: () => Promise<void>;
  onSeedMlMonth: (startDate: string) => Promise<void>;
  onGenerateMonthly: (params: {
    themeOrTopic: string;
    topicMode: 'theme' | 'custom_list';
    customTopics: string[];
    slots: ReturnType<typeof buildMonthlySlots>;
  }) => Promise<void>;
}

const PRESET_TIMES = ['09:00', '12:00', '15:00', '18:00', '21:00'];

export const MonthlyPlannerPanel: React.FC<MonthlyPlannerPanelProps> = ({
  recurringTimes,
  pendingCount,
  isGenerating,
  isApplyingSlots,
  isSeedingMl,
  errorMessage,
  onUpdateRecurringTimes,
  onApplySlotsToPending,
  onSeedMlMonth,
  onGenerateMonthly,
}) => {
  const [monthKey, setMonthKey] = useState<string>(() => getCurrentMonthKey());
  const [startDay, setStartDay] = useState<number>(() => new Date().getDate());
  const [daysCount, setDaysCount] = useState<number>(10);
  const [topicMode, setTopicMode] = useState<'theme' | 'custom_list'>('theme');
  const [themeInput, setThemeInput] = useState<string>('');
  const [customTopicsText, setCustomTopicsText] = useState<string>('');
  const [customTimeInput, setCustomTimeInput] = useState<string>('10:30');
  const [localError, setLocalError] = useState<string | null>(null);

  const daysInSelectedMonth = useMemo(() => getDaysInMonth(monthKey), [monthKey]);

  const parsedCustomTopics = useMemo(
    () =>
      customTopicsText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    [customTopicsText]
  );

  const effectiveDays =
    topicMode === 'custom_list' && parsedCustomTopics.length > 0 && recurringTimes.length > 0
      ? Math.ceil(parsedCustomTopics.length / recurringTimes.length)
      : daysCount;

  const computedSlots = useMemo(() => {
    const raw = buildMonthlySlots({
      monthKey,
      startDay: Math.max(1, Math.min(startDay, daysInSelectedMonth)),
      daysCount: effectiveDays,
      recurringTimes,
      maxSlots: 93,
    });
    if (topicMode === 'custom_list' && parsedCustomTopics.length > 0) {
      return raw.slice(0, parsedCustomTopics.length);
    }
    return raw;
  }, [
    monthKey,
    startDay,
    daysInSelectedMonth,
    effectiveDays,
    recurringTimes,
    topicMode,
    parsedCustomTopics.length,
  ]);

  const handleToggleTime = async (time: string) => {
    if (recurringTimes.includes(time)) {
      if (recurringTimes.length <= 1) {
        setLocalError('Keep at least 1 daily posting time slot.');
        return;
      }
      setLocalError(null);
      await onUpdateRecurringTimes(recurringTimes.filter((t) => t !== time));
    } else {
      setLocalError(null);
      await onUpdateRecurringTimes([...recurringTimes, time].sort());
    }
  };

  const handleAddCustomTime = async () => {
    if (!/^\d{2}:\d{2}$/.test(customTimeInput)) return;
    if (recurringTimes.includes(customTimeInput)) return;
    setLocalError(null);
    await onUpdateRecurringTimes([...recurringTimes, customTimeInput].sort());
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    if (recurringTimes.length === 0) {
      setLocalError('Select at least one recurring daily posting time.');
      return;
    }

    if (topicMode === 'theme' && !themeInput.trim()) {
      setLocalError('Enter a monthly topic theme (e.g., "SQL & Backend Engineering").');
      return;
    }

    if (topicMode === 'custom_list' && parsedCustomTopics.length === 0) {
      setLocalError('Enter at least one topic line for the monthly schedule.');
      return;
    }

    if (computedSlots.length === 0) {
      setLocalError('No valid time slots generated.');
      return;
    }

    await onGenerateMonthly({
      themeOrTopic: themeInput.trim(),
      topicMode,
      customTopics: parsedCustomTopics,
      slots: computedSlots,
    });
  };

  const activeError = localError || errorMessage;

  return (
    <section
      id="planner-section"
      className="bg-white border border-[#E4E6EB] rounded-xl p-4 sm:p-6"
      aria-labelledby="planner-heading"
    >
      <div className="mb-4 pb-4 border-b border-[#E4E6EB]">
        <h2
          id="planner-heading"
          className="font-display text-base sm:text-lg font-bold text-[#1C1E21]"
        >
          Monthly Topic &amp; Time-Slot Planner
        </h2>
        <p className="mt-1 text-xs text-[#65676B]">
          Configure recurring daily times and schedule a full month in PostgreSQL.
        </p>
      </div>

      {/* Recurring Daily Time Slots Configuration */}
      <div className="pb-5 mb-5 border-b border-[#E4E6EB] space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[#1C1E21]">
            <Clock className="w-3.5 h-3.5 text-[#1877F2]" />
            <span>Recurring Daily Post Times</span>
          </div>
          <span className="text-[11px] font-mono tabular-nums text-[#65676B]">
            {recurringTimes.length} slot{recurringTimes.length === 1 ? '' : 's'}/day
          </span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {recurringTimes.map((time) => (
            <span
              key={time}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono tabular-nums font-semibold text-[#1877F2] bg-[#E7F3FF] rounded-lg"
            >
              <span>{formatTime12h(time)}</span>
              {recurringTimes.length > 1 && (
                <button
                  type="button"
                  onClick={() => void handleToggleTime(time)}
                  aria-label={`Remove ${formatTime12h(time)}`}
                  className="text-[#1877F2]/80 hover:text-[#1877F2] cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-[#65676B] mr-1">Quick slots:</span>
          {PRESET_TIMES.map((preset) => {
            const active = recurringTimes.includes(preset);
            return (
              <button
                key={preset}
                type="button"
                onClick={() => void handleToggleTime(preset)}
                className={`px-2 py-1 text-[11px] font-mono tabular-nums rounded-md border transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#1C1E21] text-white border-[#1C1E21]'
                    : 'bg-white text-[#65676B] border-[#CCD0D5] hover:border-[#8D949E]'
                }`}
              >
                {formatTime12h(preset)}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <input
            type="time"
            value={customTimeInput}
            onChange={(e) => setCustomTimeInput(e.target.value)}
            aria-label="Custom daily post time"
            className="px-2.5 py-1.5 text-xs font-mono tabular-nums bg-white border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
          />
          <button
            type="button"
            onClick={() => void handleAddCustomTime()}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[#1C1E21] bg-[#E4E6EB] hover:bg-[#D8DADF] rounded-lg cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Time</span>
          </button>

          {pendingCount > 0 && (
            <button
              type="button"
              disabled={isApplyingSlots}
              onClick={() => void onApplySlotsToPending()}
              className="ml-auto inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-[#1877F2] bg-[#E7F3FF] hover:bg-[#DCEBFF] rounded-lg cursor-pointer whitespace-nowrap"
            >
              {isApplyingSlots ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
              <span>Apply to {pendingCount} Pending</span>
            </button>
          )}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Month & Range Controls */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="target-month"
              className="block text-xs font-medium text-[#1C1E21] mb-1"
            >
              Target Month
            </label>
            <div className="relative">
              <Calendar className="w-3.5 h-3.5 text-[#65676B] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="target-month"
                type="month"
                value={monthKey}
                onChange={(e) => setMonthKey(e.target.value)}
                disabled={isGenerating}
                className="w-full pl-8 pr-2.5 py-2 text-xs font-mono tabular-nums text-[#1C1E21] bg-white border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="start-day"
              className="block text-xs font-medium text-[#1C1E21] mb-1"
            >
              Start Day of Month
            </label>
            <input
              id="start-day"
              type="number"
              min={1}
              max={daysInSelectedMonth}
              value={startDay}
              onChange={(e) =>
                setStartDay(Math.max(1, Math.min(Number(e.target.value) || 1, daysInSelectedMonth)))
              }
              disabled={isGenerating}
              className="w-full px-3 py-2 text-xs font-mono tabular-nums text-[#1C1E21] bg-white border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
            />
          </div>
        </div>

        {/* Topic Input Mode */}
        <div>
          <div className="flex items-center gap-1 p-1 bg-[#F0F2F5] rounded-lg mb-3">
            <button
              type="button"
              onClick={() => setTopicMode('theme')}
              className={`flex-1 py-1.5 px-2.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                topicMode === 'theme'
                  ? 'bg-white text-[#1877F2] font-semibold shadow-xs'
                  : 'text-[#65676B] hover:text-[#1C1E21]'
              }`}
            >
              Theme Pillar (AI)
            </button>
            <button
              type="button"
              onClick={() => setTopicMode('custom_list')}
              className={`flex-1 py-1.5 px-2.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                topicMode === 'custom_list'
                  ? 'bg-white text-[#1877F2] font-semibold shadow-xs'
                  : 'text-[#65676B] hover:text-[#1C1E21]'
              }`}
            >
              Custom Topic List
            </button>
          </div>

          {topicMode === 'theme' ? (
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="month-theme-input"
                  className="block text-xs font-medium text-[#1C1E21] mb-1"
                >
                  Monthly Content Pillar / Topic Theme
                </label>
                <input
                  id="month-theme-input"
                  type="text"
                  value={themeInput}
                  onChange={(e) => {
                    setThemeInput(e.target.value);
                    setLocalError(null);
                  }}
                  placeholder="e.g., SQL & PostgreSQL Mastery"
                  disabled={isGenerating}
                  className="w-full px-3 py-2 text-sm text-[#1C1E21] bg-white border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label
                    htmlFor="days-count"
                    className="text-xs font-medium text-[#1C1E21]"
                  >
                    Days to Schedule
                  </label>
                  <div className="flex items-center gap-2 text-[11px]">
                    {[
                      { label: '5d', value: 5 },
                      { label: '15d', value: 15 },
                      {
                        label: 'Rest of Month',
                        value: Math.max(1, daysInSelectedMonth - startDay + 1),
                      },
                    ].map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => setDaysCount(preset.value)}
                        className="text-[#1877F2] font-medium hover:underline cursor-pointer"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
                <input
                  id="days-count"
                  type="number"
                  min={1}
                  max={31}
                  value={daysCount}
                  onChange={(e) =>
                    setDaysCount(Math.max(1, Math.min(Number(e.target.value) || 1, 31)))
                  }
                  disabled={isGenerating}
                  className="w-full px-3 py-2 text-xs font-mono tabular-nums text-[#1C1E21] bg-white border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
                />
              </div>
            </div>
          ) : (
            <div>
              <label
                htmlFor="custom-topics-textarea"
                className="block text-xs font-medium text-[#1C1E21] mb-1"
              >
                Monthly Topics (one topic per line)
              </label>
              <textarea
                id="custom-topics-textarea"
                rows={5}
                value={customTopicsText}
                onChange={(e) => {
                  setCustomTopicsText(e.target.value);
                  setLocalError(null);
                }}
                placeholder={`SQL Window Functions\nPostgreSQL Partial Indexes\nFastAPI Dependency Injection\nDocker Multi-Stage Caching\nRedis Pub/Sub Architecture`}
                disabled={isGenerating}
                className="w-full px-3 py-2 text-xs text-[#1C1E21] bg-white border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2] leading-relaxed"
              />
              <p className="mt-1 text-[11px] text-[#65676B] font-mono tabular-nums">
                {parsedCustomTopics.length} topic{parsedCustomTopics.length === 1 ? '' : 's'} queued across recurring slots
              </p>
            </div>
          )}
        </div>

        {/* Summary Readout */}
        <div className="py-2.5 border-y border-[#E4E6EB] text-xs text-[#1C1E21] space-y-1">
          <div className="flex items-center justify-between font-medium">
            <span className="text-[#65676B]">Scheduled Output</span>
            <span className="font-mono tabular-nums font-semibold">
              {computedSlots.length} posts
            </span>
          </div>
          {computedSlots.length > 0 && (
            <div className="text-[11px] text-[#65676B] font-mono tabular-nums">
              {computedSlots[0].dateLabel} ({formatTime12h(computedSlots[0].slotTime)}) →{' '}
              {computedSlots[computedSlots.length - 1].dateLabel} (
              {formatTime12h(computedSlots[computedSlots.length - 1].slotTime)})
            </div>
          )}
        </div>

        {activeError && (
          <div
            role="alert"
            className="flex items-start gap-2 p-3 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg"
          >
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <span>{activeError}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={isGenerating || isSeedingMl || computedSlots.length === 0}
          className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-[#1877F2] hover:bg-[#166FE5] disabled:opacity-60 rounded-lg transition-colors flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer min-h-[42px]"
        >
          {isGenerating ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Generating {computedSlots.length} Monthly Posts...</span>
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              <span>Generate &amp; Save {computedSlots.length} Posts</span>
            </>
          )}
        </button>

        <div className="pt-4 border-t border-[#E4E6EB]">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-xs font-semibold text-[#1C1E21]">
              Curated 30-Day Pack (Manual)
            </span>
            <span className="text-[11px] font-mono tabular-nums text-[#65676B]">
              90 posts · 3/day
            </span>
          </div>
          <p className="text-[11px] text-[#65676B] mb-2.5 leading-relaxed">
            Beginner to Advanced Machine Learning topics, SEO titles, body copy &amp; tags at 09:00 AM, 03:00 PM &amp; 06:00 PM starting {monthKey}-{String(Math.max(1, Math.min(startDay, daysInSelectedMonth))).padStart(2, '0')}.
          </p>
          <button
            type="button"
            disabled={isGenerating || isSeedingMl}
            onClick={() => {
              const clampedDay = Math.max(1, Math.min(startDay, daysInSelectedMonth));
              const startDate = `${monthKey}-${String(clampedDay).padStart(2, '0')}`;
              void onSeedMlMonth(startDate);
            }}
            className="w-full py-2 px-3 text-xs font-semibold text-[#1C1E21] bg-[#E4E6EB] hover:bg-[#D8DADF] disabled:opacity-60 rounded-lg transition-colors flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer min-h-[40px]"
          >
            {isSeedingMl ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1877F2]" />
                <span>Scheduling 90 ML Posts...</span>
              </>
            ) : (
              <>
                <BookOpen className="w-3.5 h-3.5 text-[#1877F2]" />
                <span>Load 30-Day ML Curriculum (90 Posts)</span>
              </>
            )}
          </button>
        </div>
      </form>
    </section>
  );
};
