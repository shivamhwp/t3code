import type { Code, ListItem, Root, RootContent } from "mdast";
import { unified, type Processor } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkKeepWindowsProsePaths } from "@t3tools/shared/markdownWindowsPaths";
import { absoluteFilePathMatches, parseMarkdownFileLink } from "@t3tools/shared/markdownLinks";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkKeepWindowsProsePaths);
export type MarkdownNode = Root | RootContent;

interface MarkdownEdit {
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

function applyMarkdownEdits(markdown: string, edits: MarkdownEdit[]): string {
  if (edits.length === 0) return markdown;
  const parts: string[] = [];
  let offset = 0;
  // AST traversal emits disjoint edits in source order.
  for (const edit of edits) {
    parts.push(markdown.slice(offset, edit.start), edit.content);
    offset = edit.end;
  }
  parts.push(markdown.slice(offset));
  return parts.join("");
}

function decodeCodePoint(codePoint: number, entity: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}

export function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal) {
        return decodeCodePoint(Number.parseInt(decimal, 10), entity);
      }
      if (hexadecimal) {
        return decodeCodePoint(Number.parseInt(hexadecimal, 16), entity);
      }
      switch (entity.toLowerCase()) {
        case "&amp;":
          return "&";
        case "&apos;":
          return "'";
        case "&gt;":
          return ">";
        case "&lt;":
          return "<";
        case "&nbsp;":
          return "\u00a0";
        case "&quot;":
          return '"';
        default:
          return entity;
      }
    },
  );
}

const HTML_TAG = /<!--[\s\S]*?-->|<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi;

function attribute(tag: string, name: string): string | null {
  const attributes = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(attributes)) {
    if (match[1]?.toLowerCase() === name) {
      return decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
    }
  }
  return null;
}

function markdownDestination(url: string): string {
  return `<${url.replace(/&/g, "\\&").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\|/g, "%7C").replace(/\n/g, "")}>`;
}

const ANCHOR_TAG = /^<\/?a[\s/>]/i;

/** Replacements for the anchor tags still ahead, and how many emitted links are open. */
type AnchorState = { readonly pending: string[]; open: number };

