import test from 'node:test';
import assert from 'node:assert/strict';
import { cursorAllow, parseHookPayload } from '../src/normalize.mjs';

test('Claude Code / Codex shape', () => {
  assert.deepEqual(parseHookPayload({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/a/b.ts' } }), { type: 'pre', tool: 'Edit', input: { file_path: '/a/b.ts' } });
  assert.equal(parseHookPayload({ hook_event_name: 'PostToolUse' }).type, 'post');
  assert.equal(parseHookPayload({ hook_event_name: 'UserPromptSubmit' }).type, 'prompt');
  assert.equal(parseHookPayload({ hook_event_name: 'Stop' }).type, 'stop');
});

test('Qwen Code: Claude-shaped events with snake_case tool ids', () => {
  assert.deepEqual(parseHookPayload({ hook_event_name: 'PreToolUse', tool_name: 'write_file', tool_input: { file_path: '/q/a.ts', content: 'SECRET' } }), { type: 'pre', tool: 'Write', input: { file_path: '/q/a.ts', content: 'SECRET' } });
  assert.equal(parseHookPayload({ hook_event_name: 'PreToolUse', tool_name: 'run_shell_command', tool_input: { command: 'ls' } }).tool, 'Bash');
  assert.equal(parseHookPayload({ hook_event_name: 'PreToolUse', tool_name: 'read_file', tool_input: { absolute_path: '/q/b.md' } }).input.file_path, '/q/b.md');
  assert.equal(parseHookPayload({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/c.ts' } }).tool, 'Edit'); // Claude names pass through
});

test('Gemini CLI shape maps tool names', () => {
  assert.deepEqual(parseHookPayload({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'ls' } }), { type: 'pre', tool: 'Bash', input: { command: 'ls' } });
  assert.equal(parseHookPayload({ hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: { file_path: '/x' } }).tool, 'Read');
  assert.equal(parseHookPayload({ hook_event_name: 'BeforeTool', tool_name: 'replace', tool_input: {} }).tool, 'Edit');
  // unknown / MCP tools: show only the tool name, never its arguments
  assert.deepEqual(parseHookPayload({ hook_event_name: 'BeforeTool', tool_name: 'mcp_x_y', tool_input: { secret: 1 } }), { type: 'pre', tool: 'Bash', input: { command: 'mcp_x_y' } });
  assert.equal(parseHookPayload({ hook_event_name: 'BeforeAgent' }).type, 'prompt');
  assert.equal(parseHookPayload({ hook_event_name: 'AfterAgent' }).type, 'stop');
});

test('Cursor shape, including the Windows BOM', () => {
  assert.deepEqual(parseHookPayload({ hook_event_name: 'beforeShellExecution', command: 'git status' }), { type: 'pre', tool: 'Bash', input: { command: 'git status' } });
  assert.equal(parseHookPayload({ hook_event_name: 'afterFileEdit', file_path: '/a.ts' }).tool, 'Edit');
  assert.equal(parseHookPayload('﻿' + JSON.stringify({ hook_event_name: 'stop' })).type, 'stop');
  assert.equal(parseHookPayload({ hook_event_name: 'somethingNew' }), null);
});

test('Cursor before-hooks are always allowed; other tools get no stdout', () => {
  assert.match(cursorAllow({ hook_event_name: 'beforeShellExecution', conversation_id: 'c' }), /"permission":"allow"/);
  assert.equal(cursorAllow({ hook_event_name: 'PreToolUse', session_id: 's' }), null);
  assert.equal(cursorAllow({ hook_event_name: 'BeforeTool' }), null);
});
