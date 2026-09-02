import { useEffect, useState } from "react";
import type { JsonValue } from "@shared/settings-contracts";

interface JsonValueEditorProps {
  value: JsonValue | undefined;
  rows?: number;
  onChange: (value: JsonValue | undefined) => void;
}

export function JsonValueEditor(props: JsonValueEditorProps) {
  const serialized = props.value === undefined ? "" : JSON.stringify(props.value, null, 2);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState(false);

  useEffect(() => setText(serialized), [serialized]);

  const commit = (): void => {
    if (!text.trim()) {
      setError(false);
      props.onChange(undefined);
      return;
    }
    try {
      props.onChange(JSON.parse(text) as JsonValue);
      setError(false);
    } catch {
      setError(true);
    }
  };

  return (
    <textarea
      className={error ? "invalid" : ""}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      rows={props.rows ?? 4}
    />
  );
}
