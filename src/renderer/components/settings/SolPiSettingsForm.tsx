import { Package } from "lucide-react";
import type { JsonObject } from "@shared/settings-contracts";
import { useI18n } from "../../i18n/i18n";

function updateFeature(value: JsonObject, key: "actionFusion" | "observationPack", enabled: boolean): JsonObject {
  return { ...value, version: 1, [key]: enabled };
}

export function SolPiSettingsForm(props: {
  value: JsonObject;
  disabled: boolean;
  onChange: (value: JsonObject) => void;
}) {
  const { t } = useI18n();
  const setFeature = (key: "actionFusion" | "observationPack", enabled: boolean): void => {
    props.onChange(updateFeature(props.value, key, enabled));
  };

  return (
    <fieldset className="fff-settings" disabled={props.disabled}>
      <div className="fff-status loaded">
        <Package size={15} />
        <div>
          <strong>{t("settings.solPackage")}</strong>
          <span>{t("settings.solPackageHint")}</span>
        </div>
      </div>
      <section className="settings-group">
        <h3>{t("settings.solEfficiency")}</h3>
        <div className="settings-fields">
          <label className="settings-field">
            <span><code>actionFusion</code><small>{t("settings.solActionFusionHint")}</small></span>
            <select
              value={String(props.value.actionFusion === true)}
              onChange={(event) => setFeature("actionFusion", event.target.value === "true")}
            >
              <option value="false">false</option>
              <option value="true">true</option>
            </select>
          </label>
          <label className="settings-field">
            <span><code>observationPack</code><small>{t("settings.solObservationPackHint")}</small></span>
            <select
              value={String(props.value.observationPack === true)}
              onChange={(event) => setFeature("observationPack", event.target.value === "true")}
            >
              <option value="false">false</option>
              <option value="true">true</option>
            </select>
          </label>
        </div>
      </section>
      <p className="settings-readonly">{t("settings.solSecurityNote")}</p>
    </fieldset>
  );
}
