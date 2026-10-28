require('dotenv').config();
const { planReview } = require('./llm');

function fakePatch(hunks, linesPerHunk) {
  const parts = [];
  for (let h = 0; h < hunks; h++) {
    const start = 1 + h * (linesPerHunk + 10);
    const body = [];
    for (let i = 0; i < linesPerHunk; i++) {
      body.push(`+const value${h}_${i} = compute(${i}); // generated test line`);
    }
    parts.push(`@@ -${start},0 +${start},${linesPerHunk} @@\n${body.join('\n')}`);
  }
  return parts.join('\n');
}

const files = [
  { filename: 'package-lock.json', status: 'modified', additions: 500, deletions: 0, patch: fakePatch(5, 100) },
  { filename: 'src/huge.js', status: 'modified', additions: 360, deletions: 0, patch: fakePatch(6, 60) },
  { filename: 'src/a.js', status: 'modified', additions: 40, deletions: 0, patch: fakePatch(1, 40) },
  { filename: 'src/b.js', status: 'modified', additions: 40, deletions: 0, patch: fakePatch(1, 40) },
  { filename: 'src/c.js', status: 'modified', additions: 40, deletions: 0, patch: fakePatch(1, 40) },
  { filename: 'src/d.js', status: 'modified', additions: 40, deletions: 0, patch: fakePatch(1, 40) },
  { filename: 'logo.png', status: 'added', additions: 0, deletions: 0, patch: undefined },
  { filename: 'old/removed.js', status: 'removed', additions: 0, deletions: 10, patch: fakePatch(1, 10) },
  { filename: 'README.md', status: 'modified', additions: 10, deletions: 0, patch: fakePatch(1, 10) },
  { filename: 'test/a.test.js', status: 'modified', additions: 10, deletions: 0, patch: fakePatch(1, 10) },
];

const maxBatches = parseInt(process.argv[2] || '4', 10);
const plan = planReview(files, { maxBatches });

console.log(`\nmaxBatches = ${maxBatches}`);
console.log(`Batches: ${plan.batches.length}`);
plan.batches.forEach((b, i) => {
  console.log(`  Batch ${i + 1} (${b.text.length} chars): ${b.files.join(', ')}`);
});
console.log('Notes (would appear in the PR review):');
plan.notes.forEach((n) => console.log(`  - ${n}`));

process.exit(0);