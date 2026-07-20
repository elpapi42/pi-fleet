import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  FleetStore,
  StoredAgent,
  StoredIncarnation,
  StoredOperation,
  StoredSend,
} from "./fleet-store.js";

interface JsonRow {
  readonly data_json: string;
}

export class SqliteFleetStore implements FleetStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(path);
    this.#database.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
    );
    this.#migrate();
    const metadata = this.#database
      .prepare("SELECT clean_shutdown FROM runtime_metadata WHERE singleton_key = 1")
      .get() as { clean_shutdown: number } | undefined;
    if (metadata?.clean_shutdown === 0) {
      this.#database.exec(`
        UPDATE agents
        SET state = 'failed', process_state = 'cleanup_uncertain',
            data_json = json_set(data_json,
              '$.summary.state', 'failed',
              '$.summary.process.state', 'cleanup_uncertain')
        WHERE process_state IN ('resident', 'starting');
        UPDATE incarnations
        SET state = 'cleanup_uncertain',
            data_json = json_set(data_json, '$.state', 'cleanup_uncertain')
        WHERE state IN ('starting', 'live', 'stopping');
      `);
    } else if (metadata?.clean_shutdown === 1) {
      this.#database.exec(`
        UPDATE agents
        SET state = CASE WHEN state = 'idle' THEN 'idle' ELSE 'failed' END,
            process_state = 'absent',
            data_json = json_set(data_json,
              '$.summary.state', CASE WHEN state = 'idle' THEN 'idle' ELSE 'failed' END,
              '$.summary.process.state', 'absent')
        WHERE process_state IN ('resident', 'starting');
        UPDATE incarnations
        SET state = 'gone', data_json = json_set(data_json, '$.state', 'gone')
        WHERE state IN ('starting', 'live', 'stopping');
      `);
    }
    this.#database
      .prepare(
        `INSERT INTO runtime_metadata(singleton_key, clean_shutdown)
         VALUES(1, 0)
         ON CONFLICT(singleton_key) DO UPDATE SET clean_shutdown = 0`,
      )
      .run();
  }

  async createAgent(agent: StoredAgent): Promise<boolean> {
    const result = this.#database
      .prepare(
        `INSERT OR IGNORE INTO agents(agent_id, name, state, process_state, data_json)
         VALUES(?, ?, ?, ?, ?)`,
      )
      .run(
        agent.summary.id,
        agent.summary.name,
        agent.summary.state,
        agent.summary.process.state,
        JSON.stringify(agent),
      );
    return result.changes === 1;
  }

  async getAgent(name: string): Promise<StoredAgent | null> {
    const row = this.#database.prepare("SELECT data_json FROM agents WHERE name = ?").get(name) as
      | JsonRow
      | undefined;
    return row === undefined ? null : (JSON.parse(row.data_json) as StoredAgent);
  }

  async listAgents(): Promise<readonly StoredAgent[]> {
    const rows = this.#database
      .prepare("SELECT data_json FROM agents ORDER BY name")
      .all() as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.data_json) as StoredAgent);
  }

  async putAgent(agent: StoredAgent): Promise<void> {
    this.#database
      .prepare(
        `INSERT INTO agents(agent_id, name, state, process_state, data_json)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           agent_id=excluded.agent_id,
           state=excluded.state,
           process_state=excluded.process_state,
           data_json=excluded.data_json`,
      )
      .run(
        agent.summary.id,
        agent.summary.name,
        agent.summary.state,
        agent.summary.process.state,
        JSON.stringify(agent),
      );
  }

  async deleteAgent(name: string): Promise<StoredAgent | null> {
    const existing = await this.getAgent(name);
    if (existing !== null) this.#database.prepare("DELETE FROM agents WHERE name = ?").run(name);
    return existing;
  }

  async getOperation(operationId: string): Promise<StoredOperation | null> {
    const row = this.#database
      .prepare("SELECT data_json FROM operations WHERE operation_id = ?")
      .get(operationId) as JsonRow | undefined;
    return row === undefined ? null : (JSON.parse(row.data_json) as StoredOperation);
  }

  async putOperation(operation: StoredOperation): Promise<void> {
    this.#database
      .prepare(
        `INSERT INTO operations(operation_id, method, state, data_json)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(operation_id) DO UPDATE SET
           method=excluded.method, state=excluded.state, data_json=excluded.data_json`,
      )
      .run(operation.operationId, operation.method, operation.state, JSON.stringify(operation));
  }

  async getSend(sendId: string): Promise<StoredSend | null> {
    const row = this.#database
      .prepare("SELECT data_json FROM send_records WHERE send_id = ?")
      .get(sendId) as JsonRow | undefined;
    return row === undefined ? null : (JSON.parse(row.data_json) as StoredSend);
  }

  async putSend(send: StoredSend): Promise<void> {
    this.#database
      .prepare(
        `INSERT INTO send_records(send_id, agent_name, state, data_json)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(send_id) DO UPDATE SET state=excluded.state, data_json=excluded.data_json`,
      )
      .run(send.sendId, send.agentName, send.state, JSON.stringify(send));
  }

  async listNonterminalSends(): Promise<readonly StoredSend[]> {
    const rows = this.#database
      .prepare("SELECT data_json FROM send_records WHERE state IN ('pending', 'dispatching')")
      .all() as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.data_json) as StoredSend);
  }

  async putIncarnation(incarnation: StoredIncarnation): Promise<void> {
    this.#database
      .prepare(
        `INSERT INTO incarnations(incarnation_id, agent_name, pid, state, data_json)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(incarnation_id) DO UPDATE SET
           pid=excluded.pid, state=excluded.state, data_json=excluded.data_json`,
      )
      .run(
        incarnation.incarnationId,
        incarnation.agentName,
        incarnation.pid,
        incarnation.state,
        JSON.stringify(incarnation),
      );
  }

  async listActiveIncarnations(): Promise<readonly StoredIncarnation[]> {
    const rows = this.#database
      .prepare(
        "SELECT data_json FROM incarnations WHERE state IN ('starting','live','stopping','cleanup_uncertain')",
      )
      .all() as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.data_json) as StoredIncarnation);
  }

  async close(cleanShutdown = true): Promise<void> {
    if (this.#closed) return;
    this.#database
      .prepare("UPDATE runtime_metadata SET clean_shutdown = ? WHERE singleton_key = 1")
      .run(cleanShutdown ? 1 : 0);
    this.#database.close();
    this.#closed = true;
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(
        version INTEGER PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_metadata(
        singleton_key INTEGER PRIMARY KEY CHECK(singleton_key = 1),
        clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS agents(
        agent_id TEXT NOT NULL,
        name TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('restoring','working','idle','failed','destroying')),
        process_state TEXT NOT NULL CHECK(process_state IN ('resident','starting','absent','cleanup_uncertain')),
        data_json TEXT NOT NULL CHECK(json_valid(data_json))
      );
      CREATE TABLE IF NOT EXISTS operations(
        operation_id TEXT PRIMARY KEY,
        method TEXT NOT NULL CHECK(method IN ('create','send','destroy')),
        state TEXT NOT NULL CHECK(state IN ('pending','completed')),
        data_json TEXT NOT NULL CHECK(json_valid(data_json))
      );
      CREATE TABLE IF NOT EXISTS send_records(
        send_id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','dispatching','acknowledged','failed','uncertain')),
        data_json TEXT NOT NULL CHECK(json_valid(data_json))
      );
      CREATE TABLE IF NOT EXISTS incarnations(
        incarnation_id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        pid INTEGER,
        state TEXT NOT NULL CHECK(state IN ('starting','live','stopping','cleanup_uncertain','gone')),
        data_json TEXT NOT NULL CHECK(json_valid(data_json))
      );
      INSERT OR IGNORE INTO schema_migrations(version, checksum, applied_at)
      VALUES(1, '001_initial_v1', '2026-07-20T00:00:00.000Z');
    `);
  }
}
