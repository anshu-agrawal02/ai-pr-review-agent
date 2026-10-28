const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/pr-review-agent';

// If Mongo is down, fail immediately instead of queueing writes in memory
mongoose.set('bufferCommands', false);

const reviewSchema = new mongoose.Schema(
  {
    owner: String,
    repo: String,
    pullNumber: Number,
    commitSha: String,
    status: { type: String, enum: ['reviewed', 'cache_hit'] },
    filesChanged: Number,
    findingsFound: Number,  // what the LLM reported
    findingsPosted: Number, // what was new and actually posted
    findings: [
      { file: String, line: Number, severity: String, comment: String },
    ],
    notes: [String], // things that were skipped or only partly reviewed
    durationMs: Number,
  },
  { timestamps: true } // adds createdAt / updatedAt
);
reviewSchema.index({ owner: 1, repo: 1, pullNumber: 1, createdAt: -1 });

const Review = mongoose.model('Review', reviewSchema);

async function connectDb() {
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
    console.log('MongoDB connected');
  } catch (err) {
    console.warn('MongoDB unavailable, history disabled. Retrying in 10s:', err.message);
    setTimeout(connectDb, 10000);
  }
}

// Never throws: a history failure must not fail a review
async function saveReview(doc) {
  try {
    await Review.create(doc);
  } catch (err) {
    console.warn('Could not save review history:', err.message);
  }
}

async function listReviews({ limit = 20, repo } = {}) {
  const filter = repo ? { repo } : {};
  return Review.find(filter)
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 100))
    .lean();
}

async function getStats() {
  const [totals] = await Review.aggregate([
    {
      $group: {
        _id: null,
        runs: { $sum: 1 },
        reviewed: { $sum: { $cond: [{ $eq: ['$status', 'reviewed'] }, 1, 0] } },
        cacheHits: { $sum: { $cond: [{ $eq: ['$status', 'cache_hit'] }, 1, 0] } },
        findingsPosted: { $sum: '$findingsPosted' },
        avgDurationMs: {
          $avg: { $cond: [{ $eq: ['$status', 'reviewed'] }, '$durationMs', null] },
        },
      },
    },
  ]);

  const bySeverityRows = await Review.aggregate([
    { $unwind: '$findings' },
    { $group: { _id: '$findings.severity', count: { $sum: 1 } } },
  ]);
  const bySeverity = {};
  bySeverityRows.forEach((r) => (bySeverity[r._id] = r.count));

  return {
    runs: totals ? totals.runs : 0,
    reviewed: totals ? totals.reviewed : 0,
    cacheHits: totals ? totals.cacheHits : 0,
    findingsPosted: totals ? totals.findingsPosted : 0,
    avgReviewSeconds:
      totals && totals.avgDurationMs ? Math.round(totals.avgDurationMs / 100) / 10 : null,
    findingsBySeverity: bySeverity,
  };
}

module.exports = { connectDb, saveReview, listReviews, getStats };