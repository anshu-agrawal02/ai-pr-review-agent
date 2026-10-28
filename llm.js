const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
  maxRetries: 0, // the job queue handles retries, not the SDK
});

const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

// Temporary safety limit so one huge PR can't blow through the free-tier token cap.
// We'll replace this with proper chunking later.
const MAX_DIFF_CHARS = 12000;

const VALID_SEVERITIES = ['info', 'warning', 'error'];

// Adds real line numbers to each added line in a patch, and records
// which line numbers are valid places to comment.
function annotatePatch(patch) {
  const validLines = new Map(); // line number -> text of that line
  const out = [];
  let newLine = 0;

  for (const line of patch.split('\n')) {
    if (line === '') continue;

    // Hunk header, e.g. "@@ -7,7 +7,7 @@" -> new file starts at line 7
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) {
      newLine = parseInt(m[1], 10);
      out.push(line);
      continue;
    }

    if (line.startsWith('\\')) continue; // "\ No newline at end of file"

    if (line.startsWith('-')) {
      // Removed line: it doesn't exist in the new file, so no line number
      out.push(`       ${line}`);
      continue;
    }

    if (line.startsWith('+')) {
      validLines.set(newLine, line.slice(1));
      out.push(`L${newLine}: ${line}`);
    } else {
      // Context (unchanged) line: number it so the AI can orient itself,
      // but we only allow comments on added lines
      out.push(`L${newLine}:  ${line}`);
    }
    newLine++;
  }

  return { text: out.join('\n'), validLines };
}

function buildDiffInput(files) {
  const validLinesByFile = new Map();
  const parts = [];

  for (const f of files) {
    if (!f.patch) continue;
    const { text, validLines } = annotatePatch(f.patch);
    validLinesByFile.set(f.filename, validLines);
    parts.push(`File: ${f.filename}\n${text}`);
  }

  let diffText = parts.join('\n\n');
  if (diffText.length > MAX_DIFF_CHARS) {
    diffText = diffText.slice(0, MAX_DIFF_CHARS);
  }

  return { diffText, validLinesByFile };
}

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

const SYSTEM_PROMPT = `You are a careful senior engineer reviewing a pull request.

Look ONLY for real problems: bugs, security issues, and clear correctness or maintainability problems.
Do NOT comment on things that are fine. Do NOT invent issues to fill space. If the code has no real problems, return an empty findings list.

The diff is annotated: each line starts with "L<number>:" which is the line number in the NEW version of the file.
Lines starting with "+" were added, lines with "-" were removed, other lines are unchanged context.
Only report findings on added ("+") lines, and use the exact L-number shown for that line.

Respond with ONLY a valid JSON object, no markdown, no extra text, in exactly this shape:
{"findings":[{"file":"path/to/file.js","line":42,"severity":"error","comment":"Short, specific explanation and suggested fix."}]}

severity must be one of: "info", "warning", "error".
Use "error" for bugs and security problems, "warning" for risky code, "info" for minor suggestions.`;

async function reviewDiff(files) {
  const { diffText, validLinesByFile } = buildDiffInput(files);

  if (!diffText) {
    return [];
  }

  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Review this pull request diff and return JSON:\n\n${diffText}` },
    ],
  });

  const raw = response.choices[0].message.content;
  const findings = parseFindings(raw);
  return validateFindings(findings, validLinesByFile);
}

module.exports = { reviewDiff };