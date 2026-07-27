import type {
  AgentId,
  ContinuityEpoch,
  IncarnationId,
  ProjectorState,
} from "../runtime/semantic-events.js";
import type {
  JournalAgent,
  JournalAppend,
  JournalCompact,
  JournalDestroyReceipt,
  JournalEpoch,
  JournalEventRange,
  JournalIncarnation,
  JournalOperation,
  JournalSend,
  JournalStore,
} from "./journal-store.js";
import type { JournalWorkerRequest } from "./journal-worker-protocol.js";

export async function dispatchJournalStoreRequest(
  store: JournalStore,
  request: JournalWorkerRequest,
): Promise<unknown> {
  switch (request.method) {
    case "createAgent":
      return store.createAgent(request.args[0] as JournalAgent);
    case "createAgentWithOperation":
      return store.createAgentWithOperation(
        request.args[0] as JournalAgent,
        request.args[1] as JournalOperation,
      );
    case "rollbackProvisionalCreate":
      return store.rollbackProvisionalCreate(
        request.args[0] as AgentId,
        request.args[1] as JournalOperation,
      );
    case "getAgentByName":
      return store.getAgentByName(request.args[0] as string);
    case "getAgentById":
      return store.getAgentById(request.args[0] as AgentId);
    case "listAgents":
      return store.listAgents();
    case "putAgent":
      return store.putAgent(request.args[0] as JournalAgent);
    case "putOperation":
      return store.putOperation(request.args[0] as JournalOperation);
    case "getOperation":
      return store.getOperation(request.args[0] as string);
    case "listPendingOperations":
      return store.listPendingOperations();
    case "deleteOperation":
      return store.deleteOperation(request.args[0] as string);
    case "putSend":
      return store.putSend(request.args[0] as JournalSend);
    case "getSend":
      return store.getSend(request.args[0] as string);
    case "nextSendOrdinal":
      return store.nextSendOrdinal(request.args[0] as AgentId);
    case "listNonterminalSends":
      return store.listNonterminalSends();
    case "putCompact":
      return store.putCompact(request.args[0] as JournalCompact);
    case "getCompact":
      return store.getCompact(request.args[0] as string);
    case "listNonterminalCompacts":
      return store.listNonterminalCompacts();
    case "putIncarnation":
      return store.putIncarnation(request.args[0] as JournalIncarnation);
    case "listActiveIncarnations":
      return store.listActiveIncarnations();
    case "putEpoch":
      return store.putEpoch(request.args[0] as JournalEpoch);
    case "getEpochs":
      return store.getEpochs(request.args[0] as AgentId);
    case "beginIncarnation":
      return store.beginIncarnation(
        request.args[0] as AgentId,
        request.args[1] as IncarnationId,
        request.args[2] as ContinuityEpoch,
        request.args[3] as ProjectorState,
      );
    case "append":
      return store.append(normalizeAppend(request.args[0]));
    case "openReceive":
      return store.openReceive(request.args[0] as AgentId);
    case "readEvents":
      return store.readEvents(request.args[0] as JournalEventRange);
    case "getProjectorState":
      return store.getProjectorState(
        request.args[0] as AgentId,
        request.args[1] as IncarnationId,
        request.args[2] as ContinuityEpoch,
      );
    case "getHighWater":
      return store.getHighWater(request.args[0] as AgentId);
    case "markIdle":
      return store.markIdle(request.args[0] as AgentId, request.args[1] as ContinuityEpoch);
    case "getRawRecords":
      return store.getRawRecords(
        request.args[0] as AgentId,
        request.args[1] as number,
        request.args[2] as number,
      );
    case "destroyAgent":
      return store.destroyAgent(
        request.args[0] as AgentId,
        request.args[1] as JournalDestroyReceipt,
      );
    case "getDestroyReceipt":
      return store.getDestroyReceipt(request.args[0] as string);
    case "maintain":
      return store.maintain(request.args[0] as number | undefined);
    case "getDiagnostics":
      return store.getDiagnostics();
    case "close":
      return store.close();
    default:
      throw new Error(`Unknown journal worker method ${request.method}`);
  }
}

function normalizeAppend(value: unknown): JournalAppend {
  const batch = value as JournalAppend;
  return {
    ...batch,
    records: batch.records.map((record) => ({ ...record, bytes: Buffer.from(record.bytes) })),
  };
}
