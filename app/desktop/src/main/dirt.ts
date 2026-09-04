import { createSocket, type Socket } from "dgram";

const DIRT_HOST = "127.0.0.1";
// Must match `~dirt.start(<port>, ...)` in startup.scd.
const DIRT_PORT = 57120;

export type OscArg =
  | { type: "s"; value: string }
  | { type: "i"; value: number }
  | { type: "f"; value: number };

function paddedLength(length: number): number {
  return length + ((4 - (length % 4)) % 4);
}

function encodeOscString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf-8");
  return Buffer.concat([
    bytes,
    Buffer.alloc(paddedLength(bytes.length + 1) - bytes.length),
  ]);
}

export function encodeOscMessage(
  address: string,
  args: OscArg[]
): Buffer {
  const addressBuffer = encodeOscString(address);
  const tags = `,${args.map((arg) => arg.type).join("")}`;
  const tagBuffer = encodeOscString(tags);
  const argBuffers = args.map((arg) => {
    if (arg.type === "s") return encodeOscString(arg.value);
    const buffer = Buffer.alloc(4);
    if (arg.type === "i") buffer.writeInt32BE(arg.value, 0);
    else buffer.writeFloatBE(arg.value, 0);
    return buffer;
  });
  return Buffer.concat([addressBuffer, tagBuffer, ...argBuffers]);
}

let socket: Socket | null = null;

function dirtSocket(): Socket {
  if (!socket) {
    socket = createSocket("udp4");
    socket.on("error", () => {
      socket?.close();
      socket = null;
    });
  }
  return socket;
}

export interface DirtHit {
  sound: string;
  n: number;
  gain: number;
  orbit?: number;
}

// Fire-and-forget one-shot, equivalent to `once $ s "sound:n" # gain x`.
// Silently drops when SuperDirt is not listening.
export function playDirtSample({ sound, n, gain, orbit = 0 }: DirtHit) {
  const message = encodeOscMessage("/dirt/play", [
    { type: "s", value: "s" },
    { type: "s", value: sound },
    { type: "s", value: "n" },
    { type: "i", value: n },
    { type: "s", value: "gain" },
    { type: "f", value: gain },
    { type: "s", value: "orbit" },
    { type: "i", value: orbit },
  ]);
  dirtSocket().send(message, DIRT_PORT, DIRT_HOST);
}
