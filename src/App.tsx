import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Clock,
  FlaskConical,
  Loader2,
  Play,
  Radio,
  Send,
  SlidersHorizontal,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { SidebarNav, type DashboardView } from './components/SidebarNav';
import { TopBar } from './components/TopBar';
import { LoginScreen } from './components/LoginScreen';
import { MonthlyPlannerPanel } from './components/MonthlyPlannerPanel';
import { MonthlyScheduleTable } from './components/MonthlyScheduleTable';
import { ActivityConsole } from './components/ActivityConsole';
import { FacebookFeedPreview } from './components/FacebookFeedPreview';
import {
  SettingsModal,
  type FacebookVerifyResult,
} from './components/SettingsModal';
import { SecurityModal } from './components/SecurityModal';
import type {
  ActivityLogEntry,
  AuthStatus,
  PublisherSettings,
  QueueFilter,
  ScheduledPost,
  SchedulerStatus,
} from './types';
import {
  buildMonthlySlots,
  formatDateOnly,
  formatTime12h,
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

  const [activeView, setActiveView] = useState<DashboardView>('overview');
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState<boolean>(false);
  const [tableInitialFilter, setTableInitialFilter] = useState<QueueFilter>('ALL');
  const [addPostTrigger, setAddPostTrigger] = useState<number>(0);
  const [previewFilter, setPreviewFilter] = useState<'PENDING' | 'POSTED' | 'ALL'>('PENDING');

  const [socketConnected, setSocketConnected] = useState<boolean>(false);
  const [syncMode, setSyncMode] = useState<
    'connecting' | 'websocket' | 'http-sync' | 'reconnecting'
  >('connecting');
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [isApplyingSlots, setIsApplyingSlots] = useState<boolean>(false);
  const [isSeedingMl, setIsSeedingMl] = useState<boolean>(false);
  const [generatorError, setGeneratorError] = useState<string | null>(null);
  const [publishingIds, setPublishingIds] = useState<Set<string>>(() => new Set());
  const [regeneratingIds, setRegeneratingIds] = useState<Set<string>>(() => new Set());
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isSecurityOpen, setIsSecurityOpen] = useState<boolean>(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const settingsAutoPublishRef = useRef<boolean>(true);
  const refreshPromiseRef = useRef<Promise<string | null> | null>(null);

  useEffect(() => {
    settingsAutoPublishRef.current = settings.autoPublishEnabled;
  }, [settings.autoPublishEnabled]);

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

  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    const promise = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
          },
        });
        if (!res.ok) {
          return null;
        }
        const data = (await res.json().catch(() => ({}))) as {
          token?: string;
          email?: string;
          expiresAt?: string;
          sid?: string;
          jtiPrefix?: string;
          tokenVersion?: number;
        };
        if (!data.token || !data.email) {
          return null;
        }
        setAuthToken(data.token);
        setAuthStatus((prev) =>
          prev
            ? {
                ...prev,
                authenticated: true,
                email: data.email!,
                token: data.token,
                expiresAt: data.expiresAt ?? prev.expiresAt,
                sid: data.sid ?? prev.sid,
                jtiPrefix: data.jtiPrefix ?? prev.jtiPrefix,
                tokenVersion: data.tokenVersion ?? prev.tokenVersion,
              }
            : prev
        );
        return data.token;
      } catch {
        return null;
      } finally {
        refreshPromiseRef.current = null;
      }
    })();

    refreshPromiseRef.current = promise;
    return promise;
  }, []);

  // Proactive silent JWT rotation 90 seconds before the 15m Access JWT expires
  useEffect(() => {
    if (!authToken || !authStatus?.expiresAt) return;
    const expMs = new Date(authStatus.expiresAt).getTime();
    if (Number.isNaN(expMs)) return;

    const refreshDelayMs = Math.max(15000, expMs - Date.now() - 90_000);
    const timer = window.setTimeout(() => {
      void refreshAccessToken().then((nextToken) => {
        if (!nextToken) {
          setAuthToken(null);
          void fetchAuthStatus(null);
        }
      });
    }, refreshDelayMs);

    return () => window.clearTimeout(timer);
  }, [authToken, authStatus?.expiresAt, refreshAccessToken, fetchAuthStatus]);

  const apiFetch = useCallback(
    async <T,>(url: string, options: RequestInit = {}): Promise<T> => {
      if (!authToken) {
        throw new Error('Authentication required.');
      }

      const executeFetch = async (tokenToUse: string) => {
        const headers = new Headers(options.headers);
        headers.set('Authorization', `Bearer ${tokenToUse}`);
        headers.set('X-Requested-With', 'XMLHttpRequest');
        if (options.body && !headers.has('Content-Type')) {
          headers.set('Content-Type', 'application/json');
        }
        return fetch(url, {
          ...options,
          headers,
          credentials: 'include',
        });
      };

      let res = await executeFetch(authToken);
      if (res.status === 401) {
        const refreshed = await refreshAccessToken();
        if (refreshed) {
          res = await executeFetch(refreshed);
        }
      }

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
    [authToken, fetchAuthStatus, refreshAccessToken]
  );

  const refreshWorkspaceViaRest = useCallback(async () => {
    if (!authToken) return;
    try {
      const state = await apiFetch<{
        posts: ScheduledPost[];
        settings: PublisherSettings;
        logs: ActivityLogEntry[];
        scheduler?: SchedulerStatus;
      }>('/api/sync');
      setPosts(state.posts || []);
      if (state.settings) setSettings(state.settings);
      setLogs(state.logs || []);
      if (state.scheduler) setScheduler(state.scheduler);
    } catch {
      // Handled by apiFetch on 401
    }
  }, [authToken, apiFetch]);

  // Real-time WebSocket on Node servers, automatic HTTP Live Sync on Vercel serverless
  useEffect(() => {
    if (!authToken) {
      setSocketConnected(false);
      setSyncMode('connecting');
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      return;
    }

    void refreshWorkspaceViaRest();
    let cancelled = false;
    let httpSyncTimer: number | null = null;
    let wsFailures = 0;

    const startHttpSyncFallback = () => {
      if (cancelled || httpSyncTimer !== null) return;
      setSocketConnected(false);
      setSyncMode('http-sync');
      httpSyncTimer = window.setInterval(async () => {
        if (cancelled) return;
        try {
          if (settingsAutoPublishRef.current) {
            await apiFetch('/api/scheduler/run', {
              method: 'POST',
              body: JSON.stringify({ trigger: 'auto' }),
            });
          }
          await refreshWorkspaceViaRest();
        } catch {
          // Handled by apiFetch
        }
      }, 15000);
    };

    if (authStatus?.realtimeMode === 'http-sync') {
      startHttpSyncFallback();
      return () => {
        cancelled = true;
        if (httpSyncTimer !== null) window.clearInterval(httpSyncTimer);
      };
    }

    setSyncMode('connecting');

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
              wsFailures = 0;
              setSocketConnected(true);
              setSyncMode('websocket');
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
        if (cancelled) return;
        wsFailures += 1;
        if (wsFailures >= 2) {
          startHttpSyncFallback();
          return;
        }
        setSyncMode('reconnecting');
        reconnectTimerRef.current = window.setTimeout(connect, 2500);
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
      if (httpSyncTimer !== null) {
        window.clearInterval(httpSyncTimer);
      }
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [authToken, authStatus?.realtimeMode, apiFetch, refreshWorkspaceViaRest]);

  const handleAuthenticated = (payload: {
    token: string;
    email: string;
    expiresAt?: string | null;
    sid?: string | null;
    jtiPrefix?: string | null;
    tokenVersion?: number | null;
  }) => {
    setAuthToken(payload.token);
    setAuthStatus((prev) =>
      prev
        ? {
            ...prev,
            authenticated: true,
            email: payload.email,
            token: payload.token,
            expiresAt: payload.expiresAt ?? prev.expiresAt,
            sid: payload.sid ?? prev.sid,
            jtiPrefix: payload.jtiPrefix ?? prev.jtiPrefix,
            tokenVersion: payload.tokenVersion ?? prev.tokenVersion,
            setupRequired: false,
          }
        : {
            authenticated: true,
            email: payload.email,
            token: payload.token,
            expiresAt: payload.expiresAt ?? null,
            sid: payload.sid ?? null,
            jtiPrefix: payload.jtiPrefix ?? null,
            tokenVersion: payload.tokenVersion ?? null,
            setupRequired: false,
            dbConnected: true,
            dbError: null,
          }
    );
  };

  const handleSignOut = async () => {
    try {
      const headers: Record<string, string> = {
        'X-Requested-With': 'XMLHttpRequest',
      };
      if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
      }
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers,
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

  const handleVerifyFacebookConnection = async () => {
    return apiFetch<FacebookVerifyResult>('/api/facebook/verify', {
      method: 'POST',
    });
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

  const handleSeedMlMonth = async (startDate: string) => {
    setIsSeedingMl(true);
    setGeneratorError(null);
    try {
      const res = await apiFetch<{ posts: ScheduledPost[]; count: number }>(
        '/api/posts/seed-ml-month',
        {
          method: 'POST',
          body: JSON.stringify({
            startDate,
            timezoneOffsetMinutes: new Date().getTimezoneOffset(),
          }),
        }
      );
      if (res.posts?.length) {
        setPosts((prev) => {
          const existingIds = new Set(prev.map((p) => p.id));
          const additions = res.posts.filter((p) => !existingIds.has(p.id));
          return [...prev, ...additions];
        });
      }
      setSettings((prev) => ({
        ...prev,
        recurringTimes: ['09:00', '15:00', '18:00'],
      }));
      if (!socketConnected) void refreshWorkspaceViaRest();
    } catch (err: unknown) {
      setGeneratorError(
        err instanceof Error ? err.message : 'Failed to load 30-day ML curriculum.'
      );
    } finally {
      setIsSeedingMl(false);
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

  const counts = useMemo(() => {
    const postedAll = posts.filter((p) => p.status === 'POSTED');
    const simulated = postedAll.filter((p) => p.isSimulated).length;
    const livePosted = postedAll.length - simulated;
    return {
      all: posts.length,
      pending: posts.filter((p) => p.status === 'PENDING').length,
      posted: postedAll.length,
      livePosted,
      simulated,
      failed: posts.filter((p) => p.status === 'FAILED').length,
    };
  }, [posts]);

  const nextPendingPosts = useMemo(() => {
    return [...posts]
      .filter((p) => p.status === 'PENDING')
      .sort(
        (a, b) =>
          new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
      )
      .slice(0, 3);
  }, [posts]);

  const previewPosts = useMemo(() => {
    const sorted = [...posts].sort(
      (a, b) =>
        new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
    );
    if (previewFilter === 'ALL') return sorted.slice(0, 24);
    return sorted.filter((p) => p.status === previewFilter).slice(0, 24);
  }, [posts, previewFilter]);

  const jumpToScheduleFilter = (filter: QueueFilter) => {
    setTableInitialFilter(filter);
    setActiveView('schedule');
  };

  const handleOpenCreatePost = () => {
    setActiveView('schedule');
    setAddPostTrigger((n) => n + 1);
  };

  if (authLoading && !authStatus) {
    return (
      <div className="min-h-screen bg-[#F0F2F5] flex items-center justify-center text-sm text-[#65676B] gap-2">
        <Loader2 className="w-4 h-4 animate-spin text-[#1877F2]" />
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

  const pageLabel = settings.facebookPageId
    ? `Page ${settings.facebookPageId}`
    : 'Parvez Dev';

  return (
    <div id="top" className="min-h-screen bg-[#F0F2F5] text-[#1C1E21] flex">
      {/* Left Workspace Sidebar */}
      <SidebarNav
        activeView={activeView}
        onSelectView={setActiveView}
        mobileOpen={mobileSidebarOpen}
        onCloseMobile={() => setMobileSidebarOpen(false)}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenSecurity={() => setIsSecurityOpen(true)}
        onSignOut={handleSignOut}
        userEmail={authStatus.email || 'Administrator'}
        facebookPageId={settings.facebookPageId}
        hasAccessToken={settings.hasAccessToken}
        recurringTimes={settings.recurringTimes}
        counts={{
          all: counts.all,
          pending: counts.pending,
          livePosted: counts.livePosted,
          failed: counts.failed,
        }}
        logsCount={logs.length}
      />

      {/* Right Main Shell */}
      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar
          activeView={activeView}
          onOpenMobileMenu={() => setMobileSidebarOpen(true)}
          onOpenCreatePost={handleOpenCreatePost}
        />

        {/* Workspace Control Bar (Responsive, Below TopBar) */}
        <div className="bg-white border-b border-[#E4E6EB]">
          <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <div
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 font-medium rounded-lg whitespace-nowrap ${
                  syncMode === 'websocket' || syncMode === 'http-sync'
                    ? 'bg-emerald-50 text-emerald-800'
                    : 'bg-amber-50 text-amber-800'
                }`}
              >
                {syncMode === 'websocket' || syncMode === 'http-sync' ? (
                  <Wifi className="w-3.5 h-3.5" />
                ) : (
                  <WifiOff className="w-3.5 h-3.5" />
                )}
                <span>
                  {syncMode === 'websocket'
                    ? 'Socket Live'
                    : syncMode === 'http-sync'
                      ? 'Live Sync Active'
                      : syncMode === 'connecting'
                        ? 'Connecting...'
                        : 'Reconnecting...'}
                </span>
              </div>

              <span className="hidden sm:inline text-[#BCC0C4]" aria-hidden="true">
                ·
              </span>
              <span className="hidden sm:inline text-[#65676B] font-mono tabular-nums">
                {settings.facebookPageId
                  ? `FB Page ${settings.facebookPageId}`
                  : 'FB Page ID not set'}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  void handleSaveSettings({ dryRunMode: !settings.dryRunMode })
                }
                aria-pressed={settings.dryRunMode}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap cursor-pointer ${
                  settings.dryRunMode
                    ? 'bg-amber-50 border-amber-300 text-amber-900'
                    : 'bg-white border-[#CCD0D5] text-[#1C1E21] hover:bg-[#F0F2F5]'
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
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap cursor-pointer ${
                  settings.autoPublishEnabled
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                    : 'bg-white border-[#CCD0D5] text-[#1C1E21] hover:bg-[#F0F2F5]'
                }`}
              >
                <Radio className="w-3.5 h-3.5" />
                <span className="font-mono tabular-nums">
                  {settings.autoPublishEnabled
                    ? `Auto (${scheduler.intervalSeconds}s)`
                    : 'Auto OFF'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => void handleRunSchedulerNow()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#1C1E21] bg-[#E4E6EB] hover:bg-[#D8DADF] rounded-lg whitespace-nowrap cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                <span>Run Check</span>
              </button>

              <button
                type="button"
                onClick={() => setIsSettingsOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#1C1E21] bg-white hover:bg-[#F0F2F5] border border-[#CCD0D5] rounded-lg whitespace-nowrap cursor-pointer"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Settings</span>
              </button>
            </div>
          </div>
        </div>

        {/* Main Viewport */}
        <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-6 space-y-5 sm:space-y-6">
          {/* Actionable Status Notice when Dry Run is ON or Secrets Missing */}
          {(settings.dryRunMode || !settings.facebookPageId || !settings.hasAccessToken) && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-950">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold">
                    {settings.dryRunMode
                      ? 'Dry Run (Simulation Mode) is ON — posts will NOT appear on your Facebook Page'
                      : 'Facebook Page credentials required for live publishing'}
                  </div>
                  <div className="mt-0.5 text-amber-900">
                    {settings.facebookPageId && settings.hasAccessToken
                      ? 'FACEBOOK_PAGE_ID & FACEBOOK_ACCESS_TOKEN env secrets detected. Turn Dry Run OFF to publish live, and click "Re-queue" on any SIMULATED row.'
                      : 'Add FACEBOOK_PAGE_ID and FACEBOOK_ACCESS_TOKEN in Settings > Secrets, then test the connection and switch Dry Run OFF.'}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setIsSettingsOpen(true)}
                  className="px-3 py-1.5 text-xs font-semibold text-amber-950 bg-white border border-amber-300 hover:bg-amber-100 rounded-lg whitespace-nowrap cursor-pointer"
                >
                  Open FB Settings
                </button>
                {settings.dryRunMode && settings.facebookPageId && settings.hasAccessToken && (
                  <button
                    type="button"
                    onClick={() => void handleSaveSettings({ dryRunMode: false })}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg whitespace-nowrap cursor-pointer"
                  >
                    Go Live (Dry Run OFF)
                  </button>
                )}
              </div>
            </div>
          )}

          {/* OVERVIEW VIEW */}
          {activeView === 'overview' && (
            <div className="space-y-6">
              {/* 4-Column Interactive KPI Strip */}
              <section
                aria-label="Publishing overview metrics"
                className="bg-white border border-[#E4E6EB] rounded-xl grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-[#E4E6EB]"
              >
                <button
                  type="button"
                  onClick={() => jumpToScheduleFilter('ALL')}
                  className="p-4 sm:p-5 text-left hover:bg-[#F7F8FA] transition-colors cursor-pointer first:rounded-tl-xl lg:first:rounded-l-xl"
                >
                  <div className="text-xs font-medium text-[#65676B]">
                    Total Scheduled
                  </div>
                  <div className="mt-1 font-display text-2xl font-bold font-mono tabular-nums text-[#1C1E21]">
                    {counts.all}
                  </div>
                  <div className="mt-1 text-[11px] text-[#65676B] font-mono tabular-nums">
                    {settings.recurringTimes.length} daily slots
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => jumpToScheduleFilter('PENDING')}
                  className="p-4 sm:p-5 text-left hover:bg-[#F7F8FA] transition-colors cursor-pointer border-l border-[#E4E6EB] lg:border-l-0"
                >
                  <div className="text-xs font-medium text-[#65676B]">
                    Pending Queue
                  </div>
                  <div className="mt-1 font-display text-2xl font-bold font-mono tabular-nums text-[#1877F2]">
                    {counts.pending}
                  </div>
                  <div className="mt-1 text-[11px] text-[#65676B]">
                    Click to inspect queue
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => jumpToScheduleFilter('POSTED')}
                  className="p-4 sm:p-5 text-left hover:bg-[#F7F8FA] transition-colors cursor-pointer"
                >
                  <div className="text-xs font-medium text-[#65676B]">
                    Published to FB
                  </div>
                  <div className="mt-1 font-display text-2xl font-bold font-mono tabular-nums text-emerald-700">
                    {counts.livePosted}
                    {counts.simulated > 0 && (
                      <span className="ml-1.5 text-xs font-medium text-amber-700">
                        ({counts.simulated} sim)
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-[#65676B]">
                    Live Graph API posts
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => jumpToScheduleFilter('FAILED')}
                  className="p-4 sm:p-5 text-left hover:bg-[#F7F8FA] transition-colors cursor-pointer border-l border-[#E4E6EB] lg:border-l-0 last:rounded-br-xl lg:last:rounded-r-xl"
                >
                  <div className="text-xs font-medium text-[#65676B]">
                    Failed
                  </div>
                  <div className="mt-1 font-display text-2xl font-bold font-mono tabular-nums text-red-700">
                    {counts.failed}
                  </div>
                  <div className="mt-1 text-[11px] text-[#65676B]">
                    {counts.failed > 0 ? 'Requires retry' : 'All healthy'}
                  </div>
                </button>
              </section>

              {/* Next Up Upcoming Slots */}
              {nextPendingPosts.length > 0 && (
                <section className="bg-white border border-[#E4E6EB] rounded-xl p-4 sm:p-5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h2 className="font-display text-base font-bold text-[#1C1E21]">
                        Up Next in Queue
                      </h2>
                      <p className="text-xs text-[#65676B]">
                        Next 3 scheduled posts queued for automatic publishing.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveView('previews')}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-[#1877F2] hover:underline cursor-pointer"
                    >
                      <span>View FB Feed Previews</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
                    {nextPendingPosts.map((post) => {
                      const isPublishing = publishingIds.has(post.id);
                      return (
                        <div
                          key={post.id}
                          className="p-3.5 bg-[#F7F8FA] border border-[#E4E6EB] rounded-xl flex flex-col justify-between gap-3"
                        >
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums">
                              <span className="inline-flex items-center gap-1 font-semibold text-[#1877F2]">
                                <Clock className="w-3 h-3" />
                                {formatDateOnly(post.scheduledAt)} · {formatTime12h(post.slotTime)}
                              </span>
                            </div>
                            <div className="text-xs font-medium text-[#65676B] truncate">
                              {post.topicName}
                            </div>
                            <div className="font-display text-sm font-bold text-[#1C1E21] line-clamp-2">
                              {post.seoTitle}
                            </div>
                          </div>

                          <div className="flex items-center justify-between gap-2 pt-2 border-t border-[#E4E6EB]">
                            <button
                              type="button"
                              onClick={() => jumpToScheduleFilter('PENDING')}
                              className="text-xs font-medium text-[#65676B] hover:text-[#1C1E21] cursor-pointer"
                            >
                              Inspect row
                            </button>
                            <button
                              type="button"
                              disabled={isPublishing}
                              onClick={() => void handlePublishNow(post.id)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-white bg-[#1877F2] hover:bg-[#166FE5] disabled:opacity-60 rounded-lg cursor-pointer"
                            >
                              {isPublishing ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Send className="w-3 h-3" />
                              )}
                              <span>{settings.dryRunMode ? 'Simulate' : 'Post Now'}</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Split Overview Studio: Planner + Activity on Left, Schedule Table on Right */}
              <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
                <div className="xl:col-span-4 space-y-6">
                  <MonthlyPlannerPanel
                    recurringTimes={settings.recurringTimes}
                    pendingCount={counts.pending}
                    isGenerating={isGenerating}
                    isApplyingSlots={isApplyingSlots}
                    isSeedingMl={isSeedingMl}
                    errorMessage={generatorError}
                    onUpdateRecurringTimes={(times) =>
                      handleSaveSettings({ recurringTimes: times })
                    }
                    onApplySlotsToPending={handleApplySlotsToPending}
                    onSeedMlMonth={handleSeedMlMonth}
                    onGenerateMonthly={handleGenerateMonthly}
                  />

                  <ActivityConsole
                    logs={logs}
                    onClearLogs={() => void handleClearLogs()}
                  />
                </div>

                <div className="xl:col-span-8">
                  <MonthlyScheduleTable
                    posts={posts}
                    recurringTimes={settings.recurringTimes}
                    publishingIds={publishingIds}
                    regeneratingIds={regeneratingIds}
                    dryRunMode={settings.dryRunMode}
                    pageName={pageLabel}
                    initialFilter={tableInitialFilter}
                    externalAddTrigger={addPostTrigger}
                    onAddManualPost={handleAddManualPost}
                    onUpdatePost={handleUpdatePost}
                    onPublishNow={handlePublishNow}
                    onRegeneratePart={handleRegeneratePart}
                    onDeletePost={handleDeletePost}
                  />
                </div>
              </div>
            </div>
          )}

          {/* FULL SCHEDULE TABLE VIEW */}
          {activeView === 'schedule' && (
            <MonthlyScheduleTable
              posts={posts}
              recurringTimes={settings.recurringTimes}
              publishingIds={publishingIds}
              regeneratingIds={regeneratingIds}
              dryRunMode={settings.dryRunMode}
              pageName={pageLabel}
              initialFilter={tableInitialFilter}
              externalAddTrigger={addPostTrigger}
              onAddManualPost={handleAddManualPost}
              onUpdatePost={handleUpdatePost}
              onPublishNow={handlePublishNow}
              onRegeneratePart={handleRegeneratePart}
              onDeletePost={handleDeletePost}
            />
          )}

          {/* FULL MONTHLY PLANNER VIEW */}
          {activeView === 'planner' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              <div className="lg:col-span-6">
                <MonthlyPlannerPanel
                  recurringTimes={settings.recurringTimes}
                  pendingCount={counts.pending}
                  isGenerating={isGenerating}
                  isApplyingSlots={isApplyingSlots}
                  isSeedingMl={isSeedingMl}
                  errorMessage={generatorError}
                  onUpdateRecurringTimes={(times) =>
                    handleSaveSettings({ recurringTimes: times })
                  }
                  onApplySlotsToPending={handleApplySlotsToPending}
                  onSeedMlMonth={handleSeedMlMonth}
                  onGenerateMonthly={handleGenerateMonthly}
                />
              </div>
              <div className="lg:col-span-6 space-y-4">
                <section className="bg-white border border-[#E4E6EB] rounded-xl p-5 space-y-3">
                  <h2 className="font-display text-base font-bold text-[#1C1E21]">
                    Upcoming Scheduled Feed
                  </h2>
                  <p className="text-xs text-[#65676B]">
                    Showing your next upcoming slots across {settings.recurringTimes.map(formatTime12h).join(', ')}.
                  </p>
                  {nextPendingPosts.length === 0 ? (
                    <div className="py-8 text-center text-xs text-[#65676B]">
                      No pending posts in queue. Generate a series or load the 30-Day ML Curriculum on the left.
                    </div>
                  ) : (
                    <div className="space-y-4 pt-2">
                      {nextPendingPosts.map((post) => (
                        <FacebookFeedPreview
                          key={post.id}
                          post={post}
                          pageName={pageLabel}
                          compact
                          dryRunMode={settings.dryRunMode}
                          isPublishing={publishingIds.has(post.id)}
                          onPublishNow={(id) => void handlePublishNow(id)}
                          onEdit={() => jumpToScheduleFilter('PENDING')}
                        />
                      ))}
                    </div>
                  )}
                </section>
              </div>
            </div>
          )}

          {/* FACEBOOK FEED PREVIEW VIEW */}
          {activeView === 'previews' && (
            <div className="space-y-5">
              <div className="bg-white border border-[#E4E6EB] rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="font-display text-base sm:text-lg font-bold text-[#1C1E21]">
                    Facebook Page Feed Previews
                  </h2>
                  <p className="text-xs text-[#65676B]">
                    Preview exactly how scheduled and live posts render on your Facebook Page feed.
                  </p>
                </div>
                <div className="inline-flex items-center gap-1 p-1 bg-[#F0F2F5] rounded-lg self-start sm:self-auto">
                  {(
                    [
                      { id: 'PENDING', label: `Pending (${counts.pending})` },
                      { id: 'POSTED', label: `Published (${counts.posted})` },
                      { id: 'ALL', label: 'All' },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setPreviewFilter(tab.id)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                        previewFilter === tab.id
                          ? 'bg-white text-[#1877F2] font-semibold shadow-xs'
                          : 'text-[#65676B] hover:text-[#1C1E21]'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              {previewPosts.length === 0 ? (
                <div className="bg-white border border-[#E4E6EB] rounded-xl p-12 text-center text-xs text-[#65676B]">
                  No posts match this preview filter yet.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 items-start">
                  {previewPosts.map((post) => (
                    <FacebookFeedPreview
                      key={post.id}
                      post={post}
                      pageName={pageLabel}
                      compact
                      dryRunMode={settings.dryRunMode}
                      isPublishing={publishingIds.has(post.id)}
                      onPublishNow={(id) => void handlePublishNow(id)}
                      onEdit={() => jumpToScheduleFilter(post.status)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* FULL ACTIVITY CONSOLE VIEW */}
          {activeView === 'activity' && (
            <ActivityConsole
              logs={logs}
              onClearLogs={() => void handleClearLogs()}
              expanded
            />
          )}
        </main>
      </div>

      <SettingsModal
        isOpen={isSettingsOpen}
        settings={settings}
        onClose={() => setIsSettingsOpen(false)}
        onVerifyConnection={handleVerifyFacebookConnection}
        onSave={handleSaveSettings}
      />

      <SecurityModal
        isOpen={isSecurityOpen}
        onClose={() => setIsSecurityOpen(false)}
        apiFetch={apiFetch}
        currentJtiPrefix={authStatus.jtiPrefix}
        currentExpiresAt={authStatus.expiresAt}
        currentTokenVersion={authStatus.tokenVersion}
        onTokenRotated={handleAuthenticated}
        onRefreshJwtNow={async () => {
          const next = await refreshAccessToken();
          return Boolean(next);
        }}
        onSignedOutAll={() => {
          setAuthToken(null);
          setPosts([]);
          setLogs([]);
          setSocketConnected(false);
          void fetchAuthStatus(null);
        }}
      />
    </div>
  );
}
