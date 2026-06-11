/**
 * Commander wiring for the `lun` CLI, separated from main.ts so the
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
  runStatus,
} from './commands.js';
import { parseTail } from './format.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('lun')
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

  return program;
}
