import { expect, test } from "vitest";
import type { ChatMessage } from "../../state/room-types";
import { groupMessages } from "./group-messages";

const message = (overrides: Partial<ChatMessage>): ChatMessage => ({ segment: crypto.randomUUID(), role: "assistant", text: "hola", name: "Agente", time: 1_700_000_000_000, thread: "one", session: "call", ...overrides });

test("groups consecutive messages only when sender, thread, session, day and time window match", () => {
  const groups = groupMessages([
    message({ segment: "a" }),
    message({ segment: "b", time: 1_700_000_010_000 }),
    message({ segment: "c", role: "user", name: "Tú", time: 1_700_000_020_000 }),
    message({ segment: "d", time: 1_700_000_030_000 }),
    message({ segment: "e", time: 1_700_000_400_001 }),
  ]);
  expect(groups.map((group) => group.messages.map((item) => item.segment))).toEqual([["a", "b"], ["c"], ["d"], ["e"]]);
});

test("drafts and different sessions always start a new visual group", () => {
  const groups = groupMessages([message({ segment: "a" }), message({ segment: "b", draft: true }), message({ segment: "c", session: "next" })]);
  expect(groups).toHaveLength(3);
});
