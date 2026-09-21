import type { ComposerContextId, ComposerContextKind } from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";

export interface ComposerContextReference {
  kind: ComposerContextKind;
  contextId: string;
  label: string;
}

/** Mirrors the contract's id pattern, which allows `:` and `.` for thread references. */
const CONTEXT_ID_PATTERN = /^[a-z0-9_.:-]{1,128}$/i;

/**
 * Two independent FNV-1a passes, one forward and one with a different offset basis over the
 * reversed input. 64 bits of digest, because the slug in front of it is truncated: two long
 * producer ids that agree on their first 48 characters are told apart by this alone.
 */
function fnv1a64(value: string): string {
  let forward = 0x811c9dc5;
  let reverse = 0x9dc5811c;
  for (let index = 0; index < value.length; index += 1) {
    forward ^= value.charCodeAt(index);
    forward = Math.imul(forward, 0x01000193) >>> 0;
    reverse ^= value.charCodeAt(value.length - 1 - index);
    reverse = Math.imul(reverse, 0x01000193) >>> 0;
  }
  return `${forward.toString(16).padStart(8, "0")}${reverse.toString(16).padStart(8, "0")}`;
}

/**
 * Producers mint ids in their own grammars (`pull-request-finding:42`,
 * `file-comment-<ms>-<n>`). A context id must survive a Markdown link and the wire
 * schema, so anything outside `[a-z0-9_-]` is folded into a readable slug plus a hash of
 * the original. Deterministic, so the same producer id always maps to the same context id.
 */
export function toComposerContextId(producerId: string): ComposerContextId {
  if (CONTEXT_ID_PATTERN.test(producerId)) return producerId as ComposerContextId;
  const slug = producerId
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug || "ctx"}-${fnv1a64(producerId)}` as ComposerContextId;
}

/** Raw producer IDs are always scoped, even when they already start with the kind name. */
export function toKindScopedComposerContextId(
  kind: ComposerContextKind,
  producerId: string,
): ComposerContextId {
  const prefix = `${kind}_`;
  return toComposerContextId(`${prefix}${producerId}`);
}

/** Only for importing canonical records: undo one namespace before rebuilding a draft. */
export function producerIdFromComposerContextId(
  kind: ComposerContextKind,
  contextId: string,
): string {
  const prefix = `${kind}_`;
  return contextId.startsWith(prefix) ? contextId.slice(prefix.length) : contextId;
}

export function formatInlineContextReference(reference: ComposerContextReference): string {
  return formatComposerContextReference({
    kind: reference.kind,
    contextId: reference.contextId as ComposerContextId,
    label: reference.label,
  });
}

export function collectInlineContextIds(prompt: string): string[] {
  return Array.from(
    new Set(collectComposerContextReferences(prompt).map((occurrence) => occurrence.contextId)),
  );
}

export function stripInlineContextReferences(prompt: string): string {
  return replaceComposerContextReferences(prompt, () => "");
}

function isBoundaryWhitespace(char: string | undefined): boolean {
  return char === undefined || char === " " || char === "\n" || char === "\t" || char === "\r";
}

export function inlineContextReferenceReplacement(
  prompt: string,
  selection: { start: number; end: number },
  references: ReadonlyArray<ComposerContextReference>,
): { start: number; end: number; text: string } {
  const start = Math.max(0, Math.min(prompt.length, Math.floor(selection.start)));
  const end = Math.max(start, Math.min(prompt.length, Math.floor(selection.end)));
  const needsLeadingSpace = !isBoundaryWhitespace(prompt[start - 1]);
  return {
    start,
    end: prompt[end] === " " ? end + 1 : end,
    text: `${needsLeadingSpace ? " " : ""}${references.map(formatInlineContextReference).join(" ")} `,
  };
}

export function insertInlineContextReference(
  prompt: string,
  cursorInput: number,
  reference: ComposerContextReference,
): { prompt: string; cursor: number } {
  const edit = inlineContextReferenceReplacement(prompt, { start: cursorInput, end: cursorInput }, [
    reference,
  ]);
  return {
    prompt: `${prompt.slice(0, edit.start)}${edit.text}${prompt.slice(edit.end)}`,
    cursor: edit.start + edit.text.length,
  };
}

export function appendInlineContextReference(
  prompt: string,
  reference: ComposerContextReference,
): string {
  return insertInlineContextReference(prompt, prompt.length, reference).prompt;
}

export function removeInlineContextReference(
  prompt: string,
  contextId: string,
): { prompt: string; cursor: number } {
  const occurrences = collectComposerContextReferences(prompt).filter(
    (candidate) => candidate.contextId === contextId,
  );
  if (occurrences.length === 0) return { prompt, cursor: prompt.length };
  let result = prompt;
  let cursor = prompt.length;
  for (const occurrence of occurrences.reverse()) {
    let { start, end } = occurrence;
    if (result[end] === " ") end += 1;
    else if (result[start - 1] === " ") start -= 1;
    result = `${result.slice(0, start)}${result.slice(end)}`;
    cursor = start;
  }
  if (cursor >= result.length) {
    result = result.trimEnd();
    cursor = result.length;
  }
  return { prompt: result, cursor };
}

export function ensureInlineContextReferences(
  prompt: string,
  references: ReadonlyArray<ComposerContextReference>,
): string {
  const referenced = new Set(collectInlineContextIds(prompt));
  let result = prompt;
  for (const reference of references) {
    if (referenced.has(reference.contextId)) continue;
    referenced.add(reference.contextId);
    result = appendInlineContextReference(result, reference);
  }
  return result;
}
