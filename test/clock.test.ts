import { describe, it, expect, afterEach } from "vitest";
import {
  FixedClock,
  SystemClock,
  setClock,
  getClock,
  clockFromEnv,
} from "../src/clock.js";

describe("clock", () => {
  afterEach(() => {
    setClock(new SystemClock());
  });

  it("FixedClock returns a copy of the fixed instant", () => {
    const d = new Date("2024-06-15T12:00:00.000Z");
    const c = new FixedClock(d);
    const n = c.now();
    expect(n.toISOString()).toBe(d.toISOString());
    n.setFullYear(1999);
    expect(c.now().toISOString()).toBe(d.toISOString());
  });

  it("setClock/getClock use the injected clock", () => {
    setClock(new FixedClock(new Date("2024-01-01T00:00:00.000Z")));
    expect(getClock().now().toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });

  it("clockFromEnv uses CLOCK_OVERRIDE when set", () => {
    const prev = process.env.CLOCK_OVERRIDE;
    process.env.CLOCK_OVERRIDE = "2024-03-10T08:30:00.000Z";
    const c = clockFromEnv();
    expect(c.now().toISOString()).toBe("2024-03-10T08:30:00.000Z");
    if (prev === undefined) delete process.env.CLOCK_OVERRIDE;
    else process.env.CLOCK_OVERRIDE = prev;
  });
});
