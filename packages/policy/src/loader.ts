/**
 * Policy file loading. A project may pin its autonomy policy in
 * <projectDir>/.lunaris/policy.yaml:
 *
 *   level: 2
 *   tightenWhenTainted: true
 *   allowlistedHosts:
 *     - api.github.com
 *   rules:
 *     - effect: allow
 *       tools: [read_file, list_dir, search]
 *     - effect: queue
 *       tools: [run_bash]
 *       commands: ["git push*"]
 *
 * When absent, the level falls back to an explicit argument (or L2). Rules are
 * loosely validated and coerced; unknown fields are ignored.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AutonomyLevel, PolicyEffect, PolicyRule } from '@lunaris/core';
import { defaultPolicyRules } from './approvals.js';

export interface LoadedPolicy {
  level: AutonomyLevel;
  rules: PolicyRule[];
  tightenWhenTainted: boolean;
  allowlistedHosts: string[];
}

const VALID_EFFECTS: readonly PolicyEffect[] = ['allow', 'deny', 'queue'];

/** Relative path of the policy file within a project. */
export const POLICY_REL_PATH = join('.lunaris', 'policy.yaml');

function policyPath(projectDir: string): string {
  return join(projectDir, POLICY_REL_PATH);
}

function coerceLevel(value: unknown, fallback: AutonomyLevel): AutonomyLevel {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  return fallback;
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string');
  return out.length > 0 ? out : undefined;
}

function coerceRule(raw: unknown): PolicyRule | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const effect = r['effect'];
  if (typeof effect !== 'string' || !VALID_EFFECTS.includes(effect as PolicyEffect)) {
    return undefined;
  }
  const rule: PolicyRule = { effect: effect as PolicyEffect };
  const tools = coerceStringArray(r['tools']);
  if (tools) rule.tools = tools;
  const commands = coerceStringArray(r['commands']);
  if (commands) rule.commands = commands;
  const paths = coerceStringArray(r['paths']);
  if (paths) rule.paths = paths;
  const domains = coerceStringArray(r['domains']);
  if (domains) rule.domains = domains;
  if (typeof r['whenTainted'] === 'boolean') rule.whenTainted = r['whenTainted'];
  if (typeof r['reason'] === 'string') rule.reason = r['reason'];
  return rule;
}

export interface LoadPolicyOptions {
  /** Fallback autonomy level when the file is absent or omits one. Default 2. */
  level?: AutonomyLevel;
}

/**
 * Load <projectDir>/.lunaris/policy.yaml. If absent, returns a default policy at
 * the fallback level (options.level, else L2) using defaultPolicyRules().
 */
export function loadPolicy(projectDir: string, options: LoadPolicyOptions = {}): LoadedPolicy {
  const fallbackLevel = options.level ?? 2;
  const path = policyPath(projectDir);

  if (!existsSync(path)) {
    return {
      level: fallbackLevel,
      rules: defaultPolicyRules(fallbackLevel),
      tightenWhenTainted: true,
      allowlistedHosts: [],
    };
  }

  const raw = readFileSync(path, 'utf8');
  const data = (parseYaml(raw) ?? {}) as Record<string, unknown>;

  const level = coerceLevel(data['level'], fallbackLevel);
  const rawRules = Array.isArray(data['rules']) ? data['rules'] : [];
  const rules = rawRules
    .map(coerceRule)
    .filter((r): r is PolicyRule => r !== undefined);

  return {
    level,
    rules: rules.length > 0 ? rules : defaultPolicyRules(level),
    tightenWhenTainted:
      typeof data['tightenWhenTainted'] === 'boolean' ? data['tightenWhenTainted'] : true,
    allowlistedHosts: coerceStringArray(data['allowlistedHosts']) ?? [],
  };
}

/**
 * Write a default policy.yaml for a level (creating .lunaris/ as needed).
 * Refuses to clobber an existing file unless overwrite is set.
 */
export function writeDefaultPolicy(
  projectDir: string,
  level: AutonomyLevel,
  overwrite = false,
): string {
  const path = policyPath(projectDir);
  if (existsSync(path) && !overwrite) {
    throw new Error(`Refusing to overwrite existing policy: ${path}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const doc = {
    level,
    tightenWhenTainted: true,
    allowlistedHosts: [] as string[],
    rules: defaultPolicyRules(level),
  };
  const header =
    '# Lunaris autonomy policy. level: 0 read-only · 1 supervised · 2 workspace · 3 full-auto.\n' +
    '# Rules are evaluated in order, first match wins; otherwise the level default applies.\n';
  writeFileSync(path, header + stringifyYaml(doc), 'utf8');
  return path;
}
