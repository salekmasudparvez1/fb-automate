import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Clock,
  Edit3,
  ExternalLink,
  FlaskConical,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Table2,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import type { QueueFilter, ScheduledPost } from '../types';
import {
  formatDateOnly,
  formatDateTimeDisplay,
  formatMonthLabel,
  formatTime12h,
  getCurrentMonthKey,
  isoToLocalDateTimeInput,
  localDateTimeInputToIso,
} from '../utils/schedule';
import { FacebookFeedPreview } from './FacebookFeedPreview';

interface MonthlyScheduleTableProps {
  posts: ScheduledPost[];
  recurringTimes: string[];
  publishingIds: Set<string>;
  regeneratingIds: Set<string>;
  dryRunMode: boolean;
  pageName?: string;
  initialFilter?: QueueFilter;
  externalAddTrigger?: number;
  onAddManualPost: (payload: {
    topicName: string;
    stageLabel: string;
    seoTitle: string;
    seoDescription: string;
    seoTags: string[];
    slotTime: string;
    scheduledAt: string;
    monthKey: string;
  }) => Promise<void>;
  onUpdatePost: (
    id: string,
    updates: {
      topicName?: string;
      stageLabel?: string;
      seoTitle?: string;
      seoDescription?: string;
      seoTags?: string[];
      slotTime?: string;
      scheduledAt?: string;
      monthKey?: string;
      status?: 'PENDING';
    }
  ) => Promise<void>;
  onPublishNow: (id: string) => Promise<void>;
  onRegeneratePart: (id: string) => Promise<void>;
  onDeletePost: (id: string) => Promise<void>;
}

const STATUS_META = {
  PENDING: {
    label: 'Pending',
    className: 'text-[#1877F2]',
    Icon: Clock,
  },
  POSTED: {
    label: 'Published',
    className: 'text-emerald-700',
    Icon: CheckCircle2,
  },
  FAILED: {
    label: 'Failed',
    className: 'text-red-700',
    Icon: XCircle,
  },
} as const;

