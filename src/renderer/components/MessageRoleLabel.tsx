import { useLayoutEffect, useRef, useState } from "react";
import { Bot, UserRound } from "lucide-react";
import { useI18n } from "../i18n/i18n";

const DEFAULT_NICKNAMES = { assistant: "PiECode", user: "你" } as const;

export type MessageRole = keyof typeof DEFAULT_NICKNAMES;
export type MessageNicknames = Record<MessageRole, string>;

export function normalizeNickname(role: MessageRole, value: string): string {
  return value.trim() || DEFAULT_NICKNAMES[role];
}

export function useMessageNicknames(initial: MessageNicknames = DEFAULT_NICKNAMES): {
  nicknames: MessageNicknames;
  saveNickname: (role: MessageRole, nickname: string) => void;
} {
  const [nicknames, setNicknames] = useState<MessageNicknames>(initial);
  const saveNickname = (role: MessageRole, value: string): void => {
    const nickname = normalizeNickname(role, value);
    setNicknames((current) => ({ ...current, [role]: nickname }));
  };
  return { nicknames, saveNickname };
}

export function MessageRoleLabel(props: {
  role: MessageRole;
  nickname: string;
  avatarUrl?: string | null;
  status?: string | null;
  onSave?: (role: MessageRole, nickname: string) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.nickname);
  const cancelledRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const finish = (): void => {
    const shouldSave = !cancelledRef.current;
    setEditing(false);
    if (shouldSave) props.onSave?.(props.role, draft);
  };

  const startEditing = (): void => {
    if (!props.onSave) return;
    cancelledRef.current = false;
    setDraft(props.nickname);
    setEditing(true);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="message-role message-role-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={finish}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            cancelledRef.current = true;
            setDraft(props.nickname);
            setEditing(false);
          }
        }}
        aria-label={t("conversation.editNickname")}
      />
    );
  }

  return (
    <div className="message-role">
      <span className={`message-avatar ${props.role}`} aria-hidden="true">
        {props.avatarUrl ? <img src={props.avatarUrl} alt="" /> : props.role === "assistant" ? <Bot size={19} /> : <UserRound size={18} />}
      </span>
      <span className="message-role-meta">
        <span className="message-role-name">{props.nickname}</span>
        {props.status && <span className="message-role-status">{props.status}</span>}
      </span>
    </div>
  );
}
