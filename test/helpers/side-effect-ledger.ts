import { appendFile, readFile } from "node:fs/promises";

export class SideEffectLedger {
  constructor(readonly path: string) {}

  async record(instructionId: string): Promise<void> {
    await appendFile(this.path, `${JSON.stringify({ instructionId })}\n`, { mode: 0o600 });
  }

  async entries(): Promise<readonly string[]> {
    const contents = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return contents
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { instructionId: string }).instructionId);
  }

  async count(instructionId: string): Promise<number> {
    return (await this.entries()).filter((entry) => entry === instructionId).length;
  }
}
