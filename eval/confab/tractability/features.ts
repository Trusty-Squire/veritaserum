/** Embedding-derived features for a deleted eval cell. src/embed.ts is gone. */
export interface Example {
  id: string;
  scenario: string;
  theme: string;
  label: "wrong-closure" | "right-closure";
  provenance: string;
  finalMessage: string;
  receipts: string;
}

export const ANCHORS = [] as const;

export async function featurize(): Promise<never> {
  throw new Error("Removed: ollama embedding features. The shipped classifier is Jev.");
}
