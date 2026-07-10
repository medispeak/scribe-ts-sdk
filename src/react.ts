/**
 * React entry point for `@medispeak/scribe-ts-sdk`.
 *
 * `react` is an optional peer dependency — only this module imports it. The
 * core (`.`) and server (`./server`) entry points do not depend on React.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ScribeResult,
  ScribeSession,
  ScribeStatus,
  UseScribeOptions,
  UseScribeReturn,
} from "./types";

export type { UseScribeOptions, UseScribeReturn } from "./types";
export type { ScribeResult, ScribeStatus, ScribeClient } from "./types";

/**
 * Drive a scribe session from React. Binds to `sessionId` via the given
 * `client`, exposes live status/duration, and resolves `result` after `stop()`.
 */
export function useScribe(opts: UseScribeOptions): UseScribeReturn {
  const { client, sessionId, onResult, onError } = opts;

  const session: ScribeSession = useMemo(
    () => client.session(sessionId),
    [client, sessionId],
  );

  const [status, setStatus] = useState<ScribeStatus>("idle");
  const [duration, setDuration] = useState(0);
  const [result, setResult] = useState<ScribeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keep latest callbacks without forcing re-subscription.
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onResultRef.current = onResult;
    onErrorRef.current = onError;
  });

  // Subscribe to session status changes.
  useEffect(() => {
    setStatus("idle");
    return session.onStatusChange(setStatus);
  }, [session]);

  // Tick duration (seconds) while recording; frozen while paused.
  useEffect(() => {
    if (status !== "recording") return;
    const id = setInterval(() => setDuration((d) => d + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

  const handleError = useCallback((e: unknown) => {
    const err = e instanceof Error ? e : new Error(String(e));
    setError(err.message);
    onErrorRef.current?.(err);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setResult(null);
    setDuration(0);
    try {
      await session.record();
    } catch (e) {
      handleError(e);
    }
  }, [session, handleError]);

  const pause = useCallback(() => {
    session.pause();
  }, [session]);

  const resume = useCallback(() => {
    session.resume();
  }, [session]);

  const stop = useCallback(async () => {
    try {
      await session.stop();
      const r = await session.result();
      setResult(r);
      onResultRef.current?.(r);
    } catch (e) {
      handleError(e);
    }
  }, [session, handleError]);

  const cancel = useCallback(async () => {
    try {
      await session.cancel();
    } catch (e) {
      handleError(e);
    }
  }, [session, handleError]);

  return {
    status,
    isRecording: status === "recording",
    isPaused: status === "paused",
    duration,
    result,
    error,
    start,
    pause,
    resume,
    stop,
    cancel,
  };
}
