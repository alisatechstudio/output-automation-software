export interface FacebookPage {
  _id: string; // Facebook Page ID
  name: string;
  accessToken: string;
  tokenExpiresAt?: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface YouTubeChannel {
  _id: string; // YouTube Channel ID (e.g. UCxxxx)
  title: string;
  customUrl?: string;
  refreshToken: string;
  clientId?: string;
  clientSecret?: string;
  targetPageId?: string;
  autoUpload: boolean;
  isActive: boolean;
  videoCount?: string;
  createdAt?: Date;
  updatedAt: Date;
}

export interface FacebookGroup {
  _id: string;
  name: string;
  categories: string[];
  autoShare: boolean;
  isActive?: boolean;
  pageId?: string;
  accessToken?: string | null;
  delaySeconds?: number;
  totalShares?: number;
  lastSharedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TelegramChannel {
  _id: string; // Chat ID or Channel ID e.g. -100xxxxxxxx or @channel
  title: string;
  username?: string;
  botToken?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface GroupShareRecord {
  groupId: string;
  groupName: string;
  fbSharePostId?: string;
  status: 'success' | 'failed';
  errorMessage?: string;
  sharedAt: Date;
}

export interface GroupShareLog {
  _id: string;
  groupId: string;
  groupName: string;
  articleId: string;
  articleTitle: string;
  fbPostId: string;
  sharePostId?: string | null;
  status: 'success' | 'failed' | 'dry_run' | 'skipped';
  errorMessage?: string | null;
  durationMs?: number | null;
  createdAt: Date;
}

export interface GDriveReelConfig {
  _id: string;
  name?: string;
  folderUrlOrId: string;
  folderId: string;
  apiKey?: string;
  pageId: string;
  pageName?: string;
  youtubeChannelId?: string;
  autoPostYouTube?: boolean;
  autoPostTikTok?: boolean;
  tiktokAccessToken?: string;
  autoPostTelegram?: boolean;
  telegramChannelId?: string;
  postStory?: boolean;
  shareToGroups?: boolean;
  sourceId?: string;
  isActive: boolean;
  scheduleIntervalHours: number;
  cronExpression?: string;
  category?: string;
  customHashtags?: string;
  captionStrategy: 'viral_hashtags' | 'custom';
  customCaption?: string;
  firstCommentText?: string;
  orderStrategy: 'oldest_first' | 'newest_first' | 'alphabetical' | 'random';
  postedVideoIds: string[];
  postedVideoNames: string[];
  lastPostedAt?: Date | null;
  lastPostedFile?: string | null;
  deleteAfterPosting?: boolean;
  deleteAction?: 'trash' | 'permanent';
  createdAt: Date;
  updatedAt: Date;
}

export interface ReelLog {
  _id: string;
  articleId?: string | null;
  articleTitle: string;
  pageId: string;
  pageName: string;
  theme?: string;
  fbVideoId: string;
  fbPostId: string;
  fbCommentId?: string | null;
  durationMs?: number | null;
  status: 'success' | 'failed' | 'dry_run';
  errorMessage?: string | null;
  createdAt: Date;
}

export interface YouTubeUploadLog {
  _id: string;
  articleId?: string | null;
  articleTitle: string;
  channelId?: string | null;
  channelTitle?: string | null;
  pageId?: string | null;
  ytVideoId: string;
  ytVideoUrl: string;
  durationMs?: number | null;
  status: 'success' | 'failed' | 'dry_run';
  errorMessage?: string | null;
  createdAt: Date;
}

export interface TikTokUploadLog {
  _id: string;
  videoTitle: string;
  channelId?: string;
  channelName?: string;
  gdriveFileId?: string | null;
  publishId?: string | null;
  durationMs?: number | null;
  status: 'success' | 'failed' | 'dry_run';
  errorMessage?: string | null;
  createdAt: Date;
}

export interface TelegramUploadLog {
  _id: string;
  videoTitle: string;
  channelId?: string;
  channelName?: string;
  gdriveFileId?: string | null;
  chatId: string;
  messageId?: number | string | null;
  status: 'success' | 'failed' | 'dry_run';
  errorMessage?: string | null;
  createdAt: Date;
}

export interface NewsArticle {
  _id: string;
  sourceId: string;
  guid: string;
  link: string;
  title: string;
  description?: string;
  category?: string;
  pubDate: Date;
  status: string;
  gdriveFileId?: string | null;
  fbVideoId?: string | null;
  fbPostId?: string | null;
  createdAt: Date;
  updatedAt?: Date;
}

export interface Setting {
  _id: string;
  value: string;
  description?: string | null;
  updatedAt: Date;
}
