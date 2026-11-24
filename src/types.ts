export type PostStatus = 'PENDING' | 'POSTED' | 'FAILED';

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

export interface PublisherSettings {
  facebookPageId: string;
  hasAccessToken: boolean;
  maskedAccessToken: string;
  autoPublishEnabled: boolean;
  dryRunMode: boolean;
  recurringTimes: string[];
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

export interface AuthStatus {
  authenticated: boolean;
  email: string | null;
  token?: string | null;
  allowedEmail: string;
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
