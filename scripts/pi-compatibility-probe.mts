import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface JsonFrame {
  readonly id?: string;
  readonly type?: string;
  readonly command?: string;
  readonly success?: boolean;
  readonly data?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

interface RpcState {
  readonly isStreaming: boolean;
  readonly pendingMessageCount: number;
  readonly sessionFile?: string;
  readonly sessionId: string;
}

export interface PiCompatibilityProfile {
  readonly schemaVersion: 1;
  readonly artifact: {
    readonly executable: string;
    readonly version: string;
  };
  readonly runtime: {
    readonly node: string;
    readonly platform: string;
    readonly architecture: string;
  };
  readonly selectors: {
    readonly noSelectorReportsConcretePath: boolean;
    readonly noSelectorStartsUnmaterialized: boolean;
    readonly existingSessionUsesExactPathAndId: boolean;
    readonly missingSessionUsesExactPath: boolean;
    readonly missingSessionStartsUnmaterialized: boolean;
    readonly sessionIdIsExact: boolean;
    readonly sessionDirIsHonored: boolean;
    readonly forkCreatesNewSession: boolean;
    readonly forkMaterializesImmediately: boolean;
    readonly continueReopensLatestConcreteSession: boolean;
    readonly resumeWorksHeadlessly: boolean;
  };
  readonly communication: {
    readonly promptAcknowledged: boolean;
    readonly activePromptAcceptedAsSteering: boolean;
    readonly agentSettledObserved: boolean;
    readonly latestAssistantTextObserved: boolean;
    readonly sessionMaterializedAfterAssistant: boolean;
    readonly modelRequestCount: number;
  };
  readonly process: {
    readonly rpcReady: boolean;
    readonly cleanShutdown: boolean;
  };
  readonly limitations: readonly string[];
}

const DEFAULT_PI_EXECUTABLE = process.env.PIFLEET_PI_EXECUTABLE ?? "pi";
const BASE_ARGS = ["--mode", "rpc", "--no-skills", "--no-prompt-templates", "--no-tools"];
const RESPONSE_TIMEOUT_MS = 10_000;

class RpcProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #frames: JsonFrame[] = [];
  readonly #waiters = new Set<{
    predicate: (frame: JsonFrame) => boolean;
    resolve: (frame: JsonFrame) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  #stdoutBuffer = "";
  #stderr = "";

  constructor(options: {
    executable: string;
    cwd: string;
    agentDir: string;
    args: readonly string[];
  }) {
    this.#child = spawn(options.executable, [...BASE_ARGS, ...options.args], {
      cwd: options.cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#consumeStdout(chunk));
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
  }

  get frames(): readonly JsonFrame[] {
    return this.#frames;
  }

  get stderr(): string {
    return this.#stderr;
  }

  async request(command: Record<string, unknown>): Promise<JsonFrame> {
    const id = typeof command.id === "string" ? command.id : crypto.randomUUID();
    const response = this.waitFor((frame) => frame.type === "response" && frame.id === id);
    await this.#write({ ...command, id });
    return response;
  }

  waitFor(
    predicate: (frame: JsonFrame) => boolean,
    timeoutMs = RESPONSE_TIMEOUT_MS,
  ): Promise<JsonFrame> {
    const existing = this.#frames.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);

    return new Promise((resolveFrame, rejectFrame) => {
      const waiter = {
        predicate,
        resolve: resolveFrame,
        reject: rejectFrame,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          rejectFrame(new Error(`Timed out waiting for Pi RPC frame. stderr: ${this.#stderr}`));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  async close(): Promise<boolean> {
    if (this.#child.exitCode !== null) return this.#child.exitCode === 0;
    this.#child.stdin.end();
    const timeout = setTimeout(() => this.#child.kill("SIGKILL"), 3_000);
    const [code] = (await once(this.#child, "exit")) as [number | null, NodeJS.Signals | null];
    clearTimeout(timeout);
    return code === 0;
  }

  async #write(frame: JsonFrame): Promise<void> {
    const line = `${JSON.stringify(frame)}\n`;
    if (this.#child.stdin.write(line)) return;
    await once(this.#child.stdin, "drain");
  }

  #consumeStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      const frame = JSON.parse(line) as JsonFrame;
      this.#frames.push(frame);
      for (const waiter of [...this.#waiters]) {
        if (!waiter.predicate(frame)) continue;
        clearTimeout(waiter.timer);
        this.#waiters.delete(waiter);
        waiter.resolve(frame);
      }
    }
  }
}

function stateFrom(frame: JsonFrame): RpcState {
  if (frame.success !== true || frame.command !== "get_state" || frame.data === undefined) {
    throw new Error(`Expected successful get_state response, received ${JSON.stringify(frame)}`);
  }
  return frame.data as unknown as RpcState;
}

async function getState(process: RpcProcess): Promise<RpcState> {
  return stateFrom(await process.request({ type: "get_state" }));
}

function sessionHeader(id: string, cwd: string): string {
  return `${JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd,
  })}\n`;
}

async function runOneState(options: {
  executable: string;
  root: string;
  cwd: string;
  args: readonly string[];
}): Promise<{ state: RpcState; cleanShutdown: boolean; stderr: string }> {
  const process = new RpcProcess({
    executable: options.executable,
    cwd: options.cwd,
    agentDir: join(options.root, "agent"),
    args: ["--no-extensions", ...options.args],
  });
  const state = await getState(process);
  const cleanShutdown = await process.close();
  return { state, cleanShutdown, stderr: process.stderr };
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Mock server did not bind TCP");
  return address.port;
}

async function startDeterministicModelServer(): Promise<{
  server: Server;
  port: number;
  requestCount: () => number;
}> {
  let requests = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    requests += 1;
    await new Promise<void>((resolveBody, rejectBody) => {
      request.on("data", () => undefined);
      request.on("end", resolveBody);
      request.on("error", rejectBody);
    });
    if (requests === 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    const text = requests === 1 ? "first deterministic response" : "steered deterministic response";
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const chunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
      id: `probe-${requests}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "deterministic",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
    response.write(`data: ${JSON.stringify(chunk({ role: "assistant" }, null))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({ content: text }, null))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  const port = await listen(server);
  return { server, port, requestCount: () => requests };
}

async function runCommunicationProbe(options: {
  executable: string;
  root: string;
  cwd: string;
}): Promise<{
  promptAcknowledged: boolean;
  activePromptAcceptedAsSteering: boolean;
  agentSettledObserved: boolean;
  latestAssistantTextObserved: boolean;
  sessionMaterializedAfterAssistant: boolean;
  modelRequestCount: number;
  cleanShutdown: boolean;
}> {
  const mock = await startDeterministicModelServer();
  const agentDir = join(options.root, "model-agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "pifleet-probe": {
          baseUrl: `http://127.0.0.1:${mock.port}/v1`,
          api: "openai-completions",
          apiKey: "local-probe-placeholder",
          models: [
            {
              id: "deterministic",
              name: "Deterministic Probe",
              contextWindow: 4096,
              maxTokens: 256,
            },
          ],
        },
      },
    }),
  );

  const process = new RpcProcess({
    executable: options.executable,
    cwd: options.cwd,
    agentDir,
    args: ["--no-extensions", "--provider", "pifleet-probe", "--model", "deterministic"],
  });

  try {
    await getState(process);
    const firstPrompt = process.request({
      type: "prompt",
      message: "first probe input",
      streamingBehavior: "steer",
    });
    await process.waitFor((frame) => frame.type === "agent_start");
    const firstAck = await firstPrompt;
    const secondAck = await process.request({
      type: "prompt",
      message: "steering probe input",
      streamingBehavior: "steer",
    });
    await process.waitFor((frame) => frame.type === "agent_settled", 15_000);
    const latest = await process.request({ type: "get_last_assistant_text" });
    const state = await getState(process);
    const sessionFile = state.sessionFile;
    const sessionMaterialized =
      sessionFile !== undefined &&
      (await readFile(sessionFile, "utf8")).includes("steered deterministic response");
    const cleanShutdown = await process.close();
    return {
      promptAcknowledged: firstAck.success === true,
      activePromptAcceptedAsSteering: secondAck.success === true,
      agentSettledObserved: true,
      latestAssistantTextObserved: latest.data?.text === "steered deterministic response",
      sessionMaterializedAfterAssistant: sessionMaterialized,
      modelRequestCount: mock.requestCount(),
      cleanShutdown,
    };
  } finally {
    mock.server.close();
    await once(mock.server, "close");
  }
}

async function piVersion(executable: string): Promise<string> {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`Unable to run ${executable} --version: ${result.stderr}`);
  return result.stdout.trim();
}

export async function runCompatibilityProbe(
  executable = DEFAULT_PI_EXECUTABLE,
): Promise<PiCompatibilityProfile> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-pi-probe-"));
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });

  try {
    const noSelector = await runOneState({ executable, root: join(root, "none"), cwd, args: [] });

    const existingId = "01901234-5678-7abc-8def-0123456789ab";
    const existingPath = join(root, "existing.jsonl");
    await writeFile(existingPath, sessionHeader(existingId, cwd));
    const existing = await runOneState({
      executable,
      root: join(root, "existing-agent"),
      cwd,
      args: ["--session", existingPath],
    });

    const missingPath = join(root, "missing.jsonl");
    const missing = await runOneState({
      executable,
      root: join(root, "missing-agent"),
      cwd,
      args: ["--session", missingPath],
    });

    const sessionDir = join(root, "sessions");
    const byId = await runOneState({
      executable,
      root: join(root, "id-agent"),
      cwd,
      args: ["--session-id", existingId, "--session-dir", sessionDir],
    });

    const fork = await runOneState({
      executable,
      root: join(root, "fork-agent"),
      cwd,
      args: ["--fork", existingPath, "--session-dir", sessionDir],
    });

    const continued = await runOneState({
      executable,
      root: join(root, "continue-agent"),
      cwd,
      args: ["--continue", "--session-dir", sessionDir],
    });

    const resume = spawnSync(
      executable,
      [...BASE_ARGS, "--no-extensions", "--resume", "--session-dir", sessionDir],
      {
        cwd,
        env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "resume-agent") },
        input: `${JSON.stringify({ id: "state", type: "get_state" })}\n`,
        encoding: "utf8",
        timeout: 3_000,
      },
    );
    const resumeWorksHeadlessly = resume.stdout
      .split("\n")
      .filter(Boolean)
      .some((line) => {
        try {
          const frame = JSON.parse(line) as JsonFrame;
          return frame.id === "state" && frame.command === "get_state" && frame.success === true;
        } catch {
          return false;
        }
      });

    const communication = await runCommunicationProbe({ executable, root, cwd });
    const noSelectorPath = noSelector.state.sessionFile;
    const forkPath = fork.state.sessionFile;

    return {
      schemaVersion: 1,
      artifact: { executable: basename(executable), version: await piVersion(executable) },
      runtime: {
        node: process.versions.node,
        platform: process.platform,
        architecture: process.arch,
      },
      selectors: {
        noSelectorReportsConcretePath: noSelectorPath !== undefined,
        noSelectorStartsUnmaterialized:
          noSelectorPath !== undefined && !(await import("node:fs")).existsSync(noSelectorPath),
        existingSessionUsesExactPathAndId:
          existing.state.sessionFile === existingPath && existing.state.sessionId === existingId,
        missingSessionUsesExactPath: missing.state.sessionFile === missingPath,
        missingSessionStartsUnmaterialized: !(await import("node:fs")).existsSync(missingPath),
        sessionIdIsExact: byId.state.sessionId === existingId,
        sessionDirIsHonored: byId.state.sessionFile?.startsWith(resolve(sessionDir)) === true,
        forkCreatesNewSession: fork.state.sessionId !== existingId,
        forkMaterializesImmediately:
          forkPath !== undefined && (await import("node:fs")).existsSync(forkPath),
        continueReopensLatestConcreteSession:
          continued.state.sessionFile === fork.state.sessionFile &&
          continued.state.sessionId === fork.state.sessionId,
        resumeWorksHeadlessly,
      },
      communication: {
        promptAcknowledged: communication.promptAcknowledged,
        activePromptAcceptedAsSteering: communication.activePromptAcceptedAsSteering,
        agentSettledObserved: communication.agentSettledObserved,
        latestAssistantTextObserved: communication.latestAssistantTextObserved,
        sessionMaterializedAfterAssistant: communication.sessionMaterializedAfterAssistant,
        modelRequestCount: communication.modelRequestCount,
      },
      process: {
        rpcReady: noSelector.state.sessionId.length > 0,
        cleanShutdown:
          noSelector.cleanShutdown &&
          existing.cleanShutdown &&
          missing.cleanShutdown &&
          byId.cleanShutdown &&
          fork.cleanShutdown &&
          continued.cleanShutdown &&
          communication.cleanShutdown,
      },
      limitations: [
        "Interactive --resume does not establish RPC mode during headless stdin and is unsupported in v1.",
        "The probe isolates PI_CODING_AGENT_DIR and uses a local deterministic OpenAI-compatible server; it does not validate external providers or credentials.",
        "Concurrent external writers and arbitrary session-file rewrites remain outside pi-fleet's correctness guarantee.",
      ],
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const profile = await runCompatibilityProbe();
  const serialized = `${JSON.stringify(profile, null, 2)}\n`;
  const writeIndex = process.argv.indexOf("--write");
  if (writeIndex >= 0) {
    const target = process.argv[writeIndex + 1];
    if (target === undefined) throw new Error("--write requires a target path");
    await mkdir(dirname(resolve(target)), { recursive: true });
    await writeFile(resolve(target), serialized);
  } else {
    process.stdout.write(serialized);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
