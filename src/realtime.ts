import { errorFromResponse } from "./errors";
import type { SessionHttp } from "./http";

/** Backend response from `POST scribe_sessions/:id/realtime_token`. */
export interface RealtimeConfig {
  provider: string;
  /** Ephemeral client secret (short-lived); safe to expose to the browser. */
  token: string;
  /** Where the browser POSTs its WebRTC SDP offer. */
  url: string;
  model: string;
  session?: unknown;
}

export interface RealtimeOptions {
  /** Called with the growing transcript as partials arrive. */
  onPartial: (text: string) => void;
  /** Best-effort error sink; realtime failures never touch the durable path. */
  onError?: (err: unknown) => void;
}

/**
 * OpenAI realtime transcription over WebRTC.
 *
 * Flow: fetch a backend-minted ephemeral token → open an RTCPeerConnection that
 * streams the mic to OpenAI (send-only) → receive
 * `conversation.item.input_audio_transcription.{delta,completed}` events on the
 * data channel → emit the growing transcript.
 *
 * Strictly ADDITIVE and isolated: this runs alongside the durable storage
 * recorder (which remains the authoritative source for the committed
 * transcript). Any failure is routed to `onError` and never rejects into
 * stop()/commit. Uses its own mic capture so it can be torn down independently.
 */
export class RealtimeTranscriber {
  private pc: RTCPeerConnection | undefined;
  private stream: MediaStream | undefined;
  private channel: RTCDataChannel | undefined;
  private started = false;
  private lastEmitted = "";
  // itemId -> transcript text, so out-of-order deltas across VAD segments
  // reassemble into one growing transcript.
  private readonly segments = new Map<string, string>();
  private readonly order: string[] = [];

  constructor(
    private readonly http: SessionHttp,
    private readonly sessionId: string,
    private readonly opts: RealtimeOptions,
  ) {}

  /** Best-effort start: on any failure, calls onError and resolves (never throws). */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      const cfg = await this.fetchConfig();
      if (cfg.provider !== "openai") {
        throw new Error(`unsupported realtime provider: ${cfg.provider}`);
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.stream = stream;

      const pc = new RTCPeerConnection();
      this.pc = pc;
      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);

      const channel = pc.createDataChannel("oai-events");
      this.channel = channel;
      channel.onmessage = (e) => this.onEvent(e.data);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const answerSdp = await this.exchangeSdp(cfg, offer.sdp ?? "");
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    } catch (err) {
      this.started = false;
      await this.stop();
      this.opts.onError?.(err);
    }
  }

  private async fetchConfig(): Promise<RealtimeConfig> {
    const res = await this.http.request(
      `scribe_sessions/${this.sessionId}/realtime_token`,
      { method: "POST" },
    );
    if (!res.ok) throw await errorFromResponse(res, "realtime token");
    return (await res.json()) as RealtimeConfig;
  }

  /**
   * POST the SDP offer to OpenAI's realtime calls endpoint with the ephemeral
   * token. The session (model, transcription, VAD) is already bound to the
   * token at mint time, so no query params are needed here.
   */
  private async exchangeSdp(
    cfg: RealtimeConfig,
    offerSdp: string,
  ): Promise<string> {
    const res = await fetch(cfg.url, {
      method: "POST",
      body: offerSdp,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/sdp",
      },
    });
    if (!res.ok) {
      throw new Error(
        `realtime SDP exchange failed: ${res.status} ${await res.text()}`,
      );
    }
    return res.text();
  }

  private onEvent(data: unknown): void {
    if (typeof data !== "string") return;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = evt.type as string | undefined;
    const itemId = (evt.item_id as string) || "current";

    if (type === "conversation.item.input_audio_transcription.delta") {
      const delta = (evt.delta as string) || "";
      this.append(itemId, this.get(itemId) + delta);
      this.emit();
    } else if (
      type === "conversation.item.input_audio_transcription.completed"
    ) {
      const transcript = (evt.transcript as string) || this.get(itemId);
      this.append(itemId, transcript);
      this.emit();
    }
  }

  private get(itemId: string): string {
    return this.segments.get(itemId) ?? "";
  }

  private append(itemId: string, text: string): void {
    if (!this.segments.has(itemId)) this.order.push(itemId);
    this.segments.set(itemId, text);
  }

  private emit(): void {
    const text = this.order
      .map((id) => this.segments.get(id) ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text && text !== this.lastEmitted) {
      this.lastEmitted = text;
      this.opts.onPartial(text);
    }
  }

  /** Tear down the peer connection and release the mic. Idempotent, never throws. */
  async stop(): Promise<void> {
    this.started = false;
    try {
      this.channel?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    for (const track of this.stream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    }
    this.pc = undefined;
    this.channel = undefined;
    this.stream = undefined;
  }
}
