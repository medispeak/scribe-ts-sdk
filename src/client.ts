import { SessionHttp } from "./http";
import { getChunkStore } from "./persistence";
import { Session } from "./session";
import type { ScribeClient, ScribeClientConfig, ScribeSession } from "./types";

function resolveFetch(config: ScribeClientConfig): typeof fetch {
  const impl = config.fetch ?? globalThis.fetch;
  if (typeof impl !== "function") {
    throw new TypeError(
      "No fetch implementation available. Pass `fetch` in the config or run on a platform with a global fetch.",
    );
  }
  return impl.bind(globalThis);
}

/**
 * Create a browser scribe client. The client never sees the account secret —
 * it authenticates each session with a short-lived, session-scoped token
 * returned by your `getToken` provider.
 */
export function createScribeClient(config: ScribeClientConfig): ScribeClient {
  if (!config?.baseUrl) throw new TypeError("createScribeClient: `baseUrl` is required");
  if (typeof config.getToken !== "function") {
    throw new TypeError("createScribeClient: `getToken` is required");
  }
  const fetchImpl = resolveFetch(config);

  const build = (sessionId: string): Session => {
    if (!sessionId) throw new TypeError("session: `sessionId` is required");
    const http = new SessionHttp(
      config.baseUrl,
      sessionId,
      config.getToken,
      fetchImpl,
    );
    return new Session(sessionId, http, {
      retainLocalRecording: config.retainLocalRecording,
    });
  };

  return {
    session(sessionId: string): ScribeSession {
      return build(sessionId);
    },
    async resume(sessionId: string): Promise<ScribeSession> {
      // Rebuild over the same (injected/default) store and re-hydrate its
      // pending seqs; the caller then invokes retry() to reconcile + commit.
      const session = build(sessionId);
      await session.hydrate();
      return session;
    },
  };
}

/** Session ids that have un-committed audio persisted locally (e.g. after a reload). */
export async function listUnfinishedSessions(): Promise<string[]> {
  return getChunkStore().listUnfinished();
}
