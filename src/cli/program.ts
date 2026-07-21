import { Command } from "commander";

import { PRODUCT_BINARY, PRODUCT_VERSION } from "../shared/product-identity.js";
import type { CommandContext } from "./context.js";
import { runCreate } from "./commands/create.js";
import { runDestroy } from "./commands/destroy.js";
import { runList } from "./commands/list.js";
import { runReceive } from "./commands/receive.js";
import { runSend } from "./commands/send.js";
import { runStatus } from "./commands/status.js";
import { runWatch } from "./commands/watch.js";

export function createProgram(
  context: CommandContext,
  setExitCode: (exitCode: number) => void,
): Command {
  const program = new Command()
    .name(PRODUCT_BINARY)
    .description("Pi-native execution infrastructure for programmatic orchestration")
    .version(PRODUCT_VERSION)
    .exitOverride()
    .showHelpAfterError(false)
    .showSuggestionAfterError(false)
    .configureOutput({
      writeOut: (text) => context.stdout.write(text),
      writeErr: () => undefined,
    });

  program
    .command("create")
    .description("Create a Pi agent with a stable local name")
    .argument("<name>")
    .argument("[instructions]")
    .option("--cwd <path>")
    .option("--human")
    .action(async (name: string, instructions: string | undefined, options: CreateOptions) => {
      setExitCode(
        await runCreate(
          {
            name,
            ...(instructions === undefined ? {} : { instructions }),
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            human: options.human ?? false,
          },
          context,
        ),
      );
    });

  program
    .command("send")
    .description("Submit or steer Pi input")
    .argument("<name>")
    .argument("<message>")
    .option("--human")
    .action(async (name: string, message: string, options: HumanOptions) => {
      setExitCode(await runSend({ name, message, human: options.human ?? false }, context));
    });

  program
    .command("receive")
    .description("Wait for idle and return the exact latest assistant text")
    .argument("<name>")
    .option("--timeout <duration>")
    .option("--human")
    .action(async (name: string, options: ReceiveOptions) => {
      setExitCode(
        await runReceive(
          {
            name,
            ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
            human: options.human ?? false,
          },
          context,
        ),
      );
    });

  program
    .command("status")
    .description("Inspect an agent without waking Pi")
    .argument("<name>")
    .option("--human")
    .action(async (name: string, options: HumanOptions) => {
      setExitCode(await runStatus({ name, human: options.human ?? false }, context));
    });

  program
    .command("list")
    .description("List agents without waking Pi")
    .option("--human")
    .action(async (options: HumanOptions) => {
      setExitCode(await runList({ human: options.human ?? false }, context));
    });

  program
    .command("watch")
    .description("Stream native Pi session JSONL records")
    .argument("<name>")
    .action(async (name: string) => {
      setExitCode(await runWatch(name, context));
    });

  program
    .command("destroy")
    .description("Destroy an agent without deleting its Pi session")
    .argument("<name>")
    .option("--human")
    .action(async (name: string, options: HumanOptions) => {
      setExitCode(await runDestroy({ name, human: options.human ?? false }, context));
    });

  return program;
}

interface HumanOptions {
  readonly human?: boolean;
}

interface CreateOptions extends HumanOptions {
  readonly cwd?: string;
}

interface ReceiveOptions extends HumanOptions {
  readonly timeout?: string;
}
