import { Check, Copy, TriangleAlert } from "lucide-react";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n/i18n";

type CopyStatus = "idle" | "copied" | "failed";
type ClipboardWriter = (text: string) => Promise<void>;

export async function copyText(text: string, writeText: ClipboardWriter): Promise<boolean> {
  try {
    await writeText(text);
    return true;
  } catch {
    return false;
  }
}

function MarkdownCodeBlock({ code, language }: { code: string; language: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<CopyStatus>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const copy = async (): Promise<void> => {
    const copied = await copyText(code, (value) => navigator.clipboard.writeText(value));
    setStatus(copied ? "copied" : "failed");
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setStatus("idle"), 1_500);
  };
  const label = t(status === "copied" ? "markdown.copied" : status === "failed" ? "markdown.copyFailed" : "markdown.copy");
  const Icon = status === "copied" ? Check : status === "failed" ? TriangleAlert : Copy;

  return (
    <div className="markdown-code-block">
      <button type="button" className={`markdown-copy-button ${status}`} onClick={() => void copy()} aria-label={label} title={label}>
        <Icon size={13} aria-hidden="true" />
        <span aria-live="polite">{label}</span>
      </button>
      <pre><code data-language={language || undefined}>{code}</code></pre>
    </div>
  );
}

function inlineMarkdown(text: string): ReactNode[] {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^)]+\))/gu);
  return tokens.map((token, index) => {
    if (token.startsWith("`") && token.endsWith("`")) return <code key={index}>{token.slice(1, -1)}</code>;
    if (token.startsWith("**") && token.endsWith("**")) return <strong key={index}>{token.slice(2, -2)}</strong>;
    if (token.startsWith("*") && token.endsWith("*")) return <em key={index}>{token.slice(1, -1)}</em>;
    const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/u);
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    return token;
  });
}

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  return trimmed.split(/(?<!\\)\|/u).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

function tableAlignment(cell: string): "left" | "center" | "right" | undefined {
  const trimmed = cell.trim();
  if (!/^:?-{3,}:?$/u.test(trimmed)) return undefined;
  if (trimmed.startsWith(":") && trimmed.endsWith(":")) return "center";
  if (trimmed.endsWith(":")) return "right";
  return "left";
}

