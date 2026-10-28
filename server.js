require('dotenv').config();
const express = require('express');
const { enqueueReview, startWorker } = require('./queue');
const { processReview } = require('./reviewJob');
const { connectDb, listReviews, getStats } = require('./db');
const { verifySignature } = require('./signature');

const app = express();

// Capture the raw body so we can verify GitHub's signature
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

function verifyGithubSignature(req) {
  return verifySignature(
    req.rawBody,
    req.headers['x-hub-signature-256'],
    process.env.GITHUB_WEBHOOK_SECRET
  );
}

// Protects the history endpoints. If ADMIN_TOKEN isn't set, they don't exist.
function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_TOKEN) return res.status(404).send('Not found');
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).send('Unauthorized');
  }
  next();
}

app.get('/', (req, res) => {
  res.send('AI PR Review Agent is alive');
});

app.get('/api/reviews', requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '20', 10);
    res.json(await listReviews({ limit, repo: req.query.repo }));
  } catch (err) {
    res.status(503).json({ error: 'History unavailable', detail: err.message });
  }
});

app.get('/api/stats', requireAdmin, async (req, res) => {
  try {
    res.json(await getStats());
  } catch (err) {
    res.status(503).json({ error: 'History unavailable', detail: err.message });
  }
});

app.post('/webhook/github', async (req, res) => {
  if (!verifyGithubSignature(req)) {
    console.log('Invalid signature, rejecting');
    return res.status(401).send('Invalid signature');
  }

  const event = req.headers['x-github-event'];
  const action = req.body.action;
  console.log('Webhook received and verified! Event:', event);

  if (event === 'pull_request' && (action === 'opened' || action === 'synchronize')) {
    try {
      await enqueueReview({
        owner: req.body.repository.owner.login,
        repo: req.body.repository.name,
        pullNumber: req.body.pull_request.number,
        commitSha: req.body.pull_request.head.sha,
      });
    } catch (err) {
      // If we couldn't queue it, tell GitHub so the delivery shows as failed and can be redelivered
      console.error('Failed to enqueue job:', err.message);
      return res.status(500).send('Could not enqueue');
    }
  }

  res.status(200).send('Received');
});

connectDb();
startWorker(processReview);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});