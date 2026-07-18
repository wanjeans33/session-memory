const part = (value) => encodeURIComponent(String(value ?? ''));

// Stable across repeated saves of the same source session even when ended_at changes the digest filename.
export function sessionSourceKey(digest, base = '') {
  const identity = digest?.id || base;
  return `v1:${[
    digest?.tool,
    digest?.author,
    digest?.machine,
    identity,
  ].map(part).join(':')}`;
}
