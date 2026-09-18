import type { ChatMessage } from "../../state/room-types";

export interface MessageGroupView {
  id: string;
  role: ChatMessage["role"];
  name: string;
  messages: ChatMessage[];
}

const GROUP_WINDOW_MS = 5 * 60 * 1000;

function sameCalendarDay(left: number, right: number) {
  const a = new Date(left);
  const b = new Date(right);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function groupMessages(messages: ChatMessage[]): MessageGroupView[] {
  const groups: MessageGroupView[] = [];
  for (const message of messages) {
    const group = groups.at(-1);
    const previous = group?.messages.at(-1);
    const joinsPrevious = previous
      && previous.role === message.role
      && previous.name === message.name
      && previous.thread === message.thread
      && previous.session === message.session
      && !previous.draft
      && !message.draft
      && sameCalendarDay(previous.time, message.time)
      && message.time - previous.time >= 0
      && message.time - previous.time <= GROUP_WINDOW_MS;

    if (group && joinsPrevious) group.messages.push(message);
    else groups.push({ id: message.segment || `${message.role}-${message.time}`, role: message.role, name: message.name, messages: [message] });
  }
  return groups;
}
