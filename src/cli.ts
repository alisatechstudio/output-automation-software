import { OutputPipelineService } from './pipeline/output-pipeline.js';
import { initDatabase, closeDatabase } from './db/index.js';
import { config } from './config/env.js';

async function runCli() {
  console.log('================================================================');
  console.log('   ⚡ Output Automation CLI: Drive -> FB/YT/TikTok/Telegram     ');
  console.log('================================================================');

  try {
    await initDatabase(config.MONGODB_URI, config.MONGODB_DB_NAME).catch((err) => {
      console.warn('MongoDB connection note (continuing with env defaults):', err.message);
    });

    const pipeline = new OutputPipelineService();
    const result = await pipeline.runOutputCron({ force: true });

    console.log('\n📊 Result:', JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error('Fatal CLI Error:', err);
  } finally {
    await closeDatabase().catch(() => {});
    process.exit(0);
  }
}

runCli();
