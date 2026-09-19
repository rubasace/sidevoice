import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-web";
import { TELEMETRY_ATTRIBUTES, TURN_STAGES } from "@sidevoice/protocol";

import { createTelemetry } from "./telemetry-otel";

const SPOKEN = "lo que dije en voz alta";

function telemetryUnderTest() {
  const exporter = new InMemorySpanExporter();
  return { exporter, telemetry: createTelemetry({ url: "/api/telemetry", exporter }) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the page's half of a turn's trace", () => {
  it("puts the turn inside the call and hands the room a traceparent for both", () => {
    const { exporter, telemetry } = telemetryUnderTest();
    const call = telemetry.startCall({ "sidevoice.stt_provider": "browser" });
    const turn = telemetry.startTurn("a", 1);
    expect(call).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    expect(turn).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    // The room continues the same trace, so both traceparents name one trace id.
    expect(turn!.split("-")[1]).toEqual(call!.split("-")[1]);

    telemetry.stage("a", 1, "audio_received_to_playback", 42);
    telemetry.endTurn("a", 1, "played");
    telemetry.endCall("left");

    const spans = exporter.getFinishedSpans();
    const names = spans.map((span) => span.name);
    expect(names).toEqual(["audio_received_to_playback", "voice.turn", "voice.call"]);
    const [stage, turnSpan, callSpan] = spans;
    expect(stage.parentSpanContext?.spanId).toEqual(turnSpan.spanContext().spanId);
    expect(turnSpan.parentSpanContext?.spanId).toEqual(callSpan.spanContext().spanId);
    expect(turnSpan.attributes["sidevoice.outcome"]).toBe("played");
  });

  it("gives the same turn one span however often the room announces it", () => {
    const { exporter, telemetry } = telemetryUnderTest();
    telemetry.startCall();
    const first = telemetry.startTurn("a", 1);
    expect(telemetry.startTurn("a", 1)).toEqual(first);
    telemetry.endTurn("a", 1, "played");
    telemetry.endTurn("a", 1, "played");
    expect(exporter.getFinishedSpans().filter((span) => span.name === "voice.turn")).toHaveLength(1);
  });

  it("keeps a follow-up reply in its turn's trace after the first playback closed it", () => {
    const { exporter, telemetry } = telemetryUnderTest();
    telemetry.startCall();
    telemetry.startTurn("a", 1);
    telemetry.endTurn("a", 1, "played");
    telemetry.stage("a", 1, "audio_received_to_playback", 10);
    const [turnSpan] = exporter.getFinishedSpans().filter((span) => span.name === "voice.turn");
    const [late] = exporter.getFinishedSpans().filter((span) => span.name === "audio_received_to_playback");
    expect(late.parentSpanContext?.spanId).toEqual(turnSpan.spanContext().spanId);
  });

  it("measures a stage as the duration it was handed, and refuses an impossible one", () => {
    const { exporter, telemetry } = telemetryUnderTest();
    telemetry.startCall();
    telemetry.startTurn("a", 1);
    telemetry.stage("a", 1, "audio_received_to_playback", 125.25);
    telemetry.stage("a", 1, "audio_received_to_playback", -1);
    telemetry.stage("a", 1, "audio_received_to_playback", Number.NaN);
    telemetry.stage("a", 1, "audio_received_to_playback", 3_600_001);
    const stages = exporter.getFinishedSpans().filter((span) => span.name === "audio_received_to_playback");
    expect(stages).toHaveLength(1);
    expect(stages[0].attributes["sidevoice.duration_ms"]).toBe(125.25);
  });

  it("reports the audio output as events on the call span, not as a channel of its own", () => {
    const { exporter, telemetry } = telemetryUnderTest();
    telemetry.startCall();
    telemetry.audioEvent("stall", { "sidevoice.audio_output": "element", "sidevoice.stalls": 3 });
    telemetry.endCall("left");
    const [callSpan] = exporter.getFinishedSpans().filter((span) => span.name === "voice.call");
    expect(callSpan.events.map((event) => event.name)).toEqual(["voice.audio.stall"]);
    expect(callSpan.events[0].attributes?.["sidevoice.stalls"]).toBe(3);
  });

  it("ends the call it replaces instead of leaving it open forever", () => {
    const { exporter, telemetry } = telemetryUnderTest();
    telemetry.startCall();
    telemetry.startTurn("a", 1);
    telemetry.startCall();
    const calls = exporter.getFinishedSpans().filter((span) => span.name === "voice.call");
    expect(calls).toHaveLength(1);
    expect(calls[0].attributes["sidevoice.reason"]).toBe("replaced");
    // The turn it was holding is closed with it: nothing is left dangling on a socket that is gone.
    expect(exporter.getFinishedSpans().filter((span) => span.name === "voice.turn")).toHaveLength(1);
  });
});

describe("what a span of this page may say", () => {
  it("drops everything the vocabulary does not name, however it is passed in", () => {
    const { exporter, telemetry } = telemetryUnderTest();
    telemetry.startCall({ text: SPOKEN, transcript: SPOKEN } as never);
    telemetry.startTurn("a", 1, { audio_base64: "YQ==", "sidevoice.thread_id": "a" } as never);
    telemetry.stage("a", 1, "audio_received_to_playback", 10, { message: SPOKEN } as never);
    telemetry.audioEvent("fail", { detail: SPOKEN } as never);
    telemetry.endTurn("a", 1, "played");
    telemetry.endCall("left");
    const allowed = new Set<string>(TELEMETRY_ATTRIBUTES);
    const rendered: string[] = [];
    for (const span of exporter.getFinishedSpans()) {
      for (const [key, value] of Object.entries(span.attributes)) {
        expect(allowed, `${span.name}.${key}`).toContain(key);
        rendered.push(String(value));
      }
      for (const event of span.events) {
        for (const [key, value] of Object.entries(event.attributes ?? {})) {
          expect(allowed, `${event.name}.${key}`).toContain(key);
          rendered.push(String(value));
        }
      }
    }
    expect(rendered.join(" ")).not.toContain(SPOKEN);
  });

  it("names every stage the dialog and the room name", () => {
    expect(TURN_STAGES).toContain("audio_received_to_playback");
    expect(new Set(TURN_STAGES).size).toBe(TURN_STAGES.length);
  });
});

describe("a room with no collector", () => {
  it("never loads the SDK, and every call through the facade is a no-op", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ enabled: false }), {
      headers: { "content-type": "application/json" },
    })));
    const module = await import("./telemetry");
    expect(await module.initTelemetry()).toBeNull();
    // The facade answers without an implementation behind it, and answers nothing.
    expect(module.telemetry.startCall()).toBeNull();
    expect(module.telemetry.startTurn("a", 1)).toBeNull();
    expect(() => module.telemetry.endCall("left")).not.toThrow();
    expect(() => module.telemetry.audioEvent("stall")).not.toThrow();
  });

  it("does not trace against a room too old to have the endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const module = await import("./telemetry");
    expect(await module.initTelemetry()).toBeNull();
  });
});
