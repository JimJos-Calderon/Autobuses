const ABBREVIATIONS: Record<string, string> = {
  AVDA: "Avda.",
  AVENIDA: "Avda.",
  CTRA: "Ctra.",
  "CTRA.": "Ctra.",
  RUA: "Rua",
  "RUA.": "Rua",
  C: "C/",
  "C.": "C/",
  CL: "C/",
  CALLE: "C/",
  PRAZA: "Praza",
  PLAZA: "Praza",
};

function isAllDigits(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

function toTitleWord(word: string): string {
  if (!word) return word;
  if (isAllDigits(word)) return word;
  const chunks = word.split(/([-\/])/g);
  return chunks
    .map((chunk) => {
      if (chunk === "-" || chunk === "/") return chunk;
      if (!chunk) return chunk;
      const lower = chunk.toLocaleLowerCase("es-ES");
      return lower.charAt(0).toLocaleUpperCase("es-ES") + lower.slice(1);
    })
    .join("");
}

function normalizeToken(token: string): string {
  const cleaned = token.replace(/[.,;:]+$/g, "");
  const suffix = token.slice(cleaned.length);
  const upper = cleaned.toLocaleUpperCase("es-ES");
  const known = ABBREVIATIONS[upper];
  const out = known ?? toTitleWord(cleaned);
  return `${out}${suffix}`;
}

/**
 * Convierte textos en mayusculas y espaciado inconsistente
 * a un formato legible para UI.
 * Ejemplo: "AVDA CASTRELOS 12" -> "Avda. Castrelos, 12"
 */
export function sanitizeTitle(input: string): string {
  const compact = input.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const normalized = compact
    .split(" ")
    .map((token) => normalizeToken(token))
    .join(" ");

  const parts = normalized.split(" ");
  const last = parts[parts.length - 1];
  if (parts.length > 1 && isAllDigits(last)) {
    const base = parts.slice(0, -1).join(" ").replace(/,\s*$/, "");
    return `${base}, ${last}`;
  }
  return normalized;
}

export function sanitizeNullableText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = sanitizeTitle(value);
  return clean || undefined;
}
