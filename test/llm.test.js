const mockCreate = jest.fn();

// Replace the Groq/OpenAI client and the Redis cache, so tests never touch the network
jest.mock('openai', () =>
  jest.fn(() => ({ chat: { completions: { create: mockCreate } } }))
);
jest.mock('../cache', () => ({
  getCachedReview: jest.fn(),
  setCachedReview: jest.fn(),
}));

const cache = require('../cache');
const { reviewDiff, planReview } = require('../llm');

// ---------- helpers ----------

function makeFile(filename, patch, extra = {}) {
  return { filename, status: 'modified', additions: 1, deletions: 0, patch, ...extra };
}

// Looks like a real GitHub patch. In the new file: context lines are 7, 8, 9
// and the added line is line 10.
const CALC_PATCH = [
  '@@ -7,7 +7,7 @@ function subtract(a, b) {',
  ' }',
  ' ',
  ' function multiply(a, b) {',
  '-    return a * b;',
  '+    return a + b;',
  ' }',
  ' ',
  ' module.exports = {',
].join('\n');

// A hunk that adds `count` lines starting at line `start`
function hunk(start, count) {
  const lines = [`@@ -${start},0 +${start},${count} @@`];
  for (let i = 0; i < count; i++) lines.push(`+const v${i} = ${i};`);
  return lines.join('\n');
}

function llmReturns(content) {
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { content } }] });
}

const GOOD_FINDING = {
  file: 'src/calculator.js',
  line: 10,
  severity: 'error',
  comment: 'multiply uses + instead of *',
};

let logSpy;
let errSpy;
beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  mockCreate.mockReset();
  cache.getCachedReview.mockReset();
  cache.setCachedReview.mockReset();
  cache.getCachedReview.mockResolvedValue(null); // default: cache miss
  cache.setCachedReview.mockResolvedValue();
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

// ---------- planReview: which files get reviewed, and how ----------

describe('planReview', () => {
  test('skips lockfiles, binaries, deleted files and files with no diff', () => {
    const files = [
      makeFile('package-lock.json', CALC_PATCH),
      makeFile('logo.png', undefined),
      makeFile('old.js', CALC_PATCH, { status: 'removed' }),
      makeFile('src/calculator.js', CALC_PATCH),
    ];
    const plan = planReview(files);

    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0].files).toEqual(['src/calculator.js']);
    expect(plan.notes).toHaveLength(3);
    ['package-lock.json', 'logo.png', 'old.js'].forEach((name) => {
      expect(plan.notes.join('\n')).toContain(name);
    });
  });

  test('reviews source code before tests, and tests before docs', () => {
    const files = [
      makeFile('README.md', hunk(1, 3)),
      makeFile('test/a.test.js', hunk(1, 3)),
      makeFile('src/a.js', hunk(1, 3)),
    ];
    const plan = planReview(files);
    expect(plan.batches[0].files).toEqual(['src/a.js', 'test/a.test.js', 'README.md']);
  });

  test('numbers lines by their position in the NEW file', () => {
    const plan = planReview([makeFile('src/calculator.js', CALC_PATCH)]);
    const valid = plan.validLinesByFile.get('src/calculator.js');

    expect(Array.from(valid.keys())).toEqual([10]); // only the added line is commentable
    expect(plan.batches[0].text).toContain('L10: +    return a + b;');
  });

  test('keeps whole hunks and reports when a big file is cut short', () => {
    const big = makeFile('src/big.js', [hunk(1, 10), hunk(101, 10), hunk(201, 10)].join('\n'), {
      additions: 30,
    });
    const plan = planReview([big], { budget: 600, maxBatches: 4 });
    const valid = plan.validLinesByFile.get('src/big.js');

    expect(valid.has(1)).toBe(true);
    expect(valid.has(101)).toBe(true);
    expect(valid.has(201)).toBe(false); // the third hunk did not fit
    expect(plan.notes.join('\n')).toContain('large diff');
  });

  test('stops at the per-PR batch limit and says which files were skipped', () => {
    const files = ['a', 'b', 'c', 'd'].map((n) =>
      makeFile(`src/${n}.js`, hunk(1, 20), { additions: 20 })
    );
    const plan = planReview(files, { budget: 600, maxBatches: 2 });

    expect(plan.batches).toHaveLength(2);
    const skipped = plan.notes.filter((n) => n.includes('over the per-PR review limit'));
    expect(skipped).toHaveLength(2);
  });
});

// ---------- reviewDiff: the LLM call, with the LLM mocked ----------

describe('reviewDiff', () => {
  const files = [makeFile('src/calculator.js', CALC_PATCH)];

  test('keeps a valid finding and records the text of the flagged line', async () => {
    llmReturns(JSON.stringify({ findings: [GOOD_FINDING] }));
    const { findings } = await reviewDiff(files);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'src/calculator.js',
      line: 10,
      severity: 'error',
      lineText: '    return a + b;',
    });
  });

  test('drops findings that point at unchanged lines, unknown files or bad data', async () => {
    llmReturns(
      JSON.stringify({
        findings: [
          GOOD_FINDING,
          { ...GOOD_FINDING, line: 8 }, // line 8 exists but was not changed
          { ...GOOD_FINDING, file: 'src/ghost.js' }, // file is not in this PR
          { ...GOOD_FINDING, severity: 'catastrophic' }, // not an allowed severity
          { ...GOOD_FINDING, comment: '   ' }, // empty comment
        ],
      })
    );
    const { findings } = await reviewDiff(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(10);
  });

  test('parses JSON that the model wrapped in markdown fences', async () => {
    llmReturns('```json\n' + JSON.stringify({ findings: [GOOD_FINDING] }) + '\n```');
    const { findings } = await reviewDiff(files);
    expect(findings).toHaveLength(1);
  });

  test('survives output that is not JSON at all', async () => {
    llmReturns('Sorry, I cannot review this.');
    const { findings } = await reviewDiff(files);
    expect(findings).toEqual([]);
  });

  test('returns no findings when the model finds nothing', async () => {
    llmReturns(JSON.stringify({ findings: [] }));
    const { findings } = await reviewDiff(files);
    expect(findings).toEqual([]);
  });

  test('rethrows API errors (like a 429) so the job queue can retry', async () => {
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('429 Rate limit reached'), { status: 429 }));

    await expect(reviewDiff(files)).rejects.toMatchObject({ status: 429 });
    expect(cache.setCachedReview).not.toHaveBeenCalled(); // a failed batch is never cached
  });

  test('uses a cached batch and makes no LLM call', async () => {
    cache.getCachedReview.mockResolvedValue([{ ...GOOD_FINDING, lineText: 'x' }]);
    const { findings } = await reviewDiff(files);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(findings).toHaveLength(1);
  });

  test('caches the batch result after a successful LLM call', async () => {
    llmReturns(JSON.stringify({ findings: [GOOD_FINDING] }));
    await reviewDiff(files);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(cache.setCachedReview).toHaveBeenCalledTimes(1);
    expect(cache.setCachedReview.mock.calls[0][1]).toHaveLength(1);
  });

  test('makes no LLM call when every file is skipped', async () => {
    const { findings, notes } = await reviewDiff([makeFile('package-lock.json', CALC_PATCH)]);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(findings).toEqual([]);
    expect(notes).toHaveLength(1);
  });
});