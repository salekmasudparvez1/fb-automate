import React, { useState, useEffect } from 'react';
import { Eye, EyeOff, X, ShieldCheck, Check, Loader2 } from 'lucide-react';
import type { PublisherSettings } from '../types';

interface SettingsModalProps {
  isOpen: boolean;
  settings: PublisherSettings;
  onClose: () => void;
  onSave: (payload: {
    facebookPageId: string;
    facebookAccessToken?: string;
    clearAccessToken?: boolean;
    autoPublishEnabled: boolean;
    dryRunMode: boolean;
  }) => Promise<void>;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  settings,
  onClose,
  onSave,
}) => {
  const [facebookPageId, setFacebookPageId] = useState(settings.facebookPageId);
  const [newToken, setNewToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [autoPublishEnabled, setAutoPublishEnabled] = useState(
    settings.autoPublishEnabled
  );
  const [dryRunMode, setDryRunMode] = useState(settings.dryRunMode);
  const [showToken, setShowToken] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setFacebookPageId(settings.facebookPageId);
      setNewToken('');
      setClearToken(false);
      setAutoPublishEnabled(settings.autoPublishEnabled);
      setDryRunMode(settings.dryRunMode);
      setShowToken(false);
    }
  }, [isOpen, settings]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await onSave({
        facebookPageId: facebookPageId.trim(),
        facebookAccessToken: newToken.trim() || undefined,
        clearAccessToken: clearToken,
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
      <div className="w-full max-w-lg bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h2
              id="settings-modal-title"
              className="font-display text-lg font-bold text-slate-900"
            >
              Facebook Page &amp; Background Scheduler Settings
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Persisted in PostgreSQL so the server background scheduler continues running 24/7.
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

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label
              htmlFor="fb-page-id"
              className="block text-sm font-medium text-slate-800 mb-1.5"
            >
              Facebook Page ID
            </label>
            <input
              id="fb-page-id"
              type="text"
              value={facebookPageId}
              onChange={(e) => setFacebookPageId(e.target.value)}
              placeholder="e.g., 104928374651234"
              className="w-full px-3.5 py-2 text-sm font-mono text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="fb-access-token"
                className="block text-sm font-medium text-slate-800"
              >
                Facebook Page Access Token
              </label>
              {settings.hasAccessToken && !clearToken && (
                <span className="text-xs font-mono text-emerald-700">
                  Saved: {settings.maskedAccessToken}
                </span>
              )}
            </div>
            <div className="relative">
              <input
                id="fb-access-token"
                type={showToken ? 'text' : 'password'}
                value={newToken}
                onChange={(e) => {
                  setNewToken(e.target.value);
                  setClearToken(false);
                }}
                placeholder={
                  settings.hasAccessToken && !clearToken
                    ? 'Leave blank to keep existing token'
                    : 'Paste Page Access Token (EAAB...)'
                }
                className="w-full pl-3.5 pr-10 py-2 text-sm font-mono text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              />
              <button
                type="button"
                onClick={() => setShowToken((prev) => !prev)}
                aria-label={showToken ? 'Hide token' : 'Show token'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                {showToken ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-xs text-slate-500">
              <span>
                Requires <span className="font-mono">pages_manage_posts</span> scope.
              </span>
              {settings.hasAccessToken && !clearToken && (
                <button
                  type="button"
                  onClick={() => setClearToken(true)}
                  className="text-red-600 hover:underline cursor-pointer"
                >
                  Clear stored token
                </button>
              )}
            </div>
          </div>

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
                  Test recurring time slots safely without posting to live Facebook.
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
              Live mode posts directly from the backend to{' '}
              <span className="font-mono text-slate-800">
                https://graph.facebook.com/v27.0/&#123;pageId&#125;/feed
              </span>
              .
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
