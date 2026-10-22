// Messages between a Kurviq tab and its pairing (Durable Object) over one
// WebSocket. Big messages (scene JSON, PNG renders) are sent in parts, so
// no single WebSocket message gets near the platform's size limit.
// Shared by the app (scenes-plugin) and the Worker (online/worker).

const PART_SIZE = 256 * 1024;

type Sender = { send: (data: string) => void };

export const sendMessage = (ws: Sender, message: unknown) => {
  const text = JSON.stringify(message);
  if (text.length <= PART_SIZE) {
    ws.send(text);
    return;
  }
  const id = Math.random().toString(36).slice(2, 12);
  const total = Math.ceil(text.length / PART_SIZE);
  for (let i = 0; i < total; i++) {
    ws.send(JSON.stringify({ type: "part", id, i, total, data: text.slice(i * PART_SIZE, (i + 1) * PART_SIZE) }));
  }
};

/** collects parts; returns the whole message once complete (else null) */
export const createReceiver = () => {
  const partial = new Map<string, { parts: string[]; count: number; at: number }>();
  return (raw: string): any | null => {
    const message = JSON.parse(raw);
    if (message?.type !== "part") {
      return message;
    }
    // drop leftovers of messages that never completed
    for (const [id, entry] of partial) {
      if (Date.now() - entry.at > 120_000) {
        partial.delete(id);
      }
    }
    const entry = partial.get(message.id) ?? { parts: new Array(message.total), count: 0, at: Date.now() };
    if (entry.parts[message.i] === undefined) {
      entry.parts[message.i] = message.data;
      entry.count++;
    }
    partial.set(message.id, entry);
    if (entry.count < message.total) {
      return null;
    }
    partial.delete(message.id);
    return JSON.parse(entry.parts.join(""));
  };
};
