import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

function keyFromMaterial(material: string): Buffer {
  return createHash("sha256").update(`dockyard-oauth-seal:${material}`).digest();
}

/** AES-256-GCM seal. Returns plaintext unchanged if keyMaterial empty. */
export function sealSecret(plain: string, keyMaterial: string): string {
  if (!plain) return plain;
  if (!keyMaterial) return plain;
  if (plain.startsWith(PREFIX)) return plain;
  const key = keyFromMaterial(keyMaterial);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64url");
}

/** Open sealed secret; plaintext tokens pass through for migration. */
export function openSecret(stored: string, keyMaterial: string): string {
  if (!stored) return stored;
  if (!stored.startsWith(PREFIX)) return stored;
  if (!keyMaterial) {
    throw new Error("TOKEN_ENCRYPTION_KEY (or ADMIN_TOKEN) required to decrypt secrets");
  }
  const key = keyFromMaterial(keyMaterial);
  const raw = Buffer.from(stored.slice(PREFIX.length), "base64url");
  if (raw.length < 12 + 16 + 1) throw new Error("Invalid sealed secret");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function isSealedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}
