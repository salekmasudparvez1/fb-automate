import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Laptop,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import type { AuthSecurityInfo, AuthSessionItem } from '../types';

interface SecurityModalProps {
  isOpen: boolean;
  onClose: () => void;
  apiFetch: <T>(url: string, options?: RequestInit) => Promise<T>;
  currentJtiPrefix?: string | null;
  currentExpiresAt?: string | null;
  currentTokenVersion?: number | null;
  onTokenRotated: (payload: {
    token: string;
    email: string;
    expiresAt?: string | null;
    sid?: string | null;
    jtiPrefix?: string | null;
    tokenVersion?: number | null;
  }) => void;
  onRefreshJwtNow: () => Promise<boolean>;
  onSignedOutAll: () => void;
}

function summarizeUserAgent(ua: string): string {
  if (!ua || ua === 'Unknown client') return 'Browser Session';
  let browser = 'Browser';
  if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('Chrome/')) browser = 'Chrome';
  else if (ua.includes('Firefox/')) browser = 'Firefox';
  else if (ua.includes('Safari/') && !ua.includes('Chrome/')) browser = 'Safari';
  else if (ua.includes('curl/')) browser = 'CLI / curl';

  let os = '';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac OS X')) os = 'macOS';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('Linux')) os = 'Linux';

  return os ? `${browser} on ${os}` : browser;
}

