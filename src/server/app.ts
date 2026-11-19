import express, { Request, Response } from 'express';
import { OutputPipelineService } from '../pipeline/output-pipeline.js';
import { isDbConnected, getDatabase } from '../db/index.js';
import { config } from '../config/env.js';

export function createOutputServer(pipeline: OutputPipelineService) {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get(['/', '/health'], (_req: Request, res: Response) => {
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

  app.get('/api/channels', async (_req: Request, res: Response) => {
    try {
      if (!isDbConnected()) {
        return res.json({ success: true, channels: [], message: 'Database not connected' });
      }
      const db = getDatabase();
      const channels = await db.collection('gdrive_reel_configs').find({}).toArray();
      res.json({ success: true, count: channels.length, channels });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/logs', async (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
      if (!isDbConnected()) {
        return res.json({ success: true, logs: [], message: 'Database not connected' });
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

  app.get('/api/status', async (_req: Request, res: Response) => {
    try {
      let publishedReelsCount = 0;
      let youtubeCount = 0;
      let tiktokCount = 0;
      let telegramCount = 0;

      if (isDbConnected()) {
        const db = getDatabase();
        publishedReelsCount = await db.collection('reel_logs').countDocuments();
        youtubeCount = await db.collection('youtube_upload_logs').countDocuments();
        tiktokCount = await db.collection('tiktok_upload_logs').countDocuments();
        telegramCount = await db.collection('telegram_upload_logs').countDocuments();
      }

      res.json({
        success: true,
        databaseConnected: isDbConnected(),
        lifetimePublished: {
          facebook: publishedReelsCount,
          youtube: youtubeCount,
          tiktok: tiktokCount,
          telegram: telegramCount,
        },
        config: {
          cronEnabled: config.CRON_ENABLED,
          cronSchedule: config.CRON_SCHEDULE,
          deleteAfterPosting: config.DELETE_AFTER_POSTING,
          orderStrategy: config.ORDER_STRATEGY,
          dryRun: config.DRY_RUN,
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return app;
}
