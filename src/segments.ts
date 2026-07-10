import { ScribeError } from "./errors";

/**
 * A minimal, mockable capture that emits short, **standalone, independently
 * decodable** audio files for live transcription.
 *
 * Unlike the durable storage recorder (`./media`), whose timeslice chunks are
 * only decodable once concatenated, a *segment* is a complete, playable file on
 * its own. It runs on its own `getUserMedia` stream so it never disturbs the
 * storage recorder, and it is a best-effort, additive stream: losing a segment
 * only costs a little live transcript, never the durable recording.
 *
 * jsdom has no `MediaRecorder`, so tests inject a fake factory via
 * `setSegmentRecorderFactory`. The default implementation uses the browser
 * globals (`navigator.mediaDevices.getUserMedia` + `MediaRecorder`).
 */

export interface StartSegmentParams {
  /** Target duration of each standalone segment, ms. */
  segmentMs: number;
  /** Called once per completed, independently-decodable segment file. */
  onSegment: (blob: Blob) => void;
}

export interface SegmentController {
  /** Stop segment capture; resolves after the final segment has been emitted. */
  stop(): Promise<void>;
}

export type SegmentRecorderFactory = (
  params: StartSegmentParams,
) => Promise<SegmentController>;

/**
 * The default factory: real browser mic capture driving a second
 * `MediaRecorder` that is stopped + restarted per segment, because each
 * `stop()` flushes one complete, standalone file. Restart runs on a fixed
 * `segmentMs` cadence.
 *
 * NOTE: A silence-cut refinement (restart on a brief Web Audio RMS dip so the
 * gap lands in silence between words) is a documented follow-up — it is
 * intentionally NOT implemented here (see plan 002 Maintenance notes).
 */
export const defaultSegmentRecorderFactory: SegmentRecorderFactory = async ({
  segmentMs,
  onSegment,
}) => {
  const nav: Navigator | undefined = globalThis.navigator;
  const MediaRecorderCtor = (
    globalThis as unknown as { MediaRecorder?: typeof MediaRecorder }
  ).MediaRecorder;

  if (!nav?.mediaDevices?.getUserMedia) {
    throw new ScribeError(
      "navigator.mediaDevices.getUserMedia is not available in this environment",
    );
  }
  if (!MediaRecorderCtor) {
    throw new ScribeError(
      "MediaRecorder is not available in this environment",
    );
  }

  // Its own stream — do NOT share the storage recorder's MediaRecorder/stream.
  const stream = await nav.mediaDevices.getUserMedia({ audio: true });

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: MediaRecorder | undefined;
  let resolveStopped!: () => void;
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const releaseMic = () => {
    stream.getTracks?.().forEach((track) => track.stop?.());
  };

  const startSegment = () => {
    if (stopped) return;
    const recorder = new MediaRecorderCtor(stream);
    active = recorder;
    const parts: Blob[] = [];
    recorder.ondataavailable = (event: BlobEvent) => {
      const data = event?.data;
      if (data && (data.size === undefined || data.size > 0)) parts.push(data);
    };
    recorder.onstop = () => {
      // Assemble this segment's complete, standalone file and emit it.
      if (parts.length > 0) {
        const type = parts[0]?.type || "audio/webm";
        onSegment(new Blob(parts, { type }));
      }
      if (stopped) {
        releaseMic();
        resolveStopped();
      } else {
        startSegment();
      }
    };
    recorder.start();
    // Restart per segment: each stop() flushes one complete, decodable file.
    timer = setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop();
    }, segmentMs);
  };

  startSegment();

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      // Flush the in-flight segment; its onstop emits + releases + resolves.
      if (active && active.state !== "inactive") active.stop();
      else {
        releaseMic();
        resolveStopped();
      }
      return stoppedPromise;
    },
  };
};

let activeSegmentFactory: SegmentRecorderFactory = defaultSegmentRecorderFactory;

/**
 * Override the segment recorder factory (used by tests to inject a fake, since
 * jsdom has no MediaRecorder). Not part of the public entry-point exports.
 */
export function setSegmentRecorderFactory(
  factory: SegmentRecorderFactory,
): void {
  activeSegmentFactory = factory;
}

/** Reset the segment recorder factory back to the default browser implementation. */
export function resetSegmentRecorderFactory(): void {
  activeSegmentFactory = defaultSegmentRecorderFactory;
}

export function getSegmentRecorderFactory(): SegmentRecorderFactory {
  return activeSegmentFactory;
}
