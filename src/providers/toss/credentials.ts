import { str } from "../../lib/parse";

/**
 * Toss Open API credentials. Unlike KIS/Kiwoom, a Toss client is a single
 * user-level OAuth2 client (not per account); accounts are addressed with the
 * `X-Tossinvest-Account: <accountSeq>` header.
 */
export interface TossCredentials {
  clientId: string;
  clientSecret: string;
}

/** Parses `TOSS_CREDENTIALS` (`{"clientId":"...","clientSecret":"..."}`). */
export function parseTossCredentials(raw: string | undefined | null): TossCredentials | null {
  if (!raw || raw.trim() === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("TOSS_CREDENTIALS must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TOSS_CREDENTIALS must be a JSON object");
  }

  const entry = parsed as Record<string, unknown>;
  const clientId = str(entry["clientId"]);
  const clientSecret = str(entry["clientSecret"]);
  if (!clientId || !clientSecret) {
    throw new Error("TOSS_CREDENTIALS requires clientId and clientSecret");
  }

  return { clientId, clientSecret };
}
