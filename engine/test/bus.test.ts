import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeBus } from "../src/bus.ts";

describe("event bus (pure)", () => {
  it("numbers events in order, lowercases the account and stamps the time", () => {
    const bus = makeBus();
    const a = bus.emit("receipt", "0xABCDEF0000000000000000000000000000000001", { n: 1 });
    const b = bus.emit("intent", null, { n: 2 });
    assert.equal(a.id, 1);
    assert.equal(b.id, 2);
    assert.equal(a.safe, "0xabcdef0000000000000000000000000000000001");
    assert.equal(b.safe, null);
    assert.equal(a.type, "receipt");
    assert.deepEqual(a.data, { n: 1 });
    assert.ok(Math.abs(a.ts - Date.now() / 1000) < 2);
  });

  it("replays events after a given id (Last-Event-ID) and keeps only the newest", () => {
    const bus = makeBus(3);
    for (let i = 0; i < 5; i++) bus.emit("receipt", null, { i });
    assert.deepEqual(bus.since(0).map((e) => e.id), [3, 4, 5], "ring keeps the last 3");
    assert.deepEqual(bus.since(4).map((e) => e.id), [5]);
    assert.deepEqual(bus.since(5), []);
  });

  it("delivers to every listener, survives a throwing listener, and unsubscribes", () => {
    const bus = makeBus();
    const seen: number[] = [];
    bus.subscribe(() => {
      throw new Error("listener broke");
    });
    const off = bus.subscribe((e) => seen.push(e.id));
    bus.emit("demo", null, {});
    assert.deepEqual(seen, [1]);
    off();
    bus.emit("demo", null, {});
    assert.deepEqual(seen, [1], "no delivery after unsubscribe");
  });
});
