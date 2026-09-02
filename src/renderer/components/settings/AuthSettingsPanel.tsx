import { Check, KeyRound, LoaderCircle, LogOut, Shield, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AuthFlowState, AuthPromptResponse, AuthType, ProviderStatus } from "@shared/settings-contracts";
import { useI18n } from "../../i18n/i18n";

interface AuthSettingsPanelProps {
  providers: ProviderStatus[];
  flow: AuthFlowState | null;
  disabled: boolean;
  onLogin: (providerId: string, type: AuthType) => void;
  onLogout: (providerId: string) => void;
  onRespond: (response: AuthPromptResponse) => void;
  onCancel: () => void;
}

function AuthPromptPanel(props: { flow: AuthFlowState; onRespond: (response: AuthPromptResponse) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const request = props.flow.request;
  const [value, setValue] = useState("");
  useEffect(() => setValue(""), [request?.id]);
  if (!request) return (
    <div className={`auth-flow-status ${props.flow.status}`}>
      {props.flow.status === "running" ? <LoaderCircle className="spin" size={14} /> : props.flow.status === "completed" ? <Check size={14} /> : <X size={14} />}
      <span>{props.flow.message}</span>
      {props.flow.status === "running" && <button onClick={props.onCancel}>{t("common.cancel")}</button>}
    </div>
  );
  const respond = (responseValue: string | null): void => {
    props.onRespond({ requestId: request.id, value: responseValue });
    setValue("");
  };
  return (
    <section className="auth-prompt-panel">
      <strong>{request.message}</strong>
      {request.type === "select" ? (
        <div className="auth-options">{request.options?.map((option) => (
          <button key={option.id} onClick={() => respond(option.id)}><span>{option.label}</span>{option.description && <small>{option.description}</small>}</button>
        ))}</div>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); if (value) respond(value); }}>
          <input type={request.type === "secret" ? "password" : "text"} value={value} onChange={(event) => setValue(event.target.value)} placeholder={request.placeholder} autoFocus />
          <button type="submit" disabled={!value}>{t("common.submit")}</button>
        </form>
      )}
      <button className="auth-cancel" onClick={() => respond(null)}>{t("common.cancel")}</button>
    </section>
  );
}

export function AuthSettingsPanel(props: AuthSettingsPanelProps) {
  const { t } = useI18n();
  return (
    <div className="auth-settings">
      {props.flow && <AuthPromptPanel flow={props.flow} onRespond={props.onRespond} onCancel={props.onCancel} />}
      <div className="auth-provider-list">
        {props.providers.map((provider) => {
          const running = props.flow?.status === "running" && props.flow.providerId === provider.id;
          return (
            <article className="auth-provider" key={provider.id}>
              <div className="auth-provider-icon">{provider.authenticated ? <Shield size={16} /> : <KeyRound size={16} />}</div>
              <div className="auth-provider-copy">
                <strong>{provider.name}</strong><code>{provider.id}</code>
                <span>{provider.authenticated ? `${t("settings.authenticated")} · ${provider.source ?? provider.configuredType ?? ""}` : t("settings.notAuthenticated")}</span>
              </div>
              <div className="auth-provider-actions">
                {provider.methods.map((method) => (
                  <button key={method.type} disabled={props.disabled || running} onClick={() => props.onLogin(provider.id, method.type)}>
                    {running ? <LoaderCircle className="spin" size={12} /> : <KeyRound size={12} />}{method.label}
                  </button>
                ))}
                {provider.authenticated && <button className="logout" disabled={props.disabled || running} onClick={() => props.onLogout(provider.id)}><LogOut size={12} />{t("settings.logout")}</button>}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
