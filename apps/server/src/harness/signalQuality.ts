/**
 * Lightweight, provider-neutral interpretation of user feedback for Harness.
 * Keep these phrases conservative: completion is evidence that a run ended, while
 * validation requires an explicit user indication that the result is right.
 */

const normalize = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const correctionPatterns = [
  // English
  /^(?:no[,!.?]|no\s+(?:that's|that|it|this|please)|no$)\b/,
  /\b(?:wrong|incorrect|instead|missed|redo|fix|don't|do not|not what i asked|that's not|that is not)\b/,
  // French
  /^(?:non[,!.?]|non\s+(?:ce|c'est|je|tu)|non$)\b/,
  /\b(?:faux|incorrect|plutot|a la place|oublie|oubliee|manque|refais|corrige|ce n'est pas|ce n'est vraiment pas|pas ce que j'ai demande|ce n'est pas ce que je voulais)\b/,
  // Spanish
  /^(?:no[,!.?]|no\s+(?:es|era|fue|lo|me|te|quiero)|no$)\b/,
  /\b(?:mal|incorrecto|incorrecta|en vez de|en lugar de|falto|olvidaste|rehaz|corrige|no es lo que pedi|no era eso|eso no es)\b/,
];

const validationPatterns = [
  // English: avoid treating a bare "thanks" or "done" as acceptance.
  /\b(?:looks good|that looks good|this is correct|that's correct|that is correct|that works|this works|exactly what i wanted|that's what i asked for|perfect,? thanks)\b/,
  // French
  /\b(?:c'est correct|c'est bon|ca marche|cela fonctionne|parfait|exactement ce que je voulais|c'est bien ce que j'ai demande)\b/,
  // Spanish
  /\b(?:esta correcto|esta correcta|esta bien|funciona|perfecto|perfecta|exactamente lo que queria|eso era lo que pedi|justo lo que necesitaba)\b/,
];

/** True when a user message explicitly corrects or redirects the agent (EN, FR, ES). */
export function isCorrectionPrompt(text: string): boolean {
  const normalized = normalize(text);
  return correctionPatterns.some((pattern) => pattern.test(normalized));
}

/**
 * A completed run is only considered validated when a later user message clearly
 * accepts the result. Otherwise it remains merely completed.
 */
export function classifySuccessfulRun(
  subsequentUserText?: string,
): "completed" | "validated_success" {
  if (!subsequentUserText) return "completed";
  const normalized = normalize(subsequentUserText);
  return validationPatterns.some((pattern) => pattern.test(normalized))
    ? "validated_success"
    : "completed";
}