// Code spans keep their text; an odd trailing backslash would escape the closing "]".
function escapeLinkLabel(text: string): string {
  return text
    .replace(/(`+)[\s\S]*?\1|\\*[[\]]/g, (match) =>
      match.startsWith("`") || match.length % 2 === 0
        ? match
        : `${match.slice(0, -1)}\\${match.slice(-1)}`,
    )
    .replace(/\\+$/, (slashes) => (slashes.length % 2 ? `${slashes}\\` : slashes));
}

// An unescaped "!" before the inserted "[" would turn the link into an image.
function bangBefore(text: string, index: number): boolean {
  if (text[index - 1] !== "!") return false;
  let backslashes = 0;
  while (text[index - 2 - backslashes] === "\\") backslashes += 1;
  return backslashes % 2 === 0;
}

/**
 * Pairs `<a>` tags in order. Only a closed anchor with an http(s) or mailto href becomes a
 * Markdown link; any other anchor keeps its text unlinked.
 */
function anchorMarkdown(tags: readonly string[]): AnchorState {
  const replacements = tags.map(() => "");
  const open: Array<{ index: number; href: string | undefined }> = [];
  tags.forEach((tag, index) => {
    if (tag[1] !== "/") {
      const href = attribute(tag, "href")?.trim();
      open.push({ index, href: href && /^(?:https?|mailto):/i.test(href) ? href : undefined });
      return;
    }
    const opening = open.pop();
    if (!opening?.href) return;
    replacements[opening.index] = "[";
    replacements[index] = `](${markdownDestination(opening.href)})`;
  });
  return { pending: replacements, open: 0 };
}

export function markdownHtmlTags(content: string): RegExpExecArray[] {
  // An HTML block such as <details> can also contain Markdown fences and code spans.
  const codeRanges: Array<{ start: number; end: number }> = [];
  const tags = [...content.matchAll(HTML_TAG)];
  let tagIndex = 0;
  const delimiters = [...content.matchAll(/`+|~{3,}/g)].filter((delimiter) => {
    while (tags[tagIndex] && tags[tagIndex]!.index + tags[tagIndex]![0].length <= delimiter.index)
      tagIndex += 1;
    const tag = tags[tagIndex];
    return !tag || delimiter.index < tag.index;
  });
  for (let index = 0; index < delimiters.length; index += 1) {
    const opening = delimiters[index]!;
    const lineStart = content.lastIndexOf("\n", opening.index - 1) + 1;
    const fenced =
      opening[0].length >= 3 && /^ {0,3}$/.test(content.slice(lineStart, opening.index));
    if (opening[0][0] === "~" && !fenced) continue;
    let closingIndex = -1;
    for (let candidate = index + 1; candidate < delimiters.length; candidate += 1) {
      const closing = delimiters[candidate]!;
      if (!fenced && closing[0] === opening[0]) {
        closingIndex = candidate;
        break;
      }
      if (!fenced || closing[0][0] !== opening[0][0] || closing[0].length < opening[0].length)
        continue;
      const start = content.lastIndexOf("\n", closing.index - 1) + 1;
      const nextLine = content.indexOf("\n", closing.index);
      const end = nextLine === -1 ? content.length : nextLine;
      if (
        /^ {0,3}$/.test(content.slice(start, closing.index)) &&
        /^\s*$/.test(content.slice(closing.index + closing[0].length, end))
      ) {
        closingIndex = candidate;
        break;
      }
    }
    if (closingIndex === -1) {
      if (!fenced) continue;
      // An unclosed fence runs to the end of the content, so no later opener matters.
      codeRanges.push({ start: opening.index, end: content.length });
      break;
    }
    const closing = delimiters[closingIndex]!;
    codeRanges.push({ start: opening.index, end: closing.index + closing[0].length });
    index = closingIndex;
  }
  return tags.filter(
    (tag) => !codeRanges.some((range) => tag.index >= range.start && tag.index < range.end),
  );
}

/**
 * Called only for parsed HTML nodes, so Markdown code examples keep their literal tags.
 * `anchors` is shared across sibling inline HTML nodes because each of those carries a single tag.
 */
export function markdownHtmlContent(
  content: string,
  options: { readonly anchors?: AnchorState; readonly inTableCell?: boolean } = {},
): string {
  const tags = markdownHtmlTags(content);
  const anchors =
    options.anchors ??
    anchorMarkdown(tags.map((tag) => tag[0]).filter((tag) => ANCHOR_TAG.test(tag)));
  let result = "";
  let end = 0;
  for (const match of tags) {
    const text = content.slice(end, match.index);
    result += anchors.open > 0 ? escapeLinkLabel(text) : text;
    const replacement = htmlTagMarkdown(match[0], anchors, options);
    if (replacement === "[" && bangBefore(result, result.length))
      result = `${result.slice(0, -1)}\\!`;
    result +=
      anchors.open > 0 && /[\s[]/.test(result.at(-1) ?? "")
        ? replacement.replace(/^ /, "")
        : replacement;
    end = match.index + match[0].length;
  }
  const text = content.slice(end);
  return result + (anchors.open > 0 ? escapeLinkLabel(text) : text);
}

function htmlTagMarkdown(
  tag: string,
  anchors: AnchorState,
  options: { readonly inTableCell?: boolean },
): string {
  if (tag.startsWith("<!--")) return "";
  if (ANCHOR_TAG.test(tag)) {
    const replacement = anchors.pending.shift() ?? "";
    if (replacement === "[") anchors.open += 1;
    else if (replacement) anchors.open -= 1;
    return replacement;
  }
  if (/^<img\b/i.test(tag)) {
    const src = attribute(tag, "src");
    if (!src) return "";
    const alt = (attribute(tag, "alt") ?? "").replace(/[\\[\]&]/g, "\\$&");
    return `![${alt}](${markdownDestination(src)})`;
  }
  // A blank line inside an open link label would end the paragraph before its "]".
  const blockBreak = anchors.open === 0 ? "\n\n" : " ";
  if (/^<summary\b/i.test(tag)) return `${blockBreak}**`;
  if (/^<\/summary\s*>/i.test(tag)) return `**${blockBreak}`;
  // A raw newline would end the table row; both parsers decode this reference to one inside the cell.
  if (/^<br\b/i.test(tag)) return options.inTableCell ? "&#10;" : "  \n";
  if (/^<\/?(?:p|div|details)\b/i.test(tag)) return blockBreak;
  return "";
}

export function markdownWithHtml(markdown: string): string {
  if (!/<(?:!--|\/?[a-z])/i.test(markdown)) return markdown;
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const visit = (node: MarkdownNode, inTableCell: boolean, inLink: boolean) => {
    if (!("children" in node)) return;
    inTableCell ||= node.type === "tableCell";
    const children: readonly MarkdownNode[] = node.children;
    // Inline HTML arrives one tag per node, so anchors pair across phrasing siblings.
    const anchors =
      node.type === "root" || node.type === "blockquote" || node.type === "listItem"
        ? undefined
        : anchorMarkdown(
            children.flatMap((child) =>
              child.type === "html"
                ? markdownHtmlTags(child.value)
                    .map((tag) => tag[0])
                    .filter((tag) => ANCHOR_TAG.test(tag))
                : [],
            ),
          );
    for (const child of children) {
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      const linkLabel = inLink || (anchors?.open ?? 0) > 0;
      if (child.type === "text") {
        if (linkLabel && start !== undefined && end !== undefined) {
          const content = escapeLinkLabel(markdown.slice(start, end));
          if (content !== markdown.slice(start, end)) edits.push({ start, end, content });
        }
        continue;
      }
      if (child.type !== "html") {
        visit(child, inTableCell, linkLabel);
        continue;
      }
      const content = markdownHtmlContent(child.value, { anchors, inTableCell });
      if (start === undefined || end === undefined) continue;
      // Text before an outermost link is never edited, so this edit cannot overlap another.
      if (content.startsWith("[") && !linkLabel && bangBefore(markdown, start))
        edits.push({ start: start - 1, end: start, content: "\\!" });
      edits.push({ start, end, content });
    }
  };
  visit(parser.parse(markdown), false, false);
  return applyMarkdownEdits(markdown, edits);
}

// Start only at the beginning of a backtick run to avoid retrying every suffix.
const INLINE_CODE_SPAN = /(?<!`)`+([^`\r\n]+)`+/g;

export function markdownWithInlineFileLinks(markdown: string, fileLink: RegExp): string {
  return transformNativeMarkdown(markdown, fileLink, false);
}

function transformNativeMarkdown(
  markdown: string,
  fileLink: RegExp | undefined,
  tableBreaks: boolean,
): string {
  const breakTables = tableBreaks && mayHaveTableUnderText(markdown);
  let linkFiles = false;
  if (fileLink) {
    for (const [, code] of markdown.matchAll(INLINE_CODE_SPAN)) {
      if (fileLink.test(code!.trim())) {
        linkFiles = true;
        break;
      }
    }
  }
  const linkProseFiles = fileLink !== undefined && absoluteFilePathMatches(markdown).length > 0;
  if (!linkFiles && !linkProseFiles && !breakTables) return markdown;
  const edits: MarkdownEdit[] = [];
  const fileEdits: MarkdownEdit[] = [];
  let rewritesPipe = false;
  const visit = (node: MarkdownNode) => {
    if (linkFiles && node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const escaped = node.value.replace(/[\\[\]&]/g, "\\$&");
      if (
        start !== undefined &&
        end !== undefined &&
        fileLink?.test(node.value) &&
        parseMarkdownFileLink(node.value) !== null &&
        !/[<>]/.test(node.value)
      ) {
        const edit = {
          start,
          end,
          content: `[${escaped}](<${escaped}>)`,
        };
        edits.push(edit);
        fileEdits.push(edit);
        if (node.value.includes("|")) rewritesPipe = true;
      }
    } else if (
      linkProseFiles &&
      node.type === "text" &&
      node.position?.start.offset !== undefined
    ) {
      const start = node.position.start.offset;
      const raw = markdown.slice(start, node.position.end.offset);
      for (const { index, path } of absoluteFilePathMatches(raw)) {
        // Source offsets stay valid for paths whose own text needs no Markdown decoding.
        if (raw !== node.value && /[\\&]/.test(path)) continue;
        const escaped = path.replace(/[\\[\]&]/g, "\\$&");
        const edit = {
          start: start + index,
          end: start + index + path.length,
          content: `[${escaped}](<${escaped}>)`,
        };
        edits.push(edit);
        fileEdits.push(edit);
      }
    } else if (node.type !== "link" && node.type !== "linkReference" && "children" in node)
      node.children.forEach((child, index) => {
        const previous = node.children[index - 1];
        const start = child.position?.start;
        if (
          breakTables &&
          child.type === "table" &&
          previous?.type === "paragraph" &&
          start?.offset !== undefined &&
          previous.position?.end.line === start.line - 1
        ) {
          let lineStart = start.offset;
          while (lineStart > 0 && !/[\r\n]/.test(markdown[lineStart - 1]!)) lineStart -= 1;
          // Replace only the container prefix, leaving cell edits disjoint from the table break.
          const [, header = "", , ending = "\n", markers = ""] =
            /^([ \t>]*)([^\r\n]*)(\r\n|\r|\n)([ \t>]*)/.exec(markdown.slice(lineStart)) ?? [];
          edits.push({
            start: lineStart,
            end: lineStart + header.length,
            content: `${markers.trimEnd()}${ending}${markers}`,
          });
        }
        visit(child);
      });
  };
  visit(parser.parse(markdown));
  // Rewritten pipes can change table structure, so preserve the original pass ordering.
  if (breakTables && rewritesPipe)
    return markdownWithTableBreaks(applyMarkdownEdits(markdown, fileEdits));
  return applyMarkdownEdits(markdown, edits);
}

// A delimiter row such as `|---|:--:|`, possibly inside a blockquote or list item.
function isTableDelimiterRow(line: string): boolean {
  if (!line.includes("-")) return false;
  const row = line.replace(/^[ \t>]+/, "").trim();
  return row
    .replace(/^\||\|$/g, "")
    .split("|")
    .every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function mayHaveTableUnderText(markdown: string): boolean {
  if (!markdown.includes("|")) return false;
  const lines = markdown.split(/\r\n|\r|\n/);
  for (let index = 2; index < lines.length; index += 1) {
    if (isTableDelimiterRow(lines[index]!) && /[^\s>]/.test(lines[index - 2]!)) return true;
  }
  return false;
}

/** md4c starts tables only at paragraph starts; insert breaks to match GFM. */
export function markdownWithTableBreaks(markdown: string): string {
  return transformNativeMarkdown(markdown, undefined, true);
}

// `>` covers a destination continued on a blockquote line.
const WINDOWS_DESTINATION = /\](?:\(|:)[\s>]*<?(?:[A-Za-z]:[\\/]|\\\\)/;

interface DestinationToken {
  readonly start: { readonly offset: number };
  readonly end: { readonly offset: number };
}

/**
 * Markdown reads `C:\work\.t3` as `C:\work.t3`. Web keeps authored Windows destinations
 * literally (see `remarkKeepWindowsPaths` in shared), so escape their backslashes to give
 * both parsers here the same path. `\&` stays an escape, as `markdownWithHtml` emits it.
 * Expects authored Markdown: already escaped output would be escaped twice.
 */
function markdownWithWindowsPathDestinations(markdown: string): string {
  // Skips the extra parse for the common message that has no Windows destination.
  if (!WINDOWS_DESTINATION.test(markdown)) return markdown;
  const edits: MarkdownEdit[] = [];
  function record(
    this: { resume(): string; sliceSerialize(token: DestinationToken): string },
    token: DestinationToken,
  ) {
    this.resume();
    const authored = this.sliceSerialize(token);
    if (!isWindowsAbsolutePath(authored) || !authored.includes("\\") || /[<>]/.test(authored))
      return;
    const start = token.start.offset;
    const end = token.end.offset;
    const escaped = authored.replace(/\\(?!&)/g, "\\\\");
    // A bare destination ends at an unescaped `)`, so wrap it to keep `\)` inside.
    const angled = markdown[start - 1] === "<";
    edits.push({ start, end, content: angled ? escaped : `<${escaped}>` });
  }
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(function (this: Processor) {
      (this.data().fromMarkdownExtensions ??= []).push({
        exit: { resourceDestinationString: record, definitionDestinationString: record },
      });
    })
    .parse(markdown);
  return applyMarkdownEdits(markdown, edits);
}

// A fence line with an indent or list marker before it, so possibly inside a list item.
const MAYBE_LIST_FENCE = /^(?=[ \t]|[-*+\d])[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*(?:`{3}|~{3})/m;

