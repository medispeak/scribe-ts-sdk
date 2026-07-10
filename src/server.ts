/**
 * Server entry point for `@medispeak/scribe-ts-sdk`.
 *
 * Runs on your app backend, using the account secret (`msk_live_…`) to create
 * sessions and mint short-lived, session-scoped tokens for the browser. Never
 * ship this module or the secret to a browser.
 */
import { errorFromResponse } from "./errors";
import { joinUrl, pruneUndefined } from "./http";
import { mapOutputSpec } from "./mapping";
import type {
  CreatedSession,
  MintedToken,
  ScribeServerClient,
  ServerClientConfig,
  StartSessionOptions,
} from "./types";

export { ScribeError } from "./errors";
export type {
  CreatedSession,
  MintedToken,
  ScribeServerClient,
  ServerClientConfig,
  StartSessionOptions,
  OutputSpec,
  FieldSpec,
  FieldType,
} from "./types";

interface CreateSessionResponse {
  id: string;
  status: string;
  expires_at?: string;
}

interface MintTokenResponse {
  token: string;
  expires_at: string;
}

function resolveFetch(config: ServerClientConfig): typeof fetch {
  const impl = config.fetch ?? globalThis.fetch;
  if (typeof impl !== "function") {
    throw new TypeError(
      "No fetch implementation available. Pass `fetch` in the config or run on a platform with a global fetch.",
    );
  }
  return impl.bind(globalThis);
}

/**
 * Create a server-side scribe client that authenticates with the account secret.
 */
export function createServerClient(
  config: ServerClientConfig,
): ScribeServerClient {
  if (!config?.baseUrl) throw new TypeError("createServerClient: `baseUrl` is required");
  if (!config?.apiKey) throw new TypeError("createServerClient: `apiKey` is required");
  const fetchImpl = resolveFetch(config);
  const authHeaders = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  } as const;

  return {
    async createSession(opts: StartSessionOptions): Promise<CreatedSession> {
      const body = pruneUndefined({
        outputs: opts.outputs.map(mapOutputSpec),
        language_hint: opts.language,
        mode: opts.mode,
        callback_url: opts.callbackUrl,
      });

      const res = await fetchImpl(joinUrl(config.baseUrl, "scribe_sessions"), {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await errorFromResponse(res, "createSession");

      const json = (await res.json()) as CreateSessionResponse;
      const created: CreatedSession = { id: json.id, status: json.status };
      if (json.expires_at !== undefined) created.expiresAt = json.expires_at;
      return created;
    },

    async mintSessionToken(sessionId: string): Promise<MintedToken> {
      const res = await fetchImpl(
        joinUrl(config.baseUrl, `scribe_sessions/${sessionId}/tokens`),
        {
          method: "POST",
          headers: authHeaders,
          body: "{}",
        },
      );
      if (!res.ok) throw await errorFromResponse(res, "mintSessionToken");

      const json = (await res.json()) as MintTokenResponse;
      return { token: json.token, expiresAt: json.expires_at };
    },
  };
}
