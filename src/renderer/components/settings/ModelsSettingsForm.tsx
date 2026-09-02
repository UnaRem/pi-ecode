import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { JsonObject, JsonValue } from "@shared/settings-contracts";
import { useI18n } from "../../i18n/i18n";
import { JsonValueEditor } from "./JsonValueEditor";

const API_TYPES = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

function isObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function providersFrom(value: JsonObject): JsonObject {
  return isObject(value.providers) ? value.providers : {};
}

function updateProvider(root: JsonObject, providerId: string, provider: JsonObject | undefined): JsonObject {
  const providers = structuredClone(providersFrom(root));
  if (provider) providers[providerId] = provider;
  else delete providers[providerId];
  return { ...root, providers };
}

function updateField(object: JsonObject, key: string, value: JsonValue | undefined): JsonObject {
  const next = { ...object };
  if (value === undefined || value === "") delete next[key];
  else next[key] = value;
  return next;
}

function modelsFrom(provider: JsonObject): JsonObject[] {
  return Array.isArray(provider.models) ? provider.models.filter(isObject) : [];
}

function ModelEditor(props: { model: JsonObject; onChange: (model: JsonObject) => void; onRemove: () => void }) {
  const { t } = useI18n();
  const model = props.model;
  const input = Array.isArray(model.input) && model.input.includes("image") ? "text-image" : "text";
  return (
    <article className="model-config-card">
      <div className="model-config-title">
        <strong>{typeof model.id === "string" ? model.id : "New model"}</strong>
        <button onClick={props.onRemove} aria-label={t("settings.removeModel")}><Trash2 size={13} /></button>
      </div>
      <div className="model-config-grid">
        <label><span>id</span><input value={typeof model.id === "string" ? model.id : ""} onChange={(event) => props.onChange(updateField(model, "id", event.target.value))} /></label>
        <label><span>name</span><input value={typeof model.name === "string" ? model.name : ""} onChange={(event) => props.onChange(updateField(model, "name", event.target.value))} /></label>
        <label><span>api</span><select value={typeof model.api === "string" ? model.api : ""} onChange={(event) => props.onChange(updateField(model, "api", event.target.value))}><option value="">{t("settings.providerDefault")}</option>{API_TYPES.map((api) => <option key={api}>{api}</option>)}</select></label>
        <label><span>reasoning</span><select value={model.reasoning === undefined ? "" : String(model.reasoning)} onChange={(event) => props.onChange(updateField(model, "reasoning", event.target.value ? event.target.value === "true" : undefined))}><option value="">{t("settings.default")}</option><option value="true">true</option><option value="false">false</option></select></label>
        <label><span>input</span><select value={input} onChange={(event) => props.onChange(updateField(model, "input", event.target.value === "text-image" ? ["text", "image"] : ["text"]))}><option value="text">text</option><option value="text-image">text + image</option></select></label>
        <label><span>contextWindow</span><input type="number" value={typeof model.contextWindow === "number" ? model.contextWindow : ""} onChange={(event) => props.onChange(updateField(model, "contextWindow", event.target.value ? Number(event.target.value) : undefined))} /></label>
        <label><span>maxTokens</span><input type="number" value={typeof model.maxTokens === "number" ? model.maxTokens : ""} onChange={(event) => props.onChange(updateField(model, "maxTokens", event.target.value ? Number(event.target.value) : undefined))} /></label>
      </div>
      <div className="model-json-grid">
        {(["thinkingLevelMap", "cost", "samplingParams", "headers", "compat"] as const).map((key) => (
          <label key={key}><span>{key}</span><JsonValueEditor value={model[key]} rows={3} onChange={(value) => props.onChange(updateField(model, key, value))} /></label>
        ))}
      </div>
    </article>
  );
}

