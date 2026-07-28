const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/iu,
  /\b(?:password|passwd|secret|token|api[_ -]?key)\s*[:=]\s*["']?[^\s"']{8,}/iu,
] as const;

export function rejectLikelySecrets(value: string): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error(
      "possible password, private key, or token detected; store only a secret-manager reference",
    );
  }
}
