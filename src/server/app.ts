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

  app.get(['/health', '/api/health', '/api/index', '/api'], (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'Output Automation (Google Drive -> Facebook / YouTube / TikTok / Telegram)',
      databaseConnected: isDbConnected(),
      internalCronEnabled: false,
      cronMode: 'external_webhooks (cron-job.org)',
      folderCronPattern: '/api/cron/folder/:folderId',
      globalCronEndpoint: '/api/cron/output',
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

  // External Cron Webhook trigger endpoints for cron-job.org (folder-wise, channel-wise, or global)
  app.all(
    [
      '/api/cron/folder/:folderId',
      '/api/cron/channel/:channelId',
      '/api/cron/output',
      '/api/cron',
      '/api/publish-now',
      '/api/output/run',
    ],
    async (req: Request, res: Response) => {
      const force = req.query.force === 'true' || req.body?.force === true;
      const channelId = (req.params.channelId || req.query.channelId || req.body?.channelId) as string | undefined;
      const folderId = (req.params.folderId || req.query.folderId || req.body?.folderId) as string | undefined;

      console.log(
        `[OutputServer] 🚀 Triggering Output Automation (cron-job.org webhook, folderId=${folderId || 'all'}, channelId=${channelId || 'all'}, force=${force})...`
      );
      try {
        const result = await pipeline.runOutputCron({
          force,
          channelId,
          folderId,
        });

        res.json({
          ...result,
          trigger: 'external_cron (cron-job.org)',
          targetFolder: folderId || 'all',
          targetChannel: channelId || 'all',
          scheduler: 'cron-job.org',
        });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    }
  );

  // Diagnostic report for system health & connected integrations
  app.get('/api/diagnostics', async (_req: Request, res: Response) => {
    try {
      const dbConnected = isDbConnected();
      const lastErr = getLastDbError();
      const scanner = pipeline.getScanner();

      let driveAuthMode = 'none';
      const oauthToken = await scanner.getOAuthToken().catch(() => null);
      if (oauthToken) {
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
      let apiKeyOverride: string | undefined = (req.query.apiKey as string) || undefined;
      const channelId = req.query.channelId as string;

      if (isDbConnected()) {
        const db = getDatabase();
        if (channelId) {
          const ch = await db.collection<any>('gdrive_reel_configs').findOne({ _id: channelId });
          if (ch) {
            if (Array.isArray(ch.postedVideoIds)) postedIds = ch.postedVideoIds;
            if (!apiKeyOverride && ch.apiKey) apiKeyOverride = ch.apiKey;
          }
        } else {
          const targetFid = pipeline.getScanner().extractFolderId(folderInput);
          const ch = await db.collection<any>('gdrive_reel_configs').findOne({
            $or: [{ folderId: targetFid }, { folderUrlOrId: { $regex: targetFid } }],
          });
          if (ch) {
            if (Array.isArray(ch.postedVideoIds)) postedIds = ch.postedVideoIds;
            if (!apiKeyOverride && ch.apiKey) apiKeyOverride = ch.apiKey;
          }
        }
      }

      const scanner = pipeline.getScanner();
      const result = await scanner.scanFolder(folderInput, postedIds, apiKeyOverride);
      res.json({ success: true, scan: result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Google Drive Connection & Deletion Credentials Status
  app.get('/api/gdrive/status', async (_req: Request, res: Response) => {
    try {
      const scanner = pipeline.getScanner();
      const oauthToken = await scanner.getOAuthToken();
      const hasOAuth = Boolean(oauthToken);

      res.json({
        success: true,
        authMode: hasOAuth ? 'oauth2' : (config.GOOGLE_DRIVE_API_KEY ? 'api_key' : 'none'),
        canDeleteFiles: hasOAuth,
        note: hasOAuth
          ? 'Google OAuth active. File deletion / trashing is supported.'
          : 'Read-only API Key active. An API Key is read-only; Google Drive API requires OAuth 2.0 write authorization to delete or trash files.',
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Update Google Drive OAuth Credentials in Database
  app.post('/api/gdrive/settings', async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const refreshToken = (body.refreshToken || body.GDRIVE_REFRESH_TOKEN || body.GOOGLE_REFRESH_TOKEN || '').trim();
      const clientId = (body.clientId || body.GOOGLE_CLIENT_ID || '').trim();
      const clientSecret = (body.clientSecret || body.GOOGLE_CLIENT_SECRET || '').trim();

      if (!isDbConnected()) {
        return res.status(500).json({ success: false, error: 'Database is not connected.' });
      }

      const db = getDatabase();
      const settingsCol = db.collection('settings');
      const now = new Date();

      if (refreshToken) {
        await settingsCol.updateOne(
          { _id: 'GDRIVE_REFRESH_TOKEN' as any },
          { $set: { key: 'GDRIVE_REFRESH_TOKEN', value: refreshToken, updatedAt: now } },
          { upsert: true }
        );
        await settingsCol.updateOne(
          { _id: 'GOOGLE_REFRESH_TOKEN' as any },
          { $set: { key: 'GOOGLE_REFRESH_TOKEN', value: refreshToken, updatedAt: now } },
          { upsert: true }
        );
      }

      if (clientId) {
        await settingsCol.updateOne(
          { _id: 'GOOGLE_CLIENT_ID' as any },
          { $set: { key: 'GOOGLE_CLIENT_ID', value: clientId, updatedAt: now } },
          { upsert: true }
        );
      }

      if (clientSecret) {
        await settingsCol.updateOne(
          { _id: 'GOOGLE_CLIENT_SECRET' as any },
          { $set: { key: 'GOOGLE_CLIENT_SECRET', value: clientSecret, updatedAt: now } },
          { upsert: true }
        );
      }

      const scanner = pipeline.getScanner();
      const oauthToken = await scanner.getOAuthToken();

      res.json({
        success: true,
        message: 'Google Drive settings updated.',
        canDeleteFiles: Boolean(oauthToken),
      });
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
      const limit = req.query.limit ? Math.min(Math.max(parseInt(req.query.limit as string, 10), 1), 1000) : 500;
      if (!isDbConnected()) {
        return res.json({
          success: true,
          logs: { facebook: [], youtube: [], tiktok: [], telegram: [] },
          counts: { facebook: 0, youtube: 0, tiktok: 0, telegram: 0 },
          message: 'Database not connected',
        });
      }
      const db = getDatabase();
      const [facebookLogs, youtubeLogs, tiktokLogs, telegramLogs, ytChannels] = await Promise.all([
        db.collection('reel_logs').find({}).sort({ createdAt: -1 }).limit(limit).toArray(),
        db.collection('youtube_upload_logs').find({}).sort({ createdAt: -1 }).limit(limit).toArray(),
        db.collection('tiktok_upload_logs').find({}).sort({ createdAt: -1 }).limit(limit).toArray(),
        db.collection('telegram_upload_logs').find({}).sort({ createdAt: -1 }).limit(limit).toArray(),
        db.collection<any>('youtube_channels').find({}).toArray(),
      ]);

      // Maps for fast resolution of YouTube channel names
      const ytById = new Map<string, string>();
      const ytByPageId = new Map<string, string>();
      ytChannels.forEach((ch: any) => {
        if (ch._id && ch.title) ytById.set(ch._id, ch.title);
        if (ch.targetPageId && ch.title) ytByPageId.set(ch.targetPageId, ch.title);
      });

      // Map from simultaneous Facebook reel logs (matching articleTitle)
      const titleToPage = new Map<string, { pageId: string; pageName: string }>();
      facebookLogs.forEach((fb: any) => {
        if (fb.articleTitle && fb.pageId && !titleToPage.has(fb.articleTitle)) {
          titleToPage.set(fb.articleTitle, { pageId: fb.pageId, pageName: fb.pageName || '' });
        }
      });

      // Enrich YouTube logs with exact channel names
      const enrichedYoutubeLogs = youtubeLogs.map((log: any) => {
        let channelTitle = log.channelTitle;
        let channelId = log.channelId;
        let pageId = log.pageId;

        if (!channelTitle || channelTitle === 'YouTube Channel') {
          // 1. Direct channelId lookup
          if (channelId && ytById.has(channelId)) {
            channelTitle = ytById.get(channelId);
          }

          // 2. Direct pageId lookup
          if (!channelTitle && pageId && ytByPageId.has(pageId)) {
            channelTitle = ytByPageId.get(pageId);
          }

          // 3. Correlate with simultaneous Facebook reel log by articleTitle
          if (!channelTitle && log.articleTitle && titleToPage.has(log.articleTitle)) {
            const p = titleToPage.get(log.articleTitle)!;
            pageId = pageId || p.pageId;
            if (ytByPageId.has(p.pageId)) {
              channelTitle = ytByPageId.get(p.pageId);
            }
          }

          // 4. Fallback heuristics for known channel series
          if (!channelTitle && log.articleTitle) {
            const lower = log.articleTitle.toLowerCase();
            if (lower.includes('kids') || lower.includes('ছানাপোনা')) {
              channelTitle = ytByPageId.get('1419972727872040') || 'Alisa Kids World';
              channelId = channelId || 'UCNrAZKuvQeVrzgi4tWDLxcw';
              pageId = pageId || '1419972727872040';
            } else if (lower.includes('cat ai') || lower.includes('alisa tech') || lower.includes('mix 639')) {
              channelTitle = ytById.get('UCw2WDU6BuHKz5YyT8qpBaHQ') || 'Alisa Tech Studio';
              channelId = channelId || 'UCw2WDU6BuHKz5YyT8qpBaHQ';
              pageId = pageId || '1268359636369219';
            } else if (/[\u0980-\u09FF]/.test(log.articleTitle)) {
              channelTitle = ytByPageId.get('1405135646008133') || 'বিডি নিউজ ২৪ সাইট';
              channelId = channelId || 'UCzWugTo6y2w0Fz_0TRfa1AA';
              pageId = pageId || '1405135646008133';
            } else {
              channelTitle = ytByPageId.get('1526917347161119') || 'Trending News World';
              channelId = channelId || 'UCAJi5nnA5m0ET6o0n0HSpkg';
              pageId = pageId || '1526917347161119';
            }
          }
        }

        return {
          ...log,
          channelTitle: channelTitle || 'YouTube Channel',
          channelId: channelId || log.channelId,
          pageId: pageId || log.pageId,
        };
      });

      // Asynchronously backfill unpopulated records in MongoDB
      const unpopulatedLogs = enrichedYoutubeLogs.filter((l: any) => {
        const orig = youtubeLogs.find((o: any) => o._id === l._id);
        return !orig?.channelTitle || orig.channelTitle === 'YouTube Channel';
      });
      if (unpopulatedLogs.length > 0) {
        Promise.all(
          unpopulatedLogs.map((l: any) =>
            db.collection('youtube_upload_logs').updateOne(
              { _id: l._id },
              { $set: { channelTitle: l.channelTitle, channelId: l.channelId, pageId: l.pageId } }
            )
          )
        ).catch(() => {});
      }

      res.json({
        success: true,
        counts: {
          facebook: facebookLogs.length,
          youtube: youtubeLogs.length,
          tiktok: tiktokLogs.length,
          telegram: telegramLogs.length,
          total: facebookLogs.length + youtubeLogs.length + tiktokLogs.length + telegramLogs.length,
        },
        logs: {
          facebook: facebookLogs,
          youtube: enrichedYoutubeLogs,
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

  // Comprehensive Database-driven KPI Metrics
  app.get('/api/kpi', async (_req: Request, res: Response) => {
    try {
      if (!isDbConnected()) {
        return res.json({ success: false, message: 'Database not connected' });
      }
      const db = getDatabase();

      const [
        fbReelsTotal,
        fbReelsSuccess,
        ytShortsTotal,
        ytShortsSuccess,
        ttUploadsTotal,
        tgUploadsTotal,
        groupSharesTotal,
        pagesCount,
        channelsCount,
        groupsCount,
        configsCount,
        newsArticlesCount,
        clipsCount,
        auditLogsCount,
        facebookPages,
        youtubeChannels,
        facebookGroups,
        gdriveConfigs,
        telegramChannelsCount,
        telegramChannels,
      ] = await Promise.all([
        db.collection('reel_logs').countDocuments(),
        db.collection('reel_logs').countDocuments({ status: 'success' }),
        db.collection('youtube_upload_logs').countDocuments(),
        db.collection('youtube_upload_logs').countDocuments({ status: 'success' }),
        db.collection('tiktok_upload_logs').countDocuments(),
        db.collection('telegram_upload_logs').countDocuments(),
        db.collection('group_share_logs').countDocuments().catch(() => 0),
        db.collection('facebook_pages').countDocuments(),
        db.collection('youtube_channels').countDocuments(),
        db.collection('facebook_groups').countDocuments(),
        db.collection('gdrive_reel_configs').countDocuments(),
        db.collection('news_articles').countDocuments(),
        db.collection('clips').countDocuments().catch(() => 0),
        db.collection('audit_log').countDocuments().catch(() => 0),
        db.collection('facebook_pages').find({}).toArray(),
        db.collection('youtube_channels').find({}).toArray(),
        db.collection('facebook_groups').find({}).toArray(),
        db.collection('gdrive_reel_configs').find({}).toArray(),
        db.collection('telegram_channels').countDocuments().catch(() => 0),
        db.collection('telegram_channels').find({}).toArray().catch(() => []),
      ]);

      const totalPostedInConfigs = gdriveConfigs.reduce(
        (acc: number, cur: any) => acc + (Array.isArray(cur.postedVideoIds) ? cur.postedVideoIds.length : 0),
        0
      );

      res.json({
        success: true,
        kpi: {
          publishing: {
            grandTotal: fbReelsTotal + ytShortsTotal + ttUploadsTotal + tgUploadsTotal,
            facebook: { total: fbReelsTotal, success: fbReelsSuccess },
            youtube: { total: ytShortsTotal, success: ytShortsSuccess },
            tiktok: { total: ttUploadsTotal },
            telegram: { total: tgUploadsTotal },
            groupShares: { total: groupSharesTotal },
          },
          infrastructure: {
            facebookPagesCount: pagesCount,
            youtubeChannelsCount: channelsCount,
            telegramChannelsCount: telegramChannelsCount || 0,
            facebookGroupsCount: groupsCount,
            gdrivePipelinesCount: configsCount,
            totalMemoryTrackedVideos: totalPostedInConfigs,
            newsArticlesCount,
            clipsCount,
            auditLogsCount,
          },
          assets: {
            facebookPages,
            youtubeChannels,
            telegramChannels: telegramChannels || [],
            facebookGroups,
            gdriveConfigs,
          },
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Assets direct endpoints & CRUD for Social Accounts & Channels
  app.get('/api/facebook-pages', async (_req: Request, res: Response) => {
    try {
      if (!isDbConnected()) return res.json({ success: true, pages: [] });
      const pages = await getDatabase().collection('facebook_pages').find({}).toArray();
      res.json({ success: true, count: pages.length, pages });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/facebook-pages', async (req: Request, res: Response) => {
    try {
      if (!isDbConnected()) return res.status(503).json({ success: false, error: 'Database not connected' });
      const { id, name, accessToken, isActive = true, tokenExpiresAt } = req.body;
      if (!id || !name) {
        return res.status(400).json({ success: false, error: 'Page ID and Page Name are required' });
      }
      const db = getDatabase();
      const now = new Date();
      await db.collection<any>('facebook_pages').updateOne(
        { _id: String(id).trim() },
        {
          $set: {
            name: String(name).trim(),
            ...(accessToken ? { accessToken: String(accessToken).trim() } : {}),
            isActive: Boolean(isActive),
            tokenExpiresAt: tokenExpiresAt ? new Date(tokenExpiresAt) : null,
            updatedAt: now,
          },
          $setOnInsert: {
            createdAt: now,
          },
        },
        { upsert: true }
      );
      res.json({ success: true, message: `Facebook Page "${name}" saved successfully` });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/facebook-pages/:id', async (req: Request, res: Response) => {
    try {
      if (!isDbConnected()) return res.status(503).json({ success: false, error: 'Database not connected' });
      const db = getDatabase();
      const result = await db.collection<any>('facebook_pages').deleteOne({ _id: req.params.id });
      res.json({ success: true, deleted: result.deletedCount > 0 });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/youtube-channels', async (_req: Request, res: Response) => {
    try {
      if (!isDbConnected()) return res.json({ success: true, channels: [] });
      const channels = await getDatabase().collection<any>('youtube_channels').find({}).toArray();
      res.json({ success: true, count: channels.length, channels });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/youtube-channels', async (req: Request, res: Response) => {
    try {
      if (!isDbConnected()) return res.status(503).json({ success: false, error: 'Database not connected' });
      const {
        id,
        title,
        customUrl,
        refreshToken,
        clientId,
        clientSecret,
        targetPageId,
        autoUpload = true,
        isActive = true,
      } = req.body;
      if (!id || !title) {
        return res.status(400).json({ success: false, error: 'Channel ID and Title are required' });
      }
      const db = getDatabase();
      const now = new Date();
      await db.collection<any>('youtube_channels').updateOne(
        { _id: String(id).trim() },
        {
          $set: {
            title: String(title).trim(),
            customUrl: customUrl ? String(customUrl).trim() : '',
            ...(refreshToken ? { refreshToken: String(refreshToken).trim() } : {}),
            ...(clientId ? { clientId: String(clientId).trim() } : {}),
            ...(clientSecret ? { clientSecret: String(clientSecret).trim() } : {}),
            targetPageId: targetPageId ? String(targetPageId).trim() : '',
            autoUpload: Boolean(autoUpload),
            isActive: Boolean(isActive),
            updatedAt: now,
          },
          $setOnInsert: {
            createdAt: now,
            videoCount: '0',
          },
        },
        { upsert: true }
      );
      res.json({ success: true, message: `YouTube Channel "${title}" saved successfully` });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/youtube-channels/:id', async (req: Request, res: Response) => {
    try {
      if (!isDbConnected()) return res.status(503).json({ success: false, error: 'Database not connected' });
      const db = getDatabase();
      const result = await db.collection<any>('youtube_channels').deleteOne({ _id: req.params.id });
      res.json({ success: true, deleted: result.deletedCount > 0 });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/telegram-channels', async (_req: Request, res: Response) => {
    try {
      if (!isDbConnected()) return res.json({ success: true, channels: [] });
      const channels = await getDatabase().collection<any>('telegram_channels').find({}).toArray();
      res.json({ success: true, count: channels.length, channels });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/telegram-channels', async (req: Request, res: Response) => {
    try {
      if (!isDbConnected()) return res.status(503).json({ success: false, error: 'Database not connected' });
      const { id, title, username, botToken, isActive = true } = req.body;
      if (!id || !title) {
        return res.status(400).json({ success: false, error: 'Telegram Chat/Channel ID and Title are required' });
      }
      const db = getDatabase();
      const now = new Date();
      await db.collection<any>('telegram_channels').updateOne(
        { _id: String(id).trim() },
        {
          $set: {
            title: String(title).trim(),
            username: username ? String(username).trim() : '',
            ...(botToken ? { botToken: String(botToken).trim() } : {}),
            isActive: Boolean(isActive),
            updatedAt: now,
          },
          $setOnInsert: {
            createdAt: now,
          },
        },
        { upsert: true }
      );
      res.json({ success: true, message: `Telegram Channel "${title}" saved successfully` });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/telegram-channels/:id', async (req: Request, res: Response) => {
    try {
      if (!isDbConnected()) return res.status(503).json({ success: false, error: 'Database not connected' });
      const db = getDatabase();
      const result = await db.collection<any>('telegram_channels').deleteOne({ _id: req.params.id });
      res.json({ success: true, deleted: result.deletedCount > 0 });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/facebook-groups', async (_req: Request, res: Response) => {
    try {
      if (!isDbConnected()) return res.json({ success: true, groups: [] });
      const groups = await getDatabase().collection('facebook_groups').find({}).toArray();
      res.json({ success: true, count: groups.length, groups });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/news-articles', async (req: Request, res: Response) => {
    try {
      if (!isDbConnected()) return res.json({ success: true, articles: [] });
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
      const articles = await getDatabase().collection('news_articles').find({}).sort({ pubDate: -1, createdAt: -1 }).limit(limit).toArray();
      res.json({ success: true, count: articles.length, articles });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return app;
}
