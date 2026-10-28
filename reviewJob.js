const { getPullRequestFiles, postReview } = require('./github');
const { reviewDiff } = require('./llm');
const {
  buildKey,
  getCachedReview,
  setCachedReview,
  filterNewFindings,
  markPosted,
} = require('./cache');
const { saveReview } = require('./db');

async function processReview({ owner, repo, pullNumber, commitSha }, job) {
  const startedAt = Date.now();
  console.log(`Reviewing PR #${pullNumber} in ${owner}/${repo} @ ${commitSha.slice(0, 7)}`);

  // TEST ONLY: pretend Groq rate-limited us on the first 2 attempts
  if (process.env.SIMULATE_429 === 'true' && job && job.attemptsMade < 2) {
    const err = new Error('429 Rate limit reached (SIMULATED)');
    err.status = 429;
    throw err;
  }

  const files = await getPullRequestFiles(owner, repo, pullNumber);
  console.log(`Fetched ${files.length} changed file(s)`);
  files.forEach((f) => {
    console.log(`- ${f.filename} (${f.status}, +${f.additions} -${f.deletions})`);
  });

  // Cache check: have we already reviewed exactly this diff?
  const cacheKey = buildKey(owner, repo, pullNumber, files);
  const cached = await getCachedReview(cacheKey);
  if (cached) {
    console.log('CACHE HIT: this exact diff was already reviewed, skipping LLM and posting.');
    await saveReview({
      owner, repo, pullNumber, commitSha,
      status: 'cache_hit',
      filesChanged: files.length,
      findingsFound: cached.length,
      findingsPosted: 0,
      findings: [],
      notes: [],
      durationMs: Date.now() - startedAt,
    });
    return;
  }
  console.log('Cache miss, reviewing...');

  const { findings, notes } = await reviewDiff(files);

  // Dedup: drop findings we already posted on earlier commits of this PR
  const newFindings = await filterNewFindings(owner, repo, pullNumber, findings);
  console.log(`${findings.length} valid finding(s), ${newFindings.length} new`);
  console.log(JSON.stringify(newFindings, null, 2));

  await postReview(owner, repo, pullNumber, commitSha, newFindings, notes);
  await markPosted(owner, repo, pullNumber, newFindings);

  // Only cache after a successful post, so a failed run can be retried
  await setCachedReview(cacheKey, findings);

  await saveReview({
    owner, repo, pullNumber, commitSha,
    status: 'reviewed',
    filesChanged: files.length,
    findingsFound: findings.length,
    findingsPosted: newFindings.length,
    findings: newFindings.map((f) => ({
      file: f.file, line: f.line, severity: f.severity, comment: f.comment,
    })),
    notes,
    durationMs: Date.now() - startedAt,
  });
}

module.exports = { processReview };