function formatRemainingCountdown(expiresAt?: string | null): string {
  if (!expiresAt) return 'Active';
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(diffMs) || diffMs <= 0) return 'Refreshing...';
  const totalSec = Math.floor(diffMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m ${String(secs).padStart(2, '0')}s`;
}

export const SecurityModal: React.FC<SecurityModalProps> = ({
  isOpen,
  onClose,
  apiFetch,
  currentJtiPrefix,
  currentExpiresAt,
  currentTokenVersion,
  onTokenRotated,
  onRefreshJwtNow,
  onSignedOutAll,
}) => {
  const [sessions, setSessions] = useState<AuthSessionItem[]>([]);
  const [security, setSecurity] = useState<AuthSecurityInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revokingSid, setRevokingSid] = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const [refreshingJwt, setRefreshingJwt] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [countdownText, setCountdownText] = useState(() =>
    formatRemainingCountdown(currentExpiresAt)
  );

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{
        sessions: AuthSessionItem[];
        security: AuthSecurityInfo;
      }>('/api/auth/sessions');
      setSessions(data.sessions || []);
      setSecurity(data.security || null);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Failed to load security sessions.'
      );
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    if (isOpen) {
      setNotice(null);
      setError(null);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      void loadSessions();
    }
  }, [isOpen, loadSessions]);

  useEffect(() => {
    if (!isOpen) return;
    setCountdownText(formatRemainingCountdown(currentExpiresAt));
    const timer = window.setInterval(() => {
      setCountdownText(formatRemainingCountdown(currentExpiresAt));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isOpen, currentExpiresAt]);

  if (!isOpen) return null;

  const handleManualJwtRefresh = async () => {
    setRefreshingJwt(true);
    setError(null);
    setNotice(null);
    try {
      const ok = await onRefreshJwtNow();
      if (!ok) {
        throw new Error('Could not rotate JWT session. Sign in again.');
      }
      setNotice('Access JWT and refresh token rotated successfully.');
      await loadSessions();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'JWT refresh failed.');
    } finally {
      setRefreshingJwt(false);
    }
  };

  const handleRevokeSession = async (sid: string, isCurrent: boolean) => {
    setRevokingSid(sid);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/auth/sessions/${encodeURIComponent(sid)}`, {
        method: 'DELETE',
      });
      if (isCurrent) {
        onSignedOutAll();
        onClose();
        return;
      }
      setSessions((prev) => prev.filter((s) => s.sid !== sid));
      setNotice('Session revoked immediately.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to revoke session.');
    } finally {
      setRevokingSid(null);
    }
  };

  const handleRevokeAll = async (includeCurrent: boolean) => {
    setRevokingAll(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<{
        ok: boolean;
        revokedCount: number;
        signedOutCurrent: boolean;
      }>('/api/auth/revoke-all', {
        method: 'POST',
        body: JSON.stringify({ includeCurrent }),
      });
      if (res.signedOutCurrent) {
        onSignedOutAll();
        onClose();
        return;
      }
      setNotice(
        res.revokedCount > 0
          ? `Revoked ${res.revokedCount} other active session${res.revokedCount === 1 ? '' : 's'}.`
          : 'No other active sessions found.'
      );
      await loadSessions();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to revoke sessions.');
    } finally {
      setRevokingAll(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters long.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
      return;
    }

    setChangingPassword(true);
    try {
      const res = await apiFetch<{
        ok: boolean;
        token: string;
        email: string;
        expiresAt?: string;
        sid?: string;
        jtiPrefix?: string;
        tokenVersion?: number;
      }>('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      onTokenRotated({
        token: res.token,
        email: res.email,
        expiresAt: res.expiresAt,
        sid: res.sid,
        jtiPrefix: res.jtiPrefix,
        tokenVersion: res.tokenVersion,
      });

      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setNotice(
        `Password updated successfully. Previous sessions were signed out (revision v${res.tokenVersion ?? ''}).`
      );
      await loadSessions();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update password.');
    } finally {
      setChangingPassword(false);
    }
  };

  const otherSessionsCount = sessions.filter((s) => !s.isCurrent).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-[2px] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="security-modal-title"
    >
      <div className="w-full max-w-2xl bg-white border border-[#E4E6EB] rounded-2xl shadow-xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E4E6EB]">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 text-[#1877F2] shrink-0" />
            <div>
              <h2
                id="security-modal-title"
                className="font-display text-lg font-bold text-[#1C1E21]"
              >
                Account Security &amp; Sessions
              </h2>
              <p className="text-xs text-[#65676B]">
                Manage active sessions, rotate access tokens, and update your password.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close security modal"
            className="p-1.5 text-[#65676B] hover:text-[#1C1E21] rounded-lg hover:bg-[#F0F2F5] cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 p-3 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg"
            >
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {notice && (
            <div className="flex items-start gap-2 p-3 text-xs text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg">
              <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
              <span>{notice}</span>
            </div>
          )}

          {/* Cryptographic Posture Summary */}
          <div className="border-b border-[#E4E6EB] pb-4 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-[#1C1E21]">
                Authentication Architecture
              </span>
              <button
                type="button"
                disabled={refreshingJwt}
                onClick={() => void handleManualJwtRefresh()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#1877F2] bg-[#E7F3FF] hover:bg-[#DBEBFD] disabled:opacity-60 rounded-lg cursor-pointer"
              >
                {refreshingJwt ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                <span>Rotate Token</span>
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
              <div className="flex items-center justify-between py-1 border-b border-[#F0F2F5]">
                <span className="text-[#65676B]">Password Protection</span>
                <span className="font-mono font-medium text-[#1C1E21]">
                  Encrypted
                </span>
              </div>
              <div className="flex items-center justify-between py-1 border-b border-[#F0F2F5]">
                <span className="text-[#65676B]">Session Policy</span>
                <span className="font-mono font-medium text-[#1C1E21]">
                  Auto-Rotating ({security?.accessTtlMinutes ?? 15}m / {security?.refreshTtlDays ?? 7}d)
                </span>
              </div>
              <div className="flex items-center justify-between py-1 border-b border-[#F0F2F5]">
                <span className="text-[#65676B]">Current Token</span>
                <span className="font-mono tabular-nums font-medium text-[#1C1E21]">
                  {currentJtiPrefix ? `${currentJtiPrefix}...` : 'Active'} ·{' '}
                  {countdownText}
                </span>
              </div>
              <div className="flex items-center justify-between py-1 border-b border-[#F0F2F5]">
                <span className="text-[#65676B]">Token Revision</span>
                <span className="font-mono tabular-nums font-medium text-[#1C1E21]">
                  v{security?.tokenVersion ?? currentTokenVersion ?? 1}
                </span>
              </div>
            </div>
          </div>

          {/* Active Sessions */}
          <div className="space-y-3 border-b border-[#E4E6EB] pb-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-[#1C1E21]">
                  Active Sessions ({sessions.length})
                </h3>
                <p className="text-xs text-[#65676B]">
                  Review signed-in browsers and revoke access at any time.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {otherSessionsCount > 0 && (
                  <button
                    type="button"
                    disabled={revokingAll}
                    onClick={() => void handleRevokeAll(false)}
                    className="px-3 py-1.5 text-xs font-semibold text-[#1C1E21] bg-[#E4E6EB] hover:bg-[#D8DADF] disabled:opacity-50 rounded-lg cursor-pointer"
                  >
                    Revoke Others ({otherSessionsCount})
                  </button>
                )}
                <button
                  type="button"
                  disabled={revokingAll}
                  onClick={() => void handleRevokeAll(true)}
                  className="px-3 py-1.5 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 disabled:opacity-50 rounded-lg cursor-pointer"
                >
                  Revoke All &amp; Rotate Key
                </button>
              </div>
            </div>

            {loading ? (
              <div className="py-6 flex items-center justify-center gap-2 text-xs text-[#65676B]">
                <Loader2 className="w-4 h-4 animate-spin text-[#1877F2]" />
                <span>Loading active JWT sessions...</span>
              </div>
            ) : sessions.length === 0 ? (
              <p className="text-xs text-[#65676B] py-2">
                No active sessions recorded.
              </p>
            ) : (
              <div className="divide-y divide-[#E4E6EB] border border-[#E4E6EB] rounded-lg">
                {sessions.map((s) => (
                  <div
                    key={s.sid}
                    className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="flex items-start gap-2.5 min-w-0">
                      <Laptop className="w-4 h-4 text-[#65676B] shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-medium text-[#1C1E21]">
                          <span className="truncate">
                            {summarizeUserAgent(s.userAgent)}
                          </span>
                          {s.isCurrent && (
                            <span className="text-[11px] font-semibold text-[#1877F2]">
                              Current
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-[#65676B] font-mono tabular-nums mt-0.5">
                          JTI {s.jtiPrefix} · IP {s.ipAddress} · Active{' '}
                          {new Date(s.lastUsedAt).toLocaleString()}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={revokingSid === s.sid}
                      onClick={() => void handleRevokeSession(s.sid, s.isCurrent)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 rounded-md cursor-pointer shrink-0"
                    >
                      {revokingSid === s.sid ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                      <span>{s.isCurrent ? 'Sign Out' : 'Revoke'}</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Password Management */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <KeyRound className="w-4 h-4 text-[#1877F2]" />
              <h3 className="text-sm font-semibold text-[#1C1E21]">
                Administrator Password
              </h3>
            </div>

            {security?.envPasswordOverride ? (
              <div className="p-3 bg-[#F7F8FA] border border-[#E4E6EB] rounded-lg text-xs text-[#65676B] leading-relaxed">
                <strong className="text-[#1C1E21]">Managed by Server Secret:</strong>{' '}
                Your administrator password is configured via environment secrets. Update it in Settings &gt; Secrets if needed.
              </div>
            ) : (
              <form onSubmit={handleChangePassword} className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label
                      htmlFor="sec-cur-pass"
                      className="block text-xs font-medium text-[#1C1E21] mb-1"
                    >
                      Current Password
                    </label>
                    <input
                      id="sec-cur-pass"
                      type="password"
                      required
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      placeholder="Current"
                      className="w-full px-3 py-2 text-xs text-[#1C1E21] bg-white border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="sec-new-pass"
                      className="block text-xs font-medium text-[#1C1E21] mb-1"
                    >
                      New Password (8+ chars)
                    </label>
                    <input
                      id="sec-new-pass"
                      type="password"
                      required
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="New password"
                      className="w-full px-3 py-2 text-xs text-[#1C1E21] bg-white border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="sec-confirm-pass"
                      className="block text-xs font-medium text-[#1C1E21] mb-1"
                    >
                      Confirm New
                    </label>
                    <input
                      id="sec-confirm-pass"
                      type="password"
                      required
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Repeat new"
                      className="w-full px-3 py-2 text-xs text-[#1C1E21] bg-white border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
                    />
                  </div>
                </div>
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={changingPassword}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#1877F2] hover:bg-[#166FE5] disabled:opacity-60 rounded-lg cursor-pointer"
                  >
                    {changingPassword ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Lock className="w-3.5 h-3.5" />
                    )}
                    <span>
                      {changingPassword
                        ? 'Hashing & Rotating...'
                        : 'Update Password & Rotate Sessions'}
                    </span>
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
