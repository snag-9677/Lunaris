/**
 * RulePolicyEngine: the Lunaris Policy Decision Point (PDP).
 *
 * evaluate(tool, args, ctx) walks the configured rules in order (first match
 * wins). A rule matches when its tool glob(s) match AND every supplied
 * predicate (commands for run_bash, paths for file tools, domains for
 * web_fetch, whenTainted) matches the call. When no rule matches, an
 * autonomy-level default applies (L0 read-only .. L3 full-auto).
 *
 * Two cross-cutting overlays sit on top of the level defaults:
 *  - Irreversible class (git push, deploy, rm -rf outside root, package
 *    publish, curl POST to a non-allowlisted host, sending mail/messages):
 *    always 'queue' regardless of level, UNLESS an explicit allow rule
 *    matched first.
 *  - Taint overlay: when ctx.tainted and tightenWhenTainted (default true),
 *    secret-adjacent tools are denied and any bash/network action that would
 *    otherwise be 'allow' is tightened to 'queue'.
 */
import type {
  AutonomyLevel,
  PolicyDecision,
  PolicyEffect,
  PolicyEngine,
  PolicyRule,
  ToolCallCtx,
} from '@lunaris/core';

/** Tool name classes (glob-friendly). Adapters map their concrete tool names onto these. */
export const READ_TOOLS = ['read_file', 'list_dir', 'search'] as const;
export const FILE_WRITE_TOOLS = ['write_file', 'edit_file', 'apply_patch', 'delete_file'] as const;
export const BASH_TOOLS = ['run_bash'] as const;
export const NETWORK_TOOLS = ['web_fetch'] as const;
/** Tools that touch secrets/credentials — denied entirely under taint. */
export const SECRET_TOOLS = ['read_secret', 'get_secret', 'read_env', 'dump_env'] as const;

/**
 * Translate a subset of glob syntax into a RegExp.
 *  - `**` matches any run of characters (including path separators)
 *  - `*`  matches any run of characters except `/`
 *  - all other characters are matched literally
 * Anchored to the whole string. No external deps.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'; // `**` — cross separators
        i++;
      } else {
        re += '[^/]*'; // `*` — stay within a segment
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += `\\${c}`; // escape regex metachars
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function globMatch(glob: string, value: string): boolean {
  return globToRegExp(glob).test(value);
}

function anyGlobMatch(globs: string[] | undefined, value: string): boolean {
  if (globs === undefined || globs.length === 0) return true;
  return globs.some((g) => globMatch(g, value));
}

/** Best-effort extraction of well-known fields from an opaque tool args object. */
interface ParsedArgs {
  command?: string;
  path?: string;
  url?: string;
  method?: string;
}

function parseArgs(args: unknown): ParsedArgs {
  if (typeof args !== 'object' || args === null) return {};
  const a = args as Record<string, unknown>;
  const out: ParsedArgs = {};
  if (typeof a['command'] === 'string') out.command = a['command'];
  if (typeof a['path'] === 'string') out.path = a['path'];
  else if (typeof a['file'] === 'string') out.path = a['file'];
  if (typeof a['url'] === 'string') out.url = a['url'];
  if (typeof a['method'] === 'string') out.method = a['method'];
  return out;
}

