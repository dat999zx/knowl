export interface DomainProfile {
  /** Lowercase id, `^[a-z][a-z0-9-]*$`. Matches the file name. */
  id: string;
  /** Full FILTER system prompt. */
  filter: string;
  /** Full EXTRACT system prompt, including how the 7 categories read in this domain. */
  extract: string;
  /** Full ASK system prompt. */
  ask: string;
  /** Full DERIVE system prompt, or null to skip truth derivation for this domain. */
  deriveTruth: string | null;
  /** Description of the filter's `pass` field. Absent keeps today's schema object unchanged. */
  passDescription?: string;
}
