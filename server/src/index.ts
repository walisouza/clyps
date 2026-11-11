import { createApp } from './api.js';
import { config } from './config.js';
import { rm } from 'node:fs/promises';
import { claimNextJob, db, recoverInterruptedJobs, staleFailedUploads, updateJob } from './db.js';
import { resumePendingRerenders } from './editor.js';
import { processJob } from './pipeline.js';

let stopping = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fila: um job por vez, no mesmo processo do servidor. */
async function workerLoop() {
  while (!stopping) {
    try {
      const job = claimNextJob();
      if (!job) {
        await sleep(config.pollIntervalMs);
        continue;
      }
      console.log(`[job ${job.id}] iniciando (${job.source_type})`);
      await processJob(job);
      console.log(`[job ${job.id}] finalizado`);
    } catch (err) {
      console.error('Erro no loop da fila:', err);
      await sleep(config.pollIntervalMs);
    }
  }
}

db();
recoverInterruptedJobs();
resumePendingRerenders();

const KEEP_FAILED_UPLOAD_DAYS = 7;
async function cleanupFailedUploads() {
  for (const j of staleFailedUploads(KEEP_FAILED_UPLOAD_DAYS)) {
    await rm(j.upload_path, { force: true }).catch(() => {});
    updateJob(j.id, { upload_path: null });
  }
}
cleanupFailedUploads();
setInterval(cleanupFailedUploads, 6 * 3600 * 1000).unref();

const server = createApp().listen(config.port, () => {
  console.log(`Clyps no ar na porta ${config.port}${config.mock ? ' (MOCK_AI: transcrição e seleção simuladas)' : ''}.`);
});
// Uploads grandes e renderizações longas não podem ser cortados por timeout.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

workerLoop();

function shutdown() {
  stopping = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
