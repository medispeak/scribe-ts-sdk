import { pruneUndefined } from "./http";
import type {
  FieldSpec,
  OutputSpec,
  ScribeOutputResult,
  ScribeResult,
} from "./types";

/* --------------------------------------------------------------------------
 * Outbound: OutputSpec -> backend wire shape (server.createSession)
 * ------------------------------------------------------------------------ */

/** Backend wire representation of a single output. */
export type WireOutput =
  | { type: "transcript" }
  | { type: "note"; template_ref?: string }
  | { type: "form"; fields: WireField[] };

interface WireField {
  key: string;
  label: string;
  type: string;
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

function mapField(field: FieldSpec): WireField {
  return pruneUndefined({
    key: field.key,
    label: field.label,
    type: field.type,
    description: field.description,
    enum: field.enum,
    minimum: field.minimum,
    maximum: field.maximum,
  }) as WireField;
}

/** Map a Medispeak-native OutputSpec to the backend's snake_cased wire shape. */
export function mapOutputSpec(output: OutputSpec): WireOutput {
  switch (output.type) {
    case "transcript":
      return { type: "transcript" };
    case "note":
      return pruneUndefined({
        type: "note",
        template_ref: output.templateRef,
      }) as WireOutput;
    case "form":
      return { type: "form", fields: output.fields.map(mapField) };
  }
}

/* --------------------------------------------------------------------------
 * Inbound: backend GET :id body -> ScribeResult (browser session.result)
 * ------------------------------------------------------------------------ */

/** Backend wire body for `GET /scribe_sessions/:id`. */
export interface WireSessionBody {
  id: string;
  status: string;
  /**
   * Top-level transcript the backend surfaces the instant ASR lands — and, while
   * recording, the GROWING live transcript assembled from the segments received
   * so far. This is the real-time source: the per-output `transcript` result is
   * only populated at commit, so a live poll must read this field, not outputs.
   */
  transcript?: { text?: string; language?: string } | null;
  outputs?: Array<{
    id: string;
    type: string;
    status: string;
    result?: unknown;
    errors?: unknown;
  }>;
}

const TERMINAL_STATUSES = new Set(["completed", "partial", "failed"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function hasTextResult(result: unknown): result is { text: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    typeof (result as { text?: unknown }).text === "string"
  );
}

/**
 * Extract a transcript string from the outputs: prefer the `transcript` output's
 * `result.text`; otherwise fall back to any output whose `result` has a `text`.
 */
export function extractTranscript(
  outputs: ScribeOutputResult[],
): string | undefined {
  const transcript = outputs.find((o) => o.type === "transcript");
  if (transcript && hasTextResult(transcript.result)) {
    return transcript.result.text;
  }
  const anyWithText = outputs.find((o) => hasTextResult(o.result));
  return anyWithText && hasTextResult(anyWithText.result)
    ? anyWithText.result.text
    : undefined;
}

/**
 * Shallow-merge every `form` output's `result` object (each already
 * `{ key: value }`). Returns `undefined` when there are no form outputs.
 */
export function mergeStructuredData(
  outputs: ScribeOutputResult[],
): Record<string, unknown> | undefined {
  const forms = outputs.filter(
    (o) =>
      o.type === "form" &&
      typeof o.result === "object" &&
      o.result !== null &&
      !Array.isArray(o.result),
  );
  if (forms.length === 0) return undefined;
  const merged: Record<string, unknown> = {};
  for (const form of forms) {
    Object.assign(merged, form.result as Record<string, unknown>);
  }
  return merged;
}

/** Map a raw session body to the public ScribeResult. */
export function mapSessionBody(body: WireSessionBody): ScribeResult {
  const outputs: ScribeOutputResult[] = (body.outputs ?? []).map((o) => ({
    id: o.id,
    type: o.type,
    status: o.status,
    result: o.result,
    errors: o.errors,
  }));

  // Prefer the top-level `transcript` — it carries the growing LIVE transcript
  // during recording (the per-output transcript is only filled at commit). Fall
  // back to the output for older backends without the top-level field.
  const topLevel = body.transcript?.text;
  const transcript =
    typeof topLevel === "string" && topLevel.length > 0
      ? topLevel
      : extractTranscript(outputs);
  const structuredData = mergeStructuredData(outputs);

  const status: ScribeResult["status"] =
    body.status === "completed" ||
    body.status === "partial" ||
    body.status === "failed"
      ? body.status
      : "failed";

  const result: ScribeResult = { status, outputs };
  if (transcript !== undefined) result.transcript = transcript;
  if (structuredData !== undefined) result.structuredData = structuredData;
  return result;
}
