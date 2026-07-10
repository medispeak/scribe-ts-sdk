import { ScribeError } from "./errors";

/**
 * A minimal, mockable microphone-capture abstraction.
 *
 * jsdom has no `MediaRecorder`, so tests inject a fake factory via
 * `setRecorderFactory`. The default implementation uses the browser globals
 * (`navigator.mediaDevices.getUserMedia` + `MediaRecorder`).
 */

export interface StartRecordingParams {
  /** Timeslice passed to `MediaRecorder.start(ms)`. */
  chunkMs: number;
  /** Called for every non-empty audio blob the recorder emits. */
  onChunk: (blob: Blob) => void;
}

export interface RecorderController {
  pause(): void;
  resume(): void;
  /** Stop capture and release the mic. Resolves after the final chunk + stop. */
  stop(): Promise<void>;
}

export type RecorderFactory = (
  params: StartRecordingParams,
) => Promise<RecorderController>;

/** The default factory: real browser mic capture via MediaRecorder. */
export const defaultRecorderFactory: RecorderFactory = async ({
  chunkMs,
  onChunk,
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

  const stream = await nav.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorderCtor(stream);

  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  recorder.ondataavailable = (event: BlobEvent) => {
    const data = event?.data;
    if (data && (data.size === undefined || data.size > 0)) {
      onChunk(data);
    }
  };
  recorder.onstop = () => {
    try {
      stream.getTracks?.().forEach((track) => track.stop?.());
    } finally {
      resolveStopped();
    }
  };

  recorder.start(chunkMs);

  return {
    pause: () => {
      if (recorder.state === "recording") recorder.pause();
    },
    resume: () => {
      if (recorder.state === "paused") recorder.resume();
    },
    stop: () => {
      if (recorder.state !== "inactive") recorder.stop();
      else resolveStopped();
      return stopped;
    },
  };
};

let activeRecorderFactory: RecorderFactory = defaultRecorderFactory;

/**
 * Override the recorder factory (used by tests to inject a fake, since jsdom
 * has no MediaRecorder). Not part of the public entry-point exports.
 */
export function setRecorderFactory(factory: RecorderFactory): void {
  activeRecorderFactory = factory;
}

/** Reset the recorder factory back to the default browser implementation. */
export function resetRecorderFactory(): void {
  activeRecorderFactory = defaultRecorderFactory;
}

export function getRecorderFactory(): RecorderFactory {
  return activeRecorderFactory;
}
