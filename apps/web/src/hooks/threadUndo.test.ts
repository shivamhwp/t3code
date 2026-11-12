import { describe, expect, it } from "vite-plus/test";

import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";

describe("thread action ownership", () => {
  it("does not revive the first Undo after a later pin and unpin", () => {
    const firstUnpin = ThreadUndo.begin("pin", "env/thread");
    ThreadUndo.invalidate("pin", "env/thread");
    const secondUnpin = ThreadUndo.begin("pin", "env/thread");
    expect(firstUnpin.isCurrent()).toBe(false);
    expect(secondUnpin.isCurrent()).toBe(true);
    firstUnpin.finish();
    expect(secondUnpin.isCurrent()).toBe(true);
    secondUnpin.finish();
    expect(firstUnpin.isCurrent()).toBe(false);
  });

  it("expires an Undo without invalidating another environment or thread", () => {
    const first = ThreadUndo.begin("pin", "one/thread");
    const otherEnvironment = ThreadUndo.begin("pin", "two/thread");
    const otherThread = ThreadUndo.begin("pin", "one/other");
    first.finish();
    expect(first.isCurrent()).toBe(false);
    expect(otherEnvironment.isCurrent()).toBe(true);
    expect(otherThread.isCurrent()).toBe(true);
    otherEnvironment.finish();
    otherThread.finish();
  });
});

describe("settle Undo plan", () => {
  it.each([
    ["an anchored row", "2026-09-01T00:00:00.000Z", null],
    ["a manually ordered row", null, "a1"],
  ] as const)("restores %s to its place before the settle", (_, unsettledAt, activeOrderKey) => {
    expect(ThreadUndo.planThreadUndo("settle", { unsettledAt, activeOrderKey })).toEqual([
      { action: "unsettle", restore: { unsettledAt, activeOrderKey } },
    ]);
  });
});
