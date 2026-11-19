import express, { Express, Request, Response } from 'express';
import crypto from 'node:crypto';
import { OutputPipelineService } from '../pipeline/output-pipeline.js';
import { isDbConnected, getDatabase, initDatabase, getLastDbError } from '../db/index.js';
import { config } from '../config/env.js';
import { GDriveReelConfig } from '../db/schema.js';

export function createOutputServer(pipeline: OutputPipelineService): Express {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get(['/api/health', '/api/index', '/api'], (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'Output Automation (Google Drive -> Facebook / YouTube / TikTok / Telegram)',
      databaseConnected: isDbConnected(),
      cronEnabled: config.CRON_ENABLED,
      cronSchedule: config.CRON_SCHEDULE,
      driveFolderConfigured: Boolean(config.GDRIVE_FOLDER_ID),
      platformsEnabled: {
        facebook: Boolean(config.FACEBOOK_PAGE_ID && config.FACEBOOK_PAGE_ACCESS_TOKEN),
        youtube: Boolean(config.YOUTUBE_AUTO_UPLOAD && config.YOUTUBE_REFRESH_TOKEN),
        tiktok: Boolean(config.TIKTOK_AUTO_UPLOAD && config.TIKTOK_ACCESS_TOKEN),
        telegram: Boolean(config.TELEGRAM_AUTO_UPLOAD && config.TELEGRAM_BOT_TOKEN),
      },
      time: new Date().toISOString(),
    });
  });

  app.all(['/api/cron/output', '/api/publish-now', '/api/output/run'], async (req: Request, res: Response) => {
    const force = req.query.force === 'true' || req.body?.force === true;
    const channelId = (req.query.channelId || req.body?.channelId) as string | undefined;
    const folderId = (req.query.folderId || req.body?.folderId) as string | undefined;

    console.log(`[OutputServer] 🚀 Triggering Output Automation broadcast cycle (force=${force})...`);
    try {
      const result = await pipeline.runOutputCron({
        force,
        channelId,
        folderId,
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Diagnostic report for system health & connected integrations
  app.get('/api/diagnostics', async (_req: Request, res: Response) => {
    try {
      const dbConnected = isDbConnected();
      const lastErr = getLastDbError();
      const scanner = pipeline.getScanner();

      let driveAuthMode = 'none';
      if (config.GOOGLE_CLIENT_ID && config.GOOGLE_REFRESH_TOKEN) {
        driveAuthMode = 'oauth2';
      } else if (config.GOOGLE_DRIVE_API_KEY) {
        driveAuthMode = 'api_key';
      }

      const detectedStorageKeys: string[] = [];
      ['MONGODB_URI', 'MONGODB_URL', 'MONGO_URL', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'KV_URL', 'KV_REST_API_URL', 'BLOB_READ_WRITE_TOKEN'].forEach(k => {
        if (process.env[k]) detectedStorageKeys.push(k);
      });

      const isPostgresDetected = Boolean(process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL);
      const isMongoDetected = Boolean(process.env.MONGODB_URI || process.env.MONGODB_URL || process.env.MONGO_URL || (process.env.DATABASE_URL?.startsWith('mongodb')));

      res.json({
        success: true,
        environment: {
          nodeEnv: process.env.NODE_ENV || 'production',
          isVercel: Boolean(process.env.VERCEL),
          serverTime: new Date().toISOString(),
        },
        database: {
          connected: dbConnected,
          error: lastErr,
          dbName: config.MONGODB_DB_NAME,
          vercelStorage: {
            detectedKeys: detectedStorageKeys,
            isMongoDetected,
            isPostgresDetected,
            note: isPostgresDetected && !isMongoDetected
              ? 'Warning: Vercel Postgres was detected, but this application requires MongoDB Atlas for document storage.'
              : detectedStorageKeys.length === 0
              ? 'No storage environment variables detected. If you created a database in Vercel Storage, make sure to click "Connect Project" on the database page.'
              : 'Database storage variables detected.',
          },
        },
        integrations: {
          googleDrive: {
            configured: Boolean(config.GDRIVE_FOLDER_ID),
            folderId: config.GDRIVE_FOLDER_ID ? `${config.GDRIVE_FOLDER_ID.substring(0, 6)}...` : null,
            authMode: driveAuthMode,
            deleteAfterPosting: config.DELETE_AFTER_POSTING,
          },
          facebook: {
            configured: Boolean(config.FACEBOOK_PAGE_ID && config.FACEBOOK_PAGE_ACCESS_TOKEN),
            pageId: config.FACEBOOK_PAGE_ID ? `${config.FACEBOOK_PAGE_ID.substring(0, 4)}...` : null,
            hasFirstComment: Boolean(config.DEFAULT_COMMENT_FORMAT),
          },
          youtube: {
            configured: Boolean(config.YOUTUBE_AUTO_UPLOAD && config.YOUTUBE_REFRESH_TOKEN),
            autoUpload: config.YOUTUBE_AUTO_UPLOAD,
            hasRefreshToken: Boolean(config.YOUTUBE_REFRESH_TOKEN),
          },
          tiktok: {
            configured: Boolean(config.TIKTOK_AUTO_UPLOAD && config.TIKTOK_ACCESS_TOKEN),
            autoUpload: config.TIKTOK_AUTO_UPLOAD,
          },
          telegram: {
            configured: Boolean(config.TELEGRAM_AUTO_UPLOAD && config.TELEGRAM_BOT_TOKEN),
            autoUpload: config.TELEGRAM_AUTO_UPLOAD,
            targetChatId: (config.TELEGRAM_CHAT_ID || config.TELEGRAM_CHANNEL_ID) ? `${(config.TELEGRAM_CHAT_ID || config.TELEGRAM_CHANNEL_ID)!.substring(0, 4)}...` : null,
          },
        },
        scheduler: {
          cronEnabled: config.CRON_ENABLED,
          schedule: config.CRON_SCHEDULE,
          dryRun: config.DRY_RUN,
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Reconnect DB on-demand
  app.post('/api/db/connect', async (req: Request, res: Response) => {
    try {
      const customUri = (req.body?.uri || '').trim();
      const targetUri =
        customUri ||
        process.env.MONGODB_URI ||
        process.env.MONGODB_URL ||
        process.env.MONGO_URL ||
        (process.env.DATABASE_URL?.startsWith('mongodb') ? process.env.DATABASE_URL : '') ||
        config.MONGODB_URI;

      if (!targetUri || targetUri.includes('127.0.0.1') || targetUri.includes('localhost')) {
        const hasPg = Boolean(process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL);
        if (hasPg) {
          return res.status(400).json({
            success: false,
            error: 'Vercel Postgres (POSTGRES_URL) is connected to this project, but Output Automation requires a MongoDB database (MongoDB Atlas in Vercel Storage) for JSON document collections.',
          });
        }
        return res.status(400).json({
          success: false,
          error: 'No MongoDB URI detected in this deployment. If your database is already in Vercel Storage, make sure to click "Connect Project" on the database page in Vercel to link it to output-automation-software, then trigger a Redeploy.',
        });
      }

      await initDatabase(targetUri, config.MONGODB_DB_NAME);
      res.json({ success: true, message: `Connected to MongoDB database (${config.MONGODB_DB_NAME}) successfully!` });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Scan Google Drive folder
  app.get('/api/scan', async (req: Request, res: Response) => {
    try {
      const folderInput = (req.query.folderId as string) || config.GDRIVE_FOLDER_ID;
      if (!folderInput) {
        return res.status(400).json({
          success: false,
          error: 'Please provide a Google Drive Folder ID or URL, or set GDRIVE_FOLDER_ID in environment.',
        });
      }

      let postedIds: string[] = [];
      const channelId = req.query.channelId as string;
      if (channelId && isDbConnected()) {
        const db = getDatabase();
        const ch = await db.collection<any>('gdrive_reel_configs').findOne({ _id: channelId });
        if (ch && Array.isArray(ch.postedVideoIds)) {
          postedIds = ch.postedVideoIds;
        }
      }

      const scanner = pipeline.getScanner();
      const result = await scanner.scanFolder(folderInput, postedIds);
      res.json({ success: true, scan: result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // List all channels / GDrive configs
  app.get('/api/channels', async (_req: Request, res: Response) => {
    try {
      if (!isDbConnected()) {
        return res.json({
          success: true,
          channels: [],
          message: 'Database not connected. Configure MONGODB_URI in Vercel to persist channel configurations.',
        });
      }
      const db = getDatabase();
      const channels = await db.collection<any>('gdrive_reel_configs').find({}).sort({ updatedAt: -1 }).toArray();
      res.json({ success: true, count: channels.length, channels });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Create new channel / GDrive config
  app.post('/api/channels', async (req: Request, res: Response) => {
    try {
      if (!isDbConnected()) {
        return res.status(400).json({
          success: false,
          error: 'MongoDB is not connected. Add MONGODB_URI in Vercel Environment Variables to save configs.',
        });
      }

      const body = req.body || {};
      const folderRaw = body.folderUrlOrId || body.folderId || '';
      const scanner = pipeline.getScanner();
      const folderId = scanner.extractFolderId(folderRaw);

      if (!folderId) {
        return res.status(400).json({ success: false, error: 'A valid Google Drive folder URL or ID is required.' });
      }

      const newId = body._id || `channel_${crypto.randomUUID().substring(0, 8)}`;
      const now = new Date();

      const newChannel = {
        _id: newId,
        name: body.name || `Folder ${folderId.substring(0, 8)}`,
        folderUrlOrId: folderRaw,
        folderId,
        apiKey: body.apiKey || '',
        pageId: body.pageId || config.FACEBOOK_PAGE_ID || '',
        pageName: body.pageName || '',
        youtubeChannelId: body.youtubeChannelId || '',
        autoPostYouTube: body.autoPostYouTube ?? config.YOUTUBE_AUTO_UPLOAD,
        autoPostTikTok: body.autoPostTikTok ?? config.TIKTOK_AUTO_UPLOAD,
        tiktokAccessToken: body.tiktokAccessToken || '',
        autoPostTelegram: body.autoPostTelegram ?? config.TELEGRAM_AUTO_UPLOAD,
        telegramChannelId: body.telegramChannelId || config.TELEGRAM_CHAT_ID || config.TELEGRAM_CHANNEL_ID || '',
        postStory: Boolean(body.postStory),
        shareToGroups: Boolean(body.shareToGroups),
        sourceId: body.sourceId || '',
        isActive: body.isActive !== false,
        scheduleIntervalHours: Number(body.scheduleIntervalHours) || 2,
        cronExpression: body.cronExpression || '',
        category: body.category || '',
        customHashtags: body.customHashtags || '',
        captionStrategy: body.captionStrategy || 'viral_hashtags',
        customCaption: body.customCaption || '',
        firstCommentText: body.firstCommentText || '',
        orderStrategy: body.orderStrategy || config.ORDER_STRATEGY || 'oldest_first',
        deleteAfterPosting: body.deleteAfterPosting ?? config.DELETE_AFTER_POSTING,
        deleteAction: body.deleteAction || 'trash',
        postedVideoIds: [],
        postedVideoNames: [],
        lastPostedAt: null,
        lastPostedFile: null,
        createdAt: now,
        updatedAt: now,
      };

      const db = getDatabase();
      await db.collection<any>('gdrive_reel_configs').insertOne(newChannel);

      res.status(201).json({ success: true, channel: newChannel });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Update channel
  app.put('/api/channels/:id', async (req: Request, res: Response) => {
    try {
      if (!isDbConnected()) {
        return res.status(400).json({ success: false, error: 'Database not connected' });
      }

      const id = req.params.id;
      const body = { ...req.body };
      delete body._id;
      body.updatedAt = new Date();

      if (body.folderUrlOrId) {
        const scanner = pipeline.getScanner();
        body.folderId = scanner.extractFolderId(body.folderUrlOrId);
      }

      const db = getDatabase();
      const result = await db.collection<any>('gdrive_reel_configs').updateOne(
        { _id: id },
        { $set: body }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ success: false, error: `Channel ${id} not found.` });
      }

      const updated = await db.collection<any>('gdrive_reel_configs').findOne({ _id: id });
      res.json({ success: true, channel: updated });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Toggle channel active status
  app.patch('/api/channels/:id/toggle', async (req: Request, res: Response) => {
    try {
      if (!isDbConnected()) {
        return res.status(400).json({ success: false, error: 'Database not connected' });
      }

      const id = req.params.id;
      const db = getDatabase();
      const ch = await db.collection<any>('gdrive_reel_configs').findOne({ _id: id });
      if (!ch) {
        return res.status(404).json({ success: false, error: 'Channel not found' });
      }

      const newStatus = !ch.isActive;
      await db.collection<any>('gdrive_reel_configs').updateOne(
        { _id: id },
        { $set: { isActive: newStatus, updatedAt: new Date() } }
      );

      res.json({ success: true, isActive: newStatus });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Reset posted IDs history for a channel
  app.post('/api/channels/:id/reset-posted', async (req: Request, res: Response) => {
    try {
      if (!isDbConnected()) {
        return res.status(400).json({ success: false, error: 'Database not connected' });
      }

      const id = req.params.id;
      const db = getDatabase();
      await db.collection<any>('gdrive_reel_configs').updateOne(
        { _id: id },
        { $set: { postedVideoIds: [], postedVideoNames: [], updatedAt: new Date() } }
      );

      res.json({ success: true, message: 'Posted video memory reset for this channel.' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Delete channel
  app.delete('/api/channels/:id', async (req: Request, res: Response) => {
    try {
      if (!isDbConnected()) {
        return res.status(400).json({ success: false, error: 'Database not connected' });
      }

      const id = req.params.id;
      const db = getDatabase();
      const result = await db.collection<any>('gdrive_reel_configs').deleteOne({ _id: id });
      res.json({ success: true, deleted: result.deletedCount > 0 });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Get publication logs across platforms
  app.get('/api/logs', async (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 30;
      if (!isDbConnected()) {
        return res.json({
          success: true,
          logs: { facebook: [], youtube: [], tiktok: [], telegram: [] },
          counts: { facebook: 0, youtube: 0, tiktok: 0, telegram: 0 },
          message: 'Database not connected',
        });
      }
      const db = getDatabase();
      const [facebookLogs, youtubeLogs, tiktokLogs, telegramLogs] = await Promise.all([
        db.collection('reel_logs').find({}).sort({ createdAt: -1 }).limit(limit).toArray(),
        db.collection('youtube_upload_logs').find({}).sort({ createdAt: -1 }).limit(limit).toArray(),
        db.collection('tiktok_upload_logs').find({}).sort({ createdAt: -1 }).limit(limit).toArray(),
        db.collection('telegram_upload_logs').find({}).sort({ createdAt: -1 }).limit(limit).toArray(),
      ]);

      res.json({
        success: true,
        counts: {
          facebook: facebookLogs.length,
          youtube: youtubeLogs.length,
          tiktok: tiktokLogs.length,
          telegram: telegramLogs.length,
        },
        logs: {
          facebook: facebookLogs,
          youtube: youtubeLogs,
          tiktok: tiktokLogs,
          telegram: telegramLogs,
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Get status & lifetime metrics
  app.get('/api/status', async (_req: Request, res: Response) => {
    try {
      let publishedReelsCount = 0;
      let youtubeCount = 0;
      let tiktokCount = 0;
      let telegramCount = 0;
      let channelsCount = 0;

      if (isDbConnected()) {
        const db = getDatabase();
        publishedReelsCount = await db.collection('reel_logs').countDocuments();
        youtubeCount = await db.collection('youtube_upload_logs').countDocuments();
        tiktokCount = await db.collection('tiktok_upload_logs').countDocuments();
        telegramCount = await db.collection('telegram_upload_logs').countDocuments();
        channelsCount = await db.collection('gdrive_reel_configs').countDocuments();
      }

      res.json({
        success: true,
        databaseConnected: isDbConnected(),
        lifetimePublished: {
          facebook: publishedReelsCount,
          youtube: youtubeCount,
          tiktok: tiktokCount,
          telegram: telegramCount,
          total: publishedReelsCount + youtubeCount + tiktokCount + telegramCount,
        },
        channelsCount,
        config: {
          cronEnabled: config.CRON_ENABLED,
          cronSchedule: config.CRON_SCHEDULE,
          deleteAfterPosting: config.DELETE_AFTER_POSTING,
          orderStrategy: config.ORDER_STRATEGY,
          dryRun: config.DRY_RUN,
          driveFolderConfigured: Boolean(config.GDRIVE_FOLDER_ID),
          platformsEnabled: {
            facebook: Boolean(config.FACEBOOK_PAGE_ID && config.FACEBOOK_PAGE_ACCESS_TOKEN),
            youtube: Boolean(config.YOUTUBE_AUTO_UPLOAD && config.YOUTUBE_REFRESH_TOKEN),
            tiktok: Boolean(config.TIKTOK_AUTO_UPLOAD && config.TIKTOK_ACCESS_TOKEN),
            telegram: Boolean(config.TELEGRAM_AUTO_UPLOAD && config.TELEGRAM_BOT_TOKEN),
          },
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return app;
}
