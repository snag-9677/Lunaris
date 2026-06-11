/**
 * Per-project env file (`.aienv`) loader — keeps provider API keys in a
 * gitignored per-repo file instead of global shell exports. Dep-free dotenv:
 * `KEY=value` lines, `#` comments, blank lines ignored, optional single/double
 * quotes stripped, `export ` prefix tolerated. Already-set process.env vars are
 * NOT overwritten by default, so a real shell export still wins.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROJECT_ENV_FILE = '.aienv';
export const PROJECT_ENV_SAMPLE = '.aienv.sample';

/** Parse dotenv-style text into a flat record. Does not touch process.env. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load `<projectDir>/.aienv` into process.env (missing keys only, unless
 * override). Returns the names of variables it set (never the values — keep
 * secrets out of logs/events). No-op if the file is absent.
 */
export function applyProjectEnv(
  projectDir: string,
  opts: { fileName?: string; override?: boolean; env?: Record<string, string | undefined> } = {},
): string[] {
  const fileName = opts.fileName ?? PROJECT_ENV_FILE;
  const env = opts.env ?? process.env;
  const path = join(projectDir, fileName);
  if (!existsSync(path)) return [];
  const parsed = parseEnvFile(readFileSync(path, 'utf8'));
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!opts.override && env[key] !== undefined && env[key] !== '') continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

/**
 * The starter `.aienv.sample` written by `lunaris init`. Lists the key names
 * the starter manifest's providers reference; users copy it to `.aienv` and
 * fill in values.
 */
export function sampleEnvFile(): string {
  return `# Lunaris per-project environment — copy to .aienv and fill in.
# .aienv is gitignored; never commit real keys. Values here override nothing
# that is already exported in your shell.
#
# Each provider in lunaris.toml references its key by env-var name (keyEnv).

# Anthropic (Claude)
ANTHROPIC_API_KEY=

# DeepSeek
DEEPSEEK_API_KEY=

# OpenAI / OpenAI-compatible
OPENAI_API_KEY=

# Ollama is local and needs no key. Set the base URL here to point at a
# non-default host (default http://localhost:11434); overrides lunaris.toml.
OLLAMA_BASE_URL=http://localhost:11434
`;
}
