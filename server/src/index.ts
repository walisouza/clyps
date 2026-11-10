import { createApp } from './api.js';
import { config } from './config.js';
import { claimNextJob, db, recoverInterruptedJobs } from './db.js';
import { processJob } from './pipeline.js';
import { initPublications, publicationTick } from './meta.js';

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
initPublications();
const publicationTimer = setInterval(() => { publicationTick().catch(err => console.error('Fila Instagram:', err.message)); }, 60_000);
publicationTick().catch(err => console.error('Fila Instagram:', err.message));

const server = createApp().listen(config.port, () => {
  console.log(`Clyps no ar na porta ${config.port}${config.mock ? ' (MOCK_AI: transcrição e seleção simuladas)' : ''}.`);
});
// Uploads grandes e renderizações longas não podem ser cortados por timeout.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

workerLoop();

function shutdown() {
  stopping = true;
  clearInterval(publicationTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
