const OpenAI = require('openai');
const crypto = require('crypto');
const { getCachedReview, setCachedReview } = require('./cache');

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
  maxRetries: 0, // the job queue handles retries, not the SDK
});

const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

// Tunable limits. These are starting guesses, not magic numbers: adjust them in .env.
const BATCH_CHAR_BUDGET = parseInt(process.env.BATCH_CHAR_BUDGET || '8000', 10); // chars per LLM call
const MAX_BATCHES = parseInt(process.env.MAX_BATCHES || '4', 10); // LLM calls per PR

const VALID_SEVERITIES = ['info', 'warning', 'error'];

// ---------- Which files to skip, and in what order to review the rest ----------

const SKIP_FILENAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock',
  'Gemfile.lock', 'poetry.lock', 'Cargo.lock', 'go.sum',
]);

const SKIP_PATTERNS = [
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.snap$/,
  /(^|\/)(dist|build|node_modules|vendor|coverage)\//,
  /\.(png|jpe?g|gif|svg|ico|pdf|woff2?|ttf|zip)$/i,
];

function skipReason(f) {
  const base = f.filename.split('/').pop();
  if (f.status === 'removed') return 'deleted file';
  if (SKIP_FILENAMES.has(base) || SKIP_PATTERNS.some((p) => p.test(f.filename))) {
    return 'lockfile, generated or binary file';
  }
  if (!f.patch) return 'no diff available (binary or too large for GitHub to show)';
  return null;
}

// Lower number = reviewed first
function priority(f) {
  const name = f.filename;
  if (/\.(md|txt|rst)$/i.test(name)) return 3;
  if (/(^|\/)(tests?|__tests__)\//.test(name) || /\.(test|spec)\./.test(name)) return 2;
  if (/\.(js|jsx|ts|tsx|py|java|go|rb|php|cs|cpp|c|rs|kt|swift|sql|sh)$/i.test(name)) return 0;
  return 1;
}

// ---------- Splitting big diffs ----------

function splitHunks(patch) {
  const hunks = [];
  let cur = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      cur = [line];
      hunks.push(cur);
    } else if (cur) {
      cur.push(line);
    }
  }
  return hunks.map((h) => h.join('\n'));
}

// Keep whole hunks until we hit the cap. Returns the shortened patch.
function fitPatch(patch, cap) {
  if (patch.length <= cap) return { patch, truncated: false };

  const kept = [];
  let size = 0;
  for (const h of splitHunks(patch)) {
    if (size + h.length + 1 > cap) {
      if (kept.length === 0) {
        // A single enormous hunk: cut it at a line boundary
        const cut = h.lastIndexOf('\n', cap);
        kept.push(h.slice(0, cut > 0 ? cut : cap));
      }
      break;
    }
    kept.push(h);
    size += h.length + 1;
  }
  return { patch: kept.join('\n'), truncated: true };
}

// Adds real line numbers to each added line in a patch, and records
// which line numbers are valid places to comment (line number -> line text).
function annotatePatch(patch) {
  const validLines = new Map();
  const out = [];
  let newLine = 0;

  for (const line of patch.split('\n')) {
    if (line === '') continue;

    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) {
      newLine = parseInt(m[1], 10);
      out.push(line);
      continue;
    }

    if (line.startsWith('\\')) continue; // "\ No newline at end of file"

    if (line.startsWith('-')) {
      out.push(`       ${line}`);
      continue;
    }

    if (line.startsWith('+')) {
      validLines.set(newLine, line.slice(1));
      out.push(`L${newLine}: ${line}`);
    } else {
      out.push(`L${newLine}:  ${line}`);
    }
    newLine++;
  }

  return { text: out.join('\n'), validLines };
}

// ---------- Planning: turn a list of files into batches ----------

