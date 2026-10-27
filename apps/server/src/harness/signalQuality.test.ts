import { describe, expect, it } from "@effect/vitest";
import { classifySuccessfulRun, isCorrectionPrompt } from "./signalQuality.ts";

describe("Harness signal quality", () => {
  it.each([
    "No, that's not what I asked for.",
    "Wrong approach; use the other API instead.",
    "Non, ce n'est pas ce que j'ai demandé.",
    "Tu as oublié le cas où la liste est vide.",
    "No era eso; faltó incluir los tests.",
    "En vez de borrar el archivo, actualízalo.",
  ])("recognizes a correction: %s", (text) => {
    expect(isCorrectionPrompt(text)).toBe(true);
  });

  it.each(["Thanks!", "Done.", "No worries, that is fine.", "Merci, c'est utile.", "Gracias."])(
    "does not mistake generic or incidental feedback for a correction: %s",
    (text) => {
      expect(isCorrectionPrompt(text)).toBe(false);
    },
  );

  it.each([
    "Looks good, that's exactly what I wanted.",
    "C'est parfait, ça marche.",
    "Está bien, funciona perfecto.",
  ])("marks explicit acceptance as validated: %s", (text) => {
    expect(classifySuccessfulRun(text)).toBe("validated_success");
  });

  it.each([undefined, "", "Thanks!", "Run finished.", "No, please try again."])(
    "keeps a run merely completed without explicit acceptance: %s",
    (text) => {
      expect(classifySuccessfulRun(text)).toBe("completed");
    },
  );
});
