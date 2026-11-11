import fs from "node:fs";

// Guide section 4 prices tokens with the census token list. The rows needed for the public sets
// are carried next to this file (its `source` field says where they came from), so no check here
// depends on a network call or on today's prices.
const { rows } = JSON.parse(fs.readFileSync(new URL("./prices.json", import.meta.url), "utf8"));
const byAsset = new Map(rows.map((t) => [t.assetId, t]));

/**
 * The census row that prices `token`, or null when it has no price. Native NEAR is priced as
 * wrap.near, a multi-token by its full `nep245:` id, any other token as `nep141:<id>` or its
 * 1Click form. The first row found decides, even when it carries no price, so a token is never
 * priced through a second, looser match.
 */
export function priceRow(token) {
  let t;
  if (token === "near") t = byAsset.get("nep141:wrap.near");
  else if (token.startsWith("nep245:")) t = byAsset.get(token);
  else t = byAsset.get(`nep141:${token}`) || byAsset.get(`1cs_v1:near:nep141:${token}`);
  return t && typeof t.price === "number" && t.price > 0 ? t : null;
}

/** The USD value of a whole-unit amount, or null when the token has no price or the amount is not whole units. */
export function dollars(token, amount) {
  const t = typeof token === "string" ? priceRow(token) : null;
  if (!t || typeof amount !== "string" || !/^[0-9]+$/.test(amount)) return null;
  return (Number(BigInt(amount)) / Math.pow(10, t.decimals)) * t.price;
}
