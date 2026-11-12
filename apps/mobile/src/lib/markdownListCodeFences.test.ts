import { describe, expect, it } from "vite-plus/test";
import { markdownForNativeRendering } from "./markdownDocument";
import { ENRICHED_INLINE_FILE_LINK_REGEX } from "./enrichedLinkPresentation";

const render = (markdown: string) =>
  markdownForNativeRendering(markdown, ENRICHED_INLINE_FILE_LINK_REGEX);

const fence = "```\ncd /some/path\nrm -rf a \\\n  b\n```";
const steps = `1. Run this:\n\n${fence.replace(/^/gm, "   ")}\n\n2. Next step.`;

describe("code fences inside list items", () => {
  it("moves a fence in a numbered step to the top level", () => {
    expect(render(steps)).toBe(`1. Run this:\n\n${fence}\n\n2. Next step.`);
  });

  it("moves a fence out of a bullet item", () => {
    expect(render("- Install:\n  ```sh\n  npm i\n  ```\n- Done")).toBe(
      "- Install:\n\n```sh\nnpm i\n```\n\n- Done",
    );
  });

  it("keeps the number each later item rendered with", () => {
    expect(render("1. First\n   ```\n   a\n   ```\n1. Second\n1. Third")).toBe(
      "1. First\n\n```\na\n```\n\n2. Second\n1. Third",
    );
    expect(
      render("4. First\n   ```\n   a\n   ```\n5. Second\n   ```\n   b\n   ```\n6. Third"),
    ).toBe("4. First\n\n```\na\n```\n\n5. Second\n\n```\nb\n```\n\n6. Third");
    expect(render("- Parent\n  1. Run\n     ```sh\n     x\n     ```\n  1. Continue\n- Done")).toBe(
      "- Parent\n  1. Run\n\n```sh\nx\n```\n\n2. Continue\n- Done",
    );
  });

  it("keeps the tab columns of code after a fence", () => {
    expect(render("1. Run\n   ```python\n   if True:\n\t\tprint(1)\n   ```\n2. Next")).toBe(
      "1. Run\n\n```python\nif True:\n \tprint(1)\n```\n\n2. Next",
    );
  });

  it("keeps a closing-looking line indented four columns past the fence as code", () => {
    expect(render("1. Run\n   ```md\n   text\n       ```\n2. Next")).toBe(
      "1. Run\n\n```md\ntext\n    ```\n```\n\n2. Next",
    );
  });

  it("keeps text after the fence as text rather than indented code", () => {
    expect(
      render("1. Run:\n   ```\n   make\n   ```\n   Then check the output.\n\n       code\n2. Next"),
    ).toBe("1. Run:\n\n```\nmake\n```\n\nThen check the output.\n\n    code\n\n2. Next");
  });

  it("moves every fence in an item and in each list", () => {
    expect(
      render(
        "1. a\n   ```\n   x\n   ```\n   b\n   ```\n   y\n   ```\n2. c\n\nMore\n\n- p\n  ~~~\n  z\n  ~~~",
      ),
    ).toBe("1. a\n\n```\nx\n```\n\nb\n\n```\ny\n```\n\n2. c\n\nMore\n\n- p\n\n~~~\nz\n~~~");
  });

  it("moves a fence out of a nested item and keeps the rest of the list readable", () => {
    expect(
      render("- Setup\n  - Run:\n    ```\n    x\n    ```\n    Then this.\n  - Other\n- Next"),
    ).toBe("- Setup\n  - Run:\n\n```\nx\n```\n\nThen this.\n- Other\n- Next");
  });

  it("moves a fence that opens on the marker line", () => {
    expect(render("1. ```bash\n   x\n   ```\n2. y")).toBe("1.\n\n```bash\nx\n```\n\n2. y");
  });

  it("handles CRLF and CR line endings", () => {
    const expected = `1. Run this:\n\n${fence}\n\n2. Next step.`;
    expect(render(steps.replaceAll("\n", "\r\n"))).toBe(expected.replaceAll("\n", "\r\n"));
    expect(render(steps.replaceAll("\n", "\r"))).toBe(expected.replaceAll("\n", "\r"));
  });

  it("moves an unclosed streaming fence and keeps its text", () => {
    expect(render("1. Run:\n   ```sh\n   npm i\n   npm t")).toBe("1. Run:\n\n```sh\nnpm i\nnpm t");
    expect(render("1. Run:\n   ```sh\n   npm i\n")).toBe("1. Run:\n\n```sh\nnpm i\n");
  });

  it("closes a fence that its list item ended, so it does not swallow later items", () => {
    expect(render("1. Run:\n   ```sh\n   npm i\n2. Next")).toBe(
      "1. Run:\n\n```sh\nnpm i\n```\n\n2. Next",
    );
  });

  it("leaves fences outside list items unchanged", () => {
    for (const markdown of [
      fence,
      `Intro\n\n  ${fence.replaceAll("\n", "\n  ")}`,
      `- item\n\n${fence}`,
      `> - quoted\n>   ${fence.replaceAll("\n", "\n>   ")}`,
      "- item\n\n      indented code\n      ```",
      "- item `inline` and ```spans```",
    ]) {
      expect(render(markdown)).toBe(markdown);
    }
  });
});
