import cron from 'node-cron';
import { OutputPipelineService } from './pipeline/output-pipeline.js';
import { createOutputServer } from './server/app.js';
import { initDatabase, closeDatabase } from './db/index.js';
import { config } from './config/env.js';
import { logger } from './logger.js';

async function main() {
  logger.info('================================================================');
  logger.info('   ⚡ 2. Output Automation (Drive -> FB/YT/TikTok/Telegram)     ');
  logger.info('================================================================');

  try {
    await initDatabase(config.MONGODB_URI, config.MONGODB_DB_NAME);
    logger.info('Connected to MongoDB database.');
  } catch (dbErr: any) {
    logger.warn({ err: dbErr.message }, 'MongoDB not connected, running with fallback defaults.');
  }

  const pipeline = new OutputPipelineService();
  const app = createOutputServer(pipeline);

  const server = app.listen(config.PORT, () => {
    logger.info(`Output Automation Server running on http://localhost:${config.PORT}`);
    logger.info(`Webhook broadcast endpoint: http://localhost:${config.PORT}/api/cron/output`);
  });

  let cronTask: any = null;
  if (config.CRON_ENABLED) {
    logger.info(`Starting internal cron job with schedule: "${config.CRON_SCHEDULE}"`);
    cronTask = cron.schedule(config.CRON_SCHEDULE, async () => {
      logger.info('[OutputScheduler] ⏰ Cron trigger activated. Running Output Automation...');
      try {
        await pipeline.runOutputCron();
      } catch (err: any) {
        logger.error({ err: err.message }, '[OutputScheduler] Error during scheduled broadcast');
      }
    });
  } else {
    logger.info('Internal cron scheduler disabled. Use external webhook (/api/cron/output).');
  }

  const shutdown = async () => {
    logger.info('Shutting down Output Automation cleanly...');
    if (cronTask) cronTask.stop();
    server.close(async () => {
      await closeDatabase().catch(() => {});
      logger.info('Output Automation stopped.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'Fatal Output Automation startup crash');
  process.exit(1);
});
