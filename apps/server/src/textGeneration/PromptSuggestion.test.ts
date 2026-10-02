import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { buildPromptSuggestionPrompt } from "./TextGenerationPrompts.ts";
import { sanitizePromptSuggestion, toJsonSchemaObject } from "./TextGenerationUtils.ts";

describe("prompt suggestions", () => {
  it.each([
    [9_000, 9_000, 3_000, 3_000],
    [50, 9_000, 50, 5_950],
    [9_000, 50, 5_950, 50],
    [9_000, 0, 6_000, 0],
    [0, 9_000, 0, 6_000],
  ])("bounds a %i/%i character excerpt", (userSize, replySize, userExpected, replyExpected) => {
    const { prompt } = buildPromptSuggestionPrompt({
      userMessage: "u".repeat(userSize),
      assistantMessage: "a".repeat(replySize),
    });
    const excerpt = prompt.split("Latest user message:\n")[1]!;
    const [user, reply] = excerpt.split("\n\nFinal assistant reply:\n");
    expect(user).toHaveLength(userExpected);
    expect(reply).toHaveLength(replyExpected);
    expect(user!.length + reply!.length).toBeLessThanOrEqual(6_000);
  });

  it("retains the request start and final reply end", () => {
    const { prompt } = buildPromptSuggestionPrompt({
      userMessage: `Fix login ${"x".repeat(8_000)} user tail`,
      assistantMessage: `reply start ${"y".repeat(8_000)} Test the remote callback.`,
    });
    expect(prompt).toContain("Fix login");
    expect(prompt).toContain("Test the remote callback.");
    expect(prompt).not.toContain("user tail");
    expect(prompt).not.toContain("reply start");
  });

  it("accepts nullable structured output", () => {
    const { outputSchema } = buildPromptSuggestionPrompt({ userMessage: "", assistantMessage: "" });
    expect(Schema.decodeSync(outputSchema)({ suggestion: null })).toEqual({ suggestion: null });
    expect(toJsonSchemaObject(outputSchema)).toMatchObject({
      required: ["suggestion"],
      additionalProperties: false,
    });
  });

  it.each([
    null,
    "",
    " Continue. ",
    "Tell me more",
    "What next?",
    "What should we do next?",
    "First action\nSecond action",
    "x".repeat(241),
    Array(31).fill("word").join(" "),
  ])("drops unusable output %s", (suggestion) =>
    expect(sanitizePromptSuggestion(suggestion)).toBeNull(),
  );

  it("keeps a concrete suggestion within the word and character bounds", () => {
    const suggestion = "  Add coverage for the remote login callback.  ";
    expect(sanitizePromptSuggestion(suggestion)).toBe(
      "Add coverage for the remote login callback.",
    );
    expect(sanitizePromptSuggestion(Array(30).fill("test").join(" "))).not.toBeNull();
    expect(sanitizePromptSuggestion("x".repeat(240))).toHaveLength(240);
  });
});
