import type { PastedTextAttachment } from "./contracts.js";

export const PASTED_TEXT_CHARACTER_THRESHOLD = 2_000;
export const PASTED_TEXT_LINE_THRESHOLD = 20;
const PASTED_TEXT_BLOCK = /(?:\r?\n){0,2}\[PI_ECODE_PASTED_TEXT_V1:([0-9a-f-]+):START\]\r?\n([\s\S]*?)\r?\n\[PI_ECODE_PASTED_TEXT_V1:\1:END\]/giu;

export function pastedTextLineCount(content: string): number {
  return content.split(/\r\n|\r|\n/u).length;
}

export function shouldAttachPastedText(content: string): boolean {
  return content.length > PASTED_TEXT_CHARACTER_THRESHOLD || pastedTextLineCount(content) > PASTED_TEXT_LINE_THRESHOLD;
}

export function createPastedTextAttachment(id: string, content: string): PastedTextAttachment {
  return {
    id,
    content,
    lineCount: pastedTextLineCount(content),
    byteSize: new TextEncoder().encode(content).byteLength,
  };
}

export function serializePastedTexts(message: string, attachments: PastedTextAttachment[]): string {
  const blocks = attachments.map((attachment, index) => [
    `[PI_ECODE_PASTED_TEXT_V1:${attachment.id}:START]`,
    `Pasted text #${index + 1}:`,
    attachment.content,
    `[PI_ECODE_PASTED_TEXT_V1:${attachment.id}:END]`,
  ].join("\n"));
  return [message.trim(), ...blocks].filter(Boolean).join("\n\n");
}

export function parsePastedTexts(value: string): { message: string; attachments: PastedTextAttachment[] } {
  const attachments: PastedTextAttachment[] = [];
  const message = value.replace(PASTED_TEXT_BLOCK, (_block, id: string, blockContent: string) => {
    const content = blockContent.replace(/^Pasted text #\d+:\r?\n/u, "");
    attachments.push(createPastedTextAttachment(id, content));
    return "";
  }).trim();
  return { message, attachments };
}