function MarkdownTable({ header, divider, rows }: { header: string[]; divider: string[]; rows: string[][] }) {
  const alignments = divider.map(tableAlignment);
  return (
    <div className="markdown-table-wrap">
      <table>
        <thead><tr>{header.map((cell, index) => <th key={index} style={{ textAlign: alignments[index] }}>{inlineMarkdown(cell)}</th>)}</tr></thead>
        <tbody>{rows.map((row, rowIndex) => (
          <tr key={rowIndex}>{header.map((_, cellIndex) => <td key={cellIndex} style={{ textAlign: alignments[cellIndex] }}>{inlineMarkdown(row[cellIndex] ?? "")}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}

const QUOTE_MARKER = /^ {0,3}>[ \t]?/u;
const FENCE_MARKER = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

function listMarker(line: string) {
  const match = line.match(/^( *)([-*+]|\d+[.)])([ \t]+)(.*)$/u);
  if (!match) return undefined;
  return { indent: match[1]!.length, ordered: /^\d/u.test(match[2]!), number: Number.parseInt(match[2]!, 10),
    contentIndent: match[1]!.length + match[2]!.length + match[3]!.length, text: match[4]! };
}

function parseCodeBlock(lines: string[], start: number) {
  const fence = lines[start]!.match(FENCE_MARKER)!;
  const marker = fence[1]!;
  const code: string[] = [];
  let next = start + 1;
  // 未闭合的流式围栏读到末尾；正文不 trim，保留复制所需的缩进与空行。
  while (next < lines.length) {
    const closing = lines[next]!.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u)?.[1];
    if (closing && closing[0] === marker[0] && closing.length >= marker.length) { next += 1; break; }
    code.push(lines[next++]!);
  }
  return { next, node: <MarkdownCodeBlock key={start} code={code.join("\n")} language={fence[2]!.trim()} /> };
}

function isTableStart(lines: string[], start: number): boolean {
  const line = lines[start] ?? "";
  if (!line.includes("|")) return false;
  const divider = tableCells(lines[start + 1] ?? "");
  return tableCells(line).length === divider.length && divider.every((cell) => tableAlignment(cell) !== undefined);
}

function parseTableBlock(lines: string[], start: number) {
  if (!isTableStart(lines, start)) return undefined;
  const header = tableCells(lines[start]!);
  const divider = tableCells(lines[start + 1] ?? "");
  const rows: string[][] = [];
  let next = start + 2;
  while (next < lines.length && lines[next]!.includes("|") && lines[next]!.trim()) rows.push(tableCells(lines[next++]!));
  return { next, node: <MarkdownTable key={start} header={header} divider={divider} rows={rows} /> };
}

function nextNonBlankLine(lines: string[], start: number): number {
  let index = start;
  while (index < lines.length && !lines[index]!.trim()) index += 1;
  return index;
}

function parseListBlock(lines: string[], start: number) {
  const first = listMarker(lines[start]!)!;
  const items: ReactNode[] = [];
  let next = start;
  while (next < lines.length) {
    const marker = listMarker(lines[next]!);
    if (!marker || marker.indent !== first.indent || marker.ordered !== first.ordered) break;
    const itemStart = next;
    const body = [marker.text];
    next += 1;
    while (next < lines.length) {
      const line = lines[next]!;
      if (!line.trim()) {
        const following = nextNonBlankLine(lines, next + 1);
        const followingMarker = listMarker(lines[following] ?? "");
        const sameList = followingMarker?.indent === first.indent && followingMarker.ordered === first.ordered;
        const continuation = (lines[following]?.match(/^ */u)?.[0].length ?? 0) >= marker.contentIndent;
        if (!sameList && !continuation) break;
        body.push(line.slice(marker.contentIndent));
        next += 1;
        continue;
      }
      if ((line.match(/^ */u)?.[0].length ?? 0) < marker.contentIndent) break;
      body.push(line.slice(marker.contentIndent));
      next += 1;
    }
    // 显式编号保留跨空行或跳号的有序列表；子列表复用相同块解析。
    items.push(<li key={itemStart} value={first.ordered ? marker.number : undefined}>{parseBlocks(body)}</li>);
  }
  return { next, node: first.ordered ? <ol key={start} start={first.number}>{items}</ol> : <ul key={start}>{items}</ul> };
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return QUOTE_MARKER.test(line) || FENCE_MARKER.test(line) || /^(#{1,4})\s/u.test(line)
    || listMarker(line) !== undefined || isTableStart(lines, index);
}

function parseBlocks(lines: string[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const start = index;
    const line = lines[index]!;
    if (!line.trim()) { index += 1; continue; }
    if (FENCE_MARKER.test(line)) {
      const block = parseCodeBlock(lines, start);
      nodes.push(block.node);
      index = block.next;
      continue;
    }
    if (QUOTE_MARKER.test(line)) {
      const quoted: string[] = [];
      // 每次仅剥一层引用标记，裸 > 留下空行，嵌套引用递归生成子块。
      while (index < lines.length && QUOTE_MARKER.test(lines[index]!)) quoted.push(lines[index++]!.replace(QUOTE_MARKER, ""));
      nodes.push(<blockquote key={start}>{parseBlocks(quoted)}</blockquote>);
      continue;
    }
    const table = parseTableBlock(lines, start);
    if (table) { nodes.push(table.node); index = table.next; continue; }
    const heading = line.match(/^(#{1,4})\s+(.+)$/u);
    if (heading) {
      const level = heading[1]!.length;
      const content = inlineMarkdown(heading[2]!);
      nodes.push(level === 1 ? <h1 key={start}>{content}</h1> : level === 2 ? <h2 key={start}>{content}</h2> : level === 3 ? <h3 key={start}>{content}</h3> : <h4 key={start}>{content}</h4>);
      index += 1;
      continue;
    }
    if (listMarker(line)) {
      const block = parseListBlock(lines, start);
      nodes.push(block.node);
      index = block.next;
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index]!.trim() && !startsBlock(lines, index)) paragraph.push(lines[index++]!);
    nodes.push(<p key={start}>{inlineMarkdown(paragraph.join("\n"))}</p>);
  }
  return nodes;
}

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return <div className="markdown">{parseBlocks(children.replaceAll("\r\n", "\n").split("\n"))}</div>;
});
