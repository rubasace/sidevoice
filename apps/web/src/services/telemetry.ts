/* The browser half of the room's tracing, and the reason the OpenTelemetry SDK is not in the bundle.
 *
 * This file is a facade with no static import of the SDK. It asks the room once whether a collector
 * is configured (`GET /api/telemetry`), and only then does it `import()` the implementation, which
 * Vite emits as its own chunk. A room with no `OTEL_EXPORTER_OTLP_ENDPOINT` therefore downloads
 * nothing, starts nothing, and posts nothing: that is what "costs nothing when unconfigured" means
 * on this side of the wire.
 *
 * Privacy is the same rule as the room's: only ids, revisions, states and engine names ever reach a
 * span. `attributes()` in `telemetry-otel.ts` keeps the allowlist; nothing here takes text.
 *
 * The room-session controller is a plain script, not a module, so it reaches this through
 * `window.sidevoiceTelemetry` like it reaches the audio and transcription runtimes. Every call is
 * safe before the implementation loads: it is dropped, never queued and never thrown.
 */
import { TELEMETRY_API } from "@sidevoice/protocol";
import type { RoomTelemetry, TelemetryAttributes } from "./telemetry-types";

let implementation: RoomTelemetry | null = null;
let loading: Promise<RoomTelemetry | null> | null = null;

/** Dropped until the SDK is up: a page that traced its first hundred milliseconds would still have
 *  no exporter to send them to, and a buffer here would be a second place holding turns. */
const dropped: RoomTelemetry = {
  startCall: () => null,
  noteSession: () => {},
  endCall: () => {},
  startTurn: () => null,
  endTurn: () => {},
  stage: () => {},
  audioEvent: () => {},
};

function facade(method: keyof RoomTelemetry) {
  return (...args: unknown[]) => {
    const target = (implementation ?? dropped)[method] as (...rest: unknown[]) => unknown;
    try {
      return target(...args);
    } catch {
      // Telemetry never breaks a call. A failed span is a lost measurement and nothing else.
      return null;
    }
  };
}

export const telemetry: RoomTelemetry = {
  startCall: facade("startCall") as RoomTelemetry["startCall"],
  noteSession: facade("noteSession") as RoomTelemetry["noteSession"],
  endCall: facade("endCall") as RoomTelemetry["endCall"],
  startTurn: facade("startTurn") as RoomTelemetry["startTurn"],
  endTurn: facade("endTurn") as RoomTelemetry["endTurn"],
  stage: facade("stage") as RoomTelemetry["stage"],
  audioEvent: facade("audioEvent") as RoomTelemetry["audioEvent"],
};

/** Ask the room, and load the SDK only if it says a collector is waiting for the spans. */
export function initTelemetry(): Promise<RoomTelemetry | null> {
  loading ??= (async () => {
    try {
      const response = await fetch(TELEMETRY_API, { headers: { accept: "application/json" } });
      if (!response.ok) return null;
      const state = (await response.json()) as { enabled?: boolean };
      if (!state?.enabled) return null;
      const module = await import("./telemetry-otel");
      implementation = module.createTelemetry({ url: TELEMETRY_API });
      return implementation;
    } catch {
      // An older room has no such endpoint, and a page that cannot ask simply does not trace.
      return null;
    }
  })();
  return loading;
}

declare global {
  interface Window {
    sidevoiceTelemetry?: RoomTelemetry;
  }
}

window.sidevoiceTelemetry = telemetry;
void initTelemetry();

export type { RoomTelemetry, TelemetryAttributes };
