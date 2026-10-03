// Turns the hook payloads of different agent tools into one small action vocabulary:
//   { type: 'pre', tool, input }   a tool is starting        (tool = a name Pixel Agents animates)
//   { type: 'post' }               that tool finished
//   { type: 'prompt' }             the user just sent a message → "responding to <user>"
//   { type: 'stop' }               the turn is over → idle
//   { type: 'start' | 'end' }      session lifecycle
// Shapes (all JSON on stdin):
//   Claude Code, Codex   {hook_event_name:'PreToolUse', tool_name, tool_input:{command|file_path}, …}
//   Gemini CLI           {hook_event_name:'BeforeTool'|'AfterTool'|'BeforeAgent'|'AfterAgent', tool_name, tool_input}
//   Cursor               {hook_event_name:'beforeShellExecution'|'beforeReadFile'|'afterFileEdit'|'beforeSubmitPrompt'|'stop', command|file_path}

// Gemini CLI tool names → Pixel Agents tool names.
const GEMINI_TOOLS = {
  run_shell_command: 'Bash', read_file: 'Read', read_many_files: 'Read', write_file: 'Write', replace: 'Edit',
  glob: 'Glob', list_directory: 'Glob', grep_search: 'Grep', search_file_content: 'Grep',
  web_fetch: 'WebFetch', google_web_search: 'WebSearch',
};

const pre = (tool, input) => ({ type: 'pre', tool, input });

export function parseHookPayload(raw) {
  const p = typeof raw === 'string' ? JSON.parse(raw.replace(/^﻿/, '')) : raw; // Cursor on Windows prefixes a BOM
  const ev = p.hook_event_name;
  switch (ev) {
    // Claude Code / Codex
    case 'PreToolUse': return pre(p.tool_name || 'Bash', p.tool_input ?? {});
    case 'PostToolUse': case 'PostToolUseFailure': return { type: 'post' };
    case 'UserPromptSubmit': return { type: 'prompt' };
    case 'Stop': return { type: 'stop' };
    case 'SessionStart': return { type: 'start' };
    case 'SessionEnd': return { type: 'end' };
    // Gemini CLI
    case 'BeforeTool': return pre(GEMINI_TOOLS[p.tool_name] ?? 'Bash', GEMINI_TOOLS[p.tool_name] ? (p.tool_input ?? {}) : { command: p.tool_name ?? 'tool' });
    case 'AfterTool': return { type: 'post' };
    case 'BeforeAgent': return { type: 'prompt' };
    case 'AfterAgent': return { type: 'stop' };
    // Cursor
    case 'beforeShellExecution': return pre('Bash', { command: p.command ?? '' });
    case 'afterShellExecution': return { type: 'post' };
    case 'beforeReadFile': return pre('Read', { file_path: p.file_path ?? '' });
    case 'afterFileEdit': return pre('Edit', { file_path: p.file_path ?? '' });
    case 'beforeMCPExecution': return pre('Bash', { command: p.tool_name ?? 'tool' });
    case 'beforeSubmitPrompt': return { type: 'prompt' };
    case 'stop': return { type: 'stop' };
    default: return null;
  }
}

/** Cursor's "before*" hooks wait for a verdict on stdout; we only observe, so always allow. */
export const cursorAllow = (p) => (/^before/.test(p.hook_event_name ?? '') && 'conversation_id' in p ? '{"continue":true,"permission":"allow"}' : null);
