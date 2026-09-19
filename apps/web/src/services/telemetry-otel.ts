/* The OpenTelemetry SDK, in its own chunk. Loaded only when the room says a collector is waiting.
 *
 * The page exports to the room (`POST /api/telemetry`) and to nowhere else: the browser keeps
 * talking only to the room, and the room is the only thing that knows the collector's address.
 *
 * Spans here are never put on the active context. A voice turn outlives every callback that touches
 * it — it starts on a socket message and ends on a playback callback minutes later — so each turn
 * holds its own `Context` and children are created against it explicitly. `context.with()` would
 * only be right for work that finishes inside one stack frame, and nothing here does.
 */
import { context, trace, type Context, type Span, type SpanOptions } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, SimpleSpanProcessor, WebTracerProvider, type SpanExporter } from "@opentelemetry/sdk-trace-web";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

import { TELEMETRY_ATTRIBUTES, type RoomTelemetry, type TelemetryAttributes, type TelemetryStage } from "./telemetry-types";

const ALLOWED = new Set<string>(TELEMETRY_ATTRIBUTES);
/** A page holds no more open turns than the room keeps in its own bounded trace. */
const MAX_TURNS = 64;
/** A turn nobody ever closed — the tab slept, the reply never came — is not kept open forever. */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_VALUE = 200;

/** Only what the allowlist names, bounded, never a null. Text cannot reach a span by mistake. */
function attributes(values?: TelemetryAttributes): Record<string, string | number | boolean> {
  const kept: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (!ALLOWED.has(key) || value === null || value === undefined) continue;
    kept[key] = typeof value === "string" ? value.slice(0, MAX_VALUE) : value;
  }
  return kept;
}

interface OpenTurn {
  /** Null once the turn's playback ended. The context outlives it: a follow-up reply on the same
   *  turn still belongs to the same trace, and would otherwise silently become a root of its own. */
  span: Span | null;
  context: Context;
  timer: ReturnType<typeof setTimeout>;
}

export interface TelemetryOptions {
  url: string;
  serviceName?: string;
  /** Only a test names one. In the room it is always the OTLP exporter pointed at `url`. */
  exporter?: SpanExporter;
}

export function createTelemetry({ url, serviceName = "sidevoice-web", exporter }: TelemetryOptions): RoomTelemetry {
  const buildId = (window as unknown as { sidevoiceBuildId?: string }).sidevoiceBuildId ?? "dev";
  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: buildId,
    }),
    spanProcessors: [exporter
      ? new SimpleSpanProcessor(exporter)
      : new BatchSpanProcessor(new OTLPTraceExporter({ url }))],
  });
  const tracer = provider.getTracer("sidevoice.web");
  const propagator = new W3CTraceContextPropagator();
  const turns = new Map<string, OpenTurn>();
  let callSpan: Span | null = null;
  let callContext: Context | null = null;
  let facts: Record<string, string | number | boolean> = { "sidevoice.build_id": buildId };

  /** The `traceparent` header naming a span, so the room can continue the trace it started. */
  function traceparent(parent: Context): string | null {
    const carrier: Record<string, string> = {};
    propagator.inject(parent, carrier, {
      set: (target, key, value) => {
        (target as Record<string, string>)[key] = value as string;
      },
    });
    return carrier.traceparent ?? null;
  }

  function open(name: string, parent: Context | undefined, options: SpanOptions): [Span, Context] {
    const span = tracer.startSpan(name, options, parent ?? context.active());
    return [span, trace.setSpan(parent ?? context.active(), span)];
  }

  function key(threadId: string | null, revision: number): string {
    return JSON.stringify([threadId, revision]);
  }

  function close(id: string, outcome?: string) {
    const turn = turns.get(id);
    if (!turn?.span) return;
    clearTimeout(turn.timer);
    turn.span.setAttributes(attributes({ "sidevoice.outcome": outcome }));
    turn.span.end();
    turn.span = null;
  }

  function forget(id: string) {
    close(id, "evicted");
    turns.delete(id);
  }

  // The controller reaches these through `window.sidevoiceTelemetry`, one function at a time and
  // detached from the object, so nothing here may depend on `this`.
  function endCall(reason?: string) {
    for (const id of [...turns.keys()]) close(id, "call_ended");
    callSpan?.setAttributes(attributes({ "sidevoice.reason": reason }));
    callSpan?.end();
    callSpan = null;
    callContext = null;
    void provider.forceFlush().catch(() => {});
  }

  return {
    startCall(values) {
      // A reconnect or a settings swap is another call to the room: the one it replaces ends here,
      // rather than staying open until the tab closes and never being exported at all.
      if (callSpan) endCall("replaced");
      facts = { ...facts, ...attributes(values) };
      const [span, spanContext] = open("voice.call", undefined, { attributes: facts });
      callSpan = span;
      callContext = spanContext;
      return traceparent(spanContext);
    },

    noteSession(sessionId) {
      facts = { ...facts, ...attributes({ "sidevoice.session_id": sessionId }) };
      callSpan?.setAttributes(attributes({ "sidevoice.session_id": sessionId }));
    },

    endCall,

    startTurn(threadId, revision, values) {
      const id = key(threadId, revision);
      // The room announces a turn once, but a reconnect can replay one: the first span wins.
      const existing = turns.get(id);
      if (existing) return traceparent(existing.context);
      const [span, spanContext] = open("voice.turn", callContext ?? undefined, {
        attributes: {
          ...facts,
          ...attributes({ "sidevoice.thread_id": threadId, "sidevoice.turn_revision": revision, ...values }),
        },
      });
      const timer = setTimeout(() => close(id, "abandoned"), TURN_TIMEOUT_MS);
      turns.set(id, { span, context: spanContext, timer });
      while (turns.size > MAX_TURNS) forget(turns.keys().next().value as string);
      return traceparent(spanContext);
    },

    endTurn(threadId, revision, outcome) {
      close(key(threadId, revision), outcome);
    },

    stage(threadId, revision, stage: TelemetryStage, milliseconds, values) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 3_600_000) return;
      const turn = turns.get(key(threadId, revision));
      const end = Date.now();
      const [span] = open(stage, turn?.context ?? callContext ?? undefined, {
        startTime: end - milliseconds,
        attributes: {
          ...facts,
          ...attributes({
            "sidevoice.thread_id": threadId,
            "sidevoice.turn_revision": revision,
            "sidevoice.stage": stage,
            "sidevoice.duration_ms": Math.round(milliseconds * 100) / 100,
            ...values,
          }),
        },
      });
      span.end(end);
    },

    audioEvent(kind, values) {
      callSpan?.addEvent(`voice.audio.${String(kind).slice(0, 40)}`, {
        ...facts,
        ...attributes({ "sidevoice.kind": kind, ...values }),
      });
    },
  };
}
