import { initDatabase, isDbConnected } from '../src/db/index.js';
import { OutputPipelineService } from '../src/pipeline/output-pipeline.js';
import { createOutputServer } from '../src/server/app.js';
import { config } from '../src/config/env.js';

let cachedApp: any = null;

export default async function handler(req: any, res: any) {
  try {
    const candidateUri =
      process.env.MONGODB_URI ||
      process.env.MONGODB_URL ||
      process.env.MONGO_URL ||
      (process.env.DATABASE_URL?.startsWith('mongodb') ? process.env.DATABASE_URL : '') ||
      config.MONGODB_URI;

    if (candidateUri && !candidateUri.includes('127.0.0.1') && !isDbConnected()) {
      try {
        await initDatabase(candidateUri, process.env.MONGODB_DB_NAME || 'news_automation');
      } catch (dbErr: any) {
        console.warn('[Vercel Output API] MongoDB connection note:', dbErr.message);
      }
    }

    if (!cachedApp) {
      const pipeline = new OutputPipelineService();
      cachedApp = createOutputServer(pipeline);
    }

    return new Promise<void>((resolve, reject) => {
      res.on('finish', () => resolve());
      res.on('close', () => resolve());
      res.on('error', (err: any) => reject(err));

      cachedApp(req, res, (err: any) => {
        if (err) {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: err?.message || 'Internal Server Error' }));
          }
          resolve();
        } else {
          if (!res.headersSent) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Not Found', path: req.url }));
          }
          resolve();
        }
      });
    });
  } catch (err: any) {
    console.error('[Vercel Output API] Fatal crash:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err?.message || String(err), stack: err?.stack }));
  }
}
