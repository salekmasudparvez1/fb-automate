import React, { useState, useEffect } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  KeyRound,
  Loader2,
  PlugZap,
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
  tokenOwnerName: string | null;
  availablePages?: Array<{ id: string; name: string }>;
  warnings: string[];
}

interface SettingsModalProps {
  isOpen: boolean;
  settings: PublisherSettings;
  onClose: () => void;
  onVerifyConnection: () => Promise<FacebookVerifyResult>;
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

  useEffect(() => {
    if (isOpen) {
      setAutoPublishEnabled(settings.autoPublishEnabled);
      setDryRunMode(settings.dryRunMode);
      setVerifyResult(null);
      setVerifyError(null);
    }
  }, [isOpen, settings]);

  if (!isOpen) return null;

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

  const hasEnvCredentials = Boolean(
    settings.facebookPageId && settings.hasAccessToken
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-[2px] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
    >
      <div className="w-full max-w-lg bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h2
              id="settings-modal-title"
              className="font-display text-lg font-bold text-slate-900"
            >
              Facebook Environment &amp; Scheduler Settings
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Facebook credentials are read from server environment secrets. Scheduler toggles persist in PostgreSQL.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto">
          {/* Read-only Environment Secrets Status */}
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                <KeyRound className="w-3.5 h-3.5 text-blue-700" />
                <span>Server Environment Secrets</span>
              </div>
              <span
                className={`px-2 py-0.5 text-[11px] font-semibold rounded-full border ${
                  hasEnvCredentials
                    ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                    : 'bg-amber-50 text-amber-800 border-amber-200'
                }`}
              >
                {hasEnvCredentials ? 'Configured' : 'Missing Secrets'}
              </span>
            </div>

            <div className="space-y-1.5 text-xs">
              <div className="flex items-center justify-between gap-3 py-1 border-b border-slate-200/70">
                <span className="font-mono text-slate-600">FACEBOOK_PAGE_ID</span>
                <span className="font-mono font-medium text-slate-900">
                  {settings.facebookPageId || 'Not set'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 py-1">
                <span className="font-mono text-slate-600">FACEBOOK_ACCESS_TOKEN</span>
                <span className="font-mono font-medium text-slate-900">
                  {settings.hasAccessToken ? settings.maskedAccessToken : 'Not set'}
                </span>
              </div>
            </div>

            <p className="text-[11px] text-slate-500 leading-relaxed">
              Manage these values in your platform <strong>Secrets / Environment Variables</strong> panel (no secrets are stored in browser inputs).
            </p>
          </div>

          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              disabled={isVerifying || !hasEnvCredentials}
              onClick={() => void handleTestConnection()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 border border-slate-300 rounded-lg cursor-pointer"
            >
              {isVerifying ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-700" />
              ) : (
                <PlugZap className="w-3.5 h-3.5 text-blue-700" />
              )}
              <span>{isVerifying ? 'Testing Graph API...' : 'Test Facebook Connection'}</span>
            </button>
          </div>

          {verifyError && (
            <div className="flex items-start gap-2 p-3 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg">
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
                Token Type:{' '}
                <span className="font-mono font-semibold">
                  {verifyResult.resolvedViaAccounts
                    ? 'User Token (Auto-exchanging to Page Token)'
                    : verifyResult.isPageToken
                      ? 'Valid Page Token'
                      : 'User Token (Check Warning)'}
                </span>
              </div>
              {verifyResult.availablePages && verifyResult.availablePages.length > 0 && (
                <div className="text-[11px] text-slate-700">
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

          <div className="pt-2 space-y-3 border-t border-slate-100">
            <label className="flex items-center justify-between gap-4 cursor-pointer">
              <div>
                <div className="text-sm font-medium text-slate-900">
                  Server Background Auto-Publish
                </div>
                <div className="text-xs text-slate-500">
                  Continuously check PostgreSQL every 15s and auto-publish due posts.
                </div>
              </div>
              <input
                type="checkbox"
                checked={autoPublishEnabled}
                onChange={(e) => setAutoPublishEnabled(e.target.checked)}
                className="w-4 h-4 accent-blue-700 rounded cursor-pointer"
              />
            </label>

            <label className="flex items-center justify-between gap-4 cursor-pointer">
              <div>
                <div className="text-sm font-medium text-slate-900">
                  Dry Run / Simulation Mode
                </div>
                <div className="text-xs text-slate-500">
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

          <div className="flex items-start gap-2 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
            <ShieldCheck className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
            <span>
              Live mode posts to{' '}
              <span className="font-mono text-slate-800">
                https://graph.facebook.com/v27.0/&#123;pageId&#125;/feed
              </span>
              . Note: if your Meta App is in Development Mode, posts are only visible to App Admins/Testers until the App is set to Live.
            </span>
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:bg-blue-400 rounded-lg cursor-pointer"
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
