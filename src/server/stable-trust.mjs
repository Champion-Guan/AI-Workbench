// Bootstrap/rotation is an explicit reviewed source change. Never load trust
// keys from a downloaded release, preference, URL or environment variable.
export const STABLE_TRUSTED_KEYS = Object.freeze({
  // Owner-approved bootstrap, 2026-10-11. SHA-256 of Ed25519 SPKI DER.
  '61d0312290a5ac3688099d26d595e619161fcf34bcc582262c5ab26f1c20be00': `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA+RK0sR39Ihkd0tQOkx7Ay7Z2cZa9Jqt6VK/95sMYTTU=
-----END PUBLIC KEY-----
`,
});
