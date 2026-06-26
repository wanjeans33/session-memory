// Encode an absolute path as a Claude Code project directory name
// (spaces, :, \, /, _, and . all become -). Matches the former Get-EncodedProject.
export function encodeProject(p) {
  return p.replace(/[ :\\/_.]/g, '-');
}

export function osName(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

// Split jsonl text into lines: drop trailing \r and a leading UTF-8 BOM (PowerShell-written
// files in this ecosystem can carry one, which would otherwise break JSON.parse on line 1).
export function splitLines(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines.length > 0 && lines[0].charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);
  return lines;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Parse a Claude transcript (array of jsonl lines) into the fields a digest needs.
// Claude CLI and Desktop share the same transcript format.
export function parseClaudeTranscript(lines) {
  const r = {
    id: null,
    started_at: null,
    ended_at: null,
    branch: null,
    cwd: null,
    version: null,
    turns: 0,
    first_prompt: null,
    files: [],
    tools: {},
  };
  const files = new Set();

  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    if (o.timestamp) {
      if (!r.started_at) r.started_at = o.timestamp;
      r.ended_at = o.timestamp;
    }
    if (o.sessionId && !r.id) r.id = o.sessionId;
    if (o.gitBranch && !r.branch) r.branch = o.gitBranch;
    if (o.cwd && !r.cwd) r.cwd = o.cwd;
    if (o.version && !r.version) r.version = o.version;

    if (o.type === 'user' && o.message && o.message.role === 'user') {
      const c = o.message.content;
      let text = null;
      if (typeof c === 'string') {
        text = c;
      } else if (Array.isArray(c)) {
        let isToolResult = false;
        for (const it of c) {
          if (it && it.type === 'tool_result') isToolResult = true;
          if (it && it.type === 'text' && !text) text = it.text;
        }
        if (isToolResult) text = null;
      }
      if (text && !text.startsWith('<')) {
        r.turns += 1;
        if (!r.first_prompt) r.first_prompt = text;
      }
    }

    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const it of o.message.content) {
        if (it && it.type === 'tool_use') {
          const n = it.name;
          if (n) r.tools[n] = (r.tools[n] ?? 0) + 1;
          if (n && EDIT_TOOLS.has(n) && it.input && it.input.file_path) {
            files.add(String(it.input.file_path));
          }
        }
      }
    }
  }

  r.files = [...files];
  return r;
}

// Make absolute file paths relative to root (forward slashes).
export function relFiles(files, root) {
  const rr = root.replace(/\\/g, '/');
  const rrLower = rr.toLowerCase();
  return (files ?? []).map((f) => {
    const fp = String(f).replace(/\\/g, '/');
    if (fp.toLowerCase().startsWith(rrLower)) return fp.slice(rr.length).replace(/^\/+/, '');
    return fp;
  });
}
