import { useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";

const NICKNAME_STORAGE_KEYS = {
  assistant: "pi-ecode:assistant-nickname",
  user: "pi-ecode:user-nickname",
} as const;
const DEFAULT_NICKNAMES = { assistant: "pi", user: "你" } as const;

export type MessageRole = keyof typeof DEFAULT_NICKNAMES;
export type MessageNicknames = Record<MessageRole, string>;

export function normalizeNickname(role: MessageRole, value: string): string {
  return value.trim() || DEFAULT_NICKNAMES[role];
}

function initialNickname(role: MessageRole): string {
  return normalizeNickname(role, localStorage.getItem(NICKNAME_STORAGE_KEYS[role]) ?? "");
}

export function useMessageNicknames(): {
  nicknames: MessageNicknames;
  saveNickname: (role: MessageRole, nickname: string) => void;
} {
  const [nicknames, setNicknames] = useState<MessageNicknames>(() => ({
    assistant: initialNickname("assistant"),
    user: initialNickname("user"),
  }));
  const saveNickname = (role: MessageRole, value: string): void => {
    const nickname = normalizeNickname(role, value);
    setNicknames((current) => ({ ...current, [role]: nickname }));
    try {
      localStorage.setItem(NICKNAME_STORAGE_KEYS[role], nickname);
    } catch {
      // Keep the nickname usable for this window when browser storage is unavailable.
    }
  };
  return { nicknames, saveNickname };
}

export function MessageRoleLabel(props: {
  role: MessageRole;
  nickname: string;
  onSave: (role: MessageRole, nickname: string) => void;
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
    if (shouldSave) props.onSave(props.role, draft);
  };

  const startEditing = (): void => {
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
    <button
      className="message-role message-role-button"
      onClick={startEditing}
      title={t("conversation.editNickname")}
      aria-label={`${t("conversation.editNickname")}: ${props.nickname}`}
    >
      {props.nickname}
    </button>
  );
}
