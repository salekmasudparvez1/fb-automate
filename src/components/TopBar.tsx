import React from 'react';
import { Menu, Plus } from 'lucide-react';
import type { DashboardView } from './SidebarNav';

interface TopBarProps {
  activeView: DashboardView;
  onOpenMobileMenu: () => void;
  onOpenCreatePost: () => void;
}

const VIEW_LABELS: Record<DashboardView, string> = {
  overview: 'Overview',
  schedule: 'Schedule Table',
  planner: 'Monthly Planner',
  previews: 'FB Feed Preview',
  activity: 'Activity Console',
};

export const TopBar: React.FC<TopBarProps> = ({
  activeView,
  onOpenMobileMenu,
  onOpenCreatePost,
}) => {
  return (
    <header className="sticky top-0 z-30 bg-white border-b border-[#E4E6EB]">
      <div className="px-4 sm:px-6 lg:px-8 h-14 sm:h-16 flex items-center justify-between gap-4 sm:gap-8">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onOpenMobileMenu}
            aria-label="Open navigation menu"
            className="lg:hidden p-2 -ml-2 text-[#1C1E21] hover:bg-[#F0F2F5] rounded-lg cursor-pointer shrink-0"
          >
            <Menu className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-2 min-w-0 text-sm whitespace-nowrap">
            <span className="font-display font-bold text-[#1C1E21] hidden sm:inline">
              FB Series Auto-Publisher
            </span>
            <span className="text-[#BCC0C4] hidden sm:inline" aria-hidden="true">
              /
            </span>
            <span className="font-display font-semibold text-[#1877F2] truncate">
              {VIEW_LABELS[activeView]}
            </span>
          </div>
        </div>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={onOpenCreatePost}
            className="inline-flex items-center gap-1.5 px-3.5 sm:px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-[#1877F2] hover:bg-[#166FE5] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1877F2]"
          >
            <Plus className="w-4 h-4" />
            <span>Create Post</span>
          </button>
        </div>
      </div>
    </header>
  );
};
