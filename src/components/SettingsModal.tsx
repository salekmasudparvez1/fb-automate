import React, { useState, useEffect } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  KeyRound,
  Loader2,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { PublisherSettings } from '../types';

export interface FacebookVerifyResult {
  ok: boolean;
  pageId: string;
  pageName: string;
  pageLink: string;
  isPublished: boolean;
  isPageToken: boolean;
  resolvedViaAccounts?: boolean;
  permanentExchanged?: boolean;
  tokenOwnerName: string | null;
  availablePages?: Array<{ id: string; name: string }>;
  warnings: string[];
}

export interface FacebookExchangeResult {
  ok: boolean;
  pageId: string;
  pageName: string;
  expiresLabel: string;
  settings: PublisherSettings;
}

interface SettingsModalProps {
  isOpen: boolean;
  settings: PublisherSettings;
  onClose: () => void;
  onVerifyConnection: () => Promise<FacebookVerifyResult>;
  onExchangeToken: (shortLivedToken?: string) => Promise<FacebookExchangeResult>;
  onSave: (payload: {
    autoPublishEnabled: boolean;
    dryRunMode: boolean;
  }) => Promise<void>;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  settings,
  onClose,
  onVerifyConnection,
  onExchangeToken,
  onSave,
}) => {
  const [autoPublishEnabled, setAutoPublishEnabled] = useState(
    settings.autoPublishEnabled
  );
  const [dryRunMode, setDryRunMode] = useState(settings.dryRunMode);
  const [isSaving, setIsSaving] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<FacebookVerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [freshUserToken, setFreshUserToken] = useState('');
  const [isExchanging, setIsExchanging] = useState(false);
  const [exchangeSuccess, setExchangeSuccess] = useState<string | null>(null);
  const [exchangeError, setExchangeError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setAutoPublishEnabled(settings.autoPublishEnabled);
      setDryRunMode(settings.dryRunMode);
      setVerifyResult(null);
      setVerifyError(null);
      setFreshUserToken('');
      setExchangeSuccess(null);
      setExchangeError(null);
    }
  }, [isOpen, settings]);

  if (!isOpen) return null;

  const tokenStatus = settings.tokenStatus;
  const hasEnvCredentials = Boolean(
    settings.facebookPageId && settings.hasAccessToken
  );

  const handleTestConnection = async () => {
    setIsVerifying(true);
    setVerifyResult(null);
    setVerifyError(null);
    try {
      const res = await onVerifyConnection();
      setVerifyResult(res);
    } catch (err: unknown) {
      setVerifyError(
        err instanceof Error ? err.message : 'Failed to verify Facebook connection.'
      );
    } finally {
      setIsVerifying(false);
    }
  };

  const handleUpgradeToken = async () => {
    setIsExchanging(true);
    setExchangeSuccess(null);
    setExchangeError(null);
    try {
      const trimmed = freshUserToken.trim();
      const res = await onExchangeToken(trimmed || undefined);
      setFreshUserToken('');
      setExchangeSuccess(
        `Permanent Page Token locked for "${res.pageName}" (${res.pageId}) · ${res.expiresLabel}.`
      );
    } catch (err: unknown) {
      setExchangeError(
        err instanceof Error ? err.message : 'Failed to exchange Facebook token.'
      );
    } finally {
      setIsExchanging(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await onSave({
        autoPublishEnabled,
        dryRunMode,
      });
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-[2px] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
    >
      <div className="w-full max-w-xl bg-white border border-[#E4E6EB] rounded-2xl shadow-xl overflow-hidden max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E4E6EB]">
          <div>
            <h2
              id="settings-modal-title"
              className="font-display text-lg font-bold text-[#1C1E21]"
            >
              Facebook Environment &amp; Scheduler Settings
            </h2>
            <p className="text-xs text-[#65676B] mt-0.5">
              Credentials come from server environment secrets. Encrypted Page Tokens &amp; toggles persist in PostgreSQL.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="p-1.5 text-[#65676B] hover:text-[#1C1E21] rounded-lg hover:bg-[#F0F2F5] cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto">
          {tokenStatus?.tokenErrorNotice && (
            <div className="flex items-start gap-2.5 p-3 text-xs text-red-900 bg-red-50 border border-red-200 rounded-xl">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">Facebook Session Expired</div>
                <p className="mt-0.5 leading-relaxed text-red-800">
                  {tokenStatus.tokenErrorNotice}
                </p>
              </div>
            </div>
          )}

          {/* Read-only Environment Secrets Status */}
          <div className="pb-4 border-b border-[#E4E6EB] space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[#1C1E21]">
                <KeyRound className="w-3.5 h-3.5 text-[#1877F2]" />
                <span>Server Environment Secrets</span>
              </div>
              <span
                className={`text-xs font-semibold ${
                  hasEnvCredentials ? 'text-emerald-700' : 'text-amber-700'
                }`}
              >
                {hasEnvCredentials ? 'Configured' : 'Missing Secrets'}
              </span>
            </div>

            <div className="space-y-1.5 text-xs">
              <div className="flex items-center justify-between gap-3 py-1 border-b border-[#E4E6EB]">
                <span className="font-mono text-[#65676B]">FACEBOOK_PAGE_ID</span>
                <span className="font-mono font-medium text-[#1C1E21]">
                  {settings.facebookPageId || 'Not set'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 py-1 border-b border-[#E4E6EB]">
                <span className="font-mono text-[#65676B]">FACEBOOK_ACCESS_TOKEN</span>
                <span className="font-mono font-medium text-[#1C1E21]">
                  {settings.hasAccessToken ? settings.maskedAccessToken : 'Not set'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 py-1 border-b border-[#E4E6EB]">
                <span className="font-mono text-[#65676B]">FACEBOOK_APP_ID / SECRET</span>
                <span
                  className={`font-mono font-medium ${
                    tokenStatus?.hasAppCredentials ? 'text-emerald-700' : 'text-[#65676B]'
                  }`}
                >
                  {tokenStatus?.hasAppCredentials
                    ? 'Configured (Auto-Exchange Ready)'
                    : 'Not set (Optional)'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 py-1">
                <span className="text-[#65676B]">Active Publishing Token</span>
                <span
                  className={`font-medium ${
                    tokenStatus?.hasPermanentStoredToken
                      ? 'text-emerald-700'
                      : 'text-[#1C1E21]'
                  }`}
                >
                  {tokenStatus?.hasPermanentStoredToken
                    ? `Encrypted DB Page Token (${tokenStatus.expiresLabel || 'Never Expires'})`
                    : 'Using Environment Token'}
                </span>
              </div>
            </div>
          </div>

          {/* Test & Permanent Page Token Exchange Section */}
          <div className="p-3.5 bg-[#F7F8FA] border border-[#E4E6EB] rounded-xl space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-semibold text-[#1C1E21]">
                Graph API Connection &amp; Non-Expiring Page Token
              </div>
              <button
                type="button"
                disabled={isVerifying || !hasEnvCredentials}
                onClick={() => void handleTestConnection()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#1C1E21] bg-white border border-[#CCD0D5] hover:bg-[#F0F2F5] disabled:opacity-50 rounded-lg cursor-pointer"
              >
                {isVerifying ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1877F2]" />
                ) : (
                  <PlugZap className="w-3.5 h-3.5 text-[#1877F2]" />
                )}
                <span>{isVerifying ? 'Testing...' : 'Test Connection'}</span>
              </button>
            </div>

            <p className="text-[11px] text-[#65676B] leading-relaxed">
              Short-lived Graph Explorer User Tokens expire in ~2 hours and pause unattended publishing.{' '}
              {tokenStatus?.hasAppCredentials
                ? 'Paste a fresh User Token below (or use your current env token) to exchange & encrypt a permanent Page Access Token in PostgreSQL.'
                : 'Add FACEBOOK_APP_ID and FACEBOOK_APP_SECRET to Secrets to enable 1-click exchange into a never-expiring Page Access Token.'}
            </p>

            {tokenStatus?.hasAppCredentials && (
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="password"
                  value={freshUserToken}
                  onChange={(e) => setFreshUserToken(e.target.value)}
                  placeholder="Optional: paste fresh Graph Explorer token..."
                  autoComplete="off"
                  className="flex-1 px-3 py-2 text-xs font-mono bg-white border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
                />
                <button
                  type="button"
                  disabled={isExchanging || (!freshUserToken.trim() && !hasEnvCredentials)}
                  onClick={() => void handleUpgradeToken()}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-[#1877F2] hover:bg-[#166FE5] disabled:opacity-50 rounded-lg whitespace-nowrap cursor-pointer"
                >
                  {isExchanging ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  <span>Upgrade to Permanent Token</span>
                </button>
              </div>
            )}

            {exchangeError && (
              <div className="flex items-start gap-2 p-2.5 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <span>{exchangeError}</span>
              </div>
            )}

            {exchangeSuccess && (
              <div className="flex items-start gap-2 p-2.5 text-xs text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg">
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                <span>{exchangeSuccess}</span>
              </div>
            )}

            {verifyError && (
              <div className="flex items-start gap-2 p-2.5 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <span>{verifyError}</span>
              </div>
            )}

            {verifyResult && (
              <div
                className={`p-3 text-xs rounded-lg border space-y-1.5 ${
                  verifyResult.warnings.length > 0
                    ? 'bg-amber-50 border-amber-200 text-amber-900'
                    : 'bg-emerald-50 border-emerald-200 text-emerald-900'
                }`}
              >
                <div className="flex items-center gap-1.5 font-semibold">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>
                    Connected to Page: {verifyResult.pageName} ({verifyResult.pageId})
                  </span>
                </div>
                <div className="text-[11px]">
                  Token Status:{' '}
                  <span className="font-mono font-semibold">
                    {verifyResult.permanentExchanged
                      ? 'Auto-upgraded & encrypted permanent Page Token'
                      : verifyResult.resolvedViaAccounts
                        ? 'User Token (Page token resolved)'
                        : verifyResult.isPageToken
                          ? 'Valid Page Token'
                          : 'User Token (Check Warning)'}
                  </span>
                </div>
                {verifyResult.availablePages && verifyResult.availablePages.length > 0 && (
                  <div className="text-[11px] text-[#1C1E21]">
                    Accessible Pages:{' '}
                    {verifyResult.availablePages
                      .map((p) => `${p.name} (${p.id})`)
                      .join(', ')}
                  </div>
                )}
                {verifyResult.warnings.map((w, i) => (
                  <div key={i} className="text-[11px] text-amber-800">
                    • {w}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="pt-2 space-y-3 border-t border-[#E4E6EB]">
            <label className="flex items-center justify-between gap-4 cursor-pointer">
              <div>
                <div className="text-sm font-medium text-[#1C1E21]">
                  Server Background Auto-Publish
                </div>
                <div className="text-xs text-[#65676B]">
                  Continuously check PostgreSQL every 15s and auto-publish due posts.
                </div>
              </div>
              <input
                type="checkbox"
                checked={autoPublishEnabled}
                onChange={(e) => setAutoPublishEnabled(e.target.checked)}
                className="w-4 h-4 accent-[#1877F2] rounded cursor-pointer"
              />
            </label>

            <label className="flex items-center justify-between gap-4 cursor-pointer">
              <div>
                <div className="text-sm font-medium text-[#1C1E21]">
                  Dry Run / Simulation Mode
                </div>
                <div className="text-xs text-[#65676B]">
                  When ON, posts are only simulated locally and <strong>do NOT appear on Facebook</strong>. Turn OFF to publish live.
                </div>
              </div>
              <input
                type="checkbox"
                checked={dryRunMode}
                onChange={(e) => setDryRunMode(e.target.checked)}
                className="w-4 h-4 accent-amber-600 rounded cursor-pointer"
              />
            </label>
          </div>

          <div className="flex items-start gap-2 p-3 bg-[#F7F8FA] border border-[#E4E6EB] rounded-lg text-xs text-[#65676B]">
            <ShieldCheck className="w-4 h-4 text-[#65676B] shrink-0 mt-0.5" />
            <span>
              Live mode posts to{' '}
              <span className="font-mono text-[#1C1E21]">
                https://graph.facebook.com/v27.0/&#123;pageId&#125;/feed
              </span>
              . Note: if your Meta App is in Development Mode, posts are only visible to App Admins/Testers until the App is set to Live.
            </span>
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-[#E4E6EB]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-semibold text-[#1C1E21] bg-[#E4E6EB] hover:bg-[#D8DADF] rounded-lg cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-[#1877F2] hover:bg-[#166FE5] disabled:opacity-60 rounded-lg cursor-pointer"
            >
              {isSaving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Check className="w-4 h-4" />
              )}
              <span>{isSaving ? 'Saving...' : 'Save Settings'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
