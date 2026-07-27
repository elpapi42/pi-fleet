import { Command } from "commander";

import { PRODUCT_BINARY, PRODUCT_VERSION } from "../shared/product-identity.js";
import type { CommandContext } from "./context.js";
import { runCompact } from "./commands/compact.js";
import { runCreate } from "./commands/create.js";
import { runDestroy } from "./commands/destroy.js";
import { runList } from "./commands/list.js";
import { runReceive } from "./commands/receive.js";
import { runSend } from "./commands/send.js";
import { runStatus } from "./commands/status.js";

export function createProgram(
  context: CommandContext,
  setExitCode: (exitCode: number) => void,
): Command {
  const program = new Command()
    .name(PRODUCT_BINARY)
    .description(
      "Control shared local Pi agents; stream durable semantic activity with user-owned sessions",
    )
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
    .option("--follow-up", "Queue the input until Pi is fully done")
    .option("--human")
    .action(async (name: string, message: string, options: SendOptions) => {
      setExitCode(
        await runSend(
          {
            name,
            message,
            delivery: options.followUp === true ? "followUp" : "steer",
            human: options.human ?? false,
          },
          context,
        ),
      );
    });

  program
    .command("receive")
    .description("Stream durable high-level Pi activity")
    .argument("<name>")
    .option("--after <cursor>", "Replay strictly after a receive cursor, then follow live")
    .option("--from-start", "Replay retained agent history, then follow live")
    .option("--until-idle", "Attach live and exit after the exact observed idle boundary")
    .option("--human")
    .action(async (name: string, options: ReceiveOptions) => {
      setExitCode(
        await runReceive(
          {
            name,
            ...(options.after === undefined ? {} : { after: options.after }),
            fromStart: options.fromStart ?? false,
            untilIdle: options.untilIdle ?? false,
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
    .command("compact")
    .description("Compact an idle Pi agent session")
    .argument("<name>")
    .option("--human")
    .action(async (name: string, options: HumanOptions) => {
      setExitCode(await runCompact({ name, human: options.human ?? false }, context));
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

interface SendOptions extends HumanOptions {
  readonly followUp?: boolean;
}

interface ReceiveOptions extends HumanOptions {
  readonly after?: string;
  readonly fromStart?: boolean;
  readonly untilIdle?: boolean;
}
