import { encodeOscMessage } from "./dirt";

function decodeOscString(buffer: Buffer, offset: number): string {
  const end = buffer.indexOf(0, offset);
  return buffer.toString("utf-8", offset, end);
}

describe("encodeOscMessage", () => {
  it("encodes a /dirt/play hit for funny:24 at gain 0.6", () => {
    const message = encodeOscMessage("/dirt/play", [
      { type: "s", value: "s" },
      { type: "s", value: "funny" },
      { type: "s", value: "n" },
      { type: "i", value: 24 },
      { type: "s", value: "gain" },
      { type: "f", value: 0.6 },
      { type: "s", value: "orbit" },
      { type: "i", value: 0 },
    ]);

    // Address + type tags + args, all 4-byte aligned.
    expect(message.length % 4).toBe(0);
    expect(decodeOscString(message, 0)).toBe("/dirt/play");
    // "/dirt/play" is 10 chars + null = 11 bytes, padded to 12.
    const tags = decodeOscString(message, 12);
    expect(tags).toBe(",sssisfsi");

    // Payload carries the bank name and the float gain bytes (0.6).
    expect(message.includes(Buffer.from("funny"))).toBe(true);
    const gainBytes = Buffer.alloc(4);
    gainBytes.writeFloatBE(0.6, 0);
    expect(message.includes(gainBytes)).toBe(true);
  });
});
