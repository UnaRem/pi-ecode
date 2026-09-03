import type { ChangeEventHandler, ClipboardEventHandler, KeyboardEventHandler, RefObject } from "react";
import { ArrowUp, Paperclip, Redo2, Square, Undo2 } from "lucide-react";
import type { ImageAttachment } from "@shared/contracts";
import type { ComposerProps } from "./Composer";
import { CompactionStatusPanel } from "./CompactionStatusPanel";
import { ExtensionQuestionPanel } from "./ExtensionQuestionPanel";
import { ImageGallery } from "./ImageGallery";
import { PdfAttachmentPanel } from "./PdfAttachmentPanel";
import { useI18n } from "../i18n/i18n";

interface ComposerViewProps {
  agent: ComposerProps;
  text: string;
  images: ImageAttachment[];
  pdfFile: File | null;
  attachmentError: string | null;
  contextLabel: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  onTextChange: (text: string) => void;
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onPaste: ClipboardEventHandler<HTMLTextAreaElement>;
  onAddAttachments: ChangeEventHandler<HTMLInputElement>;
  onRemoveImage: (id: string) => void;
  onAddPdfPage: (attachment: ImageAttachment) => void;
  onClosePdf: () => void;
  onSubmit: () => void;
}

export const MAX_ATTACHMENTS = 8;

export function ComposerView(view: ComposerViewProps) {
  const { t } = useI18n();
  const props = view.agent;
  return (
    <footer className="composer-area">
      <CompactionStatusPanel status={props.context.compaction} onCancel={props.onCancelCompact} />
      {props.extensionUi && <ExtensionQuestionPanel request={props.extensionUi} onRespond={props.onRespondExtensionUi} />}
      <div className={`composer ${props.isStreaming ? "working" : ""} ${props.extensionUi ? "blocked" : ""}`}>
        {view.images.length > 0 && <ImageGallery images={view.images} variant="composer" onRemove={view.onRemoveImage} />}
        {view.pdfFile && (
          <PdfAttachmentPanel
            file={view.pdfFile}
            attachments={view.images}
            maximumAttachments={MAX_ATTACHMENTS}
            disabled={!props.supportsImages}
            onAdd={view.onAddPdfPage}
            onClose={view.onClosePdf}
          />
        )}
        {view.attachmentError && <div className="attachment-error">{view.attachmentError}</div>}
        <textarea
          ref={view.textareaRef}
          value={view.text}
          rows={1}
          placeholder={props.extensionUi ? t("composer.answerAbove") : props.modelReady ? t("composer.ask") : t("composer.configureModel")}
          disabled={!props.modelReady || Boolean(props.extensionUi)}
          onChange={(event) => view.onTextChange(event.target.value)}
          onKeyDown={view.onKeyDown}
          onPaste={view.onPaste}
          aria-label={t("composer.message")}
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <input ref={view.inputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf" multiple hidden onChange={view.onAddAttachments} />
            <button className="composer-tool-button" onClick={() => view.inputRef.current?.click()} disabled={!props.modelReady || !props.supportsImages || Boolean(props.extensionUi)} aria-label={t("composer.attach")} title={props.supportsImages ? t("composer.attach") : t("composer.attachUnsupported")}><Paperclip size={15} /></button>
            <button className="composer-tool-button" onClick={props.onUndo} disabled={props.isStreaming || Boolean(props.extensionUi) || props.history.isBusy || !props.history.canUndo} aria-label={t("composer.undo")} title={t("composer.undo")}><Undo2 size={15} /></button>
            <button className="composer-tool-button" onClick={props.onRedo} disabled={props.isStreaming || Boolean(props.extensionUi) || props.history.isBusy || !props.history.canRedo} aria-label={t("composer.redo")} title={t("composer.redo")}><Redo2 size={15} /></button>
            <button className={`context-button ${props.context.isCompacting ? "cancel" : ""}`} onClick={props.context.isCompacting ? props.onCancelCompact : props.onCompact} disabled={Boolean(props.extensionUi) || (!props.context.isCompacting && (props.isStreaming || !props.context.contextWindow))} title={props.context.isCompacting ? t("composer.cancelCompact") : t("composer.compact")}>
              {props.context.isCompacting ? t("composer.cancelCompact") : view.contextLabel}
            </button>
          </div>
          <span>{props.extensionUi ? t("composer.waitingAnswer") : props.isStreaming ? (props.pendingCount ? t("composer.steeringCount", { count: props.pendingCount }) : t("composer.steerHint")) : t("composer.sendHint")}</span>
          <div className="composer-actions">
            <button className={`send-button ${props.isStreaming ? "steer" : ""}`} onClick={view.onSubmit} disabled={Boolean(props.extensionUi) || (!view.text.trim() && view.images.length === 0) || !props.modelReady} aria-label={props.isStreaming ? t("composer.steer") : t("composer.send")} title={props.isStreaming ? t("composer.steer") : t("composer.send")}><ArrowUp size={17} /></button>
            {props.isStreaming && <button className="send-button stop" onClick={props.onStop} aria-label={t("composer.stop")} title={t("composer.stop")}><Square size={12} fill="currentColor" /></button>}
          </div>
        </div>
      </div>
      <div className="composer-note">{t("composer.note")}</div>
    </footer>
  );
}
