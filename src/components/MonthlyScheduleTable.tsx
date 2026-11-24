import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Edit3,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
  X,
  XCircle,
  Check,
  Table2,
} from 'lucide-react';
import type { QueueFilter, ScheduledPost } from '../types';
import {
  formatDateOnly,
  formatDateTimeDisplay,
  formatFacebookMessage,
  formatMonthLabel,
  formatTime12h,
  getCurrentMonthKey,
  isoToLocalDateTimeInput,
  localDateTimeInputToIso,
} from '../utils/schedule';

interface MonthlyScheduleTableProps {
  posts: ScheduledPost[];
  recurringTimes: string[];
  publishingIds: Set<string>;
  regeneratingIds: Set<string>;
  dryRunMode: boolean;
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

const STATUS_BADGE = {
  PENDING: {
    label: 'PENDING',
    className: 'bg-amber-50 text-amber-800 border-amber-200',
    Icon: Clock,
  },
  POSTED: {
    label: 'POSTED',
    className: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    Icon: CheckCircle2,
  },
  FAILED: {
    label: 'FAILED',
    className: 'bg-red-50 text-red-800 border-red-200',
    Icon: XCircle,
  },
} as const;

export const MonthlyScheduleTable: React.FC<MonthlyScheduleTableProps> = ({
  posts,
  recurringTimes,
  publishingIds,
  regeneratingIds,
  dryRunMode,
  onAddManualPost,
  onUpdatePost,
  onPublishNow,
  onRegeneratePart,
  onDeletePost,
}) => {
  const [selectedMonth, setSelectedMonth] = useState<string>('ALL');
  const [activeTab, setActiveTab] = useState<QueueFilter>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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
  const [newTags, setNewTags] = useState('#Tech #Tutorial');
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

  return (
    <section
      id="table-section"
      className="bg-white border border-slate-200 rounded-xl overflow-hidden"
      aria-labelledby="table-heading"
    >
      {/* Header & Controls */}
      <div className="p-4 sm:p-5 border-b border-slate-200 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1
              id="table-heading"
              className="font-display text-lg font-bold text-slate-900"
            >
              Whole-Month Publishing Schedule Table
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              PostgreSQL-backed schedule synced in real time via WebSocket. Server publishes automatically at each slot time.
            </p>
          </div>

          <button
            type="button"
            onClick={() => setIsAddOpen(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Post Row</span>
          </button>
        </div>

        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
          <div
            role="tablist"
            aria-label="Filter schedule table by status"
            className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg"
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
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}{' '}
                <span className="font-mono tabular-nums text-slate-400 ml-1">
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
              className="px-2.5 py-1.5 text-xs text-slate-800 bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
            >
              <option value="ALL">All Months ({posts.length})</option>
              {availableMonths.map((mk) => (
                <option key={mk} value={mk}>
                  {formatMonthLabel(mk)}
                </option>
              ))}
            </select>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search topic, title, FB ID..."
                aria-label="Search schedule table"
                className="w-full sm:w-52 pl-8 pr-3 py-1.5 text-xs text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Data Table */}
      {filteredPosts.length === 0 ? (
        <div className="p-12 text-center">
          <div className="mx-auto w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500 mb-3">
            <Table2 className="w-5 h-5" />
          </div>
          <h3 className="font-display text-base font-bold text-slate-900">
            {posts.length === 0
              ? 'No monthly posts scheduled yet'
              : 'No rows match your current filter'}
          </h3>
          <p className="mt-1 text-xs text-slate-500 max-w-md mx-auto">
            {posts.length === 0
              ? 'Use the Monthly Topic & Time-Slot Planner on the left to generate a whole month of recurring posts, or click Add Post Row above.'
              : 'Reset filters or switch months to view other scheduled entries.'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-600 uppercase tracking-wider">
                <th className="py-3 px-4 whitespace-nowrap">Schedule &amp; Slot</th>
                <th className="py-3 px-4 whitespace-nowrap">Topic</th>
                <th className="py-3 px-4">SEO Headline &amp; Post Preview</th>
                <th className="py-3 px-4 whitespace-nowrap">Status</th>
                <th className="py-3 px-4 whitespace-nowrap">Published At &amp; FB ID</th>
                <th className="py-3 px-4 text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {filteredPosts.map((post) => {
                const statusMeta = STATUS_BADGE[post.status];
                const StatusIcon = statusMeta.Icon;
                const isPublishing = publishingIds.has(post.id);
                const isRegenerating = regeneratingIds.has(post.id);

                return (
                  <tr
                    key={post.id}
                    className="hover:bg-slate-50/70 transition-colors align-top"
                  >
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <div className="font-mono tabular-nums font-medium text-slate-900">
                        {formatDateOnly(post.scheduledAt)}
                      </div>
                      <div className="mt-0.5 font-mono tabular-nums text-blue-700 font-semibold">
                        {formatTime12h(post.slotTime)}
                      </div>
                    </td>

                    <td className="py-3.5 px-4 max-w-[180px]">
                      <div className="font-semibold text-slate-900 line-clamp-2">
                        {post.topicName}
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500 truncate">
                        {post.stageLabel}
                      </div>
                    </td>

                    <td className="py-3.5 px-4 min-w-[260px] max-w-[380px]">
                      <button
                        type="button"
                        onClick={() => openEditor(post)}
                        className="text-left group cursor-pointer"
                      >
                        <div className="font-semibold text-slate-900 group-hover:text-blue-700 transition-colors line-clamp-1">
                          {post.seoTitle}
                        </div>
                        <p className="mt-0.5 text-slate-600 line-clamp-2 leading-relaxed">
                          {post.seoDescription}
                        </p>
                      </button>
                      {post.seoTags.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[11px] text-blue-700">
                          {post.seoTags.map((t) => (
                            <span key={t}>{t}</span>
                          ))}
                        </div>
                      )}
                      {post.status === 'FAILED' && post.errorMessage && (
                        <div className="mt-1.5 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
                          {post.errorMessage}
                        </div>
                      )}
                    </td>

                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded-full border ${statusMeta.className}`}
                      >
                        <StatusIcon className="w-3 h-3" />
                        <span>{statusMeta.label}</span>
                      </span>
                    </td>

                    <td className="py-3.5 px-4 whitespace-nowrap">
                      {post.status === 'POSTED' && post.publishedAt ? (
                        <div>
                          <div className="font-mono tabular-nums text-slate-800">
                            {formatDateTimeDisplay(post.publishedAt)}
                          </div>
                          {post.fbPostId && (
                            <div className="mt-0.5 font-mono tabular-nums text-[11px] text-emerald-700">
                              {post.fbPostId}
                              {post.isSimulated && (
                                <span className="ml-1 font-sans text-amber-700">
                                  (Sim)
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="font-mono text-slate-400">—</span>
                      )}
                    </td>

                    <td className="py-3.5 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          disabled={isPublishing || isRegenerating}
                          onClick={() => void onPublishNow(post.id)}
                          title={dryRunMode ? 'Simulate Publish Now' : 'Publish Now'}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:bg-blue-400 rounded-md cursor-pointer"
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
                          title="Edit post"
                          className="p-1.5 text-slate-600 hover:text-slate-900 bg-white border border-slate-200 hover:bg-slate-100 rounded-md cursor-pointer"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>

                        <button
                          type="button"
                          disabled={isPublishing || isRegenerating}
                          onClick={() => void onRegeneratePart(post.id)}
                          title="Regenerate with Gemini"
                          className="p-1.5 text-slate-600 hover:text-blue-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-md cursor-pointer"
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
                              className="px-1.5 py-1 text-[11px] text-slate-500 hover:text-slate-800 cursor-pointer"
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
                            className="p-1.5 text-slate-400 hover:text-red-700 bg-white border border-slate-200 hover:bg-red-50 rounded-md cursor-pointer"
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
      )}

      {/* Edit / Inspect Modal */}
      {editingPost && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-[2px] p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-2xl bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <div>
                <h3 className="font-display text-base font-bold text-slate-900">
                  Edit Scheduled Post
                </h3>
                <p className="text-xs text-slate-500">
                  Changes sync immediately to PostgreSQL and connected sessions.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingPost(null)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form
              onSubmit={handleSaveEditor}
              className="p-6 space-y-4 overflow-y-auto"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Topic Name
                  </label>
                  <input
                    type="text"
                    required
                    value={editTopic}
                    onChange={(e) => setEditTopic(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Scheduled Date &amp; Time
                  </label>
                  <input
                    type="datetime-local"
                    required
                    value={editDateTimeLocal}
                    onChange={(e) => setEditDateTimeLocal(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono tabular-nums border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Stage Label
                  </label>
                  <input
                    type="text"
                    value={editStage}
                    onChange={(e) => setEditStage(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    SEO Tags
                  </label>
                  <input
                    type="text"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-slate-700">
                    SEO Title
                  </label>
                  <span
                    className={`text-xs font-mono tabular-nums ${
                      editTitle.length > 70 ? 'text-red-600' : 'text-slate-400'
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
                  className="w-full px-3 py-2 text-sm font-medium border border-slate-300 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  SEO Description (Facebook Feed Message)
                </label>
                <textarea
                  rows={6}
                  required
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg leading-relaxed"
                />
              </div>

              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                <div className="text-[11px] font-mono text-slate-500 mb-1">
                  Facebook Payload Preview
                </div>
                <pre className="whitespace-pre-wrap font-sans text-xs text-slate-700 max-h-32 overflow-y-auto">
                  {formatFacebookMessage({
                    seoTitle: editTitle,
                    seoDescription: editBody,
                    seoTags: editTags.split(/[\s,]+/).filter(Boolean),
                  })}
                </pre>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                {editingPost.status === 'FAILED' ? (
                  <button
                    type="button"
                    onClick={async () => {
                      await onUpdatePost(editingPost.id, { status: 'PENDING' });
                      setEditingPost(null);
                    }}
                    className="px-3 py-1.5 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 hover:bg-amber-100 rounded-lg cursor-pointer"
                  >
                    Reset Status to PENDING
                  </button>
                ) : (
                  <div />
                )}

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingPost(null)}
                    className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSavingEdit}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer"
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-[2px] p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-lg bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <h3 className="font-display text-base font-bold text-slate-900">
                Add Custom Scheduled Post
              </h3>
              <button
                type="button"
                onClick={() => setIsAddOpen(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateManual} className="p-6 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Topic Name
                  </label>
                  <input
                    type="text"
                    required
                    value={newTopic}
                    onChange={(e) => setNewTopic(e.target.value)}
                    placeholder="e.g., PostgreSQL Indexing"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Scheduled Date &amp; Time
                  </label>
                  <input
                    type="datetime-local"
                    required
                    value={newDateTimeLocal}
                    onChange={(e) => setNewDateTimeLocal(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono tabular-nums border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  SEO Title (under 70 chars)
                </label>
                <input
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Why B-Tree Indexes Make Queries 100x Faster"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Post Body
                </label>
                <textarea
                  rows={5}
                  required
                  value={newBody}
                  onChange={(e) => setNewBody(e.target.value)}
                  placeholder="Write your Facebook post body..."
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  SEO Hashtags
                </label>
                <input
                  type="text"
                  value={newTags}
                  onChange={(e) => setNewTags(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsAddOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isAdding}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer"
                >
                  {isAdding ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Plus className="w-3.5 h-3.5" />
                  )}
                  <span>Save to Schedule Table</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
};
