import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export interface OutputAppConfig {
  PORT: number;
  NODE_ENV: string;
  MONGODB_URI: string;
  MONGODB_DB_NAME: string;
  DRY_RUN: boolean;

  // Google OAuth / Drive
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  GOOGLE_DRIVE_API_KEY?: string;
  GDRIVE_FOLDER_ID?: string;

  // Facebook
  FACEBOOK_PAGE_ID?: string;
  FACEBOOK_PAGE_ACCESS_TOKEN?: string;
  DEFAULT_HASHTAGS: string;
  DEFAULT_CAPTION_FORMAT: string;
  DEFAULT_COMMENT_FORMAT: string;

  // YouTube
  YOUTUBE_CLIENT_ID?: string;
  YOUTUBE_CLIENT_SECRET?: string;
  YOUTUBE_REFRESH_TOKEN?: string;
  YOUTUBE_AUTO_UPLOAD: boolean;

  // TikTok
  TIKTOK_ACCESS_TOKEN?: string;
  TIKTOK_AUTO_UPLOAD: boolean;

  // Telegram
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHANNEL_ID?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_AUTO_UPLOAD: boolean;

  // Cron & Execution
  CRON_ENABLED: boolean;
  CRON_SCHEDULE: string;
  DELETE_AFTER_POSTING: boolean;
  ORDER_STRATEGY: 'oldest_first' | 'newest_first' | 'alphabetical' | 'random';
  DATA_DIR: string;
}

const rootDir = process.cwd();
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');

const ATLAS_URI = 'mongodb+srv://Vercel-Admin-atlas-copper-notebook:BNp8pQVDocNKaDwL@atlas-copper-notebook.0czlcmy.mongodb.net/?retryWrites=true&w=majority';

const resolvedMongoUri =
  process.env.MONGODB_URI ||
  process.env.MONGODB_URL ||
  process.env.MONGO_URL ||
  (process.env.DATABASE_URL?.startsWith('mongodb') ? process.env.DATABASE_URL : '') ||
  ATLAS_URI;

export const config: OutputAppConfig = {
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 3002,
  NODE_ENV: process.env.NODE_ENV || 'development',
  MONGODB_URI: resolvedMongoUri,
  MONGODB_DB_NAME: process.env.MONGODB_DB_NAME || 'news_automation',
  DRY_RUN: process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1',

  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || process.env.YOUTUBE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || process.env.YOUTUBE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN:
    process.env.GOOGLE_REFRESH_TOKEN ||
    process.env.GDRIVE_REFRESH_TOKEN ||
    process.env.YOUTUBE_REFRESH_TOKEN,
  GOOGLE_DRIVE_API_KEY:
    process.env.GOOGLE_DRIVE_API_KEY ||
    process.env.GDRIVE_API_KEY ||
    'AIzaSyBNHbV-WItof0jq2j32oj3MFCHOYHfdkxw',
  GDRIVE_FOLDER_ID: process.env.GDRIVE_FOLDER_ID || '',

  FACEBOOK_PAGE_ID: process.env.FACEBOOK_PAGE_ID,
  FACEBOOK_PAGE_ACCESS_TOKEN: process.env.FACEBOOK_PAGE_ACCESS_TOKEN,
  DEFAULT_HASHTAGS:
    process.env.DEFAULT_HASHTAGS || '#BreakingNews #BanglaNews #ViralNews #Bangladesh #NewsUpdate',
  DEFAULT_CAPTION_FORMAT:
    process.env.DEFAULT_CAPTION_FORMAT || '{headline}\n\n{summary}\n\n{hashtags}',
  DEFAULT_COMMENT_FORMAT:
    process.env.DEFAULT_COMMENT_FORMAT || '📌 বিস্তারিত খবর পড়ুন কমেন্টের লিংকে:',

  YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET,
  YOUTUBE_REFRESH_TOKEN:
    process.env.YOUTUBE_REFRESH_TOKEN || process.env.GOOGLE_REFRESH_TOKEN,
  YOUTUBE_AUTO_UPLOAD: process.env.YOUTUBE_AUTO_UPLOAD !== 'false',

  TIKTOK_ACCESS_TOKEN: process.env.TIKTOK_ACCESS_TOKEN,
  TIKTOK_AUTO_UPLOAD: process.env.TIKTOK_AUTO_UPLOAD !== 'false',

  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_ID: process.env.TELEGRAM_CHANNEL_ID || process.env.TELEGRAM_CHAT_ID,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  TELEGRAM_AUTO_UPLOAD: process.env.TELEGRAM_AUTO_UPLOAD !== 'false',

  CRON_ENABLED: false, // Internal cron removed. All scheduling is handled externally by cron-job.org
  CRON_SCHEDULE: process.env.CRON_SCHEDULE || 'external (cron-job.org)',
  DELETE_AFTER_POSTING: process.env.DELETE_AFTER_POSTING !== 'false',
  ORDER_STRATEGY: (process.env.ORDER_STRATEGY as any) || 'oldest_first',
  DATA_DIR: dataDir,
};
