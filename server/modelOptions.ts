// Checks the model settings a request carries (a message, or a saved setting)
// against the connection it is for. The decision is the connection kind's
// (src/connections); this finds the kind and, for Claude, what the model can
// do, and turns a refusal into a 400.

import { getCapabilities } from "../src/api.ts";
import { InvalidOptions, type ModelOptions, connection, validateShape } from "../src/connections/index.ts";
import { HttpError } from "./http.ts";
import { load } from "./store.ts";

// The cleaned settings, or a 400 saying what to change. A connection the
// server doesn't know (or none given) is checked for shape only. A failed ask
// for the model's capabilities is no reason to refuse: the value is checked
// for shape and the request itself leaves the setting out (see anthropic.ts).
export async function checkOptions(connectorId: string | undefined, model: string, raw: unknown): Promise<ModelOptions> {
  try {
    const connector = connectorId ? (await load()).connectors.find((c) => c.id === connectorId) : undefined;
    if (!connector) return validateShape(raw);
    const conn = connection(connector.kind);
    return conn.validate(raw, conn.needsCapabilities ? await getCapabilities(connector.id, model) : undefined);
  } catch (e) {
    if (e instanceof InvalidOptions) throw new HttpError(400, e.message);
    throw e;
  }
}
