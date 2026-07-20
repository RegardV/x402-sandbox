// Minimal encrypted keystore: a private key sealed with a passphrase (scrypt + AES-256-GCM).
// No plaintext key on disk, no key in env. Decrypted only in memory at startup.
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const N = 16384; // scrypt cost

export function sealKey(privateKey, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  return {
    v: 1,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ct: ct.toString("hex"),
  };
}

export function openKey(keystore, passphrase) {
  const key = scryptSync(passphrase, Buffer.from(keystore.salt, "hex"), 32, { N });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(keystore.iv, "hex"));
  decipher.setAuthTag(Buffer.from(keystore.tag, "hex"));
  const pt = Buffer.concat([decipher.update(Buffer.from(keystore.ct, "hex")), decipher.final()]);
  return pt.toString("utf8");
}

export function writeKeystore(path, privateKey, passphrase) {
  writeFileSync(path, JSON.stringify(sealKey(privateKey, passphrase), null, 2), { mode: 0o600 });
}

export function readKeystore(path, passphrase) {
  return openKey(JSON.parse(readFileSync(path, "utf8")), passphrase);
}