function planReview(files, opts = {}) {
  const budget = opts.budget || BATCH_CHAR_BUDGET;
  const maxBatches = opts.maxBatches || MAX_BATCHES;
  const perFileCap = Math.floor(budget * 0.7); // leave room for line-number annotations

  const notes = [];
  const candidates = [];

  for (const f of files) {
    const reason = skipReason(f);
    if (reason) {
      notes.push(`\`${f.filename}\` (skipped: ${reason})`);
    } else {
      candidates.push(f);
    }
  }

  candidates.sort(
    (a, b) => priority(a) - priority(b) || (b.additions + b.deletions) - (a.additions + a.deletions)
  );

  const validLinesByFile = new Map();
  const batches = [];
  let current = null;

  for (const f of candidates) {
    const fit = fitPatch(f.patch, perFileCap);
    const { text, validLines } = annotatePatch(fit.patch);

    if (validLines.size === 0) {
      notes.push(`\`${f.filename}\` (skipped: no added lines to review)`);
      continue;
    }

    const block = `File: ${f.filename}\n${text}`;

    if (!current || current.size + block.length > budget) {
      if (batches.length >= maxBatches) {
        notes.push(`\`${f.filename}\` (skipped: PR is large, over the per-PR review limit)`);
        continue;
      }
      current = { parts: [], files: [], size: 0 };
      batches.push(current);
    }

    current.parts.push(block);
    current.files.push(f.filename);
    current.size += block.length + 2;
    validLinesByFile.set(f.filename, validLines);

    if (fit.truncated) {
      notes.push(`\`${f.filename}\` (large diff: only the first part was reviewed)`);
    }
  }

  return {
    batches: batches.map((b) => ({ text: b.parts.join('\n\n'), files: b.files })),
    notes,
    validLinesByFile,
  };
}

// ---------- Calling the LLM ----------

function parseFindings(raw) {
  let text = (raw || '').trim();
  // Some models wrap JSON in ```json fences even when told not to
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();

  try {
    const data = JSON.parse(text);
    return Array.isArray(data.findings) ? data.findings : [];
  } catch (err) {
    console.error('Could not parse LLM output as JSON. Raw output was:');
    console.error(raw);
    return [];
  }
}

function validateFindings(findings, validLinesByFile) {
  const good = [];

  for (const f of findings) {
    const validLines = validLinesByFile.get(f && f.file);

    if (!validLines) {
      console.log('Dropping finding (unknown file):', JSON.stringify(f));
    } else if (!Number.isInteger(f.line) || !validLines.has(f.line)) {
      console.log('Dropping finding (line is not a changed line):', JSON.stringify(f));
    } else if (!VALID_SEVERITIES.includes(f.severity)) {
      console.log('Dropping finding (bad severity):', JSON.stringify(f));
    } else if (typeof f.comment !== 'string' || !f.comment.trim()) {
      console.log('Dropping finding (empty comment):', JSON.stringify(f));
    } else {
      good.push({
        file: f.file,
        line: f.line,
        severity: f.severity,
        comment: f.comment.trim(),
        lineText: validLines.get(f.line),
      });
    }
  }

  return good;
}

const SYSTEM_PROMPT = `You are a careful senior engineer reviewing a pull request. The diff may contain several files.

Look ONLY for real problems: bugs, security issues, and clear correctness or maintainability problems.
Do NOT comment on things that are fine. Do NOT invent issues to fill space. If the code has no real problems, return an empty findings list.

The diff is annotated: each line starts with "L<number>:" which is the line number in the NEW version of the file.
Lines starting with "+" were added, lines with "-" were removed, other lines are unchanged context.
Only report findings on added ("+") lines, and use the exact L-number shown for that line.

Respond with ONLY a valid JSON object, no markdown, no extra text, in exactly this shape:
{"findings":[{"file":"path/to/file.js","line":42,"severity":"error","comment":"Short, specific explanation and suggested fix."}]}

severity must be one of: "info", "warning", "error".
Use "error" for bugs and security problems, "warning" for risky code, "info" for minor suggestions.`;

async function reviewBatch(text, validLinesByFile) {
  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Review this pull request diff and return JSON:\n\n${text}` },
    ],
  });

  const raw = response.choices[0].message.content;
  return validateFindings(parseFindings(raw), validLinesByFile);
}

function batchCacheKey(text) {
  const hash = crypto.createHash('sha256').update(`batch-v1|${MODEL}|${text}`).digest('hex');
  return `llmbatch:${hash}`;
}

// Returns { findings, notes }. notes = things we could not fully review.
async function reviewDiff(files) {
  const { batches, notes, validLinesByFile } = planReview(files);
  console.log(`Plan: ${batches.length} batch(es), ${notes.length} note(s)`);

  const all = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const key = batchCacheKey(batch.text);

    let found = await getCachedReview(key);
    if (found) {
      console.log(`Batch ${i + 1}/${batches.length}: cached (${batch.files.join(', ')})`);
    } else {
      console.log(`Batch ${i + 1}/${batches.length}: asking the LLM (${batch.files.join(', ')})`);
      found = await reviewBatch(batch.text, validLinesByFile);
      await setCachedReview(key, found); // if a later batch fails, a retry skips this one
    }
    all.push(...found);
  }

  return { findings: all, notes };
}

module.exports = { reviewDiff, planReview };