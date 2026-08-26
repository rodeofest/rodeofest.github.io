/* Lightweight Web Crypto helper for obscuring low-sensitivity secrets (currently:
   the Supabase anon key) at rest in the local secrets file.
   NOT a real security boundary: the passphrase below ships in this same file, so
   anyone who can read the app's source can derive the key and decrypt. It only
   stops a value from sitting in plain text if someone opens the JSON file directly.
   The real security boundary for login/data access is Supabase Auth + RLS, not this. */

const CRYPTO_PASSPHRASE = 'business-suite-local-secrets-v1';
const CRYPTO_SALT = new TextEncoder().encode('business-suite-static-salt');

let cachedKeyPromise = null;

function deriveKey() {
  if (!cachedKeyPromise) {
    cachedKeyPromise = crypto.subtle
      .importKey('raw', new TextEncoder().encode(CRYPTO_PASSPHRASE), 'PBKDF2', false, ['deriveKey'])
      .then((baseKey) =>
        crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: CRYPTO_SALT, iterations: 100000, hash: 'SHA-256' },
          baseKey,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        )
      );
  }
  return cachedKeyPromise;
}

function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToBuf(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function encryptSecret(plaintext) {
  const key = await deriveKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext || ''));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bufToBase64(combined);
}

async function decryptSecret(ciphertextB64) {
  if (!ciphertextB64) return '';
  const key = await deriveKey();
  const combined = base64ToBuf(ciphertextB64);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintextBuf);
}
