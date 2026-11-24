import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlaskConical,
  Loader2,
  LogOut,
  Play,
  Radio,
  SlidersHorizontal,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { TopBar } from './components/TopBar';
import { LoginScreen } from './components/LoginScreen';
import { MonthlyPlannerPanel } from './components/MonthlyPlannerPanel';
import { MonthlyScheduleTable } from './components/MonthlyScheduleTable';
import { ActivityConsole } from './components/ActivityConsole';
import { SettingsModal } from './components/SettingsModal';
import type {
  ActivityLogEntry,
  AuthStatus,
  PublisherSettings,
  ScheduledPost,
  SchedulerStatus,
} from './types';
import {
  buildMonthlySlots,
  recomputePendingSlots,
} from './utils/schedule';

const DEFAULT_SETTINGS: PublisherSettings = {
  facebookPageId: '',
  hasAccessToken: false,
  maskedAccessToken: '',
  autoPublishEnabled: true,
  dryRunMode: true,
  recurringTimes: ['09:00', '15:00', '18:00'],
};

export default function App() {
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(true);

  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [settings, setSettings] = useState<PublisherSettings>(DEFAULT_SETTINGS);
  const [logs, setLogs] = useState<ActivityLogEntry[]>([]);
  const [scheduler, setScheduler] = useState<SchedulerStatus>({
    intervalSeconds: 15,
    lastRunAt: null,
    nextRunAt: null,
  });

  const [socketConnected, setSocketConnected] = useState<boolean>(false);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [isApplyingSlots, setIsApplyingSlots] = useState<boolean>(false);
  const [generatorError, setGeneratorError] = useState<string | null>(null);
  const [publishingIds, setPublishingIds] = useState<Set<string>>(() => new Set());
  const [regeneratingIds, setRegeneratingIds] = useState<Set<string>>(() => new Set());
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  const fetchAuthStatus = useCallback(async (token?: string | null) => {
    setAuthLoading(true);
    try {
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const res = await fetch('/api/auth/status', {
        headers,
        credentials: 'include',
      });
      const data = (await res.json()) as AuthStatus;
      setAuthStatus(data);
      if (data.authenticated && data.token) {
        setAuthToken(data.token);
      }
    } catch {
      setAuthStatus({
        authenticated: false,
        email: null,
        allowedEmail: 'salekmasudparvez@gmail.com',
        setupRequired: false,
        dbConnected: false,
        dbError: 'Unable to reach backend server.',
      });
    } finally {
      setAuthLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAuthStatus(null);
  }, [fetchAuthStatus]);

  const apiFetch = useCallback(
    async <T,>(url: string, options: RequestInit = {}): Promise<T> => {
      if (!authToken) {
        throw new Error('Authentication required.');
      }
      const headers = new Headers(options.headers);
      headers.set('Authorization', `Bearer ${authToken}`);
      headers.set('X-Requested-With', 'XMLHttpRequest');
      if (options.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }

      const res = await fetch(url, {
        ...options,
        headers,
        credentials: 'include',
      });
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (res.status === 401) {
        setAuthToken(null);
        void fetchAuthStatus(null);
        throw new Error(data.error || 'Session expired. Please sign in again.');
      }
      if (!res.ok) {
        throw new Error(data.error || `Request failed (${res.status}).`);
      }
      return data;
    },
    [authToken, fetchAuthStatus]
  );

  const refreshWorkspaceViaRest = useCallback(async () => {
    if (!authToken) return;
    try {
      const [postsRes, settingsRes, logsRes] = await Promise.all([
        apiFetch<{ posts: ScheduledPost[] }>('/api/posts'),
        apiFetch<{ settings: PublisherSettings }>('/api/settings'),
        apiFetch<{ logs: ActivityLogEntry[] }>('/api/logs'),
      ]);
      setPosts(postsRes.posts || []);
      if (settingsRes.settings) setSettings(settingsRes.settings);
      setLogs(logsRes.logs || []);
    } catch {
      // Handled by apiFetch on 401
    }
  }, [authToken, apiFetch]);

  // Real-time WebSocket connection & REST initial load when authenticated
  useEffect(() => {
    if (!authToken) {
      setSocketConnected(false);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      return;
    }

    void refreshWorkspaceViaRest();
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth', token: authToken }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as {
            type: string;
            data?: unknown;
            error?: string;
          };

          switch (msg.type) {
            case 'init': {
              const payload = msg.data as {
                posts: ScheduledPost[];
                settings: PublisherSettings;
                logs: ActivityLogEntry[];
                scheduler: SchedulerStatus;
              };
              setSocketConnected(true);
              setPosts(payload.posts || []);
              if (payload.settings) setSettings(payload.settings);
              setLogs(payload.logs || []);
              if (payload.scheduler) setScheduler(payload.scheduler);
              break;
            }
            case 'post:created': {
              const created = msg.data as ScheduledPost;
              setPosts((prev) =>
                prev.some((p) => p.id === created.id) ? prev : [...prev, created]
              );
              break;
            }
            case 'posts:bulk_created': {
              const batch = msg.data as ScheduledPost[];
              setPosts((prev) => {
                const existingIds = new Set(prev.map((p) => p.id));
                const additions = batch.filter((p) => !existingIds.has(p.id));
                return [...prev, ...additions];
              });
              break;
            }
            case 'post:updated': {
              const updated = msg.data as ScheduledPost;
              setPosts((prev) =>
                prev.map((p) => (p.id === updated.id ? updated : p))
              );
              break;
            }
            case 'posts:bulk_updated': {
              const batch = msg.data as ScheduledPost[];
              const byId = new Map(batch.map((p) => [p.id, p]));
              setPosts((prev) => prev.map((p) => byId.get(p.id) ?? p));
              break;
            }
            case 'post:deleted': {
              const { id } = msg.data as { id: string };
              setPosts((prev) => prev.filter((p) => p.id !== id));
              break;
            }
            case 'settings:updated': {
              setSettings(msg.data as PublisherSettings);
              break;
            }
            case 'activity:logged': {
              const entry = msg.data as ActivityLogEntry;
              setLogs((prev) =>
                prev.some((l) => l.id === entry.id)
                  ? prev
                  : [entry, ...prev].slice(0, 150)
              );
              break;
            }
            case 'activity:cleared': {
              setLogs([]);
              break;
            }
            case 'scheduler:tick': {
              setScheduler(msg.data as SchedulerStatus);
              break;
            }
            case 'auth:error': {
              setAuthToken(null);
              break;
            }
          }
        } catch {
          // Ignore invalid socket JSON
        }
      };

      ws.onclose = () => {
        setSocketConnected(false);
        if (!cancelled) {
          reconnectTimerRef.current = window.setTimeout(connect, 2500);
        }
      };
    };

    connect();

    const pingInterval = window.setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20000);

    return () => {
      cancelled = true;
      window.clearInterval(pingInterval);
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [authToken, refreshWorkspaceViaRest]);

  const handleAuthenticated = (token: string, email: string) => {
    setAuthToken(token);
    setAuthStatus((prev) =>
      prev
        ? { ...prev, authenticated: true, email, setupRequired: false }
        : {
            authenticated: true,
            email,
            allowedEmail: email,
            setupRequired: false,
            dbConnected: true,
            dbError: null,
          }
    );
  };

  const handleSignOut = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
    } catch {
      // Ignore network errors during sign out
    }
    setAuthToken(null);
    setPosts([]);
    setLogs([]);
    setSocketConnected(false);
    void fetchAuthStatus(null);
  };

  const handleSaveSettings = async (payload: {
    facebookPageId?: string;
    facebookAccessToken?: string;
    clearAccessToken?: boolean;
    autoPublishEnabled?: boolean;
    dryRunMode?: boolean;
    recurringTimes?: string[];
  }) => {
    const res = await apiFetch<{ settings: PublisherSettings }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    setSettings(res.settings);
  };

  const handleApplySlotsToPending = async () => {
    const pendingPosts = posts.filter((p) => p.status === 'PENDING');
    if (pendingPosts.length === 0) return;
    setIsApplyingSlots(true);
    try {
      const updates = recomputePendingSlots(pendingPosts, settings.recurringTimes);
      const res = await apiFetch<{ posts: ScheduledPost[] }>(
        '/api/posts/apply-recurring-times',
        {
          method: 'POST',
          body: JSON.stringify({ updates }),
        }
      );
      if (res.posts?.length) {
        const byId = new Map(res.posts.map((p) => [p.id, p]));
        setPosts((prev) => prev.map((p) => byId.get(p.id) ?? p));
      }
      if (!socketConnected) void refreshWorkspaceViaRest();
    } finally {
      setIsApplyingSlots(false);
    }
  };

  const handleGenerateMonthly = async (params: {
    themeOrTopic: string;
    topicMode: 'theme' | 'custom_list';
    customTopics: string[];
    slots: ReturnType<typeof buildMonthlySlots>;
  }) => {
    setIsGenerating(true);
    setGeneratorError(null);
    try {
      const res = await apiFetch<{ posts: ScheduledPost[] }>('/api/gemini/generate-monthly', {
        method: 'POST',
        body: JSON.stringify(params),
      });
      if (res.posts?.length) {
        setPosts((prev) => {
          const existingIds = new Set(prev.map((p) => p.id));
          const additions = res.posts.filter((p) => !existingIds.has(p.id));
          return [...prev, ...additions];
        });
      }
      if (!socketConnected) void refreshWorkspaceViaRest();
    } catch (err: unknown) {
      setGeneratorError(
        err instanceof Error ? err.message : 'Failed to generate monthly schedule.'
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAddManualPost = async (payload: {
    topicName: string;
    stageLabel: string;
    seoTitle: string;
    seoDescription: string;
    seoTags: string[];
    slotTime: string;
    scheduledAt: string;
    monthKey: string;
  }) => {
    const res = await apiFetch<{ post: ScheduledPost }>('/api/posts', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (res.post) {
      setPosts((prev) =>
        prev.some((p) => p.id === res.post.id) ? prev : [...prev, res.post]
      );
    }
    if (!socketConnected) void refreshWorkspaceViaRest();
  };

  const handleUpdatePost = async (
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
  ) => {
    const res = await apiFetch<{ post: ScheduledPost }>(`/api/posts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
    if (res.post) {
      setPosts((prev) => prev.map((p) => (p.id === res.post.id ? res.post : p)));
    }
    if (!socketConnected) void refreshWorkspaceViaRest();
  };

  const handlePublishNow = async (id: string) => {
    setPublishingIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    try {
      const res = await apiFetch<{ post: ScheduledPost }>(
        `/api/posts/${encodeURIComponent(id)}/publish`,
        { method: 'POST' }
      );
      if (res.post) {
        setPosts((prev) => prev.map((p) => (p.id === res.post.id ? res.post : p)));
      }
    } catch {
      // Server persists FAILED status
    } finally {
      if (!socketConnected) void refreshWorkspaceViaRest();
      setPublishingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleRegeneratePart = async (id: string) => {
    setRegeneratingIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    try {
      const res = await apiFetch<{ post: ScheduledPost }>('/api/gemini/regenerate-part', {
        method: 'POST',
        body: JSON.stringify({ id }),
      });
      if (res.post) {
        setPosts((prev) => prev.map((p) => (p.id === res.post.id ? res.post : p)));
      }
      if (!socketConnected) void refreshWorkspaceViaRest();
    } finally {
      setRegeneratingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleDeletePost = async (id: string) => {
    await apiFetch<{ deletedId: string }>(`/api/posts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    setPosts((prev) => prev.filter((p) => p.id !== id));
    if (!socketConnected) void refreshWorkspaceViaRest();
  };

  const handleClearLogs = async () => {
    await apiFetch<{ ok: boolean }>('/api/logs', { method: 'DELETE' });
    setLogs([]);
  };

  const handleRunSchedulerNow = async () => {
    await apiFetch('/api/scheduler/run', { method: 'POST' });
    if (!socketConnected) void refreshWorkspaceViaRest();
  };

  const handleNavigate = (sectionId: string) => {
    const el = document.getElementById(sectionId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const counts = useMemo(() => {
    return {
      all: posts.length,
      pending: posts.filter((p) => p.status === 'PENDING').length,
      posted: posts.filter((p) => p.status === 'POSTED').length,
      failed: posts.filter((p) => p.status === 'FAILED').length,
    };
  }, [posts]);

  if (authLoading && !authStatus) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-600 gap-2">
        <Loader2 className="w-4 h-4 animate-spin text-blue-700" />
        <span>Checking workspace session...</span>
      </div>
    );
  }

  if (!authToken || !authStatus?.authenticated) {
    return (
      <LoginScreen
        authStatus={
          authStatus ?? {
            authenticated: false,
            email: null,
            allowedEmail: 'salekmasudparvez@gmail.com',
            setupRequired: false,
            dbConnected: false,
            dbError: null,
          }
        }
        onAuthenticated={handleAuthenticated}
        onRefreshStatus={() => fetchAuthStatus(null)}
      />
    );
  }

  return (
    <div id="top" className="min-h-screen bg-slate-50 text-slate-900">
      <TopBar
        onNavigate={handleNavigate}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      {/* Workspace Status & Controls Toolbar */}
      <div className="bg-white border-b border-slate-200">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-4 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6 sm:divide-x sm:divide-slate-200">
            <div className="sm:pr-4">
              <div className="text-xs text-slate-500">Monthly Rows</div>
              <div className="mt-0.5 font-display text-xl font-bold font-mono tabular-nums text-slate-900">
                {counts.all}
              </div>
            </div>
            <div className="sm:px-4">
              <div className="text-xs text-slate-500">Scheduled (Pending)</div>
              <div className="mt-0.5 font-display text-xl font-bold font-mono tabular-nums text-amber-700">
                {counts.pending}
              </div>
            </div>
            <div className="sm:px-4">
              <div className="text-xs text-slate-500">Published</div>
              <div className="mt-0.5 font-display text-xl font-bold font-mono tabular-nums text-emerald-700">
                {counts.posted}
              </div>
            </div>
            <div className="sm:pl-4">
              <div className="text-xs text-slate-500">Failed</div>
              <div className="mt-0.5 font-display text-xl font-bold font-mono tabular-nums text-red-700">
                {counts.failed}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Real Live WebSocket Connection Status */}
            <div
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border whitespace-nowrap ${
                socketConnected
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-amber-50 border-amber-200 text-amber-800'
              }`}
            >
              {socketConnected ? (
                <Wifi className="w-3.5 h-3.5" />
              ) : (
                <WifiOff className="w-3.5 h-3.5" />
              )}
              <span>
                {socketConnected ? 'Socket Live' : 'Reconnecting...'}
              </span>
            </div>

            <button
              type="button"
              onClick={() =>
                void handleSaveSettings({ dryRunMode: !settings.dryRunMode })
              }
              aria-pressed={settings.dryRunMode}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap cursor-pointer ${
                settings.dryRunMode
                  ? 'bg-amber-50 border-amber-300 text-amber-900'
                  : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <FlaskConical className="w-3.5 h-3.5" />
              <span>
                Dry Run: {settings.dryRunMode ? 'ON' : 'OFF (Live)'}
              </span>
            </button>

            <button
              type="button"
              onClick={() =>
                void handleSaveSettings({
                  autoPublishEnabled: !settings.autoPublishEnabled,
                })
              }
              aria-pressed={settings.autoPublishEnabled}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap cursor-pointer ${
                settings.autoPublishEnabled
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                  : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Radio className="w-3.5 h-3.5" />
              <span className="font-mono tabular-nums">
                {settings.autoPublishEnabled
                  ? `BG Scheduler ON (${scheduler.intervalSeconds}s)`
                  : 'BG Scheduler OFF'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => void handleRunSchedulerNow()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-lg whitespace-nowrap cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Run Check</span>
            </button>

            <button
              type="button"
              onClick={() => setIsSettingsOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-300 rounded-lg whitespace-nowrap cursor-pointer"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>Settings</span>
            </button>

            <button
              type="button"
              onClick={handleSignOut}
              title={`Signed in as ${authStatus.email}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-red-700 bg-white hover:bg-red-50 border border-slate-200 rounded-lg whitespace-nowrap cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Studio Grid */}
      <main className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 xl:col-span-4 space-y-6">
            <MonthlyPlannerPanel
              recurringTimes={settings.recurringTimes}
              pendingCount={counts.pending}
              isGenerating={isGenerating}
              isApplyingSlots={isApplyingSlots}
              errorMessage={generatorError}
              onUpdateRecurringTimes={(times) =>
                handleSaveSettings({ recurringTimes: times })
              }
              onApplySlotsToPending={handleApplySlotsToPending}
              onGenerateMonthly={handleGenerateMonthly}
            />

            <ActivityConsole
              logs={logs}
              onClearLogs={() => void handleClearLogs()}
            />
          </div>

          <div className="lg:col-span-7 xl:col-span-8">
            <MonthlyScheduleTable
              posts={posts}
              recurringTimes={settings.recurringTimes}
              publishingIds={publishingIds}
              regeneratingIds={regeneratingIds}
              dryRunMode={settings.dryRunMode}
              onAddManualPost={handleAddManualPost}
              onUpdatePost={handleUpdatePost}
              onPublishNow={handlePublishNow}
              onRegeneratePart={handleRegeneratePart}
              onDeletePost={handleDeletePost}
            />
          </div>
        </div>
      </main>

      <SettingsModal
        isOpen={isSettingsOpen}
        settings={settings}
        onClose={() => setIsSettingsOpen(false)}
        onSave={handleSaveSettings}
      />
    </div>
  );
}