export const MonthlyScheduleTable: React.FC<MonthlyScheduleTableProps> = ({
  posts,
  recurringTimes,
  publishingIds,
  regeneratingIds,
  dryRunMode,
  pageName = 'Parvez Dev',
  initialFilter = 'ALL',
  externalAddTrigger = 0,
  onAddManualPost,
  onUpdatePost,
  onPublishNow,
  onRegeneratePart,
  onDeletePost,
}) => {
  const [selectedMonth, setSelectedMonth] = useState<string>('ALL');
  const [activeTab, setActiveTab] = useState<QueueFilter>(initialFilter);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    setActiveTab(initialFilter);
  }, [initialFilter]);

  useEffect(() => {
    if (externalAddTrigger > 0) {
      setIsAddOpen(true);
    }
  }, [externalAddTrigger]);

  // Edit/Inspect modal state
  const [editingPost, setEditingPost] = useState<ScheduledPost | null>(null);
  const [editTopic, setEditTopic] = useState('');
  const [editStage, setEditStage] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editDateTimeLocal, setEditDateTimeLocal] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Add Manual Post modal state
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newTopic, setNewTopic] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newTags, setNewTags] = useState('#MachineLearning #AI #Tech');
  const [newDateTimeLocal, setNewDateTimeLocal] = useState(() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const slot = recurringTimes[0] || '09:00';
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${slot}`;
  });
  const [isAdding, setIsAdding] = useState(false);

  const availableMonths = useMemo(() => {
    const set = new Set<string>(posts.map((p) => p.monthKey));
    return Array.from(set).sort();
  }, [posts]);

  const monthScopedPosts = useMemo(() => {
    if (selectedMonth === 'ALL') return posts;
    return posts.filter((p) => p.monthKey === selectedMonth);
  }, [posts, selectedMonth]);

  const counts = useMemo(() => {
    return {
      all: monthScopedPosts.length,
      pending: monthScopedPosts.filter((p) => p.status === 'PENDING').length,
      posted: monthScopedPosts.filter((p) => p.status === 'POSTED').length,
      failed: monthScopedPosts.filter((p) => p.status === 'FAILED').length,
    };
  }, [monthScopedPosts]);

  const filteredPosts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return monthScopedPosts
      .filter((p) => {
        if (activeTab !== 'ALL' && p.status !== activeTab) return false;
        if (q) {
          const hay = `${p.topicName} ${p.stageLabel} ${p.seoTitle} ${p.seoDescription} ${p.seoTags.join(' ')} ${p.fbPostId ?? ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort(
        (a, b) =>
          new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
      );
  }, [monthScopedPosts, activeTab, searchQuery]);

  const openEditor = (post: ScheduledPost) => {
    setEditingPost(post);
    setEditTopic(post.topicName);
    setEditStage(post.stageLabel);
    setEditTitle(post.seoTitle);
    setEditBody(post.seoDescription);
    setEditTags(post.seoTags.join(' '));
    setEditDateTimeLocal(isoToLocalDateTimeInput(post.scheduledAt));
  };

  const handleSaveEditor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPost) return;
    setIsSavingEdit(true);
    try {
      const iso = localDateTimeInputToIso(editDateTimeLocal);
      const dt = new Date(iso);
      const pad = (n: number) => String(n).padStart(2, '0');
      const monthKey = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`;
      const slotTime = `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
      const tags = editTags
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => (t.startsWith('#') ? t : `#${t.replace(/^#+/, '')}`));

      await onUpdatePost(editingPost.id, {
        topicName: editTopic.trim(),
        stageLabel: editStage.trim(),
        seoTitle: editTitle.trim(),
        seoDescription: editBody.trim(),
        seoTags: tags,
        scheduledAt: iso,
        slotTime,
        monthKey,
      });
      setEditingPost(null);
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleCreateManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTopic.trim() || !newTitle.trim() || !newBody.trim()) return;
    setIsAdding(true);
    try {
      const iso = localDateTimeInputToIso(newDateTimeLocal);
      const dt = new Date(iso);
      const pad = (n: number) => String(n).padStart(2, '0');
      const monthKey = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`;
      const slotTime = `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
      const tags = newTags
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => (t.startsWith('#') ? t : `#${t.replace(/^#+/, '')}`));

      await onAddManualPost({
        topicName: newTopic.trim(),
        stageLabel: `Slot ${formatTime12h(slotTime)}`,
        seoTitle: newTitle.trim(),
        seoDescription: newBody.trim(),
        seoTags: tags,
        slotTime,
        scheduledAt: iso,
        monthKey: monthKey || getCurrentMonthKey(),
      });
      setIsAddOpen(false);
      setNewTopic('');
      setNewTitle('');
      setNewBody('');
    } finally {
      setIsAdding(false);
    }
  };

  const renderStatusIndicator = (post: ScheduledPost) => {
    if (post.status === 'POSTED' && post.isSimulated) {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700">
          <FlaskConical className="w-3.5 h-3.5 shrink-0" />
          <span>Simulated</span>
        </span>
      );
    }
    const meta = STATUS_META[post.status];
    const StatusIcon = meta.Icon;
    return (
      <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${meta.className}`}>
        <StatusIcon className="w-3.5 h-3.5 shrink-0" />
        <span>{meta.label}</span>
      </span>
    );
  };

  return (
    <section
      id="table-section"
      className="bg-white border border-[#E4E6EB] rounded-xl overflow-hidden"
      aria-labelledby="table-heading"
    >
      {/* Header & Controls */}
      <div className="p-4 sm:p-5 border-b border-[#E4E6EB] space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2
              id="table-heading"
              className="font-display text-base sm:text-lg font-bold text-[#1C1E21]"
            >
              Publishing Queue &amp; Monthly Schedule
            </h2>
            <p className="text-xs text-[#65676B] mt-0.5">
              Synced with PostgreSQL. Posts publish automatically at each recurring slot time.
            </p>
          </div>

          <button
            type="button"
            onClick={() => setIsAddOpen(true)}
            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#1877F2] hover:bg-[#166FE5] rounded-lg whitespace-nowrap shrink-0 cursor-pointer min-h-[38px]"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Post Row</span>
          </button>
        </div>

        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
          <div
            role="tablist"
            aria-label="Filter schedule table by status"
            className="inline-flex flex-wrap items-center gap-1 p-1 bg-[#F0F2F5] rounded-lg"
          >
            {(
              [
                { id: 'ALL', label: 'All Posts', count: counts.all },
                { id: 'PENDING', label: 'Pending', count: counts.pending },
                { id: 'POSTED', label: 'Published', count: counts.posted },
                { id: 'FAILED', label: 'Failed', count: counts.failed },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === tab.id
                    ? 'bg-white text-[#1877F2] font-semibold shadow-xs'
                    : 'text-[#65676B] hover:text-[#1C1E21]'
                }`}
              >
                {tab.label}{' '}
                <span className="font-mono tabular-nums opacity-75 ml-1">
                  {tab.count}
                </span>
              </button>
            ))}
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <select
              aria-label="Filter by month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="px-3 py-2 text-xs text-[#1C1E21] bg-white border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
            >
              <option value="ALL">All Months ({posts.length})</option>
              {availableMonths.map((mk) => (
                <option key={mk} value={mk}>
                  {formatMonthLabel(mk)}
                </option>
              ))}
            </select>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#65676B] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search topic, title, FB ID..."
                aria-label="Search schedule table"
                className="w-full sm:w-56 pl-8 pr-3 py-2 text-xs text-[#1C1E21] bg-white border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Empty State */}
      {filteredPosts.length === 0 ? (
        <div className="p-10 sm:p-12 text-center">
          <div className="mx-auto w-11 h-11 rounded-full bg-[#F0F2F5] flex items-center justify-center text-[#65676B] mb-3">
            <Table2 className="w-5 h-5" />
          </div>
          <h3 className="font-display text-base font-bold text-[#1C1E21]">
            {posts.length === 0
              ? 'No monthly posts scheduled yet'
              : 'No rows match your current filter'}
          </h3>
          <p className="mt-1 text-xs text-[#65676B] max-w-md mx-auto">
            {posts.length === 0
              ? 'Use the Monthly Topic & Time-Slot Planner to generate a schedule, load the 30-Day ML Curriculum, or add a custom post.'
              : 'Reset status tabs or search filters to view other scheduled posts.'}
          </p>
        </div>
      ) : (
        <>
          {/* Mobile & Small Screen Responsive Card Feed */}
          <div className="md:hidden divide-y divide-[#E4E6EB]">
            {filteredPosts.map((post) => {
              const isPublishing = publishingIds.has(post.id);
              const isRegenerating = regeneratingIds.has(post.id);

              return (
                <div key={post.id} className="p-4 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-mono tabular-nums text-[#65676B]">
                      <span className="font-semibold text-[#1C1E21]">
                        {formatDateOnly(post.scheduledAt)}
                      </span>{' '}
                      <span aria-hidden="true">·</span>{' '}
                      <span className="text-[#1877F2] font-semibold">
                        {formatTime12h(post.slotTime)}
                      </span>
                    </div>
                    {renderStatusIndicator(post)}
                  </div>

                  <div>
                    <div className="text-xs text-[#65676B] truncate">
                      {post.topicName} <span aria-hidden="true">·</span> {post.stageLabel}
                    </div>
                    <button
                      type="button"
                      onClick={() => openEditor(post)}
                      className="mt-0.5 text-left font-display text-sm font-bold text-[#1C1E21] hover:text-[#1877F2] cursor-pointer"
                    >
                      {post.seoTitle}
                    </button>
                    <p className="mt-1 text-xs text-[#65676B] line-clamp-2 leading-relaxed">
                      {post.seoDescription}
                    </p>
                    {post.seoTags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[11px] text-[#1877F2]">
                        {post.seoTags.map((t) => (
                          <span key={t}>{t}</span>
                        ))}
                      </div>
                    )}
                  </div>

                  {post.status === 'FAILED' && post.errorMessage && (
                    <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">
                      {post.errorMessage}
                    </div>
                  )}

                  {post.status === 'POSTED' && post.publishedAt && (
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#65676B] pt-1">
                      <span className="font-mono tabular-nums">
                        {formatDateTimeDisplay(post.publishedAt)}
                      </span>
                      {post.isSimulated ? (
                        <button
                          type="button"
                          onClick={() =>
                            void onUpdatePost(post.id, { status: 'PENDING' })
                          }
                          className="inline-flex items-center gap-1 font-semibold text-[#1877F2] hover:underline cursor-pointer"
                        >
                          <RotateCcw className="w-3 h-3" />
                          <span>Re-queue for Live</span>
                        </button>
                      ) : (
                        post.fbPostId && (
                          <a
                            href={`https://www.facebook.com/${encodeURIComponent(post.fbPostId)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-emerald-700 hover:underline"
                          >
                            <span>View on FB</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )
                      )}
                    </div>
                  )}

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      disabled={isPublishing || isRegenerating}
                      onClick={() => void onPublishNow(post.id)}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-[#1877F2] hover:bg-[#166FE5] disabled:opacity-60 rounded-lg cursor-pointer min-h-[40px]"
                    >
                      {isPublishing ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Send className="w-3.5 h-3.5" />
                      )}
                      <span>{dryRunMode ? 'Simulate' : 'Publish Now'}</span>
                    </button>

                    <button
                      type="button"
                      disabled={isPublishing || isRegenerating}
                      onClick={() => openEditor(post)}
                      aria-label="Edit post"
                      className="p-2.5 text-[#1C1E21] bg-[#E4E6EB] hover:bg-[#D8DADF] rounded-lg cursor-pointer min-h-[40px] min-w-[40px] flex items-center justify-center"
                    >
                      <Edit3 className="w-4 h-4" />
                    </button>

                    <button
                      type="button"
                      disabled={isPublishing || isRegenerating}
                      onClick={() => void onRegeneratePart(post.id)}
                      aria-label="Regenerate with Gemini"
                      className="p-2.5 text-[#1C1E21] bg-[#E4E6EB] hover:bg-[#D8DADF] rounded-lg cursor-pointer min-h-[40px] min-w-[40px] flex items-center justify-center"
                    >
                      {isRegenerating ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                    </button>

                    {confirmDeleteId === post.id ? (
                      <button
                        type="button"
                        onClick={() => {
                          void onDeletePost(post.id);
                          setConfirmDeleteId(null);
                        }}
                        className="px-3 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer min-h-[40px]"
                      >
                        Confirm
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={isPublishing || isRegenerating}
                        onClick={() => setConfirmDeleteId(post.id)}
                        aria-label="Delete row"
                        className="p-2.5 text-[#65676B] hover:text-red-700 bg-[#F0F2F5] hover:bg-red-50 rounded-lg cursor-pointer min-h-[40px] min-w-[40px] flex items-center justify-center"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Desktop High-Density Table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#F7F8FA] border-b border-[#E4E6EB] text-[11px] font-semibold text-[#65676B] tracking-wide">
                  <th className="py-3 px-4 whitespace-nowrap">Schedule &amp; Slot</th>
                  <th className="py-3 px-4 whitespace-nowrap">Topic</th>
                  <th className="py-3 px-4">Headline &amp; Post Body</th>
                  <th className="py-3 px-4 whitespace-nowrap">Status</th>
                  <th className="py-3 px-4 whitespace-nowrap">Published At &amp; FB ID</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E4E6EB] text-xs">
                {filteredPosts.map((post) => {
                  const isPublishing = publishingIds.has(post.id);
                  const isRegenerating = regeneratingIds.has(post.id);

                  return (
                    <tr
                      key={post.id}
                      className="hover:bg-[#F7F8FA] transition-colors align-top"
                    >
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <div className="font-mono tabular-nums font-medium text-[#1C1E21]">
                          {formatDateOnly(post.scheduledAt)}
                        </div>
                        <div className="mt-0.5 font-mono tabular-nums text-[#1877F2] font-semibold">
                          {formatTime12h(post.slotTime)}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 max-w-[190px]">
                        <div className="font-semibold text-[#1C1E21] line-clamp-2">
                          {post.topicName}
                        </div>
                        <div className="mt-0.5 text-[11px] text-[#65676B] truncate">
                          {post.stageLabel}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 min-w-[260px] max-w-[400px]">
                        <button
                          type="button"
                          onClick={() => openEditor(post)}
                          className="text-left group cursor-pointer"
                        >
                          <div className="font-semibold text-[#1C1E21] group-hover:text-[#1877F2] transition-colors line-clamp-1">
                            {post.seoTitle}
                          </div>
                          <p className="mt-0.5 text-[#65676B] line-clamp-2 leading-relaxed">
                            {post.seoDescription}
                          </p>
                        </button>
                        {post.seoTags.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[11px] text-[#1877F2]">
                            {post.seoTags.map((t) => (
                              <span key={t}>{t}</span>
                            ))}
                          </div>
                        )}
                        {post.status === 'FAILED' && post.errorMessage && (
                          <div className="mt-1.5 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1">
                            {post.errorMessage}
                          </div>
                        )}
                      </td>

                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {renderStatusIndicator(post)}
                      </td>

                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {post.status === 'POSTED' && post.publishedAt ? (
                          <div>
                            <div className="font-mono tabular-nums text-[#1C1E21]">
                              {formatDateTimeDisplay(post.publishedAt)}
                            </div>
                            {post.isSimulated ? (
                              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-amber-700">
                                <span>Dry Run (not on FB)</span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void onUpdatePost(post.id, { status: 'PENDING' })
                                  }
                                  title="Reset back to PENDING so you can publish live to Facebook"
                                  className="inline-flex items-center gap-0.5 font-semibold text-[#1877F2] hover:underline cursor-pointer"
                                >
                                  <RotateCcw className="w-3 h-3" />
                                  <span>Re-queue</span>
                                </button>
                              </div>
                            ) : (
                              post.fbPostId && (
                                <a
                                  href={`https://www.facebook.com/${encodeURIComponent(post.fbPostId)}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-0.5 inline-flex items-center gap-1 font-mono tabular-nums text-[11px] text-emerald-700 hover:underline"
                                >
                                  <span>{post.fbPostId}</span>
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              )
                            )}
                          </div>
                        ) : (
                          <span className="font-mono text-[#BCC0C4]">—</span>
                        )}
                      </td>

                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            disabled={isPublishing || isRegenerating}
                            onClick={() => void onPublishNow(post.id)}
                            title={dryRunMode ? 'Simulate Publish Now' : 'Publish to Facebook'}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-white bg-[#1877F2] hover:bg-[#166FE5] disabled:opacity-60 rounded-md cursor-pointer"
                          >
                            {isPublishing ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Send className="w-3 h-3" />
                            )}
                            <span>{dryRunMode ? 'Sim' : 'Post'}</span>
                          </button>

                          <button
                            type="button"
                            disabled={isPublishing || isRegenerating}
                            onClick={() => openEditor(post)}
                            title="Edit post & preview"
                            className="p-1.5 text-[#65676B] hover:text-[#1C1E21] bg-white border border-[#CCD0D5] hover:bg-[#F0F2F5] rounded-md cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>

                          <button
                            type="button"
                            disabled={isPublishing || isRegenerating}
                            onClick={() => void onRegeneratePart(post.id)}
                            title="Regenerate with Gemini"
                            className="p-1.5 text-[#65676B] hover:text-[#1877F2] bg-white border border-[#CCD0D5] hover:bg-[#F0F2F5] rounded-md cursor-pointer"
                          >
                            {isRegenerating ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="w-3.5 h-3.5" />
                            )}
                          </button>

                          {confirmDeleteId === post.id ? (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => {
                                  void onDeletePost(post.id);
                                  setConfirmDeleteId(null);
                                }}
                                className="px-2 py-1 text-[11px] font-semibold text-white bg-red-600 hover:bg-red-700 rounded cursor-pointer"
                              >
                                Delete
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="px-1.5 py-1 text-[11px] text-[#65676B] hover:text-[#1C1E21] cursor-pointer"
                              >
                                No
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              disabled={isPublishing || isRegenerating}
                              onClick={() => setConfirmDeleteId(post.id)}
                              title="Delete row"
                              className="p-1.5 text-[#65676B] hover:text-red-700 bg-white border border-[#CCD0D5] hover:bg-red-50 rounded-md cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Edit & Live Facebook Feed Preview Modal */}
      {editingPost && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-[2px] p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-4xl bg-white border border-[#E4E6EB] rounded-2xl shadow-xl overflow-hidden max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-[#E4E6EB]">
              <div>
                <h3 className="font-display text-base font-bold text-[#1C1E21]">
                  Edit Scheduled Post &amp; Live FB Preview
                </h3>
                <p className="text-xs text-[#65676B]">
                  Updates save to PostgreSQL and sync across active sessions.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingPost(null)}
                className="p-1.5 text-[#65676B] hover:text-[#1C1E21] hover:bg-[#F0F2F5] rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form
              onSubmit={handleSaveEditor}
              className="p-5 sm:p-6 overflow-y-auto grid grid-cols-1 lg:grid-cols-12 gap-6"
            >
              <div className="lg:col-span-7 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-[#1C1E21] mb-1">
                      Topic Name
                    </label>
                    <input
                      type="text"
                      required
                      value={editTopic}
                      onChange={(e) => setEditTopic(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#1C1E21] mb-1">
                      Scheduled Date &amp; Time
                    </label>
                    <input
                      type="datetime-local"
                      required
                      value={editDateTimeLocal}
                      onChange={(e) => setEditDateTimeLocal(e.target.value)}
                      className="w-full px-3 py-2 text-xs font-mono tabular-nums border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-[#1C1E21] mb-1">
                      Stage Label
                    </label>
                    <input
                      type="text"
                      value={editStage}
                      onChange={(e) => setEditStage(e.target.value)}
                      className="w-full px-3 py-2 text-xs border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#1C1E21] mb-1">
                      SEO Tags
                    </label>
                    <input
                      type="text"
                      value={editTags}
                      onChange={(e) => setEditTags(e.target.value)}
                      className="w-full px-3 py-2 text-xs font-mono border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-[#1C1E21]">
                      SEO Title
                    </label>
                    <span
                      className={`text-xs font-mono tabular-nums ${
                        editTitle.length > 70 ? 'text-red-600' : 'text-[#65676B]'
                      }`}
                    >
                      {editTitle.length}/70 chars
                    </span>
                  </div>
                  <input
                    type="text"
                    required
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-medium border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#1C1E21] mb-1">
                    Post Body
                  </label>
                  <textarea
                    rows={7}
                    required
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-[#CCD0D5] rounded-lg leading-relaxed focus:outline-none focus:border-[#1877F2]"
                  />
                </div>
              </div>

              <div className="lg:col-span-5 space-y-3">
                <div className="text-xs font-semibold text-[#65676B]">
                  Live Facebook Page Preview
                </div>
                <div className="bg-[#F0F2F5] p-3 rounded-xl">
                  <FacebookFeedPreview
                    pageName={pageName}
                    post={{
                      id: editingPost.id,
                      topicName: editTopic,
                      stageLabel: editStage,
                      seoTitle: editTitle,
                      seoDescription: editBody,
                      seoTags: editTags.split(/[\s,]+/).filter(Boolean),
                      slotTime: editDateTimeLocal.split('T')[1] || editingPost.slotTime,
                      scheduledAt: localDateTimeInputToIso(editDateTimeLocal),
                      status: editingPost.status,
                      fbPostId: editingPost.fbPostId,
                      isSimulated: editingPost.isSimulated,
                    }}
                  />
                </div>
              </div>

              <div className="lg:col-span-12 flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-[#E4E6EB]">
                {editingPost.status !== 'PENDING' ? (
                  <button
                    type="button"
                    onClick={async () => {
                      await onUpdatePost(editingPost.id, { status: 'PENDING' });
                      setEditingPost(null);
                    }}
                    className="px-3 py-2 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 hover:bg-amber-100 rounded-lg cursor-pointer"
                  >
                    Reset Status to PENDING
                  </button>
                ) : (
                  <div />
                )}

                <div className="flex items-center gap-2 ml-auto">
                  <button
                    type="button"
                    onClick={() => setEditingPost(null)}
                    className="px-4 py-2 text-xs font-semibold text-[#1C1E21] bg-[#E4E6EB] hover:bg-[#D8DADF] rounded-lg cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSavingEdit}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#1877F2] hover:bg-[#166FE5] rounded-lg cursor-pointer"
                  >
                    {isSavingEdit ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Check className="w-3.5 h-3.5" />
                    )}
                    <span>Save Row</span>
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Manual Row Modal */}
      {isAddOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-[2px] p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-lg bg-white border border-[#E4E6EB] rounded-2xl shadow-xl overflow-hidden max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E4E6EB]">
              <h3 className="font-display text-base font-bold text-[#1C1E21]">
                Create Custom Scheduled Post
              </h3>
              <button
                type="button"
                onClick={() => setIsAddOpen(false)}
                className="p-1.5 text-[#65676B] hover:text-[#1C1E21] hover:bg-[#F0F2F5] rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateManual} className="p-6 space-y-4 overflow-y-auto">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[#1C1E21] mb-1">
                    Topic Name
                  </label>
                  <input
                    type="text"
                    required
                    value={newTopic}
                    onChange={(e) => setNewTopic(e.target.value)}
                    placeholder="e.g., Gradient Boosting"
                    className="w-full px-3 py-2 text-sm border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#1C1E21] mb-1">
                    Scheduled Date &amp; Time
                  </label>
                  <input
                    type="datetime-local"
                    required
                    value={newDateTimeLocal}
                    onChange={(e) => setNewDateTimeLocal(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono tabular-nums border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-[#1C1E21] mb-1">
                  SEO Title (under 70 chars)
                </label>
                <input
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Why Gradient Boosting Wins Tabular ML Benchmarks"
                  className="w-full px-3 py-2 text-sm border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[#1C1E21] mb-1">
                  Post Body
                </label>
                <textarea
                  rows={5}
                  required
                  value={newBody}
                  onChange={(e) => setNewBody(e.target.value)}
                  placeholder="Write your Facebook post body..."
                  className="w-full px-3 py-2 text-sm border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[#1C1E21] mb-1">
                  SEO Hashtags
                </label>
                <input
                  type="text"
                  value={newTags}
                  onChange={(e) => setNewTags(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-[#E4E6EB]">
                <button
                  type="button"
                  onClick={() => setIsAddOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-[#1C1E21] bg-[#E4E6EB] hover:bg-[#D8DADF] rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isAdding}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#1877F2] hover:bg-[#166FE5] rounded-lg cursor-pointer"
                >
                  {isAdding ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Plus className="w-3.5 h-3.5" />
                  )}
                  <span>Save to Schedule</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
};
