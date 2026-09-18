export type CartConfiguration = { name: string; value: string }[];

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function dimension(value: unknown): number | undefined {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !/^\d+(?:\.\d+)?$/.test(String(value))
  )
    return;
  const number = Number(value);
  return Number.isFinite(number) && number <= Number.MAX_SAFE_INTEGER
    ? number
    : undefined;
}

function unit(value: unknown): "mm" | "cm" | "in" | undefined {
  if (value === "inches" || value === "in") return "in";
  if (value === "mm" || value === "cm") return value;
}

/** Display-only projection of the saved line, independent of the current PDP. */
export function cartLineConfiguration(
  item: Record<string, unknown>,
): CartConfiguration {
  const configuration: CartConfiguration = [];
  const seen = new Set<string>();
  function append(name: unknown, value: unknown) {
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.trimStart().startsWith("_") ||
      name.length > 150 ||
      !["string", "number", "boolean"].includes(typeof value) ||
      (typeof value === "number" && !Number.isFinite(value))
    )
      return;
    const text = String(value).trim();
    if (!text || text.length > 1000 || configuration.length >= 50) return;
    const label = name.trim();
    const key = JSON.stringify([label, text]);
    if (seen.has(key)) return;
    seen.add(key);
    configuration.push({ name: label, value: text });
  }

  const properties = object(item.properties) ? item.properties : undefined;
  if (properties) {
    // HD's theme serializer stores customer selections in these private fields.
    // Decode only their display values; IDs, pricing and linked-item metadata
    // stay private. These fields never enter Roman's tool/approval snapshots.
    const userUnit = unit(properties._user_unit);
    const baseUnit = unit(properties._unit);
    for (const [axis, label] of [
      ["width", "Width"],
      ["drop", "Drop"],
    ]) {
      let value = userUnit
        ? dimension(properties[`_user_unit_${axis}`])
        : undefined;
      let selectedUnit = userUnit;
      if (value !== undefined && userUnit === "in") {
        const fraction = dimension(
          properties[`_user_unit_${axis}_inches`] ?? 0,
        );
        value =
          fraction !== undefined && fraction < 1 ? value + fraction : undefined;
      }
      if (value === undefined) {
        value = baseUnit ? dimension(properties[`_${axis}`]) : undefined;
        selectedUnit = baseUnit;
      }
      if (value !== undefined && value > 0 && selectedUnit)
        append(label, `${value} ${selectedUnit}`);
    }
    append("Size", properties._preset_size_name);
    const encoded = properties._selected_features_data;
    if (typeof encoded === "string" && encoded.length <= 50_000) {
      let features: unknown;
      try {
        features = JSON.parse(encoded);
      } catch {
        // Invalid optional theme metadata must not hide the cart line.
      }
      if (Array.isArray(features))
        for (const feature of features.slice(0, 50)) {
          if (
            !object(feature) ||
            feature.feature_label === "Measurement Placeholder"
          )
            continue;
          const label = feature.feature_option_label;
          const selected = dimension(feature.selected_value);
          append(
            feature.feature_label,
            typeof label === "string" && selected !== undefined
              ? `${label}: ${selected}`
              : label,
          );
        }
    }
  }

  if (Array.isArray(item.options_with_values))
    for (const option of item.options_with_values.slice(0, 50)) {
      if (!object(option)) continue;
      if (option.name === "Title" && option.value === "Default Title") continue;
      append(option.name, option.value);
    }
  if (properties)
    for (const [name, value] of Object.entries(properties)) append(name, value);
  return configuration;
}
