require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { enqueueReview, startWorker } = require('./queue');
const { processReview } = require('./reviewJob');

const app = express();

// Capture the raw body so we can verify GitHub's signature
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

function verifyGithubSignature(req) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature || !req.rawBody) return false;

  const hmac = crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');

  const a = Buffer.from(signature);
  const b = Buffer.from(digest);
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

app.get('/', (req, res) => {
  res.send('AI PR Review Agent is alive');
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

startWorker(processReview);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});