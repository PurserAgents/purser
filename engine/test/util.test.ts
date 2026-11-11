import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiFailure, checksum, dayKey, fail, fmt, id, json, lower, MAX_U128, now, parseJson, sameAddress, sleep, usd, ZERO } from "../src/util.ts";

describe("util (pure)", () => {
  it("fmt trims decimals, keeps at least two and adds thousands separators", () => {
    assert.equal(fmt(0n, 6), "0.00");
    assert.equal(fmt(1_000_000n, 6), "1.00");
    assert.equal(fmt(12_500_000n, 6), "12.50");
    assert.equal(fmt(1_234_567_890_123n, 6), "1,234,567.890123");
    assert.equal(fmt(1n, 6), "0.000001");
    assert.equal(fmt(10n ** 18n + 123n, 18), "1.00", "default 6 dp drops dust");
    assert.equal(fmt(1_234_567n, 6, 2), "1.23");
    assert.equal(fmt(-2_500_000n, 6), "-2.50");
  });

  it("usd gives a plain 2-decimal string without separators", () => {
    assert.equal(usd(0n), "0.00");
    assert.equal(usd(1_234_567_890n), "1234.56");
    assert.equal(usd(5_000n), "0.00");
  });

  it("ids carry a prefix and are unique", () => {
    const a = id("int");
    const b = id("int");
    assert.match(a, /^int_[A-Za-z0-9_-]{12}$/);
    assert.notEqual(a, b);
  });

  it("address helpers compare case-insensitively and refuse empty values", () => {
    const a = "0xAbCdEf0000000000000000000000000000000001";
    assert.equal(lower(a), a.toLowerCase());
    assert.equal(sameAddress(a, a.toLowerCase()), true);
    assert.equal(sameAddress(a, ZERO), false);
    assert.equal(sameAddress(null, null), false);
    assert.equal(sameAddress(undefined, a), false);
    assert.equal(sameAddress("", ""), false);
    assert.equal(checksum(a.toLowerCase()), checksum(a.toUpperCase().replace("0X", "0x")));
    assert.notEqual(checksum(a.toLowerCase()), a.toLowerCase(), "checksummed form is mixed case");
    assert.throws(() => checksum("0x1234"));
    assert.equal(MAX_U128, 2n ** 128n - 1n);
  });

  it("fail throws an ApiFailure with status and code", () => {
    try {
      fail(409, "busy", "Already running.");
      assert.fail("did not throw");
    } catch (e) {
      assert.ok(e instanceof ApiFailure);
      assert.equal(e.status, 409);
      assert.equal(e.code, "busy");
      assert.equal(e.message, "Already running.");
    }
  });

  it("json writes bigints as strings; parseJson falls back on bad or empty input", () => {
    assert.equal(json({ a: 10n ** 30n, b: [1n] }), '{"a":"1000000000000000000000000000000","b":["1"]}');
    assert.deepEqual(parseJson('{"x":1}', {}), { x: 1 });
    assert.deepEqual(parseJson("{nope", { d: true }), { d: true });
    assert.deepEqual(parseJson(null, []), []);
    assert.deepEqual(parseJson(undefined, 7), 7);
    assert.deepEqual(parseJson("", "f"), "f");
  });

  it("dayKey is the UTC date; now is unix seconds", async () => {
    assert.equal(dayKey(0), "1970-01-01");
    assert.equal(dayKey(86_399), "1970-01-01");
    assert.equal(dayKey(86_400), "1970-01-02");
    const t = now();
    assert.ok(Math.abs(t - Date.now() / 1000) < 2);
    const s = Date.now();
    await sleep(20);
    assert.ok(Date.now() - s >= 15);
  });
});
