/**
 * Commander wiring for the `lunaris` CLI, separated from main.ts so the
 * program shape can be unit tested without executing it.
 */
import { Command } from 'commander';
import {
  runAnalytics,
  runApprovals,
  runChat,
  runDaemon,
  runEvents,
  runInit,
  runMemory,
  runOptimize,
  runPluginNew,
  runPluginToggle,
  runPlugins,
  runProposals,
  runQueue,
  runSchedule,
  runStatus,
} from './commands.js';
import {
  runAdopt,
  runExport,
  runLease,
  runLogin,
  runRestore,
  runSnapshot,
  runVersion,
  runWhoami,
} from './phase4.js';
import { parseTail } from './format.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('lunaris')
    .description('Lunaris — multi-project autonomous AI dev harness')
    .version('0.1.0')
    .showHelpAfterError();

  program
    .command('init')
    .description('Scaffold a Lunaris project (lunaris.toml + .lunaris/) in the current directory')
    .option('--name <name>', 'project name')
    .action(async (opts: { name?: string }) => {
      process.exitCode = await runInit(process.cwd(), opts.name);
    });

  program
    .command('chat')
    .description('Send a prompt to the orchestrator agent loop and stream progress')
    .argument('<prompt...>', 'prompt text')
    .option('--model <model>', 'override model as <provider>/<model>')
    .action(async (promptParts: string[], opts: { model?: string }) => {
      process.exitCode = await runChat(process.cwd(), promptParts.join(' '), opts.model);
    });

  program
    .command('status')
    .description('Show project id, name, default model and event count')
    .action(async () => {
      process.exitCode = await runStatus(process.cwd());
    });

  program
    .command('events')
    .description('Print recent events from .lunaris/state/events.db')
    .option('--tail <n>', 'number of events to show', '20')
    .action(async (opts: { tail?: string }) => {
      process.exitCode = await runEvents(process.cwd(), parseTail(opts.tail));
    });

  program
    .command('analytics')
    .description('Print a usage rollup: goals, cost, by-model, tools')
    .option('--since <iso>', 'only count events on/after this ISO timestamp')
    .action(async (opts: { since?: string }) => {
      process.exitCode = await runAnalytics(process.cwd(), opts.since);
    });

  program
    .command('memory')
    .description('List or search the project memory graph')
    .option('--search <q>', 'search query (omit to list the strongest records)')
    .option('--limit <n>', 'max records to show', '50')
    .action(async (opts: { search?: string; limit?: string }) => {
      const limit = Number.parseInt(opts.limit ?? '50', 10);
      process.exitCode = await runMemory(
        process.cwd(),
        opts.search,
        Number.isFinite(limit) && limit > 0 ? limit : 50,
      );
    });

  program
    .command('approvals')
    .description('List pending approvals, or resolve one with --resolve <id> --approve|--deny')
    .option('--resolve <id>', 'ticket id to resolve')
    .option('--approve', 'approve the resolved ticket')
    .option('--deny', 'deny the resolved ticket')
    .option('--by <who>', 'resolver identity', 'cli')
    .action(async (opts: { resolve?: string; approve?: boolean; deny?: boolean; by?: string }) => {
      process.exitCode = await runApprovals(process.cwd(), opts);
    });

  program
    .command('daemon')
    .description('Run the lunarisd daemon in the foreground')
    .option('--port <port>', 'port to listen on', '7340')
    .action(async (opts: { port?: string }) => {
      const port = Number.parseInt(opts.port ?? '7340', 10);
      process.exitCode = await runDaemon(Number.isFinite(port) && port > 0 ? port : 7340);
    });

  // ---- Phase 3: optimizer ----

  program
    .command('optimize')
    .description('Run the recursive self-optimizer (propose-only): stats, routing, proposals')
    .option('--since <iso>', 'only consider events on/after this ISO timestamp')
    .action(async (opts: { since?: string }) => {
      process.exitCode = await runOptimize(process.cwd(), opts.since);
    });

  program
    .command('proposals')
    .description('List config proposals, or resolve one with --resolve <id> --approve|--reject')
    .option('--resolve <id>', 'proposal id to resolve')
    .option('--approve', 'approve the resolved proposal')
    .option('--reject', 'reject the resolved proposal')
    .option('--status <status>', 'filter list by status (pending|approved|rejected)')
    .action(async (opts: { resolve?: string; approve?: boolean; reject?: boolean; status?: string }) => {
      process.exitCode = await runProposals(process.cwd(), opts);
    });

  // ---- Phase 3: plugins ----

  const plugins = program
    .command('plugins')
    .description('List discovered plugins under .lunaris/plugins')
    .action(async () => {
      process.exitCode = await runPlugins(process.cwd());
    });
  void plugins;

  const plugin = program.command('plugin').description('Manage plugins (new / enable / disable)');

  plugin
    .command('new <dir>')
    .description('Scaffold a starter plugin (plugin.toml + tools/echo.js)')
    .option('--id <id>', 'reverse-DNS plugin id, e.g. dev.acme.tools')
    .option('--name <name>', 'human-readable plugin name')
    .action(async (dir: string, opts: { id?: string; name?: string }) => {
      process.exitCode = await runPluginNew(process.cwd(), dir, opts.id, opts.name);
    });

  plugin
    .command('enable <id>')
    .description('Enable a plugin by id')
    .action(async (id: string) => {
      process.exitCode = await runPluginToggle(process.cwd(), id, true);
    });

  plugin
    .command('disable <id>')
    .description('Disable a plugin by id')
    .action(async (id: string) => {
      process.exitCode = await runPluginToggle(process.cwd(), id, false);
    });

  // ---- Phase 3: scheduler + queue ----

  program
    .command('schedule')
    .description('List schedules, add one (--cron <expr> --prompt <p>), or remove one (rm <id>)')
    .argument('[action]', 'list (default) or rm')
    .argument('[id]', 'schedule id (for rm)')
    .option('--cron <expr>', '5-field cron expression')
    .option('--prompt <p>', 'inline prompt for the scheduled goal')
    .action(async (action: string | undefined, id: string | undefined, opts: { cron?: string; prompt?: string }) => {
      const rm = action === 'rm' ? id : undefined;
      process.exitCode = await runSchedule(process.cwd(), { rm, cron: opts.cron, prompt: opts.prompt });
    });

  program
    .command('queue')
    .description('List queued goals, or push one (push <prompt...>)')
    .argument('[action]', 'list (default) or push')
    .argument('[prompt...]', 'prompt text (for push)')
    .option('--priority <n>', 'priority for a pushed goal (higher runs first)', '0')
    .action(async (action: string | undefined, promptParts: string[], opts: { priority?: string }) => {
      const priorityNum = Number.parseInt(opts.priority ?? '0', 10);
      const priority = Number.isFinite(priorityNum) ? priorityNum : 0;
      const push = action === 'push' ? promptParts.join(' ') : undefined;
      process.exitCode = await runQueue(process.cwd(), { push, priority });
    });

  // ---- Phase 4: auth / lifecycle / lease / version ----

  program
    .command('login')
    .description('Authenticate against the local identity store and cache a bearer token')
    .option('--user <user>', 'user display name', 'local')
    .option('--password <password>', 'password (omit for the passwordless loopback owner)')
    .action(async (opts: { user?: string; password?: string }) => {
      process.exitCode = await runLogin(opts);
    });

  program
    .command('whoami')
    .description('Show the current principal (cached token or implicit loopback owner) and role')
    .action(async () => {
      process.exitCode = await runWhoami(process.cwd());
    });

  program
    .command('snapshot')
    .description('List project snapshots, or create one (create)')
    .argument('[action]', 'list (default) or create')
    .action(async (action: string | undefined) => {
      const a = action === 'create' ? 'create' : 'list';
      process.exitCode = await runSnapshot(process.cwd(), { action: a });
    });

  program
    .command('restore')
    .description('Restore a snapshot by id (use --dry-run to preview the file list)')
    .argument('<id>', 'snapshot id')
    .option('--dry-run', 'list files that would be restored without writing')
    .action(async (id: string, opts: { dryRun?: boolean }) => {
      process.exitCode = await runRestore(process.cwd(), id, opts.dryRun === true);
    });

  program
    .command('export')
    .description('Export a portable project bundle (.tar.gz)')
    .option('--out <path>', 'output bundle path')
    .action(async (opts: { out?: string }) => {
      process.exitCode = await runExport(process.cwd(), opts.out);
    });

  program
    .command('adopt')
    .description('Adopt the project in the current directory (mint a machine-local instance id)')
    .action(async () => {
      process.exitCode = await runAdopt(process.cwd());
    });

  program
    .command('lease')
    .description('Show the current orchestrator lease holder + epoch for this project')
    .action(async () => {
      process.exitCode = await runLease(process.cwd());
    });

  program
    .command('version')
    .description('Show the harness version and a per-store schema doctor table')
    .action(async () => {
      process.exitCode = await runVersion(process.cwd());
    });

  return program;
}
