/**
 * Browser entry point for `@medispeak/scribe-ts-sdk`.
 *
 * Create a client with your v2 base URL and a `getToken` provider, then drive a
 * session: record → stop → result. The client never holds an account secret.
 */
export { createScribeClient, listUnfinishedSessions } from "./client";
export { ScribeError } from "./errors";

export type {
  // Shared, Medispeak-native types
  FieldType,
  FieldSpec,
  OutputSpec,
  StartSessionOptions,
  ScribeOutputResult,
  ScribeResult,
  ScribeStatus,
  // Browser client types
  ScribeClient,
  ScribeClientConfig,
  ScribeSession,
  RecordOptions,
  ResultOptions,
} from "./types";
