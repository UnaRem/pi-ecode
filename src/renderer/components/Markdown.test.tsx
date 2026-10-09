/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { copyText, Markdown } from "./Markdown";

function renderMarkdown(text: string): string {
  vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
  return renderToStaticMarkup(<I18nProvider><Markdown>{text}</Markdown></I18nProvider>);
}

describe("Markdown blocks", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("将连续引用解析成同一容器内的段落，裸引用标记保留段落边界", () => {
    expect(renderMarkdown("> first\n> second\n>\n> third\noutside")).toBe(
      '<div class="markdown"><blockquote><p>first\nsecond</p><p>third</p></blockquote><p>outside</p></div>',
    );
  });

  it("空引用不产生正文标记，支持三空格及 Tab 引用分隔符", () => {
    expect(renderMarkdown(">\n > \n   >\t")).toBe('<div class="markdown"><blockquote></blockquote></div>');
    expect(renderMarkdown("   >\ttext")).toContain("<blockquote><p>text</p></blockquote>");
  });

  it("引用内有序列表跨空行连续编号，并保留起始编号及跳号", () => {
    const markup = renderMarkdown("> 1. one\n>\n> 2. two\n>\n> 3. three\n>\n> 4. four");
    expect(markup).toBe('<div class="markdown"><blockquote><ol start="1"><li value="1"><p>one</p></li><li value="2"><p>two</p></li><li value="3"><p>three</p></li><li value="4"><p>four</p></li></ol></blockquote></div>');
    expect(renderMarkdown("> 3. third\n>\n> 7. seventh")).toContain('<ol start="3"><li value="3"><p>third</p></li><li value="7"><p>seventh</p></li></ol>');
  });

  it("递归解析引用内缩进子列表和嵌套引用", () => {
    const markup = renderMarkdown("> - parent\n>   2. child\n>      - leaf\n> - sibling\n>\n> > nested\n> >\n> > paragraph");
    expect(markup).toContain('<ul><li><p>parent</p><ol start="2"><li value="2"><p>child</p><ul><li><p>leaf</p></li></ul></li></ol></li><li><p>sibling</p></li></ul>');
    expect(markup).toContain('<blockquote><p>nested</p><p>paragraph</p></blockquote>');
    expect(markup.match(/<blockquote>/g)).toHaveLength(2);
  });

  it("引用内表格复用表格和行内格式渲染", () => {
    const markup = renderMarkdown("> | Name | Value |\n> | --- | ---: |\n> | **bold** | `code` |");
    expect(markup).toContain('<blockquote><div class="markdown-table-wrap"><table>');
    expect(markup).toContain('<strong>bold</strong>');
    expect(markup).toContain('<code>code</code>');
  });

  it("引用内未闭合流式围栏保留缩进、空行和 Markdown 字面内容", () => {
    const partial = "> ```ts\n>   const text = '<tag>';\n>\n> > literal\n> - literal";
    const codeMarkup = '<code data-language="ts">  const text = &#x27;&lt;tag&gt;&#x27;;\n\n&gt; literal\n- literal</code>';
    const streaming = renderMarkdown(partial);
    expect(streaming).toContain(codeMarkup);
    expect(streaming.match(/<blockquote>/g)).toHaveLength(1);
    expect(streaming).not.toContain("<ul>");
    const completed = renderMarkdown(partial + "\n> ```\n>\n> after");
    expect(completed).toContain(codeMarkup);
    expect(completed).toContain("</div><p>after</p></blockquote>");
  });

  it.each([
    { quoted: false, whitespace: "  " },
    { quoted: false, whitespace: "\t" },
    { quoted: true, whitespace: "  " },
    { quoted: true, whitespace: "\t" },
  ])("列表围栏正文保留去缩进后的空白：%j", ({ quoted, whitespace }) => {
    const lines = ["- ```text", "  a", `  ${whitespace}`, "  b", "  ```"];
    const text = lines.map((line) => quoted ? `> ${line}` : line).join("\n");
    const markup = renderMarkdown(text);
    const code = markup.match(/<code data-language="text">([\s\S]*?)<\/code>/u)?.[1];

    expect(code).toBe(`a\n${whitespace}\nb`);
    expect(markup).toContain('<ul><li><div class="markdown-code-block">');
    expect(markup.includes("<blockquote>")).toBe(quoted);
  });

  it("文本增量在新渲染中正常显示，并保持 HTML 转义及 http(s) 链接限制", () => {
    expect(renderMarkdown("> first")).not.toContain("second");
    expect(renderMarkdown("> first\n> second")).toContain("first\nsecond");
    const markup = renderMarkdown('> <script>alert(1)</script>\n> [bad](javascript:alert(1)) [data](data:text/html,test) [safe](https://example.com)\n>\n> ```html\n> <img src=x onerror=alert(1)>\n> ```');
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain('href="javascript:');
    expect(markup).not.toContain('href="data:');
    expect(markup).toContain('href="https://example.com" target="_blank" rel="noreferrer"');
  });
});

describe("Markdown code blocks", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders a keyboard-accessible copy button with exact code text", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider><Markdown>{"```ts\nconst answer = 42;\n```"}</Markdown></I18nProvider>,
    );

    expect(markup).toContain('class="markdown-code-block"');
    expect(markup).toContain('class="markdown-copy-button idle"');
    expect(markup).toContain('aria-label="Copy"');
    expect(markup).toContain('data-language="ts"');
    expect(markup).toContain("const answer = 42;");
  });

  it("reports clipboard success and failure without throwing", async () => {
    const writeText = vi.fn(async () => undefined);
    await expect(copyText("exact code", writeText)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("exact code");

    await expect(copyText("blocked", async () => { throw new Error("denied"); })).resolves.toBe(false);
  });

  it("keeps the copy action above code and styles feedback states", () => {
    const stylesheet = readFileSync(new URL("../styles/components/conversation.css", import.meta.url), "utf8");
    expect(stylesheet).toMatch(/\.markdown-copy-button\s*\{[^}]*position:\s*absolute;[^}]*top:\s*7px;[^}]*right:\s*7px;/u);
    expect(stylesheet).toContain(".markdown-copy-button.copied");
    expect(stylesheet).toContain(".markdown-copy-button.failed");
  });
});
