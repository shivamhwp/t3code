/// <reference lib="dom" />
// The DOM lib types the mouse-event fallback this scenario runs in the page.
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Fast clicks across sidebar projects open the last clicked thread",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const threads = [];
    for (const name of ["First", "Second", "Third"]) {
      const project = await t3.project(`${name.toLowerCase()}-project`);
      threads.push(await t3.thread({ project, title: `${name} thread`, messages: ["hello"] }));
    }
    const [first, second, third] = threads;
    if (!first || !second || !third) throw new Error("The three fixture threads were not created");
    await t3.open(first);

    const targets = [second, first, third];
    for (const title of ["First thread", "Second thread", "Third thread"]) {
      await screen.getByRole("button", new RegExp(`^${title},`)).focus();
    }

    // e2e's mouse wrapper drops clickCount and its config import has no active live page.
    // Fall back to DOM mouse events to reproduce macOS click counts across different rows.
    await browser.evaluate(
      (threadIds) => {
        for (const [index, threadId] of threadIds.entries()) {
          const detail = index + 1;
          const row = document.querySelector(`[data-sidebar-row$=":${threadId}"][role="button"]`);
          if (!row) throw new Error(`Sidebar row not found: ${threadId}`);
          const bounds = row.getBoundingClientRect();
          const clientX = bounds.x + bounds.width / 2;
          const clientY = bounds.y + bounds.height / 2;
          const target = document.elementFromPoint(clientX, clientY);
          if (!target || target.closest("[data-sidebar-row]") !== row) {
            throw new Error(`Sidebar row center is not hittable: ${threadId}`);
          }
          const mouse = { bubbles: true, cancelable: true, clientX, clientY, button: 0, detail };
          const pointer = { ...mouse, pointerId: 1, pointerType: "mouse", isPrimary: true };
          target.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
          target.dispatchEvent(new MouseEvent("mousedown", { ...mouse, buttons: 1 }));
          target.dispatchEvent(new PointerEvent("pointerup", pointer));
          target.dispatchEvent(new MouseEvent("mouseup", mouse));
          target.dispatchEvent(new PointerEvent("click", pointer));
        }
        return null;
      },
      targets.map((thread) => thread.threadId),
    );

    await app.screenshot("after-clicks");
    await expect(browser).toHaveURL(new RegExp(`/${encodeURIComponent(third.threadId)}$`));
  },
);
