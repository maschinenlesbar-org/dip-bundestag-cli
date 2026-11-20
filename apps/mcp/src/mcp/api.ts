// How the MCP server reaches this repository's client. The server's generic files (server.ts,
// limiter.ts, config.ts, run.ts, result.ts, credentials.ts: the kit, the same in every
// repository) import the client only through this file, under the names below; the names on the
// right are this client's. Per repository, like tools.ts: a client whose names or functions differ
// adapts here.
//
// DIP needs an API key (`Authorization: ApiKey …`). No key is bundled: `findCredentials` (the
// kit's hook, credentials.ts) takes it, at the first tool call, from DIP_API_KEY, else from the
// credentials file `dip config set api-key` writes, else obtains the Bundestag's published public
// key and verifies it against the live API before using it, as `dip obtain-key` does (the
// machine-readable source has lagged behind the current key). Never from argv.

import { API_KEY_CREDENTIAL, CredentialStore } from "@maschinenlesbar.org/dip-bundestag-client/internal/credentials";
import { API_PATH, DEFAULT_BASE_URL } from "@maschinenlesbar.org/dip-bundestag-client/internal/engine";
import { API_KEY_ENV_VAR, HELP_PAGE_URL, KEY_CONTACT, obtainKey } from "@maschinenlesbar.org/dip-bundestag-client/internal/obtain-key";
import { DipError, DipValidationError } from "@maschinenlesbar.org/dip-bundestag-client/internal/errors";
import { apiKeyProblem } from "@maschinenlesbar.org/dip-bundestag-client/internal/client";
import type { CredentialContext, FoundCredentials } from "./credentials.js";

export {
  DipClient as Client,
  DipError as ClientError,
  DipNetworkError as NetworkError,
  baseUrlProblem,
  DEFAULT_BASE_URL,
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "@maschinenlesbar.org/dip-bundestag-client";
export { sizeLimitMessage } from "@maschinenlesbar.org/dip-bundestag-client/internal/http";
export { cutText, toWellFormed } from "@maschinenlesbar.org/dip-bundestag-client/internal/errors";

/** The API's base URL as a result's `source` starts with it (`--base-url`, else the default, and `/api/v1`). */
export function apiBase(baseUrl: string | undefined): string {
  return `${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}${API_PATH}`;
}

/**
 * The API key, in this order: DIP_API_KEY from the server's environment (what an MCP client's
 * config sets), the credentials file (`dip config set api-key`; only when the server runs from its
 * bin), or the public key the Bundestag publishes, obtained and verified against the live API. A
 * DIP_API_KEY no header can carry, and a stored value the CLI would refuse too, are errors naming
 * the fix: never silently skipped. A key that can't be obtained says how to give one. Every form of
 * the key is a secret of the server from here on.
 */
export async function findCredentials(context: CredentialContext): Promise<FoundCredentials> {
  const fromEnv = context.env[API_KEY_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const key = fromEnv.trim();
    const problem = apiKeyProblem(key);
    if (problem !== undefined) throw new DipValidationError(`Invalid ${API_KEY_ENV_VAR} in the server's environment: ${problem}`);
    return { clientOptions: { apiKey: key }, secrets: [fromEnv, key], source: `the API key from the ${API_KEY_ENV_VAR} environment variable` };
  }
  if (context.credentialsFile) {
    const store = CredentialStore.fromEnv(context.env);
    const raw = store.get(API_KEY_CREDENTIAL);
    // A stored value the CLI would refuse is an error naming the file and the fix (usable()).
    const stored = store.usable(API_KEY_CREDENTIAL);
    if (stored !== undefined) {
      return { clientOptions: { apiKey: stored }, secrets: [raw ?? stored, stored], source: `the API key stored in ${store.path} (dip config)` };
    }
  }
  try {
    // Verified (the default): a candidate the live API refuses is never used.
    const obtained = await obtainKey({
      transport: context.transport,
      timeoutMs: context.timeoutMs,
      userAgent: context.userAgent,
      maxResponseBytes: context.maxResponseBytes,
    });
    return {
      clientOptions: { apiKey: obtained.key },
      secrets: [obtained.key],
      source: `the public API key obtained from ${obtained.sourceUrl} and verified against the API (${API_KEY_ENV_VAR} is not set${context.credentialsFile ? " and no key is stored" : ""})`,
    };
  } catch (err) {
    if (err instanceof DipError) {
      // The CLI's own way out (--no-verify) is no option of the server.
      err.message =
        `${err.message.replace(/ Re-run with --no-verify to print it unchecked, or see \S+\.$/, "")} ` +
        `The server could not obtain a working public API key; it tries again at the next call. Or set ${API_KEY_ENV_VAR} in the server's environment ` +
        `(\`dip obtain-key\` prints the current key; it is published at ${HELP_PAGE_URL}, a personal one is available from ${KEY_CONTACT}) and restart it.`;
    }
    throw err;
  }
}
