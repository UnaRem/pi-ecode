import { useEffect, useState, type AnimationEvent, type ChangeEventHandler, type ClipboardEventHandler, type KeyboardEventHandler, type RefObject } from "react";
import { ArrowUp, Paperclip, Redo2, Square, Undo2 } from "lucide-react";
import type { ExtensionUiRequest, ExtensionUiResponse, ImageAttachment, PastedTextAttachment } from "@shared/contracts";
import type { ComposerProps } from "./Composer";
import { CompactionStatusPanel } from "./CompactionStatusPanel";
import { ComposerModelControls } from "./ComposerModelControls";
import { ExtensionQuestionPanel } from "./ExtensionQuestionPanel";
import { ImageGallery } from "./ImageGallery";
import { PastedTextAttachments } from "./PastedTextAttachments";
import { PdfAttachmentPanel } from "./PdfAttachmentPanel";
import { useI18n } from "../i18n/i18n";

interface ComposerViewProps {
  agent: ComposerProps;
  text: string;
  images: ImageAttachment[];
  pastedTexts: PastedTextAttachment[];
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
  onRemovePastedText: (id: string) => void;
  onAddPdfPage: (attachment: ImageAttachment) => void;
  onClosePdf: () => void;
  onSubmit: () => void;
}

export const MAX_ATTACHMENTS = 8;

function PdfAttachmentPresence(props: Pick<ComposerViewProps, "pdfFile" | "images" | "pastedTexts" | "onAddPdfPage" | "onClosePdf"> & { supportsImages: boolean }) {
  const [visibleFile, setVisibleFile] = useState(props.pdfFile);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (props.pdfFile) {
      setVisibleFile(props.pdfFile);
      setLeaving(false);
    } else if (visibleFile) {
      setLeaving(true);
    }
  }, [props.pdfFile]);

  if (!visibleFile) return null;
  return (
    <div
      className={`pdf-presence attachment-item ${leaving ? "leaving" : ""}`}
      inert={leaving ? true : undefined}
      onAnimationEnd={(event: AnimationEvent<HTMLDivElement>) => {
        if (leaving && event.animationName === "attachment-leave") setVisibleFile(null);
      }}
    >
      <PdfAttachmentPanel
        file={visibleFile}
        attachments={props.images}
        maximumAttachments={MAX_ATTACHMENTS - props.pastedTexts.length}
        disabled={!props.supportsImages}
        onAdd={props.onAddPdfPage}
        onClose={() => {
          setLeaving(true);
          props.onClosePdf();
        }}
      />
    </div>
  );
}

function AttachmentErrorPresence({ error }: { error: string | null }) {
  const [visibleError, setVisibleError] = useState(error);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (error) {
      setVisibleError(error);
      setLeaving(false);
    } else if (visibleError) {
      setLeaving(true);
    }
  }, [error]);

  if (!visibleError) return null;
  return (
    <div
      className={`attachment-error transient-panel ${leaving ? "leaving" : ""}`}
      role="alert"
      inert={leaving ? true : undefined}
      onAnimationEnd={(event: AnimationEvent<HTMLDivElement>) => {
        if (leaving && event.animationName === "panel-leave") setVisibleError(null);
      }}
    >{visibleError}</div>
  );
}

function ExtensionQuestionPresence(props: {
  request: ExtensionUiRequest | null;
  onRespond: (response: ExtensionUiResponse) => void;
}) {
  const [visibleRequest, setVisibleRequest] = useState(props.request);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (props.request) {
      setVisibleRequest(props.request);
      setLeaving(false);
    } else if (visibleRequest) {
      setLeaving(true);
    }
  }, [props.request]);

  if (!visibleRequest) return null;
  return (
    <ExtensionQuestionPanel
      request={visibleRequest}
      leaving={leaving}
      onRespond={(response) => {
        setLeaving(true);
        props.onRespond(response);
      }}
      onLeaveEnd={() => {
        setVisibleRequest(null);
        setLeaving(false);
      }}
    />
  );
}

export function ComposerView(view: ComposerViewProps) {
  const { t } = useI18n();
  const props = view.agent;
  return (
    <footer className="composer-area">
      <CompactionStatusPanel status={props.context.compaction} onCancel={props.onCancelCompact} />
      <ExtensionQuestionPresence request={props.extensionUi} onRespond={props.onRespondExtensionUi} />
      <div className={`composer ${props.isStreaming ? "working" : ""} ${props.extensionUi ? "blocked" : ""}`}>
        {view.pastedTexts.length > 0 && <PastedTextAttachments attachments={view.pastedTexts} variant="composer" onRemove={view.onRemovePastedText} />}
        {view.images.length > 0 && <ImageGallery images={view.images} variant="composer" onRemove={view.onRemoveImage} />}
        <PdfAttachmentPresence
          pdfFile={view.pdfFile}
          images={view.images}
          pastedTexts={view.pastedTexts}
          supportsImages={props.supportsImages}
          onAddPdfPage={view.onAddPdfPage}
          onClosePdf={view.onClosePdf}
        />
        <AttachmentErrorPresence error={view.attachmentError} />
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
            <button className={`context-button ${props.context.isCompacting ? "cancel" : ""}`} onClick={props.context.isCompacting ? props.onCancelCompact : props.onCompact} disabled={Boolean(props.extensionUi) || (!props.context.isCompacting && (props.isStreaming || !props.context.contextWindow || !props.context.canCompact))} title={props.context.isCompacting ? t("composer.cancelCompact") : t("composer.compact")}>
              {props.context.isCompacting ? t("composer.cancelCompact") : view.contextLabel}
            </button>
            <ComposerModelControls
              models={props.models}
              selectedModel={props.selectedModel}
              thinkingLevel={props.thinkingLevel}
              thinkingLevels={props.thinkingLevels}
              disabled={props.isStreaming || Boolean(props.extensionUi)}
              onSetModel={props.onSetModel}
              onSetThinking={props.onSetThinking}
            />
          </div>
          <span>{props.extensionUi ? t("composer.waitingAnswer") : props.isStreaming ? (props.pendingCount ? t("composer.steeringCount", { count: props.pendingCount }) : t("composer.steerHint")) : t("composer.sendHint")}</span>
          <div className="composer-actions">
            <button className={`send-button ${props.isStreaming ? "steer" : ""}`} onClick={view.onSubmit} disabled={Boolean(props.extensionUi) || (!view.text.trim() && view.images.length === 0 && view.pastedTexts.length === 0) || !props.modelReady} aria-label={props.isStreaming ? t("composer.steer") : t("composer.send")} title={props.isStreaming ? t("composer.steer") : t("composer.send")}><ArrowUp size={17} /></button>
            <button
              className={`send-button stop ${props.isStreaming ? "visible" : ""}`}
              onClick={props.onStop}
              disabled={!props.isStreaming}
              tabIndex={props.isStreaming ? 0 : -1}
              aria-hidden={!props.isStreaming}
              aria-label={t("composer.stop")}
              title={props.isStreaming ? t("composer.stop") : undefined}
            ><Square size={12} fill="currentColor" /></button>
          </div>
        </div>
      </div>
      <div className="composer-note">{t("composer.note")}</div>
    </footer>
  );
}
