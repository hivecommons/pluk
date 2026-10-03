import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

export interface PatternSet {
  cli: string;
  idle: RegExp | null;
  working: RegExp | null;
  rateLimit: RegExp | null;
  login: RegExp | null;
  trustDialog: RegExp | null;
  bypass: RegExp | null;
  toolStart: RegExp | null;
  toolEnd: RegExp | null;
  error: RegExp | null;
  model: RegExp | null;
  sessionEnd: RegExp | null;
}

const PATTERN_KEYS: Record<string, keyof Omit<PatternSet, 'cli'>> = {
  IDLE_PATTERN: 'idle',
  WORKING_PATTERNS: 'working',
  RATE_LIMIT_PATTERN: 'rateLimit',
  LOGIN_PATTERN: 'login',
  TRUST_DIALOG_PATTERN: 'trustDialog',
  BYPASS_PATTERN: 'bypass',
  TOOL_START_PATTERN: 'toolStart',
  TOOL_END_PATTERN: 'toolEnd',
  ERROR_PATTERN: 'error',
  MODEL_PATTERN: 'model',
  SESSION_END_PATTERN: 'sessionEnd',
};

function compileOptional(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

export function loadPatterns(patternsDir: string, cli: string): PatternSet {
  const filePath = join(patternsDir, `${cli}.patterns`);
  const content = readFileSync(filePath, 'utf-8');
  return parsePatternsContent(content, cli);
}

export function parsePatternsContent(content: string, cli: string): PatternSet {
  const vars: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith("'") && val.endsWith("'")) ||
        (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }

  const result: PatternSet = {
    cli,
    idle: null,
    working: null,
    rateLimit: null,
    login: null,
    trustDialog: null,
    bypass: null,
    toolStart: null,
    toolEnd: null,
    error: null,
    model: null,
    sessionEnd: null,
  };

  for (const [varName, field] of Object.entries(PATTERN_KEYS)) {
    (result[field] as RegExp | null) = compileOptional(vars[varName]);
  }

  return result;
}

export function listAvailableCLIs(patternsDir: string): string[] {
  if (!existsSync(patternsDir)) return [];
  return readdirSync(patternsDir)
    .filter((f: string) => f.endsWith('.patterns'))
    .map((f: string) => f.replace('.patterns', ''));
}

export function bundledPatternsDir(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, '..', 'patterns');
}

// These four constants are the last-resort fallback used only when neither
// an explicit --patterns-dir nor the bundled patterns/ directory can be read
// (e.g. a packaging mode that strips non-JS assets). They must stay in sync
// with patterns/*.patterns — see the "inline builtin patterns match bundled
// pattern files" test in test/patterns.test.js, which fails if they drift.
const CLAUDE_PATTERNS = `
IDLE_PATTERN='❯\\s*$|^\\$ $'
WORKING_PATTERNS='esc to interrupt|● Working|↳ '
RATE_LIMIT_PATTERN='out of extra usage|Claude usage limit|monthly limit|quota exhausted|rate limit reached'
LOGIN_PATTERN='anthropic\\.com/login|Please log in|authentication required'
TRUST_DIALOG_PATTERN='Do you trust the files'
BYPASS_PATTERN='bypass permissions on'
TOOL_START_PATTERN='● (Read|Write|Edit|Bash|Agent|WebSearch|WebFetch|Skill|Workflow|NotebookEdit)'
TOOL_END_PATTERN='✓ (Read|Write|Edit|Bash|Agent|WebSearch|WebFetch|Skill|Workflow|NotebookEdit).*\\([0-9]'
ERROR_PATTERN='^\\s*Error:|^\\s*error:|^\\s*FATAL|^\\s*panic:|InputValidationError'
MODEL_PATTERN='model.*claude-|Switched to .*claude-'
SESSION_END_PATTERN='Session ended|Goodbye'
`;

const COPILOT_PATTERNS = `
IDLE_PATTERN='❯\\s*$|^\\$ $'
WORKING_PATTERNS='◐|◑|◒|◓|◉|◎|○|● Working|● Read|● Environment loaded|Esc to cancel'
RATE_LIMIT_PATTERN='Copilot usage limit|out of extra usage|quota exhausted|monthly limit'
LOGIN_PATTERN='github\\.com/login|Please sign in|authentication required|Device code:'
TRUST_DIALOG_PATTERN='Do you trust the files'
BYPASS_PATTERN=''
TOOL_START_PATTERN='● .+ \\(shell\\)|● .+ \\(read\\)|● .+ \\(write\\)|● .+ \\(edit\\)'
TOOL_END_PATTERN='✓ .+ \\(shell\\)|✓ .+ \\(read\\)|✓ .+ \\(write\\)|✓ .+ \\(edit\\)'
ERROR_PATTERN='^\\s*Error:|^\\s*error:|^\\s*FATAL|^\\s*panic:'
MODEL_PATTERN='Using model:|model.*claude-|model.*gpt-'
SESSION_END_PATTERN='Session ended|Goodbye'
`;

