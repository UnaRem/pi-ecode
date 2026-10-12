import { useRef, useState, type KeyboardEvent } from "react";
import { createConfirmationResponse, type PendingConfirmation } from "../../shared/confirmation.js";
import { useI18n } from "../i18n/i18n";

interface ConfirmationPromptProps {
  request: PendingConfirmation;
  disabled: boolean;
  onSend: (message: string) => Promise<void>;
}

export function ConfirmationPrompt({ request, disabled, onSend }: ConfirmationPromptProps) {
  const { t } = useI18n();
  const [additionalMessage, setAdditionalMessage] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const blocked = disabled || sending;

  const send = async (confirmed: boolean): Promise<void> => {
    if (disabled || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await onSend(createConfirmationResponse(request, confirmed, additionalMessage));
    } catch {
      // 发送方负责全局错误反馈；保留补充文字，等待重试或真实用户消息结束请求。
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send(true);
  };

  return (
    <section className="confirmation-prompt" aria-label={t("confirmation.pending")} aria-busy={sending}>
      <strong className="confirmation-prompt-title">{request.title}</strong>
      <p className="confirmation-prompt-message">{request.message}</p>
      <label>
        <span>{t("confirmation.additional")}</span>
        <textarea
          rows={2}
          value={additionalMessage}
          disabled={blocked}
          placeholder={t("confirmation.additionalPlaceholder")}
          onChange={(event) => setAdditionalMessage(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </label>
      <div className="confirmation-prompt-actions">
        <button type="button" className="confirmation-prompt-confirm" disabled={blocked} onClick={() => void send(true)}>
          {t(sending ? "confirmation.sending" : "confirmation.confirm")}
        </button>
        <button type="button" disabled={blocked} onClick={() => void send(false)}>{t("confirmation.cancel")}</button>
      </div>
    </section>
  );
}