function ProviderEditor(props: { id: string; provider: JsonObject; onRename: (id: string) => void; onChange: (value: JsonObject) => void; onRemove: () => void }) {
  const { t } = useI18n();
  const { provider } = props;
  const models = modelsFrom(provider);
  const setModels = (next: JsonObject[]): void => props.onChange(updateField(provider, "models", next));
  return (
    <section className="provider-config-card">
      <header>
        <label><span>Provider ID</span><input defaultValue={props.id} onBlur={(event) => props.onRename(event.target.value.trim())} /></label>
        <button onClick={props.onRemove}><Trash2 size={13} />{t("settings.removeProvider")}</button>
      </header>
      <div className="provider-config-grid">
        <label><span>baseUrl</span><input value={typeof provider.baseUrl === "string" ? provider.baseUrl : ""} onChange={(event) => props.onChange(updateField(provider, "baseUrl", event.target.value))} /></label>
        <label><span>api</span><select value={typeof provider.api === "string" ? provider.api : ""} onChange={(event) => props.onChange(updateField(provider, "api", event.target.value))}><option value="">{t("settings.modelDefault")}</option>{API_TYPES.map((api) => <option key={api}>{api}</option>)}</select></label>
        <label><span>oauth</span><input value={typeof provider.oauth === "string" ? provider.oauth : ""} onChange={(event) => props.onChange(updateField(provider, "oauth", event.target.value))} placeholder="radius" /></label>
        <label><span>authHeader</span><select value={provider.authHeader === undefined ? "" : String(provider.authHeader)} onChange={(event) => props.onChange(updateField(provider, "authHeader", event.target.value ? event.target.value === "true" : undefined))}><option value="">{t("settings.default")}</option><option value="true">true</option><option value="false">false</option></select></label>
      </div>
      <div className="model-json-grid provider-json-grid">
        {(["headers", "compat", "modelOverrides"] as const).map((key) => (
          <label key={key}><span>{key}</span><JsonValueEditor value={provider[key]} rows={4} onChange={(value) => props.onChange(updateField(provider, key, value))} /></label>
        ))}
      </div>
      <div className="provider-models-title"><strong>Models</strong><button onClick={() => setModels([...models, { id: "new-model" }])}><Plus size={13} />{t("settings.addModel")}</button></div>
      <div className="provider-models">
        {models.map((model, index) => (
          <ModelEditor
            key={`${String(model.id)}-${index}`}
            model={model}
            onChange={(next) => setModels(models.map((item, itemIndex) => itemIndex === index ? next : item))}
            onRemove={() => setModels(models.filter((_item, itemIndex) => itemIndex !== index))}
          />
        ))}
      </div>
    </section>
  );
}

export function ModelsSettingsForm(props: { value: JsonObject; disabled: boolean; onChange: (value: JsonObject) => void }) {
  const { t } = useI18n();
  const [newProviderId, setNewProviderId] = useState("");
  const providers = providersFrom(props.value);
  const addProvider = (): void => {
    const id = newProviderId.trim();
    if (!id || providers[id]) return;
    props.onChange(updateProvider(props.value, id, { api: "openai-completions", models: [] }));
    setNewProviderId("");
  };
  const renameProvider = (currentId: string, nextId: string): void => {
    if (!nextId || nextId === currentId || providers[nextId]) return;
    const withoutCurrent = updateProvider(props.value, currentId, undefined);
    props.onChange(updateProvider(withoutCurrent, nextId, providers[currentId] as JsonObject));
  };
  return (
    <fieldset className="models-settings" disabled={props.disabled}>
      <div className="add-provider">
        <input value={newProviderId} onChange={(event) => setNewProviderId(event.target.value)} placeholder="provider-id" />
        <button onClick={addProvider} disabled={!newProviderId.trim()}><Plus size={14} />{t("settings.addProvider")}</button>
      </div>
      {Object.entries(providers).map(([providerId, providerValue]) => isObject(providerValue) && (
        <ProviderEditor
          key={providerId}
          id={providerId}
          provider={providerValue}
          onRename={(nextId) => renameProvider(providerId, nextId)}
          onChange={(provider) => props.onChange(updateProvider(props.value, providerId, provider))}
          onRemove={() => props.onChange(updateProvider(props.value, providerId, undefined))}
        />
      ))}
    </fieldset>
  );
}