const GEMINI_PATTERNS = `
IDLE_PATTERN='>\\s*$|❯\\s*$'
WORKING_PATTERNS='◐|◑|◒|◓|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|Thinking|Generating'
RATE_LIMIT_PATTERN='rate limit|quota exceeded|resource exhausted|429'
LOGIN_PATTERN='gcloud auth login|authenticate|sign in'
TRUST_DIALOG_PATTERN=''
BYPASS_PATTERN=''
TOOL_START_PATTERN=''
TOOL_END_PATTERN=''
ERROR_PATTERN='^\\s*Error:|^\\s*ERROR:|^\\s*FATAL|^\\s*panic:'
MODEL_PATTERN='Using model:|gemini-'
SESSION_END_PATTERN='Session ended|Goodbye'
`;

const GOOSE_PATTERNS = `
IDLE_PATTERN='>\\s*$|❯\\s*$|goose>'
WORKING_PATTERNS='◐|◑|◒|◓|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|thinking|processing'
RATE_LIMIT_PATTERN='rate limit|quota exceeded|429|too many requests'
LOGIN_PATTERN='authenticate|sign in|login required'
TRUST_DIALOG_PATTERN=''
BYPASS_PATTERN=''
TOOL_START_PATTERN=''
TOOL_END_PATTERN=''
ERROR_PATTERN='^\\s*Error:|^\\s*error:|^\\s*FATAL|^\\s*panic:'
MODEL_PATTERN='Using model:'
SESSION_END_PATTERN='Session ended|Goodbye'
`;

const CODEX_PATTERNS = `
IDLE_PATTERN='>\\s*$|❯\\s*$'
WORKING_PATTERNS='esc to interrupt|● Working|Working \\('
RATE_LIMIT_PATTERN='rate limit|quota exceeded|usage limit|429|too many requests'
LOGIN_PATTERN='Please log in|authentication required|sign in|login required'
TRUST_DIALOG_PATTERN=''
BYPASS_PATTERN=''
TOOL_START_PATTERN=''
TOOL_END_PATTERN=''
ERROR_PATTERN='^\\s*Error:|^\\s*error:|^\\s*FATAL|^\\s*panic:'
MODEL_PATTERN='Using model:|model.*gpt-|model.*o[0-9]'
SESSION_END_PATTERN='Session ended|Goodbye'
`;

const AIDER_PATTERNS = `
IDLE_PATTERN='^>\\s*$'
WORKING_PATTERNS='Tokens: [0-9]'
RATE_LIMIT_PATTERN='rate limit|quota exceeded|429|too many requests'
LOGIN_PATTERN='API key|authenticate|sign in|login required'
TRUST_DIALOG_PATTERN=''
BYPASS_PATTERN=''
TOOL_START_PATTERN=''
TOOL_END_PATTERN=''
ERROR_PATTERN='^\\s*Error:|^\\s*error:|^\\s*FATAL|^\\s*panic:'
MODEL_PATTERN='^Model:|model.*gpt-|model.*claude-'
SESSION_END_PATTERN='Session ended|Goodbye'
`;

export const BUILTIN_PATTERNS: Record<string, string> = {
  claude: CLAUDE_PATTERNS,
  copilot: COPILOT_PATTERNS,
  gemini: GEMINI_PATTERNS,
  goose: GOOSE_PATTERNS,
  codex: CODEX_PATTERNS,
  aider: AIDER_PATTERNS,
};

export function getPatterns(cli: string, patternsDir?: string): PatternSet {
  if (patternsDir) {
    try {
      return loadPatterns(patternsDir, cli);
    } catch {
      // fall through to builtin
    }
  }

  const bundled = bundledPatternsDir();
  try {
    return loadPatterns(bundled, cli);
  } catch {
    // fall through to inline
  }

  const inline = BUILTIN_PATTERNS[cli];
  if (inline) {
    return parsePatternsContent(inline, cli);
  }

  return { cli, idle: null, working: null, rateLimit: null, login: null, trustDialog: null, bypass: null, toolStart: null, toolEnd: null, error: null, model: null, sessionEnd: null };
}
