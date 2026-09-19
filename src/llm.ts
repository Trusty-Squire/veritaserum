/**
 * TYPESAFE_API_KEY for Jev (typesafe.ai System One). Presence is the opt-in.
 * The value must never be logged, written to a fixture, or placed on argv —
 * callers put it in an Authorization header only.
 */
export function typesafeApiKey(): string | undefined {
  const v = process.env.TYPESAFE_API_KEY;
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed ? trimmed : undefined;
}
