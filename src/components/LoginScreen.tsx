import React, { useState } from 'react';
import { Lock, Mail, Loader2, AlertCircle, Database, KeyRound } from 'lucide-react';
import type { AuthStatus } from '../types';

interface LoginScreenProps {
  authStatus: AuthStatus;
  onAuthenticated: (token: string, email: string) => void;
  onRefreshStatus: () => Promise<void>;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({
  authStatus,
  onAuthenticated,
  onRefreshStatus,
}) => {
  const [email, setEmail] = useState(authStatus.allowedEmail);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSetup = authStatus.setupRequired;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail !== authStatus.allowedEmail.toLowerCase()) {
      setError(`Only ${authStatus.allowedEmail} has permission to log in.`);
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: normalizedEmail,
          password,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        token?: string;
        email?: string;
        error?: string;
      };

      if (!res.ok || !data.token || !data.email) {
        throw new Error(data.error || 'Authentication failed.');
      }

      onAuthenticated(data.token, data.email);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center px-4 py-12">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
        <div className="mb-6">
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            FB Series Auto-Publisher
          </h1>
          <p className="mt-1.5 text-sm text-slate-600">
            {isSetup
              ? 'First-run setup: claim your administrator password in PostgreSQL.'
              : 'Sign in with your authorized administrator account.'}
          </p>
        </div>

        {!authStatus.dbConnected && (
          <div className="mb-5 p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 space-y-1.5">
            <div className="flex items-center gap-1.5 font-semibold">
              <Database className="w-4 h-4 text-amber-700 shrink-0" />
              <span>PostgreSQL Connection Required</span>
            </div>
            <p className="leading-relaxed">
              {authStatus.dbError ||
                'Set DATABASE_URL in Settings > Secrets so scheduled posts, activity logs, and credentials persist.'}
            </p>
            <button
              type="button"
              onClick={() => void onRefreshStatus()}
              className="text-amber-900 underline font-medium cursor-pointer"
            >
              Retry Connection Check
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="auth-email"
              className="block text-sm font-medium text-slate-800 mb-1.5"
            >
              Authorized Email
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="auth-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={authStatus.allowedEmail}
                disabled={isSubmitting}
                className="w-full pl-9 pr-3.5 py-2.5 text-sm text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              />
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Restricted to <span className="font-mono">{authStatus.allowedEmail}</span>
            </p>
          </div>

          <div>
            <label
              htmlFor="auth-password"
              className="block text-sm font-medium text-slate-800 mb-1.5"
            >
              {isSetup ? 'Set Administrator Password' : 'Password'}
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="auth-password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isSetup ? 'Enter administrator password' : 'Enter password'}
                disabled={isSubmitting}
                className="w-full pl-9 pr-3.5 py-2.5 text-sm text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              />
            </div>
          </div>

          {isSetup && (
            <div>
              <label
                htmlFor="auth-password-confirm"
                className="block text-sm font-medium text-slate-800 mb-1.5"
              >
                Confirm Password
              </label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="auth-password-confirm"
                  type="password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  disabled={isSubmitting}
                  className="w-full pl-9 pr-3.5 py-2.5 text-sm text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
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
            className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:bg-blue-400 rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer"
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
