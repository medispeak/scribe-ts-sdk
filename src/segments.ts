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
  // Set the instant a rotation stop() is requested (timer-driven), cleared when
  // the next recorder starts. It closes the race between the timer firing
  // recorder.stop() and its async onstop: the next segment recorder is started
  // ONLY from onstop (never the timer), and no stop() is issued twice on the same
  // recorder — so two segment recorders can never overlap on the shared stream.
  let restarting = false;
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
    // A fresh recorder is now the active one; any prior rotation has completed.
    restarting = false;
    const recorder = new MediaRecorderCtor(stream);
    active = recorder;
    const parts: Blob[] = [];
    recorder.ondataavailable = (event: BlobEvent) => {
      const data = event?.data;
      if (data && (data.size === undefined || data.size > 0)) parts.push(data);
    };
    recorder.onstop = () => {
      // The previous recorder has now fully stopped. Assemble + emit its
      // complete, standalone file, then — and only then — start the next
      // segment. Driving the restart from onstop (never the timer) guarantees
      // the next recorder starts after this one is done, never alongside it.
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
    // Rotate on a fixed cadence: the timer only *requests* a stop (each stop()
    // flushes one complete, decodable file). Guard with `restarting` so a
    // concurrent public stop() cannot also call stop() on the same recorder.
    timer = setTimeout(() => {
      if (!stopped && !restarting && recorder.state !== "inactive") {
        restarting = true;
        recorder.stop();
      }
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
      // A rotation stop() is already in flight: its pending onstop will emit,
      // release the mic, and resolve (with `stopped` set it won't restart). Do
      // NOT call stop() again — a double stop() would throw in a real browser.
      if (restarting) return stoppedPromise;
      // Otherwise flush the in-flight segment; its onstop emits + releases +
      // resolves. If nothing is active, release + resolve directly.
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
