/**
 * The exact text an atom becomes before it reaches the model, and the version of that decision.
 *
 * **This is a cross-repo contract.** `knowl-cloud` holds a byte-identical copy, because the
 * server still embeds on three occasions -- knowledge created in its web UI, a workspace reindex,
 * and query strings -- and those vectors land in the same corpus as client-published ones. Two
 * recipes means two vector spaces from one model, which nothing downstream can detect: the
 * fingerprint records provider, model, dtype and pooling, and every one of them would match.
 *
 * So the recipe travels as a fifth fingerprint field. Any change here -- field order, separators,
 * labels, which fields are included, or the token budget the embedder clips to -- is a new
 * version, and a vector built under version N is not comparable to one built under N+1.
 *
 * Version 1 is `knowl`'s historical text shape, adopted by `knowl-cloud` in the same change. The
 * server previously dropped tags entirely and left reasoning unlabelled, so every atom carrying
 * either produced a different vector on the two sides from an identical model.
 */
export const EMBED_RECIPE_VERSION = 1;

export type EmbedRecipeInput = {
  title: string;
  content: string;
  reasoning?: string | null;
  tags?: string[] | null;
};

/**
 * Labels rather than bare concatenation, deliberately.
 *
 * `Reasoning:` and `Tags:` tell the model what the following span is. Bare concatenation reads as
 * one continuous document, which ranks a rationale as though it were an assertion.
 *
 * Not truncated here. Clipping happens in the embedder, one layer down, so it is on the path
 * every text takes -- including query text -- rather than the one an author's atom happens to
 * travel.
 */
export function buildEmbedText(input: EmbedRecipeInput): string {
  const reasoning = input.reasoning ? `\nReasoning: ${input.reasoning}` : '';
  const tags = input.tags?.length ? `\nTags: ${input.tags.join(', ')}` : '';
  return `${input.title}\n${input.content}${reasoning}${tags}`;
}
