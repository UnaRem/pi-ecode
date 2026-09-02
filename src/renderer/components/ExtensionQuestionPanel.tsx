import { Check, Circle, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ExtensionUiRequest, ExtensionUiResponse } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";

interface ExtensionQuestionPanelProps {
  request: ExtensionUiRequest;
  onRespond: (response: ExtensionUiResponse) => void;
}

export function multiSelectResponse(selected: string[], customAnswer: string): string[] | string {
  const custom = customAnswer.trim();
  return custom ? custom : selected;
}

export function ExtensionQuestionPanel({ request, onRespond }: ExtensionQuestionPanelProps) {
  const { t } = useI18n();
  const [text, setText] = useState(request.prefill ?? "");
  const [selected, setSelected] = useState<string[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText(request.prefill ?? "");
    setSelected([]);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [request.id]);

  const respond = (value: ExtensionUiResponse["value"]): void => {
    onRespond({ requestId: request.id, value });
  };

  const submitText = (event: FormEvent): void => {
    event.preventDefault();
    respond(request.method === "multi-select" ? multiSelectResponse(selected, text) : text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      respond(null);
    }
    if (event.key === "Enter" && !event.shiftKey && request.method !== "select" && request.method !== "confirm") {
      event.preventDefault();
      event.currentTarget.querySelector<HTMLFormElement>("form")?.requestSubmit();
    }
  };

  const toggleOption = (value: string): void => {
    setSelected((current) => current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value]);
  };

  return (
    <section className="extension-question" role="dialog" aria-label={t("question.dialog")} onKeyDown={onKeyDown}>
      <header className="extension-question-header">
        <div>
          <span>{t("question.needsInput")}</span>
          {request.questionCount && request.questionIndex !== undefined && (
            <small>{request.questionIndex + 1}/{request.questionCount}</small>
          )}
        </div>
        <button onClick={() => respond(null)} aria-label={t("question.cancel")}><X size={14} /></button>
      </header>
      <div className="extension-question-title">{request.title}</div>
      {request.message && <p className="extension-question-message">{request.message}</p>}

      {(request.method === "select" || request.method === "multi-select") && (
        <div className="extension-question-options">
          {request.options?.map((option) => {
            const checked = selected.includes(option.value);
            return (
              <button
                key={option.value}
                className={checked ? "selected" : ""}
                aria-pressed={request.method === "multi-select" ? checked : undefined}
                onClick={() => request.method === "select" ? respond(option.value) : toggleOption(option.value)}
              >
                <span className="extension-option-icon" aria-hidden="true">
                  {checked ? <Check size={12} /> : <Circle size={12} />}
                </span>
                <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
              </button>
            );
          })}
        </div>
      )}

      {request.method === "confirm" ? (
        <div className="extension-question-actions">
          <button onClick={() => respond(false)}>{t("common.no")}</button>
          <button className="primary" onClick={() => respond(true)}>{t("common.yes")}</button>
        </div>
      ) : request.method !== "select" && (
        <form onSubmit={submitText}>
          <textarea
            ref={inputRef}
            value={text}
            rows={request.method === "editor" ? 4 : 2}
            placeholder={request.method === "multi-select" ? t("question.custom") : request.placeholder}
            onChange={(event) => setText(event.target.value)}
            aria-label={t("question.response")}
          />
          <div className="extension-question-actions">
            <button type="button" onClick={() => respond(null)}>{t("common.cancel")}</button>
            <button className="primary" type="submit">{t("common.submit")}</button>
          </div>
        </form>
      )}
    </section>
  );
}
