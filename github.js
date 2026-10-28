let octokitInstance;

async function getOctokit() {
  if (!octokitInstance) {
    const { Octokit } = await import('@octokit/rest');
    octokitInstance = new Octokit({ auth: process.env.GITHUB_TOKEN });
  }
  return octokitInstance;
}

async function getPullRequestFiles(owner, repo, pullNumber) {
  const octokit = await getOctokit();

  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  return files.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch, // can be undefined for binary/huge files
  }));
}

const SEVERITY_LABEL = {
  error: '🔴 **Error**',
  warning: '🟡 **Warning**',
  info: '🔵 **Info**',
};

async function postReview(owner, repo, pullNumber, commitSha, findings) {
  if (findings.length === 0) {
    console.log('No findings, nothing to post.');
    return;
  }

  const octokit = await getOctokit();

  const comments = findings.map((f) => ({
    path: f.file,
    line: f.line,
    side: 'RIGHT', // RIGHT = the new version of the file
    body: `${SEVERITY_LABEL[f.severity]}\n\n${f.comment}`,
  }));

  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: commitSha,
    event: 'COMMENT', // leave comments only; don't approve or request changes
    body: `🤖 Automated first-pass review: ${findings.length} finding(s).`,
    comments,
  });

  console.log(`Posted review with ${comments.length} inline comment(s).`);
}

module.exports = { getPullRequestFiles, postReview };