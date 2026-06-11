/**
 * lunaris.toml manifest: zod schema mirroring LunarisManifest (types.ts),
 * plus loadManifest()/initManifest().
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { uuidv7 } from './ids.js';
import { PROJECT_ENV_FILE, PROJECT_ENV_SAMPLE, sampleEnvFile } from './env.js';
import type { LunarisManifest } from './types.js';

/** "<provider>/<model>", e.g. "anthropic/claude-sonnet-4-6", "ollama/qwen3:8b". */
const modelRefSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*\/\S+$/i, 'must be "<provider>/<model>", e.g. "mock/echo"');

const providerConfigSchema = z.object({
  baseUrl: z.string().optional(),
  keyEnv: z.string().optional(),
});

const budgetCapsSchema = z.object({
  perCallUsd: z.number().nonnegative().optional(),
  perTaskUsd: z.number().nonnegative().optional(),
  perDayUsd: z.number().nonnegative().optional(),
});

export const lunarisManifestSchema = z.object({
  project: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  models: z.object({
    default: modelRefSchema,
    roles: z.record(z.string(), modelRefSchema).optional(),
  }),
  providers: z.record(z.string(), providerConfigSchema).optional(),
  budgets: budgetCapsSchema.optional(),
  devenv: z
    .object({
      provisioner: z.enum(['devcontainer', 'nix', 'dockerfile', 'probe']).optional(),
    })
    .optional(),
});

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `  - ${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('\n');
}

/** Validate an already-parsed object as a LunarisManifest. */
export function validateManifest(data: unknown, source = 'lunaris.toml'): LunarisManifest {
  const result = lunarisManifestSchema.safeParse(data);
  if (!result.success) {
    throw new ManifestError(`Invalid manifest at ${source}:\n${formatIssues(result.error)}`);
  }
  return result.data as LunarisManifest;
}

/** Parse and validate <projectDir>/lunaris.toml. Throws ManifestError with a clear message. */
export function loadManifest(projectDir: string): LunarisManifest {
  const manifestPath = join(projectDir, 'lunaris.toml');
  if (!existsSync(manifestPath)) {
    throw new ManifestError(
      `Manifest not found: ${manifestPath} (run "lunaris init" to create one)`,
    );
  }
  const raw = readFileSync(manifestPath, 'utf8');
  let data: unknown;
  try {
    data = parseToml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ManifestError(`Invalid TOML in ${manifestPath}: ${msg}`);
  }
  return validateManifest(data, manifestPath);
}

function tomlEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function starterToml(id: string, name: string): string {
  return `# Lunaris project manifest. See LUNARIS_SPEC.md for the full schema.

[project]
id = "${id}"
name = "${tomlEscape(name)}"

[models]
# "<provider>/<model>". "mock/echo" needs no API key; swap once providers are configured.
default = "mock/echo"
# Per-role overrides, e.g.:
# [models.roles]
# coder = "anthropic/claude-sonnet-4-6"
# reviewer = "deepseek/deepseek-chat"

# Providers reference API keys by env var name (keyEnv) -- never store keys here.
[providers.anthropic]
keyEnv = "ANTHROPIC_API_KEY"

[providers.deepseek]
baseUrl = "https://api.deepseek.com"
keyEnv = "DEEPSEEK_API_KEY"

[providers.ollama]
# Local, no key. Base URL comes from OLLAMA_BASE_URL in .aienv
# (default http://localhost:11434); uncomment to pin it here instead.
# baseUrl = "http://localhost:11434"

[budgets]
perCallUsd = 0.5
perDayUsd = 10.0
`;
}

export interface InitManifestOptions {
  name?: string;
}

/**
 * Initialize a Lunaris project: mint a UUIDv7 project id, write a starter
 * lunaris.toml, and create the .lunaris/{journal,state} directories.
 * Throws ManifestError if a lunaris.toml already exists in projectDir.
 * The project name may be passed as a plain string or as { name }; it
 * defaults to the project directory's basename.
 */
export function initManifest(
  projectDir: string,
  nameOrOptions?: string | InitManifestOptions,
): LunarisManifest {
  const name =
    (typeof nameOrOptions === 'string' ? nameOrOptions : nameOrOptions?.name) ??
    basename(resolve(projectDir));
  const manifestPath = join(projectDir, 'lunaris.toml');
  if (existsSync(manifestPath)) {
    throw new ManifestError(`Refusing to overwrite existing manifest: ${manifestPath}`);
  }
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(projectDir, '.lunaris', 'journal'), { recursive: true });
  mkdirSync(join(projectDir, '.lunaris', 'state'), { recursive: true });

  const id = uuidv7();
  writeFileSync(manifestPath, starterToml(id, name), 'utf8');

  // Per-project env: write a .aienv.sample to copy, and gitignore the real .aienv.
  const samplePath = join(projectDir, PROJECT_ENV_SAMPLE);
  if (!existsSync(samplePath)) writeFileSync(samplePath, sampleEnvFile(), 'utf8');
  ensureGitignored(projectDir, PROJECT_ENV_FILE);

  return loadManifest(projectDir);
}

/** Append an entry to <dir>/.gitignore if not already present (creates the file). */
function ensureGitignored(projectDir: string, entry: string): void {
  const gitignorePath = join(projectDir, '.gitignore');
  let current = '';
  if (existsSync(gitignorePath)) current = readFileSync(gitignorePath, 'utf8');
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(entry)) return;
  const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
  writeFileSync(gitignorePath, `${current}${prefix}${entry}\n`, 'utf8');
}
