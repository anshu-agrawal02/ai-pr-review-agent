const crypto = require('crypto');
const Redis = require('ioredis');

// Bump this whenever you change the prompt, so old cached reviews stop matching
const CACHE_VERSION = 'v1';
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false, // fail fast instead of hanging if Redis is down
  retryStrategy: (times) => Math.min(times * 500, 5000),
});

let warned = false;
redis.on('error', (err) => {
  if (!warned) {
    console.warn('Redis unavailable, caching disabled:', err.message);
    warned = true;
  }
});
redis.on('ready', () => {
  warned = false;
  console.log('Redis connected');
});

// Same files + same patches + same model/prompt version = same hash
function hashDiff(files) {
  const h = crypto.createHash('sha256');
  h.update(`${CACHE_VERSION}|${process.env.GROQ_MODEL || 'default'}|`);

  const sorted = [...files].sort((a, b) => a.filename.localeCompare(b.filename));
  for (const f of sorted) {
    h.update(`${f.filename}\n${f.patch || ''}\n`);
  }
  return h.digest('hex');
}

function buildKey(owner, repo, pullNumber, files) {
  return `review:${owner}/${repo}#${pullNumber}:${hashDiff(files)}`;
}

// Returns the cached findings, or null on a miss (or if Redis is down)
async function getCachedReview(key) {
  try {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  } catch (err) {
    console.warn('Cache read failed, continuing without cache:', err.message);
    return null;
  }
}

async function setCachedReview(key, findings) {
  try {
    await redis.set(key, JSON.stringify(findings), 'EX', TTL_SECONDS);
  } catch (err) {
    console.warn('Cache write failed, continuing without cache:', err.message);
  }
}

// ---- Per-finding dedup: never post the same finding twice on one PR ----

function fingerprint(file, lineText) {
  return crypto
    .createHash('sha256')
    .update(`${file}|${(lineText || '').trim()}`)
    .digest('hex');
}

function postedKey(owner, repo, pullNumber) {
  return `posted:${owner}/${repo}#${pullNumber}`;
}

// Returns only the findings we haven't already posted on this PR
async function filterNewFindings(owner, repo, pullNumber, findings) {
  if (findings.length === 0) return findings;
  try {
    const key = postedKey(owner, repo, pullNumber);
    const seen = await Promise.all(
      findings.map((f) => redis.sismember(key, fingerprint(f.file, f.lineText)))
    );
    return findings.filter((f, i) => !seen[i]);
  } catch (err) {
    console.warn('Dedup check failed, treating all findings as new:', err.message);
    return findings;
  }
}

async function markPosted(owner, repo, pullNumber, findings) {
  if (findings.length === 0) return;
  try {
    const key = postedKey(owner, repo, pullNumber);
    await redis.sadd(key, ...findings.map((f) => fingerprint(f.file, f.lineText)));
    await redis.expire(key, TTL_SECONDS);
  } catch (err) {
    console.warn('Could not record posted findings:', err.message);
  }
}

module.exports = {
  buildKey,
  getCachedReview,
  setCachedReview,
  filterNewFindings,
  markPosted,
};