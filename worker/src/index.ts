import { config } from './config.js';
import { claimNextJob } from './db.js';
import { processJob } from './pipeline.js';

let stopping = false;
process.on('SIGTERM', () => (stopping = true));
process.on('SIGINT', () => (stopping = true));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Clyps worker no ar${config.mock ? ' (MOCK_AI: sem transcrição/LLM reais)' : ''}.`);
  while (!stopping) {
    try {
      const job = await claimNextJob();
      if (!job) {
        await sleep(config.pollIntervalMs);
        continue;
      }
      console.log(`[job ${job.id}] iniciando (${job.source_type})`);
      await processJob(job);
      console.log(`[job ${job.id}] finalizado`);
    } catch (err) {
      console.error('Erro no loop do worker:', err);
      await sleep(config.pollIntervalMs);
    }
  }
  console.log('Worker encerrado.');
}

main();
