import { randomUUID } from 'node:crypto';

const IMPORTER_VERSION = 'session-memory/0.1.0';

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      return { historical_input: value };
    }
  }
  return {};
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

export function buildClaudeSession({
  events,
  id,
  cwd,
  branch = '',
  marker,
  importedAt = new Date(),
  uuidFactory = randomUUID,
}) {
  const rows = [];
  let offset = 0;
  const pendingToolIds = [];
  let parentUuid = null;
  const timestamp = () => new Date(importedAt.getTime() + offset++).toISOString();
  const common = () => ({
    sessionId: id,
    cwd: String(cwd).replace(/\\/g, '/'),
    gitBranch: branch,
    version: IMPORTER_VERSION,
  });
  const push = (row) => {
    const uuid = uuidFactory();
    rows.push({
      ...common(),
      parentUuid,
      uuid,
      isSidechain: false,
      userType: 'external',
      ...row,
    });
    parentUuid = uuid;
    return uuid;
  };

  for (const event of events || []) {
    if (event.kind === 'user_message') {
      push({
        type: 'user',
        timestamp: timestamp(),
        permissionMode: 'auto',
        origin: { kind: 'human' },
        message: { role: 'user', content: event.content },
      });
    } else if (event.kind === 'assistant_message') {
      push({
        type: 'assistant',
        timestamp: timestamp(),
        message: { role: 'assistant', content: [{ type: 'text', text: event.content }] },
      });
    } else if (event.kind === 'tool_call') {
      const toolId = `toolu_${String(uuidFactory()).replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`;
      const assistantUuid = push({
        type: 'assistant',
        timestamp: timestamp(),
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolId, name: event.name || 'historical_tool', input: asObject(event.arguments) }],
        },
      });
      pendingToolIds.push({ toolId, assistantUuid });
    } else if (event.kind === 'tool_result') {
      const pending = pendingToolIds.shift() || { toolId: 'historical_tool_call', assistantUuid: null };
      push({
        type: 'user',
        timestamp: timestamp(),
        sourceToolAssistantUUID: pending.assistantUuid,
        toolUseResult: {},
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: pending.toolId, content: asText(event.output) }],
        },
      });
    }
  }
  if (rows[0]) rows[0].sessionMemory = marker;
  return rows.map((row) => JSON.stringify(row));
}

export function buildCodexSession({
  events,
  id,
  cwd,
  branch = '',
  marker,
  importedAt = new Date(),
  uuidFactory = randomUUID,
}) {
  let offset = 0;
  let activeTurn = null;
  let lastAssistant = null;
  const pendingToolCallIds = [];
  const timestamp = () => new Date(importedAt.getTime() + offset++).toISOString();
  const metaTimestamp = timestamp();
  const rows = [{
    timestamp: metaTimestamp,
    type: 'session_meta',
    payload: {
      id,
      session_id: id,
      timestamp: metaTimestamp,
      cwd: String(cwd),
      originator: 'session-memory',
      history_mode: 'legacy',
      cli_version: IMPORTER_VERSION,
      source: 'cli',
      model_provider: 'openai',
      session_memory: marker,
      git: { branch, commit_hash: null, repository_url: null },
    },
  }];

  const finishTurn = () => {
    if (!activeTurn) return;
    const completed = timestamp();
    rows.push({
      timestamp: completed,
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: activeTurn,
        last_agent_message: lastAssistant,
        completed_at: Math.floor(Date.parse(completed) / 1000),
      },
    });
    activeTurn = null;
    lastAssistant = null;
  };

  for (const event of events || []) {
    if (event.kind === 'user_message') {
      finishTurn();
      activeTurn = uuidFactory();
      const started = timestamp();
      rows.push({ timestamp: started, type: 'event_msg', payload: { type: 'task_started', turn_id: activeTurn } });
      rows.push({
        timestamp: timestamp(),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: event.content }],
          internal_chat_message_metadata_passthrough: { turn_id: activeTurn },
        },
      });
      rows.push({ timestamp: timestamp(), type: 'event_msg', payload: { type: 'user_message', message: event.content } });
    } else if (event.kind === 'assistant_message') {
      lastAssistant = event.content;
      rows.push({
        timestamp: timestamp(),
        type: 'response_item',
        payload: {
          type: 'message',
          id: `msg_${String(uuidFactory()).replace(/-/g, '')}`,
          role: 'assistant',
          content: [{ type: 'output_text', text: event.content }],
          phase: 'final_answer',
        },
      });
      rows.push({ timestamp: timestamp(), type: 'event_msg', payload: { type: 'agent_message', message: event.content, phase: 'final_answer' } });
    } else if (event.kind === 'tool_call') {
      const toolCallId = uuidFactory();
      pendingToolCallIds.push(toolCallId);
      rows.push({
        timestamp: timestamp(),
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: toolCallId,
          name: event.name || 'historical_tool',
          arguments: JSON.stringify(asObject(event.arguments)),
        },
      });
    } else if (event.kind === 'tool_result') {
      const toolCallId = pendingToolCallIds.shift() || 'historical_tool_call';
      rows.push({
        timestamp: timestamp(),
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: toolCallId, output: event.output ?? '' },
      });
    }
  }
  finishTurn();
  return rows.map((row) => JSON.stringify(row));
}
