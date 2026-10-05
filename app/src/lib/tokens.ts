import tokens from "@/design-system/stockwoven-design-system/tokens.json";

/** A flat color token from tokens.json, for places CSS variables can't reach (metadata, manifest). */
export function colorToken(name: string): string {
  const value = tokens.color.tokens.find((t) => t.name === name)?.value;
  if (typeof value !== "string") throw new Error(`no flat color token "${name}"`);
  return value;
}
