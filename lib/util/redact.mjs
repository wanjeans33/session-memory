// Best-effort secret redaction applied to transcript lines before they are written.
// See DESIGN.md §5. This cannot be exhaustive; target project repositories must stay private.
const RULES = [
  [/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED:anthropic-key]'],
  [/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED:openai-key]'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/g, '[REDACTED:github-token]'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED:aws-key]'],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED:jwt]'],
  [/(authorization"?\s*[:=]\s*"?\s*bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED:bearer]'],
  [/((?:password|passwd|api[_-]?key|secret|access[_-]?token|token)"?\s*[:=]\s*"?)[^"\s,}]{6,}/gi, '$1[REDACTED]'],
];

export function redact(text) {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

function redactValue(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  }
  return value;
}

// Redact parsed string values so replacements can never break JSON escaping.
export function redactJsonLine(line) {
  if (typeof line !== 'string') return redactValue(line);
  try {
    return JSON.stringify(redactValue(JSON.parse(line)));
  } catch {
    return redact(line); // Preserve a live partial final row; canonical parsing decides whether it is allowed.
  }
}
