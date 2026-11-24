import React, { useState } from 'react';
import { Lock, Mail, Loader2, AlertCircle, Database, KeyRound } from 'lucide-react';
import type { AuthStatus } from '../types';

interface LoginScreenProps {
  authStatus: AuthStatus;
  onAuthenticated: (payload: {
    token: string;
    email: string;
    expiresAt?: string | null;
    sid?: string | null;
    jtiPrefix?: string | null;
    tokenVersion?: number | null;
  }) => void;
  onRefreshStatus: () => Promise<void>;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({
  authStatus,
  onAuthenticated,
  onRefreshStatus,
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSetup = authStatus.setupRequired;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      setError('Email is required.');
      return;
    }

    if (!password) {
      setError('Password is required.');
      return;
    }

    if (isSetup) {
      if (password.length < 8) {
        setError('Password must be at least 8 characters long.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const endpoint = isSetup ? '/api/auth/claim' : '/api/auth/login';
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          email: normalizedEmail,
          password,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        token?: string;
        email?: string;
        expiresAt?: string;
        sid?: string;
        jtiPrefix?: string;
        tokenVersion?: number;
        error?: string;
      };

      if (!res.ok || !data.token || !data.email) {
        throw new Error(data.error || 'Authentication failed.');
      }

      onAuthenticated({
        token: data.token,
        email: data.email,
        expiresAt: data.expiresAt ?? null,
        sid: data.sid ?? null,
        jtiPrefix: data.jtiPrefix ?? null,
        tokenVersion: data.tokenVersion ?? null,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F0F2F5] flex flex-col justify-center items-center px-4 py-10 sm:py-16">
      <div className="w-full max-w-[440px] bg-white border border-[#E4E6EB] rounded-2xl shadow-sm p-6 sm:p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-11 h-11 rounded-full bg-[#1877F2] text-white flex items-center justify-center font-display font-extrabold text-2xl leading-none shrink-0">
            f
          </div>
          <div>
            <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-[#1C1E21]">
              FB Page Studio
            </h1>
            <p className="text-xs text-[#65676B]">
              {isSetup
                ? 'First-run setup: claim your administrator password.'
                : 'Sign in to manage your automated publishing schedule.'}
            </p>
          </div>
        </div>

        {!authStatus.dbConnected && (
          <div className="mb-5 p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 space-y-1.5">
            <div className="flex items-center gap-1.5 font-semibold">
              <Database className="w-4 h-4 text-amber-700 shrink-0" />
              <span>Service Temporarily Unavailable</span>
            </div>
            <p className="leading-relaxed">
              Backend storage is not ready yet. Please try again in a moment.
            </p>
            <button
              type="button"
              onClick={() => void onRefreshStatus()}
              className="text-amber-900 underline font-medium cursor-pointer"
            >
              Retry Connection
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="auth-email"
              className="block text-sm font-medium text-[#1C1E21] mb-1.5"
            >
              Email
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-[#65676B] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="auth-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                disabled={isSubmitting}
                className="w-full pl-9 pr-3.5 py-2.5 text-sm text-[#1C1E21] bg-white border border-[#CCD0D5] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1877F2]/20 focus:border-[#1877F2]"
              />
            </div>
            <p className="mt-1 text-xs text-[#65676B]">
              Authorized administrator access only.
            </p>
          </div>

          <div>
            <label
              htmlFor="auth-password"
              className="block text-sm font-medium text-[#1C1E21] mb-1.5"
            >
              {isSetup ? 'Set Administrator Password' : 'Password'}
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-[#65676B] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="auth-password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isSetup ? 'Enter administrator password' : 'Enter password'}
                disabled={isSubmitting}
                className="w-full pl-9 pr-3.5 py-2.5 text-sm text-[#1C1E21] bg-white border border-[#CCD0D5] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1877F2]/20 focus:border-[#1877F2]"
              />
            </div>
          </div>

          {isSetup && (
            <div>
              <label
                htmlFor="auth-password-confirm"
                className="block text-sm font-medium text-[#1C1E21] mb-1.5"
              >
                Confirm Password
              </label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-[#65676B] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="auth-password-confirm"
                  type="password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  disabled={isSubmitting}
                  className="w-full pl-9 pr-3.5 py-2.5 text-sm text-[#1C1E21] bg-white border border-[#CCD0D5] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1877F2]/20 focus:border-[#1877F2]"
                />
              </div>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 p-3 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg"
            >
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting || (!authStatus.dbConnected && isSetup)}
            className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-[#1877F2] hover:bg-[#166FE5] disabled:bg-[#1877F2]/60 rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer min-h-[44px]"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{isSetup ? 'Saving Admin Password...' : 'Signing In...'}</span>
              </>
            ) : (
              <span>{isSetup ? 'Claim Admin Access & Sign In' : 'Sign In'}</span>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
