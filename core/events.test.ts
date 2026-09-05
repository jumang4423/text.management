import { EventEmitter } from "./events";

class Emitter extends EventEmitter<{ change: void }> {
  fire() { this.emit("change", undefined); }
}

test("a once listener does not skip the next listener when disconnecting", () => {
  const emitter = new Emitter();
  const first = jest.fn();
  const second = jest.fn();
  emitter.once("change", first);
  emitter.on("change", second);
  emitter.fire();
  emitter.fire();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(2);
});
