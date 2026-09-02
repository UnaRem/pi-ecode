import type { ReactNode } from "react";

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

export function Markdown({ children }: { children: string }) {
  const lines = children.replaceAll("\r\n", "\n").split("\n");
  const nodes: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) code.push(lines[index++] ?? "");
      index += 1;
      nodes.push(<pre key={`code-${index}`}><code data-language={language || undefined}>{code.join("\n")}</code></pre>);
      continue;
    }
    const nextLine = lines[index + 1] ?? "";
    const headerCells = tableCells(line);
    const dividerCells = tableCells(nextLine);
    if (line.includes("|") && headerCells.length === dividerCells.length && dividerCells.every((cell) => tableAlignment(cell))) {
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim()) {
        rows.push(tableCells(lines[index++] ?? ""));
      }
      nodes.push(<MarkdownTable key={`table-${index}`} header={headerCells} divider={dividerCells} rows={rows} />);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/u);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const content = inlineMarkdown(heading[2] ?? "");
      nodes.push(level === 1 ? <h1 key={index}>{content}</h1> : level === 2 ? <h2 key={index}>{content}</h2> : level === 3 ? <h3 key={index}>{content}</h3> : <h4 key={index}>{content}</h4>);
      index += 1;
      continue;
    }
    if (/^[-*]\s+/u.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/u.test(lines[index] ?? "")) items.push((lines[index++] ?? "").replace(/^[-*]\s+/u, ""));
      nodes.push(<ul key={`list-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ul>);
      continue;
    }
    if (/^\d+\.\s+/u.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/u.test(lines[index] ?? "")) items.push((lines[index++] ?? "").replace(/^\d+\.\s+/u, ""));
      nodes.push(<ol key={`ordered-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ol>);
      continue;
    }
    if (line.startsWith("> ")) {
      nodes.push(<blockquote key={index}>{inlineMarkdown(line.slice(2))}</blockquote>);
      index += 1;
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() && !/^(#{1,4})\s|^```|^[-*]\s|^\d+\.\s|^>\s/u.test(lines[index] ?? "")) paragraph.push(lines[index++] ?? "");
    nodes.push(<p key={`paragraph-${index}`}>{inlineMarkdown(paragraph.join("\n"))}</p>);
  }
  return <div className="markdown">{nodes}</div>;
}
