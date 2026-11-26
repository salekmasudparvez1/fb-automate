export type PostStatus = 'PENDING' | 'POSTED' | 'FAILED';
export type MediaType = 'none' | 'image' | 'video';

export interface ScheduledPost {
  id: string;
  monthKey: string;
  topicName: string;
  partNumber: number;
  totalParts: number;
  stageLabel: string;
  seoTitle: string;
  seoDescription: string;
  seoTags: string[];
  mediaType: MediaType;
  mediaUrl?: string;
  mediaPublicId?: string;
  slotTime: string;
  scheduledAt: string;
  status: PostStatus;
  fbPostId?: string;
  publishedAt?: string;
  isSimulated?: boolean;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FacebookTokenStatus {
  hasPermanentStoredToken: boolean;
  expiresLabel: string | null;
  tokenErrorNotice: string | null;
  hasAppCredentials: boolean;
}

export interface CloudinaryMediaConfig {
  configured: boolean;
  cloudName: string;
  maskedApiKey: string;
}

export interface PublisherSettings {
  facebookPageId: string;
  hasAccessToken: boolean;
  maskedAccessToken: string;
  autoPublishEnabled: boolean;
  dryRunMode: boolean;
  recurringTimes: string[];
  tokenStatus?: FacebookTokenStatus;
  mediaConfig?: CloudinaryMediaConfig;
}

export interface BulkImportRowPayload {
  topicName: string;
  stageLabel: string;
  seoTitle: string;
  seoDescription: string;
  seoTags: string[];
  mediaType: MediaType;
  mediaUrl?: string;
  slotTime: string;
  scheduledAt: string;
  monthKey: string;
  warnings: string[];
}

export type PostSortOrder = 'asc' | 'desc' | 'updated';

export interface PaginationMeta {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface PaginatedPostsResponse {
  posts: ScheduledPost[];
  pagination: PaginationMeta;
  counts: {
    all: number;
    pending: number;
    posted: number;
    simulated: number;
    failed: number;
  };
  availableMonths: string[];
}

export type ActivityLevel = 'info' | 'success' | 'warning' | 'error';
export type ActivityCategory =
  | 'scheduler'
  | 'gemini'
  | 'facebook'
  | 'storage'
  | 'auth'
  | 'socket';

export interface ActivityLogEntry {
  id: string;
  timestamp: string;
  level: ActivityLevel;
  category: ActivityCategory;
  message: string;
  detail?: string;
}

export type QueueFilter = 'ALL' | 'PENDING' | 'POSTED' | 'FAILED';

export interface AuthSecurityInfo {
  passwordAlgorithm: string;
  passwordStoredInDb: boolean;
  envPasswordOverride: boolean;
  jwtAlgorithm: string;
  accessTtlMinutes: number;
  refreshTtlDays: number;
  activeSessionsCount?: number;
  tokenVersion?: number;
  lastLoginAt?: string | null;
  passwordUpdatedAt?: string | null;
}

export interface AuthSessionItem {
  sid: string;
  jtiPrefix: string;
  userAgent: string;
  ipAddress: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export interface AuthStatus {
  authenticated: boolean;
  email: string | null;
  token?: string | null;
  expiresAt?: string | null;
  sid?: string | null;
  jtiPrefix?: string | null;
  tokenVersion?: number | null;
  realtimeMode?: 'websocket' | 'http-sync';
  setupRequired: boolean;
  dbConnected: boolean;
  dbError: string | null;
}

export interface SchedulerStatus {
  intervalSeconds: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  autoPublishEnabled?: boolean;
}
