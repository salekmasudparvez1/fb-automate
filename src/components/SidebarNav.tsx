import React from 'react';
import {
  CalendarPlus,
  LayoutDashboard,
  LogOut,
  Newspaper,
  ShieldCheck,
  SlidersHorizontal,
  Table2,
  Terminal,
  X,
} from 'lucide-react';
import { formatTime12h } from '../utils/schedule';

export type DashboardView =
  | 'overview'
  | 'schedule'
  | 'planner'
  | 'previews'
  | 'activity';

interface SidebarNavProps {
  activeView: DashboardView;
  onSelectView: (view: DashboardView) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onOpenSettings: () => void;
  onOpenSecurity: () => void;
  onSignOut: () => void;
  userEmail: string;
  facebookPageId: string;
  hasAccessToken: boolean;
  recurringTimes: string[];
  counts: {
    all: number;
    pending: number;
    livePosted: number;
    failed: number;
  };
  logsCount: number;
}

export const SidebarNav: React.FC<SidebarNavProps> = ({
  activeView,
  onSelectView,
  mobileOpen,
  onCloseMobile,
  onOpenSettings,
  onOpenSecurity,
  onSignOut,
  userEmail,
  facebookPageId,
  hasAccessToken,
  recurringTimes,
  counts,
  logsCount,
}) => {
  const navItems: Array<{
    id: DashboardView;
    label: string;
    Icon: React.ComponentType<{ className?: string }>;
    count?: number;
  }> = [
    { id: 'overview', label: 'Overview', Icon: LayoutDashboard },
    { id: 'schedule', label: 'Schedule Table', Icon: Table2, count: counts.all },
    { id: 'planner', label: 'Monthly Planner', Icon: CalendarPlus, count: counts.pending },
    { id: 'previews', label: 'FB Feed Preview', Icon: Newspaper },
    { id: 'activity', label: 'Activity Console', Icon: Terminal, count: logsCount },
  ];

  const handleSelect = (view: DashboardView) => {
    onSelectView(view);
    onCloseMobile();
  };

  const sidebarContent = (
    <div className="flex flex-col h-full bg-white border-r border-[#E4E6EB]">
      {/* Brand Header */}
      <div className="h-16 px-5 flex items-center justify-between border-b border-[#E4E6EB] shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-full bg-[#1877F2] text-white flex items-center justify-center font-display font-extrabold text-xl leading-none shrink-0">
            f
          </div>
          <div className="min-w-0">
            <div className="font-display text-sm font-bold text-[#1C1E21] truncate">
              Page Studio
            </div>
            <div className="text-[11px] text-[#65676B] truncate">
              {facebookPageId ? `Page ${facebookPageId}` : 'Auto-Publisher'}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation menu"
          className="lg:hidden p-2 text-[#65676B] hover:text-[#1C1E21] hover:bg-[#F0F2F5] rounded-lg cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Primary Workspace Navigation */}
      <nav aria-label="Dashboard sections" className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {navItems.map(({ id, label, Icon, count }) => {
          const active = activeView === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => handleSelect(id)}
              aria-current={active ? 'page' : undefined}
              className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer min-h-[42px] ${
                active
                  ? 'bg-[#E7F3FF] text-[#1877F2] font-semibold'
                  : 'text-[#1C1E21] hover:bg-[#F0F2F5]'
              }`}
            >
              <span className="flex items-center gap-3 min-w-0">
                <Icon
                  className={`w-4 h-4 shrink-0 ${
                    active ? 'text-[#1877F2]' : 'text-[#65676B]'
                  }`}
                />
                <span className="truncate">{label}</span>
              </span>
              {typeof count === 'number' && (
                <span
                  className={`font-mono tabular-nums text-xs ${
                    active ? 'text-[#1877F2]' : 'text-[#65676B]'
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}

        <div className="pt-4 mt-4 border-t border-[#E4E6EB] px-3 space-y-2">
          <div className="text-xs font-semibold text-[#65676B]">
            Daily Posting Slots
          </div>
          <div className="text-xs font-mono tabular-nums text-[#1C1E21] leading-relaxed">
            {recurringTimes.length > 0
              ? recurringTimes.map(formatTime12h).join(' · ')
              : 'No slots configured'}
          </div>
          <div className="text-[11px] text-[#65676B]">
            {facebookPageId && hasAccessToken
              ? 'Facebook secrets active'
              : 'Add FB secrets in Env'}
          </div>
        </div>
      </nav>

      {/* Footer Actions & Account */}
      <div className="p-3 border-t border-[#E4E6EB] space-y-1.5 shrink-0">
        <button
          type="button"
          onClick={() => {
            onOpenSecurity();
            onCloseMobile();
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium text-[#1C1E21] hover:bg-[#F0F2F5] rounded-lg transition-colors cursor-pointer min-h-[40px]"
        >
          <ShieldCheck className="w-4 h-4 text-[#1877F2]" />
          <span>Security &amp; JWT</span>
        </button>

        <button
          type="button"
          onClick={() => {
            onOpenSettings();
            onCloseMobile();
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium text-[#1C1E21] hover:bg-[#F0F2F5] rounded-lg transition-colors cursor-pointer min-h-[40px]"
        >
          <SlidersHorizontal className="w-4 h-4 text-[#65676B]" />
          <span>Page Settings</span>
        </button>

        <div className="px-3 py-2 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-medium text-[#1C1E21] truncate">
              {userEmail}
            </div>
            <div className="text-[11px] text-[#65676B]">
              Administrator
            </div>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            title="Sign Out"
            aria-label="Sign Out"
            className="p-2 text-[#65676B] hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors cursor-pointer shrink-0"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Persistent Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 sticky top-0 h-screen">
        {sidebarContent}
      </aside>

      {/* Mobile / Tablet Slide-Over Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-[1px]"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <div className="relative w-72 max-w-[85vw] h-full z-10 shadow-xl">
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  );
};
