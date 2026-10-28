const { Queue, Worker, UnrecoverableError } = require('bullmq');
const IORedis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const QUEUE_NAME = 'pr-reviews';
const MAX_ATTEMPTS = 6;
// Delays double each time: base, 2x, 4x, 8x, 16x (15s, 30s, 60s, 120s, 240s by default)
const BACKOFF_BASE_MS = parseInt(process.env.BACKOFF_BASE_MS || '15000', 10);

function makeConnection() {
  return new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
}

const reviewQueue = new Queue(QUEUE_NAME, { connection: makeConnection() });
reviewQueue.on('error', (err) => console.error('Queue error:', err.message));

// Same PR + same commit = same job id, so duplicate webhooks don't create duplicate jobs
async function enqueueReview(data) {
  const jobId = `${data.owner}_${data.repo}_${data.pullNumber}_${data.commitSha}`;

  const existing = await reviewQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'completed' || state === 'failed') {
      await existing.remove(); // allow a manual redelivery to run again
    } else {
      console.log(`Job ${jobId} is already ${state}, ignoring duplicate.`);
      return null;
    }
  }

  const job = await reviewQueue.add('review', data, {
    jobId,
    attempts: MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: BACKOFF_BASE_MS },
    removeOnComplete: { count: 100 }, // keep the last 100 for inspection
    removeOnFail: { count: 100 },     // failed jobs stay visible instead of vanishing
  });
  console.log(`Queued job ${job.id}`);
  return job;
}

// Which errors are worth retrying?
function isRetryable(err) {
  const status = err && err.status;
  if (!status) return true; // network errors, timeouts
  if (status === 429 || status === 408 || status >= 500) return true;
  if (status === 403 && /rate limit/i.test(err.message || '')) return true;
  return false; // 401, 404, 422... retrying won't fix these
}

function startWorker(processor) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      try {
        return await processor(job.data, job);
      } catch (err) {
        if (!isRetryable(err)) {
          // Tells BullMQ to give up immediately, no more attempts
          throw new UnrecoverableError(`${err.status || ''} ${err.message}`.trim());
        }
        throw err;
      }
    },
    {
      connection: makeConnection(),
      concurrency: 1, // one review at a time
      // Proactive limit: at most 20 jobs per minute, safely under Groq's ~30 requests/min
      limiter: { max: 20, duration: 60 * 1000 },
    }
  );

  worker.on('active', (job) =>
    console.log(`Job ${job.id} started (attempt ${job.attemptsMade + 1}/${MAX_ATTEMPTS})`)
  );
  worker.on('completed', (job) => console.log(`Job ${job.id} completed`));
  worker.on('failed', (job, err) => {
    const giveUp = err && err.name === 'UnrecoverableError';
    console.error(
      `Job ${job && job.id} failed: ${err.message}` +
        (giveUp ? ' (not retryable, giving up)' : ' (will retry with backoff if attempts remain)')
    );
  });
  worker.on('error', (err) => console.error('Worker error:', err.message));

  return worker;
}

module.exports = { enqueueReview, startWorker };