import React, { useState } from 'react';
import { Terminal, Trash2, CheckCircle2, AlertTriangle, XCircle, Info } from 'lucide-react';
import type { ActivityLogEntry } from '../types';
import { formatShortTime } from '../utils/schedule';

interface ActivityConsoleProps {
  logs: ActivityLogEntry[];
  onClearLogs: () => void;
  expanded?: boolean;
}

type LogFilter = 'all' | 'issues' | 'success';

export const ActivityConsole: React.FC<ActivityConsoleProps> = ({
  logs,
  onClearLogs,
  expanded = false,
}) => {
  const [filter, setFilter] = useState<LogFilter>('all');

  const filteredLogs = logs.filter((entry) => {
    if (filter === 'issues') {
      return entry.level === 'warning' || entry.level === 'error';
    }
    if (filter === 'success') {
      return entry.level === 'success';
    }
    return true;
  });

  const renderIcon = (level: ActivityLogEntry['level']) => {
    switch (level) {
      case 'success':
        return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />;
      case 'warning':
        return <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />;
      case 'error':
        return <XCircle className="w-3.5 h-3.5 text-red-600 shrink-0 mt-0.5" />;
      default:
        return <Info className="w-3.5 h-3.5 text-[#65676B] shrink-0 mt-0.5" />;
    }
  };

  return (
    <section
      id="activity-section"
      className="bg-white border border-[#E4E6EB] rounded-xl p-4 sm:p-5"
      aria-labelledby="activity-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-[#1877F2]" />
          <h2
            id="activity-heading"
            className="font-display text-base font-bold text-[#1C1E21]"
          >
            Activity Console
          </h2>
        </div>

        <button
          type="button"
          onClick={onClearLogs}
          disabled={logs.length === 0}
          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-[#65676B] hover:text-[#1C1E21] hover:bg-[#F0F2F5] rounded-md disabled:opacity-40 cursor-pointer"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>Clear</span>
        </button>
      </div>

      <div className="flex items-center gap-1 p-1 bg-[#F0F2F5] rounded-lg mb-3">
        {(
          [
            { id: 'all', label: 'All Events' },
            { id: 'success', label: 'Published' },
            { id: 'issues', label: 'Warnings & Errors' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setFilter(tab.id)}
            className={`flex-1 py-1.5 px-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              filter === tab.id
                ? 'bg-white text-[#1877F2] shadow-xs font-semibold'
                : 'text-[#65676B] hover:text-[#1C1E21]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        className={`divide-y divide-[#E4E6EB] overflow-y-auto ${
          expanded ? 'max-h-[540px]' : 'h-72'
        }`}
      >
        {filteredLogs.length === 0 ? (
          <div className="h-48 flex items-center justify-center text-xs text-[#65676B] text-center px-4">
            No activity recorded yet. Generate a series or trigger a scheduler check to view live events.
          </div>
        ) : (
          filteredLogs.map((entry) => (
            <div
              key={entry.id}
              className="flex items-start gap-2.5 text-xs py-2.5 first:pt-1 last:pb-1"
            >
              {renderIcon(entry.level)}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[11px] font-mono tabular-nums text-[#65676B]">
                  <span>{formatShortTime(entry.timestamp)}</span>
                  <span aria-hidden="true">·</span>
                  <span className="capitalize font-medium">
                    {entry.category}
                  </span>
                </div>
                <p className="text-[#1C1E21] mt-0.5 leading-snug break-words">
                  {entry.message}
                </p>
                {entry.detail && (
                  <p className="mt-1 font-mono text-[11px] text-[#65676B] break-all">
                    {entry.detail}
                  </p>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
};