interface SourceLine {
  readonly start: number;
  readonly text: string;
}

function sourceLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (const ending of markdown.matchAll(/\r\n|\r|\n/g)) {
    lines.push({ start, text: markdown.slice(start, ending.index) });
    start = ending.index + ending[0].length;
  }
  lines.push({ start, text: markdown.slice(start) });
  return lines;
}

function dedent(text: string, width: number): string {
  return text.replace(new RegExp(`^[ \\t]{0,${width}}`), "");
}

/**
 * The native renderer gives only top-level fences a header with copy and wrap buttons
 * (software-mansion/enriched-markdown#925), so move fences out of list items. Text after a
 * fence loses its item indent so it cannot become indented code, and the list that resumes
 * after the item keeps its numbering.
 */
export function markdownWithListFencesAtTopLevel(markdown: string): string {
  if (!MAYBE_LIST_FENCE.test(markdown)) return markdown;
  const lines = sourceLines(markdown);
  const eol = /\r\n|\r|\n/.exec(markdown)?.[0] ?? "\n";
  const line = (point: { readonly line: number }) => point.line - 1;
  // A block that its container closed ends at column 1 of the following line.
  const lastLineOf = ({ position }: ListItem | Code) =>
    position!.end.column === 1 && position!.end.line > position!.start.line
      ? position!.end.line - 2
      : line(position!.end);
  const fromStart = ({ position }: ListItem | Code) =>
    lines[line(position!.start)]!.text.slice(position!.start.column - 1);
  const contentIndent = (item: ListItem) => {
    const [, marker = "", spaces = "", rest = ""] =
      /^([-*+]|\d{1,9}[.)])([ \t]*)(.*)/.exec(fromStart(item)) ?? [];
    const width = rest === "" || spaces.length > 4 ? 1 : spaces.length;
    return item.position!.start.column - 1 + marker.length + width;
  };
  const fencesIn = (
    item: ListItem,
    chain: readonly ListItem[],
  ): Array<{ code: Code; chain: readonly ListItem[] }> =>
    item.children.flatMap((child) => {
      if (child.type === "list")
        return child.children.flatMap((nested) => fencesIn(nested, [...chain, nested]));
      if (child.type !== "code") return [];
      return /^[ \t]{0,3}(?:`{3}|~{3})/.test(fromStart(child)) ? [{ code: child, chain }] : [];
    });
  const edits: MarkdownEdit[] = [];
  for (const list of parser.parse(markdown).children) {
    if (list.type !== "list") continue;
    list.children.forEach((item, itemIndex) => {
      const fences = fencesIn(item, [item]);
      if (fences.length === 0) return;
      const firstLine = line(fences[0]!.code.position!.start);
      const following = list.children[itemIndex + 1];
      const lastLine = Math.min(
        lastLineOf(item),
        following ? line(following.position!.start) - 1 : Infinity,
      );
      const emitted: string[] = [];
      const separate = () => {
        if (emitted.length > 0 && emitted.at(-1)!.trim() !== "") emitted.push("");
      };
      let chain: readonly ListItem[] = [];
      let indents: number[] = [];
      const dedentAfterFence = (index: number, text: string) => {
        let depth = chain.length - 1;
        while (depth > 0 && lastLineOf(chain[depth]!) < index) depth -= 1;
        return dedent(text, indents[depth]!);
      };
      let keptPrefix = "";
      let afterFence = false;
      let next = 0;
      for (let index = firstLine; index <= lastLine;) {
        const source = lines[index]!;
        const fence = fences[next];
        if (fence && index === line(fence.code.position!.start)) {
          const column = fence.code.position!.start.offset! - source.start;
          const prefix = source.text.slice(0, column).trimEnd();
          if (next === 0) {
            keptPrefix = prefix.trim() ? prefix : "";
            // The previous line only decides the blank line before the fence; it is dropped below.
            emitted.push(keptPrefix || (lines[index - 1]?.text ?? ""));
          } else if (prefix.trim()) {
            separate();
            emitted.push(dedentAfterFence(index, prefix));
          }
          separate();
          const opening = source.text.slice(column).trimStart();
          const fenceColumn = source.text.length - opening.length;
          const end = lastLineOf(fence.code);
          const run = /^(`+|~+)/.exec(opening)![1]!;
          const closing = /^[ \t]*(`+|~+)[ \t]*$/.exec(lines[end]!.text)?.[1] ?? "";
          const closed = end > index && closing[0] === run[0] && closing.length >= run.length;
          emitted.push(opening);
          for (let inner = index + 1; inner <= end; inner += 1) {
            const text = lines[inner]!.text;
            emitted.push(inner === end && closed ? text.trimStart() : dedent(text, fenceColumn));
          }
          // The item's end closed this fence; at the top level it would run on past the list.
          if (!closed && lines.slice(end + 1).some(({ text }) => text.trim() !== ""))
            emitted.push(run);
          if (next === 0 && !keptPrefix) emitted.shift();
          chain = fence.chain;
          indents = chain.map(contentIndent);
          afterFence = true;
          next += 1;
          index = end + 1;
          continue;
        }
        const text = dedentAfterFence(index, source.text);
        if (afterFence && text.trim() !== "") emitted.push("");
        afterFence = false;
        emitted.push(text);
        index += 1;
      }
      // A paragraph can be interrupted by a bullet item but not by an item numbered past 1.
      if ((afterFence || list.ordered) && (lines[lastLine + 1]?.text.trim() ?? "") !== "")
        separate();
      const start = lines[firstLine]!.start + keptPrefix.length;
      const endLine = lines[lastLine]!;
      edits.push({
        start,
        end: endLine.start + endLine.text.length,
        content: emitted.join(eol).slice(keptPrefix.length),
      });
      if (!list.ordered || !following) return;
      // Native lists number items from the first marker, so the resumed list keeps its count.
      const markerStart = following.position!.start.offset!;
      const number = /^\d+/.exec(fromStart(following))![0];
      const expected = String((list.start ?? 1) + itemIndex + 1);
      if (number !== expected)
        edits.push({ start: markerStart, end: markerStart + number.length, content: expected });
    });
  }
  return applyMarkdownEdits(markdown, edits);
}

// HTML wrappers can expose Markdown that wasn't in the first AST, so normalize them first.
export function markdownForNativeParsing(markdown: string): string {
  return markdownWithWindowsPathDestinations(markdownWithHtml(markdown));
}

export function parseMarkdownDocument(markdown: string): Root {
  return parser.parse(markdownForNativeParsing(markdown));
}

export function markdownForNativeRendering(markdown: string, fileLink: RegExp): string {
  return transformNativeMarkdown(
    markdownWithListFencesAtTopLevel(markdownForNativeParsing(markdown)),
    fileLink,
    true,
  );
}

/** Native media slots only cover standalone images; nested file embeds must become links. */
export function markdownWithFileEmbeds(
  markdown: string,
  label: (href: string, standalone: boolean) => string | null,
): { markdown: string; fileHrefs: ReadonlySet<string> } {
  const fileHrefs = new Set<string>();
  if (!markdown.includes("![")) return { markdown, fileHrefs };
  const root = parser.parse(markdown);
  const topLevelBlocks = new Set<MarkdownNode>(root.children);
  const definitions = new Map<string, string>();
  const collect = (node: MarkdownNode) => {
    if (node.type === "definition") {
      const identifier = node.identifier.toUpperCase();
      if (!definitions.has(identifier)) definitions.set(identifier, node.url);
    }
    if ("children" in node) node.children.forEach(collect);
  };
  collect(root);
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const visit = (node: MarkdownNode, standalone = false, insideLink = false) => {
    if (node.type === "image" || node.type === "imageReference") {
      const href =
        node.type === "image" ? node.url : definitions.get(node.identifier.toUpperCase());
      const name = href === undefined ? null : label(href, standalone);
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (href !== undefined && name !== null && start !== undefined && end !== undefined) {
        const text = name.replace(/[\\[\]`*_~|&<>]/g, "\\$&");
        const url = href.replace(/[\\&]/g, "\\$&").replace(/</g, "%3C").replace(/>/g, "%3E");
        edits.push({ start, end, content: insideLink ? text : `[${text}](<${url}>)` });
        fileHrefs.add(href);
      }
    }
    if ("children" in node)
      node.children.forEach((child) =>
        visit(
          child,
          node.type === "paragraph" && node.children.length === 1 && topLevelBlocks.has(node),
          insideLink || node.type === "link" || node.type === "linkReference",
        ),
      );
  };
  visit(root);
  const parts: string[] = [];
  let offset = 0;
  for (const edit of edits) {
    parts.push(markdown.slice(offset, edit.start), edit.content);
    offset = edit.end;
  }
  parts.push(markdown.slice(offset));
  return { markdown: parts.join(""), fileHrefs };
}
