/* The handle the room-session controller drives tracing with.
 *
 * The vocabulary itself — which stages exist, and what a span may say — belongs to
 * `@sidevoice/protocol`, because the room implements the same list. Nothing is redefined here. */
import { TELEMETRY_ATTRIBUTES, TURN_STAGES, type TurnStage } from "@sidevoice/protocol";

export { TELEMETRY_ATTRIBUTES, TURN_STAGES };
export type TelemetryStage = TurnStage;

export type TelemetryAttributes = Record<string, string | number | boolean | null | undefined>;

export interface RoomTelemetry {
  /** Open the call span. Returns the W3C `traceparent` the hello carries, or null when not tracing. */
  startCall(values?: TelemetryAttributes): string | null;
  /** The room minted this browser's session id; every later span of the call carries it. */
  noteSession(sessionId: string | null): void;
  endCall(reason?: string): void;
  /** Open the turn's root span. Returns the `traceparent` the room continues the turn with. */
  startTurn(threadId: string | null, revision: number, values?: TelemetryAttributes): string | null;
  endTurn(threadId: string | null, revision: number, outcome?: string): void;
  /** A stage this page measured, in milliseconds, ending now. */
  stage(threadId: string | null, revision: number, stage: TelemetryStage, milliseconds: number, values?: TelemetryAttributes): void;
  /** What the audio output did, as an event on the call span. Not a second channel. */
  audioEvent(kind: string, values?: TelemetryAttributes): void;
}