function hostOf(url: string | undefined): string {
  if (url === undefined) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isReadTool(tool: string): boolean {
  return (READ_TOOLS as readonly string[]).includes(tool);
}
function isFileWriteTool(tool: string): boolean {
  return (FILE_WRITE_TOOLS as readonly string[]).includes(tool);
}
function isBashTool(tool: string): boolean {
  return (BASH_TOOLS as readonly string[]).includes(tool);
}
function isNetworkTool(tool: string): boolean {
  return (NETWORK_TOOLS as readonly string[]).includes(tool);
}
/**
 * Secret-adjacent tool names denied under taint. Beyond the hardcoded
 * SECRET_TOOLS allowlist, match anything whose NAME signals secret access
 * (FIX 5): a tool a malicious injected instruction might invoke to exfiltrate
 * credentials — `*_secret`, `*credential*`, `*token*`, `vault_*`, `read_env`...
 */
const SECRET_SUBSTR = /secret|credential|password|passwd/i;
const SECRET_TOKENS = new Set(['vault', 'env', 'token', 'secret', 'secrets', 'creds', 'credential', 'credentials']);

function isSecretTool(tool: string): boolean {
  if ((SECRET_TOOLS as readonly string[]).includes(tool)) return true;
  // Substrings that signal secrets even mid-word (aws_get_secret, mysecretstore).
  if (SECRET_SUBSTR.test(tool)) return true;
  // Tokenize on common separators so vault_read / read_env / aws.token match —
  // \bvault\b fails here because '_' is a word char (no boundary).
  return tool
    .toLowerCase()
    .split(/[_\-.:/]+/)
    .some((t) => SECRET_TOKENS.has(t));
}

/** Bash command fragments that signal an irreversible / externally-visible action. */
const IRREVERSIBLE_BASH = [
  /\bgit\b(?:\s+-\S+(?:\s+\S+)?)*\s+push\b/, // git push, also `git -C /repo push`, `git --no-pager push`
  /\bgit\s+(?:remote|tag)\b.*\b(?:push|--delete|-d)\b/,
  /\bnpm\s+publish\b/,
  /\bpnpm\s+publish\b/,
  /\byarn\s+publish\b/,
  /\bcargo\s+publish\b/,
  /\b(?:kubectl|helm)\s+(?:apply|delete|rollout|upgrade|install)\b/,
  /\bterraform\s+apply\b/,
  /\b(?:docker|gh|flyctl|fly|vercel|netlify|wrangler)\s+(?:push|deploy|release)\b/,
  /\bdeploy\b/,
  /\b(?:mail|sendmail|mailx|msmtp)\b/,
];

/**
 * Shell separators that chain independent commands. Splitting on these lets the
 * PDP evaluate every segment of a compound command (FIX 2): `ls; git push` must
 * not slip past an `ls*` allow rule, and an irreversible segment anywhere taints
 * the whole command. `>`/`<` redirections and `&` background are also cut so a
 * trailing/leading dangerous command in `foo & git push` is still seen.
 */
const SHELL_SEPARATORS = /(?:&&|\|\||;|\||&|\n|\r)+/;

/** Split a compound bash command into its independently-evaluated segments. */
export function splitBashSegments(command: string): string[] {
  return command
    .split(SHELL_SEPARATORS)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Detect `rm` with recursive AND force semantics, accepting long flags
 * (`--recursive`, `--force`), short flags in any order/grouping (`-rf`, `-fr`,
 * `-R -f`, `-r --force`), and `-R`. Returns the substring AFTER the rm + flags
 * (the would-be targets) when matched, else undefined.
 */
function rmRecursiveForceTargets(segment: string): string | undefined {
  const m = /\brm\b((?:\s+-{1,2}[a-zA-Z]+)*)/.exec(segment);
  if (m === null) return undefined;
  // Collect every flag token between `rm` and the first non-flag token.
  const flagText = m[1] ?? '';
  let recursive = false;
  let force = false;
  for (const tok of flagText.split(/\s+/)) {
    if (tok === '--recursive') recursive = true;
    else if (tok === '--force') force = true;
    else if (/^-[a-zA-Z]+$/.test(tok)) {
      // Combined / single short flags: -rf, -fr, -R, -f, -r ...
      if (tok.includes('R') || tok.includes('r')) recursive = true;
      if (tok.includes('f')) force = true;
    }
  }
  if (!recursive || !force) return undefined;
  return segment.slice(m.index + m[0].length);
}

/** A target that escapes the workspace root or expands to one we cannot vet. */
function rmTargetIsDangerous(targets: string): boolean {
  const toks = targets.split(/\s+/).filter((t) => t.length > 0 && !t.startsWith('-'));
  if (toks.length === 0) return true; // `rm -rf` with no parseable target: treat conservatively.
  for (const t of toks) {
    // Strip simple surrounding quotes for inspection.
    const u = t.replace(/^['"]|['"]$/g, '');
    if (u === '/' || u === '~' || u.startsWith('/') || u.startsWith('~')) return true; // absolute / home
    if (u.includes('$') || u.includes('`') || u.includes('*')) return true; // variable / cmd-subst / glob: unvettable
    if (u === '..' || u.startsWith('../') || u.includes('/../') || u.endsWith('/..')) return true; // parent escape
  }
  return false;
}

/** True if a SINGLE bash segment is irreversible-class. */
function segmentIsIrreversible(segment: string): boolean {
  if (IRREVERSIBLE_BASH.some((re) => re.test(segment))) return true;
  // rm -r -f is only irreversible-class when its targets escape the workspace
  // root, expand to a home/absolute path, or are otherwise unvettable.
  const targets = rmRecursiveForceTargets(segment);
  if (targets !== undefined && rmTargetIsDangerous(targets)) return true;
  return false;
}

/**
 * A bash command is irreversible if ANY of its chained segments is irreversible
 * (FIX 2a). This closes the chained-command hole: `ls; git push` is irreversible
 * even though `ls` alone is not.
 */
function bashIsIrreversible(command: string): boolean {
  const segments = splitBashSegments(command);
  if (segments.length === 0) return segmentIsIrreversible(command);
  return segments.some(segmentIsIrreversible);
}

/**
 * Is this call in the irreversible class? Such calls always queue regardless of
 * level (unless an explicit allow rule already matched).
 *  - run_bash: matches an irreversible command pattern, or rm -rf outside root
 *  - web_fetch: a non-GET (POST/PUT/PATCH/DELETE) to a host that is NOT allowlisted
 *  - send_email / send_message / *.publish / deploy_* tools
 */
export function isIrreversible(
  tool: string,
  parsed: ParsedArgs,
  allowlistedHosts: readonly string[],
): boolean {
  if (/(?:^|[._])(?:send_email|send_message|sms|slack_post|publish|deploy)/.test(tool)) {
    return true;
  }
  if (isBashTool(tool) && parsed.command !== undefined) {
    return bashIsIrreversible(parsed.command);
  }
  if (isNetworkTool(tool)) {
    const method = (parsed.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      const host = hostOf(parsed.url);
      const allowed = allowlistedHosts.some((g) => globMatch(g, host));
      if (!allowed) return true;
    }
  }
  return false;
}

/**
 * The "irreversible verbs" a narrow allow rule must literally begin with to be
 * allowed to override the irreversible-class overlay (FIX 1). These mirror the
 * irreversible bash patterns: only an allow rule whose command globs ALL start
 * with one of these specific verb-phrases (e.g. `git push`) may override the
 * overlay — a broad `git*` or `*` must not.
 */
const IRREVERSIBLE_VERB_PREFIXES = [
  'git push',
  'git remote',
  'git tag',
  'npm publish',
  'pnpm publish',
  'yarn publish',
  'cargo publish',
  'kubectl apply',
  'kubectl delete',
  'kubectl rollout',
  'kubectl upgrade',
  'kubectl install',
  'helm apply',
  'helm delete',
  'helm rollout',
  'helm upgrade',
  'helm install',
  'terraform apply',
  'docker push',
  'docker deploy',
  'docker release',
  'gh release',
  'flyctl deploy',
  'fly deploy',
  'vercel deploy',
  'netlify deploy',
  'wrangler deploy',
  'wrangler publish',
  'deploy',
] as const;

/**
 * The literal-prefix of a command glob: the leading run of characters before
 * the first glob metachar (`*`/`?`), with regex-irrelevant whitespace collapsed.
 * `git push*` -> `git push`; `git*` -> `git`; `*` -> ``.
 */
function literalPrefix(glob: string): string {
  const meta = glob.search(/[*?]/);
  const head = meta === -1 ? glob : glob.slice(0, meta);
  return head.replace(/\s+/g, ' ').trim();
}

/**
 * FIX 1: decide whether an explicit `allow` rule is narrow enough to override
 * the irreversible-class overlay. Conservative by design: the rule overrides the
 * overlay only when it carries command globs AND every one of those globs has a
 * literal prefix that begins with a specific irreversible verb-phrase (e.g.
 * `git push`), NOT a broad prefix like `git` or `` (from `git*` / `*`). A rule
 * with no command globs (tool-only allow) never overrides the overlay. When in
 * doubt we do NOT override — the call falls through to 'queue'.
 */
function allowRuleOverridesIrreversible(rule: PolicyRule): boolean {
  if (rule.effect !== 'allow') return false;
  const globs = rule.commands;
  if (globs === undefined || globs.length === 0) return false;
  return globs.every((g) => {
    const prefix = literalPrefix(g).toLowerCase();
    if (prefix.length === 0) return false; // e.g. `*` — far too broad.
    return IRREVERSIBLE_VERB_PREFIXES.some((verb) => {
      // The glob's literal prefix must START WITH the full verb-phrase, so a
      // broad `git` (from `git*`) — which is a prefix OF `git push` but does
      // not itself begin with `git push` — does not qualify.
      return prefix === verb || prefix.startsWith(`${verb} `) || prefix.startsWith(`${verb}/`);
    });
  });
}

export interface RulePolicyEngineOptions {
  level: AutonomyLevel;
  rules?: PolicyRule[];
  /** When tainted, tighten allow→queue for bash/network and deny secret tools. Default true. */
  tightenWhenTainted?: boolean;
  /** Hosts (globs) considered safe destinations for non-GET web_fetch. */
  allowlistedHosts?: string[];
}

/** Does a rule's predicates match this concrete call? */
function ruleMatches(rule: PolicyRule, tool: string, parsed: ParsedArgs, ctx: ToolCallCtx): boolean {
  if (rule.tools !== undefined && rule.tools.length > 0) {
    if (!rule.tools.some((g) => globMatch(g, tool))) return false;
  }
  if (rule.whenTainted !== undefined && rule.whenTainted !== ctx.tainted) return false;
  if (rule.commands !== undefined && rule.commands.length > 0) {
    if (!isBashTool(tool) || parsed.command === undefined) return false;
    // FIX 2c: match command globs against EVERY chained segment, not one greedy
    // glob over the whole string. A rule matches the call only if all segments
    // are covered — so `ls; git push` is NOT matched by an `ls*` rule.
    const segments = splitBashSegments(parsed.command);
    const toCheck = segments.length > 0 ? segments : [parsed.command];
    if (!toCheck.every((seg) => anyGlobMatch(rule.commands, seg))) return false;
  }
  if (rule.paths !== undefined && rule.paths.length > 0) {
    if (parsed.path === undefined) return false;
    if (!anyGlobMatch(rule.paths, parsed.path)) return false;
  }
  if (rule.domains !== undefined && rule.domains.length > 0) {
    if (!isNetworkTool(tool)) return false;
    if (!anyGlobMatch(rule.domains, hostOf(parsed.url))) return false;
  }
  return true;
}

export class RulePolicyEngine implements PolicyEngine {
  readonly level: AutonomyLevel;
  private readonly rules: PolicyRule[];
  private readonly tightenWhenTainted: boolean;
  private readonly allowlistedHosts: string[];

  constructor(options: RulePolicyEngineOptions) {
    this.level = options.level;
    this.rules = options.rules ?? [];
    this.tightenWhenTainted = options.tightenWhenTainted ?? true;
    this.allowlistedHosts = options.allowlistedHosts ?? [];
  }

  evaluate(tool: string, args: unknown, ctx: ToolCallCtx): PolicyDecision {
    const parsed = parseArgs(args);
    const irreversible = isIrreversible(tool, parsed, this.allowlistedHosts);

    // 1) Explicit rules, first match wins.
    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i]!;
      if (!ruleMatches(rule, tool, parsed, ctx)) continue;
      const reason = rule.reason ?? `matched rule #${i} (${rule.effect})`;

      // FIX 1: the irreversible-class overlay is NOT bypassed by every allow
      // rule. An allow that matches an irreversible (tool,args) is downgraded to
      // 'queue' UNLESS the rule narrowly and explicitly names the irreversible
      // verb (e.g. command glob `git push*`). A broad `git*`/`*` allow still
      // queues `git push`. Non-allow effects (deny/queue) pass through unchanged.
      if (rule.effect === 'allow' && irreversible && !allowRuleOverridesIrreversible(rule)) {
        return this.applyTaintOverlay(
          {
            effect: 'queue',
            reason: `irreversible action requires approval (L${this.level}); matched allow rule #${i} is too broad to override`,
            ruleIndex: i,
          },
          tool,
          ctx,
          false,
        );
      }

      return this.applyTaintOverlay({ effect: rule.effect, reason, ruleIndex: i }, tool, ctx, true);
    }

    // 2) Irreversible class always queues (no explicit allow matched above).
    if (irreversible) {
      return this.applyTaintOverlay(
        { effect: 'queue', reason: `irreversible action requires approval (L${this.level})` },
        tool,
        ctx,
        false,
      );
    }

    // 3) Autonomy-level default.
    return this.applyTaintOverlay(this.levelDefault(tool), tool, ctx, false);
  }

  /** The default decision for a tool at this autonomy level (irreversible handled by caller). */
  private levelDefault(tool: string): PolicyDecision {
    const read = isReadTool(tool);
    const net = isNetworkTool(tool);
    const write = isFileWriteTool(tool);
    const bash = isBashTool(tool);

    switch (this.level) {
      case 0: // read-only
        if (read || net) return { effect: 'allow', reason: 'L0 read-only: allow read/fetch' };
        return { effect: 'deny', reason: 'L0 read-only: writes and bash are denied' };
      case 1: // supervised
        if (read || net) return { effect: 'allow', reason: 'L1 supervised: allow read/fetch' };
        if (write || bash)
          return { effect: 'queue', reason: 'L1 supervised: writes/bash need approval' };
        return { effect: 'queue', reason: 'L1 supervised: unknown tool needs approval' };
      case 2: // autonomous-in-workspace
        if (read || net) return { effect: 'allow', reason: 'L2 workspace: allow read/fetch' };
        if (write || bash)
          return { effect: 'allow', reason: 'L2 workspace: allow file/bash in workspace' };
        return { effect: 'queue', reason: 'L2 workspace: unknown tool needs approval' };
      case 3: // full-auto
      default:
        return { effect: 'allow', reason: 'L3 full-auto: allow' };
    }
  }

  /**
   * Taint overlay. When the context is tainted and tightening is enabled:
   *  - secret-adjacent tools are denied outright (even an explicit allow),
   *  - bash/network that would otherwise 'allow' are tightened to 'queue'.
   * @param fromExplicitAllow whether the base decision came from a matched rule
   *        (still subject to secret-tool denial, but its allow is otherwise honored
   *        only when not bash/network — same tightening applies for safety).
   */
  private applyTaintOverlay(
    base: PolicyDecision,
    tool: string,
    ctx: ToolCallCtx,
    fromExplicitAllow: boolean,
  ): PolicyDecision {
    if (!ctx.tainted || !this.tightenWhenTainted) return base;

    if (isSecretTool(tool)) {
      return {
        effect: 'deny',
        reason: 'tainted context: secret-adjacent tools are denied',
        ...(base.ruleIndex !== undefined ? { ruleIndex: base.ruleIndex } : {}),
      };
    }

    if (base.effect === 'allow' && (isBashTool(tool) || isNetworkTool(tool))) {
      return {
        effect: 'queue',
        reason: `tainted context: tightened ${tool} from allow to queue`,
        ...(base.ruleIndex !== undefined ? { ruleIndex: base.ruleIndex } : {}),
      };
    }

    // fromExplicitAllow is intentionally not used to bypass tightening above;
    // an explicit allow on a tainted bash/network call is still queued.
    void fromExplicitAllow;
    return base;
  }
}

/** Convenience type re-export for consumers building decisions. */
export type { PolicyEffect };
