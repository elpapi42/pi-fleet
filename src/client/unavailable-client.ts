import type { FleetClient, FleetClientError } from "./fleet-client.js";
import { err } from "../shared/result.js";

const unavailable = (): FleetClientError => ({
  code: "runtime_unavailable",
  message: "pi-fleet runtime is not implemented yet.",
});

export const unavailableFleetClient: FleetClient = {
  create: async () => err(unavailable()),
  send: async () => err(unavailable()),
  receive: async () => err(unavailable()),
  status: async () => err(unavailable()),
  list: async () => err(unavailable()),
  watchSession: async function* () {
    yield err(unavailable());
  },
  destroy: async () => err(unavailable()),
  compact: async () => err(unavailable()),
};
