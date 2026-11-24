import React from 'react';
import {
  CheckCircle2,
  Clock,
  Edit3,
  ExternalLink,
  FlaskConical,
  Globe,
  Loader2,
  MessageSquare,
  Send,
  Share2,
  ThumbsUp,
  XCircle,
} from 'lucide-react';
import type { ScheduledPost } from '../types';
import { formatDateOnly, formatTime12h } from '../utils/schedule';

interface FacebookFeedPreviewProps {
  post: Pick<
    ScheduledPost,
    | 'id'
    | 'topicName'
    | 'stageLabel'
    | 'seoTitle'
    | 'seoDescription'
    | 'seoTags'
    | 'slotTime'
    | 'scheduledAt'
    | 'status'
    | 'fbPostId'
    | 'isSimulated'
  >;
  pageName?: string;
  compact?: boolean;
  dryRunMode?: boolean;
  isPublishing?: boolean;
  onPublishNow?: (id: string) => void;
  onEdit?: () => void;
}

export const FacebookFeedPreview: React.FC<FacebookFeedPreviewProps> = ({
  post,
  pageName = 'Parvez Dev',
  compact = false,
  dryRunMode = true,
  isPublishing = false,
  onPublishNow,
  onEdit,
}) => {
  const displayTags = post.seoTags
    .map((t) => (t.startsWith('#') ? t : `#${t.replace(/^#+/, '')}`))
    .join(' ');

  return (
    <article className="bg-white border border-[#E4E6EB] rounded-xl overflow-hidden">
      {/* Facebook Post Header */}
      <div className="px-4 pt-3.5 pb-2.5 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-10 h-10 rounded-full bg-[#1877F2] text-white font-display font-bold text-base flex items-center justify-center shrink-0">
            {pageName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-display text-sm font-bold text-[#1C1E21] truncate">
                {pageName}
              </span>
              <CheckCircle2
                className="w-3.5 h-3.5 text-[#1877F2] shrink-0"
                aria-label="Verified Page"
              />
            </div>
            <div className="flex items-center gap-1.5 text-xs text-[#65676B] font-mono tabular-nums">
              <span>{formatDateOnly(post.scheduledAt)}</span>
              <span aria-hidden="true">·</span>
              <span>{formatTime12h(post.slotTime)}</span>
              <span aria-hidden="true">·</span>
              <Globe className="w-3 h-3 text-[#65676B]" aria-label="Public" />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0 text-xs font-medium">
          {post.status === 'POSTED' && !post.isSimulated && (
            <span className="inline-flex items-center gap-1 text-emerald-700">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Live</span>
            </span>
          )}
          {post.status === 'POSTED' && post.isSimulated && (
            <span className="inline-flex items-center gap-1 text-amber-700">
              <FlaskConical className="w-3.5 h-3.5" />
              <span>Simulated</span>
            </span>
          )}
          {post.status === 'PENDING' && (
            <span className="inline-flex items-center gap-1 text-[#1877F2]">
              <Clock className="w-3.5 h-3.5" />
              <span>Scheduled</span>
            </span>
          )}
          {post.status === 'FAILED' && (
            <span className="inline-flex items-center gap-1 text-red-700">
              <XCircle className="w-3.5 h-3.5" />
              <span>Failed</span>
            </span>
          )}
        </div>
      </div>

      {/* Facebook Feed Post Body */}
      <div className="px-4 pb-3 space-y-2 text-[14px] text-[#1C1E21] leading-relaxed">
        <div className="font-display font-bold text-[15px] text-[#1C1E21]">
          {post.seoTitle}
        </div>
        <p
          className={`whitespace-pre-line text-[#1C1E21] ${
            compact ? 'line-clamp-5' : ''
          }`}
        >
          {post.seoDescription}
        </p>
        {displayTags && (
          <div className="text-[13px] font-medium text-[#1877F2] break-words">
            {displayTags}
          </div>
        )}
      </div>

      {/* Quiet Topic Metadata Line */}
      <div className="px-4 py-2 border-t border-[#E4E6EB] bg-[#F7F8FA] flex flex-wrap items-center justify-between gap-2 text-xs text-[#65676B]">
        <div className="truncate">
          {post.topicName} <span aria-hidden="true">·</span> {post.stageLabel}
        </div>
        {post.status === 'POSTED' && !post.isSimulated && post.fbPostId && (
          <a
            href={`https://www.facebook.com/${encodeURIComponent(post.fbPostId)}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[#1877F2] font-medium hover:underline whitespace-nowrap"
          >
            <span>View on Facebook</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      {/* Realistic FB Footer + Action Bar */}
      {(onPublishNow || onEdit) ? (
        <div className="px-4 py-2.5 border-t border-[#E4E6EB] flex items-center justify-between gap-2">
          <div className="hidden sm:flex items-center gap-4 text-xs text-[#65676B]">
            <span className="inline-flex items-center gap-1">
              <ThumbsUp className="w-3.5 h-3.5" /> Like
            </span>
            <span className="inline-flex items-center gap-1">
              <MessageSquare className="w-3.5 h-3.5" /> Comment
            </span>
            <span className="inline-flex items-center gap-1">
              <Share2 className="w-3.5 h-3.5" /> Share
            </span>
          </div>

          <div className="flex items-center gap-2 ml-auto">
            {onEdit && (
              <button
                type="button"
                onClick={onEdit}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#1C1E21] bg-[#E4E6EB] hover:bg-[#D8DADF] rounded-lg transition-colors cursor-pointer whitespace-nowrap"
              >
                <Edit3 className="w-3.5 h-3.5" />
                <span>Edit</span>
              </button>
            )}
            {onPublishNow && (
              <button
                type="button"
                disabled={isPublishing}
                onClick={() => onPublishNow(post.id)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-[#1877F2] hover:bg-[#166FE5] disabled:opacity-60 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
              >
                {isPublishing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                <span>{dryRunMode ? 'Simulate Post' : 'Publish to FB'}</span>
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="px-4 py-2 border-t border-[#E4E6EB] flex items-center justify-around text-xs font-medium text-[#65676B]">
          <span className="inline-flex items-center gap-1.5 py-1">
            <ThumbsUp className="w-3.5 h-3.5" /> Like
          </span>
          <span className="inline-flex items-center gap-1.5 py-1">
            <MessageSquare className="w-3.5 h-3.5" /> Comment
          </span>
          <span className="inline-flex items-center gap-1.5 py-1">
            <Share2 className="w-3.5 h-3.5" /> Share
          </span>
        </div>
      )}
    </article>
  );
};
