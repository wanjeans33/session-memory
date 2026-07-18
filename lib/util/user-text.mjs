const INJECT_PREFIXES = [
  '# AGENTS.md',
  '<INSTRUCTIONS',
  '<permissions',
  '<user_instructions',
  '<environment_context',
  '<recommended_plugins',
  '<apps_instructions',
  '<plugins_instructions',
  '<skills_instructions',
  '<collaboration_mode',
  '<multi_agent_mode',
  '<system',
  '<context',
  '## Memory',
  'Base directory for this skill:',
];

const SESSION_MEMORY_BOOLEAN_ARGS = new Set([
  '--all', '--current', '--commit', '--publish', '--list', '--import', '--pending', '--force',
  '--help', '--yes',
]);

const SESSION_MEMORY_VALUE_ARGS = new Set([
  '--ids', '--revision', '--targets', '--author', '--actor', '--device', '--scope', '--role',
  '--owner', '--source-author', '--source-role', '--cwd', '--sessions-dir', '--projects-dir',
  '--desktop-sessions-dir', '--codex-session-id', '--repo', '--days',
]);

function unwrapCommandText(text) {
  const original = String(text ?? '');
  const commandName = original.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/i)?.[1]?.trim();
  if (!commandName) return original;
  const commandArgs = original.match(/<command-args>\s*([^<]*?)\s*<\/command-args>/i)?.[1]?.trim();
  return `${commandName}${commandArgs ? ` ${commandArgs}` : ''}`;
}

export function isSessionMemoryControlText(text) {
  const tokens = unwrapCommandText(text).trim().split(/\s+/).filter(Boolean);
  if (!/^[$\/]session-memory$/i.test(tokens[0] || '')) return false;
  if (!/^(save|read|get)$/i.test(tokens[1] || '')) return false;
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index].toLowerCase();
    if (SESSION_MEMORY_BOOLEAN_ARGS.has(token) || /^(all|current|mine|team)$/i.test(token)) continue;
    const [name, inlineValue] = token.split('=', 2);
    if (!SESSION_MEMORY_VALUE_ARGS.has(name)) return false;
    if (inlineValue !== undefined) continue;
    if (!tokens[index + 1] || tokens[index + 1].startsWith('--')) return false;
    index += 1;
  }
  return true;
}

export function cleanRealUserText(text) {
  if (!text) return null;
  const original = unwrapCommandText(text);
  if (isSessionMemoryControlText(original)) return null;
  const value = original.trimStart();
  if (value.length === 0 || INJECT_PREFIXES.some((prefix) => value.startsWith(prefix))) return null;
  return original;
}

export function isRealUserText(text) {
  return cleanRealUserText(text) !== null;
}

export function firstRealInputText(content) {
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (item?.type === 'input_text') {
      const text = cleanRealUserText(item.text);
      if (text) return text;
    }
  }
  return null;
}
