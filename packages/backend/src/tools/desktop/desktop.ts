/**
 * Desktop Control Tool
 *
 * Gives the AI agent native OS-level control over the computer:
 *   - Mouse movement and clicks
 *   - Keyboard key presses and shortcuts
 *   - Typing text (ASCII and Unicode)
 *   - Full-screen or region screenshot (returned as an image)
 *
 * Requires Python + pyautogui:
 *   pip install pyautogui pillow
 *   # Windows also needs: pip install pywin32
 */

import * as path from 'node:path';
import type { Tool, ToolResult } from '../types.js';
import { spawnPython, PYTHON_SCRIPTS_DIR } from '../../services/python-env.js';
import { desktopArgsFile } from './args-file.js';
import {
  execToolRefusal,
  isExecToolsEnabled,
  minimalChildEnv,
  safeChildCwd,
} from '../exec-policy.js';

// ─── Python script runner ─────────────────────────────────────────────────────

const SCRIPT_PATH = path.join(
  PYTHON_SCRIPTS_DIR,
  'tools',
  'desktop',
  'desktop.py',
);

function runDesktopScript(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let ipc: ReturnType<typeof desktopArgsFile> | undefined;
    const cleanup = () => {
      try { ipc?.cleanup(); } catch { console.warn('[Desktop] Could not remove private helper arguments'); }
    };
    let child: ReturnType<typeof spawnPython>;
    try {
      const cwd = safeChildCwd();
      ipc = desktopArgsFile(args);
      child = spawnPython(SCRIPT_PATH, ['--args-file', ipc.file], {
        baseEnv: minimalChildEnv(),
        cwd,
      });
    } catch {
      cleanup();
      return reject(new Error('Could not start the desktop helper'));
    }

    let stdout = '';
    let stderr = '';

    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    child.on('close', (code) => {
      cleanup();

      if (code !== 0) {
        return reject(new Error(stderr.trim() || `Process exited with code ${code}`));
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed?.success === false) {
          return reject(new Error(parsed.error ?? 'Unknown Python error'));
        }
        return resolve(parsed);
      } catch {
        return reject(new Error(`Could not parse Python output: ${stdout.trim()}`));
      }
    });

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export const desktopControlTool: Tool = {
  name: 'desktop_control',
  description: `Control the computer at the OS level: move the mouse, click, type text, press keyboard shortcuts, and take screenshots.

Use this tool to interact with any application running on the screen — not just the terminal or browser, but any GUI application: file managers, text editors, desktop apps, games, etc.

Available actions:
  • get_screens         – List all connected monitors: index, left, top, width, height
  • get_active_window   – Return the active window title, its position, and WHICH SCREEN it is on (screen index)
  • show_indicator      – Show a glowing blue border around a specific monitor AND moves the mouse to its center (tells the user which screen you are working on, and positions the mouse ready to interact)
  • hide_indicator      – Remove the border when done
  • screenshot          – Capture the screen; pass screen=0/1/2 for a specific monitor, omit for all combined
  • mouse_move          – Move the mouse cursor to absolute screen coordinates (x, y)
  • mouse_click         – Click at (x, y); supports left/right/middle button and double-click
  • scroll              – Scroll the mouse wheel at (x, y): amount > 0 = up, amount < 0 = down
  • drag                – Click-and-drag from (start_x, start_y) to (end_x, end_y)
  • key_press           – Press a single key or keyboard shortcut (e.g. "enter", "ctrl+c", "alt+tab")
  • type_text           – Type a string of text (works with ASCII and Unicode / Arabic)
  • wait                – Pause for N seconds (use after launching an app so it has time to open)

Multi-monitor workflow:
  1. Call get_screens → learn every monitor's index + pixel offset (left/top)
  2. Launch the app (exec), wait, then call get_active_window → tells you which screen=N it opened on
  3. Call show_indicator(screen=N) → user sees which screen you are working on
  4. Use screenshot(screen=N) to see only that screen
  5. All mouse coordinates are ABSOLUTE (add the monitor's left/top offset when clicking on non-primary screens)
  6. Call hide_indicator() when the task is fully complete`,

  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['mouse_move', 'mouse_click', 'scroll', 'drag', 'key_press', 'type_text', 'screenshot', 'get_screens', 'get_active_window', 'show_indicator', 'hide_indicator', 'wait'],
        description: 'The desktop action to perform',
      },
      x: {
        type: 'number',
        description: 'Horizontal screen coordinate in pixels (required for mouse_move and mouse_click)',
      },
      y: {
        type: 'number',
        description: 'Vertical screen coordinate in pixels (required for mouse_move and mouse_click)',
      },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'Mouse button to use for mouse_click (default: "left")',
      },
      clicks: {
        type: 'number',
        description: 'Number of clicks: 1 for single-click, 2 for double-click (default: 1)',
      },
      keys: {
        type: 'string',
        description: 'Key or shortcut for key_press, e.g. "enter", "escape", "ctrl+c", "ctrl+alt+del"',
      },
      text: {
        type: 'string',
        description: 'Text to type for type_text action (supports Unicode/Arabic)',
      },
      interval: {
        type: 'number',
        description: 'Seconds between keystrokes for type_text (default: 0.03)',
      },
      amount: {
        type: 'number',
        description: 'Scroll amount for scroll action: positive = scroll up, negative = scroll down (default: 3)',
      },
      start_x: {
        type: 'number',
        description: 'Drag start X coordinate in pixels (required for drag)',
      },
      start_y: {
        type: 'number',
        description: 'Drag start Y coordinate in pixels (required for drag)',
      },
      end_x: {
        type: 'number',
        description: 'Drag end X coordinate in pixels (required for drag)',
      },
      end_y: {
        type: 'number',
        description: 'Drag end Y coordinate in pixels (required for drag)',
      },
      duration: {
        type: 'number',
        description: 'Drag duration in seconds (default: 0.4). Increase for smoother / slower drag.',
      },
      screen: {
        type: 'number',
        description: 'Monitor index for screenshot / show_indicator: 0 = primary, 1 = second, etc. Omit (or -1) for all combined (screenshot only).',
      },
      color: {
        type: 'string',
        description: 'Border color for show_indicator, as a hex string (default: "#0066ff")',
      },
      thickness: {
        type: 'number',
        description: 'Border thickness in pixels for show_indicator (default: 5)',
      },
      seconds: {
        type: 'number',
        description: 'Number of seconds to wait for the wait action (default: 1)',
      },
      region: {
        type: 'object',
        description: 'Capture region for screenshot: { left, top, width, height }. Omit for full screen.',
        properties: {
          left:   { type: 'number', description: 'Left edge in pixels' },
          top:    { type: 'number', description: 'Top edge in pixels' },
          width:  { type: 'number', description: 'Width in pixels' },
          height: { type: 'number', description: 'Height in pixels' },
        },
        required: ['left', 'top', 'width', 'height'],
      },
    },
    required: ['action'],
    examples: [
      {
        action: 'screenshot',
        description: 'Capture full screen screenshot',
      },
      {
        action: 'click',
        x: 500,
        y: 300,
        description: 'Click at specific coordinates (500, 300)',
      },
      {
        action: 'type',
        text: 'Hello World',
        description: 'Type text using keyboard',
      },
      {
        action: 'open_app',
        app: 'notepad',
        description: 'Open Notepad application',
      },
    ],
  },

  async execute(params): Promise<ToolResult> {
    const { action } = params;

    // SECURITY: exec-class tools are off unless AGENT_EXEC_TOOLS=true (S0-Q.5)
    if (!isExecToolsEnabled()) return execToolRefusal('desktop_control');

    console.log(`[DesktopControl] 🖥️  action=${action}`, params);

    try {
      const result = await runDesktopScript(params);

      // Screenshot: return image content block
      if (action === 'screenshot' && typeof result.image === 'string') {
        // Python script saves as JPEG now (smaller = fewer tokens for Claude)
        const mediaType = result.format === 'jpeg' ? 'image/jpeg' : 'image/png';
        return {
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: result.image,
              },
            },
            {
              type: 'text',
              text: `Screenshot captured: ${result.width}×${result.height} px`,
            },
          ],
          details: { width: result.width, height: result.height },
        };
      }

      // All other actions: simple confirmation text
      const actionLabel: Record<string, string> = {
        mouse_move:  `Mouse moved to (${params.x}, ${params.y})`,
        mouse_click: `${params.clicks === 2 ? 'Double-click' : 'Click'} (${params.button ?? 'left'}) at (${params.x}, ${params.y})`,
        scroll:      `Scrolled ${(params.amount as number) > 0 ? 'up' : 'down'} ${Math.abs(params.amount as number ?? 3)} at (${params.x}, ${params.y})`,
        drag:        `Dragged from (${params.start_x}, ${params.start_y}) to (${params.end_x}, ${params.end_y})`,
        key_press:   `Key pressed: ${params.keys}`,
        type_text:   `Typed ${(params.text as string)?.length ?? 0} characters`,
        wait:        `Waited ${params.seconds ?? 1} seconds`,
        get_screens:        `Found ${(result as any).count ?? '?'} monitor(s)`,
        get_active_window:  `Active window: "${(result as any).title ?? ''}" on screen ${(result as any).screen ?? '?'}`,
        show_indicator:     `Indicator shown on screen ${(result as any).screen ?? '?'} — Monitor offset: left=${(result as any).monitor?.left ?? 0}, top=${(result as any).monitor?.top ?? 0} — IMPORTANT: all click/scroll coordinates must be ABSOLUTE (add left offset to local X, add top offset to local Y)`,
        hide_indicator:     `Indicator hidden`,
      };

      return {
        content: [{ type: 'text', text: `✅ ${actionLabel[action] ?? action}` }],
        details: result,
      };

    } catch (error: any) {
      console.error(`[DesktopControl] ❌ ${error.message}`);

      // Friendly error for missing dependency
      if (error.message.includes('pyautogui') || error.message.includes('No module named')) {
        return {
          content: [{
            type: 'text',
            text: [
              '❌ Desktop control requires **pyautogui**.',
              '',
              'Install it with:',
              '```',
              'pip install pyautogui pillow' + (process.platform === 'win32' ? ' pywin32' : ''),
              '```',
            ].join('\n'),
          }],
          error: 'pyautogui not installed',
        };
      }

      return {
        content: [{ type: 'text', text: `❌ Desktop control failed: ${error.message}` }],
        error: error.message,
      };
    }
  },
};
