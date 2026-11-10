import {
  EnvironmentId,
  ThreadId,
  type PreviewEvent,
  type PreviewListResult,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { createElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";

// Only the transport is substituted. The hook, atom registry and preview
// store run unchanged, including idle-TTL node removal.
type ListResult = AsyncResult.AsyncResult<PreviewListResult, never>;
type EventResult = AsyncResult.AsyncResult<PreviewEvent, never>;
const harness = vi.hoisted(() => ({
  lists: new Map<string, { requests: number; atom: Atom.Writable<ListResult> }>(),
  events: new Map<string, Atom.Writable<EventResult>>(),
}));

vi.mock("~/env", () => ({ isElectron: true }));

vi.mock("~/state/preview", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    previewEnvironment: {
      list: (target: { environmentId: string; input: { threadId?: string } }) => {
        const key = target.input.threadId ?? `all:${target.environmentId}`;
        let entry = harness.lists.get(key);
        if (!entry) {
          let current: ListResult = AsyncResult.initial();
          const created = {
            requests: 0,
            atom: Atom.writable(
              () => {
                created.requests += 1;
                return AsyncResult.waiting(current);
              },
              (ctx, value: ListResult) => {
                current = value;
                ctx.setSelf(value);
              },
            ),
          };
          entry = created;
          harness.lists.set(key, entry);
        }
        return entry.atom;
      },
      events: (target: { environmentId: string }) => {
        let atom = harness.events.get(target.environmentId);
        if (!atom) {
          atom = Atom.make<EventResult>(AsyncResult.initial());
          harness.events.set(target.environmentId, atom);
        }
        return atom;
      },
    },
  };
});

import { readThreadPreviewState, resetPreviewStateForTests } from "~/previewStateStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";
import { useDesktopHostedPreviewSessions } from "./usePreviewSession";

describe("desktop-hosted preview session sync", () => {
  it("discovers threads that already have tabs before any preview event", async () => {
    resetPreviewStateForTests();
    const environmentId = EnvironmentId.make("preview-sync-baseline");
    const openThreadId = ThreadId.make("thread-baseline-open");
    const closedThreadId = ThreadId.make("thread-baseline-closed");
    previewEnvironment.events({ environmentId, input: {} });
    for (const input of [{}, { threadId: openThreadId }, { threadId: closedThreadId }]) {
      previewEnvironment.list({ environmentId, input });
    }
    const list = (key: string) => harness.lists.get(key)!;
    const isMounted = (key: string) => appAtomRegistry.getNodes().has(list(key).atom);
    const snapshot = (threadId: ThreadId, tabId: string): PreviewSessionSnapshot => ({
      threadId,
      tabId,
      navStatus: { _tag: "Idle" },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-10-02T00:00:00.000Z",
    });
    const answer = (key: string, revision: number, sessions: PreviewSessionSnapshot[]) =>
      act(async () => {
        appAtomRegistry.set(
          list(key).atom,
          AsyncResult.success({ serverEpoch: "epoch-1", revision, sessions }),
        );
      });

    function DesktopSessionSync() {
      useDesktopHostedPreviewSessions(environmentId);
      return null;
    }
    // The hook renders nothing and never reads or changes the route.
    await using screen = await render(
      createElement(AppAtomRegistryProvider, null, createElement(DesktopSessionSync)),
      { router: false },
    );
    using _timers = fakeTimers();

    // A reloaded renderer gets no event for tabs that already exist.
    await answer(`all:${environmentId}`, 2, [
      snapshot(openThreadId, "kept"),
      snapshot(closedThreadId, "gone"),
    ]);
    expect(list(openThreadId).requests).toBe(1);
    expect(list(closedThreadId).requests).toBe(1);

    await answer(openThreadId, 2, [snapshot(openThreadId, "kept")]);
    // This tab closed between the environment list and the thread list.
    await answer(closedThreadId, 3, []);
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(
      Object.keys(readThreadPreviewState({ environmentId, threadId: openThreadId }).sessions),
    ).toEqual(["kept"]);
    expect(isMounted(openThreadId)).toBe(true);
    expect(isMounted(closedThreadId)).toBe(false);

    // Removing the host releases discovered threads under fake time, so no idle sweep outlives the test.
    await screen.unmount();
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(isMounted(openThreadId)).toBe(false);
    resetPreviewStateForTests();
  });

  it("stops syncing a thread once its last tab closes and resumes when a tab opens again", async () => {
    resetPreviewStateForTests();
    const ref = {
      environmentId: EnvironmentId.make("preview-sync-release"),
      threadId: ThreadId.make("thread-sync-release"),
    };
    previewEnvironment.events({ environmentId: ref.environmentId, input: {} });
    previewEnvironment.list({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId },
    });
    const events = harness.events.get(ref.environmentId)!;
    const listAtom = harness.lists.get(ref.threadId)!.atom;
    const listRequests = () => harness.lists.get(ref.threadId)!.requests;
    const isListMounted = () => appAtomRegistry.getNodes().has(listAtom);
    const snapshot = (tabId: string): PreviewSessionSnapshot => ({
      threadId: ref.threadId,
      tabId,
      navStatus: { _tag: "Idle" },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-10-02T00:00:00.000Z",
    });
    let revision = 0;
    const emit = (type: "opened" | "closed", tabId: string) =>
      act(async () => {
        revision += 1;
        const base = {
          threadId: ref.threadId,
          tabId,
          serverEpoch: "epoch-1",
          revision,
          createdAt: "2026-10-02T00:00:00.000Z",
        };
        appAtomRegistry.set(
          events,
          AsyncResult.success(
            type === "opened" ? { ...base, type, snapshot: snapshot(tabId) } : { ...base, type },
          ),
        );
      });

    function DesktopSessionSync() {
      useDesktopHostedPreviewSessions(ref.environmentId);
      return null;
    }
    // The hook renders nothing and never reads or changes the route.
    await using _screen = await render(
      createElement(AppAtomRegistryProvider, null, createElement(DesktopSessionSync)),
      { router: false },
    );
    using _timers = fakeTimers();

    await emit("opened", "first");
    await emit("opened", "second");
    appAtomRegistry.set(
      listAtom,
      AsyncResult.success({
        serverEpoch: "epoch-1",
        revision,
        sessions: [snapshot("first"), snapshot("second")],
      }),
    );
    expect(listRequests()).toBe(1);

    // One tab is still open, so the thread keeps syncing.
    await emit("closed", "first");
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(isListMounted()).toBe(true);

    await emit("closed", "second");
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(readThreadPreviewState(ref).sessions).toEqual({});
    expect(isListMounted()).toBe(false);

    await emit("opened", "third");
    expect(listRequests()).toBe(2);
    expect(Object.keys(readThreadPreviewState(ref).sessions)).toEqual(["third"]);
    await emit("closed", "third");
    expect(readThreadPreviewState(ref).sessions).toEqual({});
    resetPreviewStateForTests();
  });
});
