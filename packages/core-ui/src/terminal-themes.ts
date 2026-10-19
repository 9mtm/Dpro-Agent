import type { TerminalFont, TerminalTheme } from './terminal-contract.js';

/** A full terminal palette: screen colors plus the 16 ANSI colors. */
export type Palette = {
  label: string; dark: boolean; background: string; foreground: string; cursor: string; cursorAccent: string; selectionBackground: string;
  black: string; red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string; brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
};

/** Dpro Agent's own terminal themes. */
export const PALETTES: Record<TerminalTheme, Palette> = {
  'dpro-night': { label: 'Dpro Agent Night', dark: true, background: '#121417', foreground: '#dfe3ea', cursor: '#5b8cff', cursorAccent: '#121417', selectionBackground: '#2b3a5c',
    black: '#1c1f24', red: '#f16c75', green: '#7ccf8a', yellow: '#e8c46b', blue: '#5b8cff', magenta: '#c08cf5', cyan: '#5fc8d6', white: '#c9ced8',
    brightBlack: '#5c6370', brightRed: '#ff8a92', brightGreen: '#97e3a4', brightYellow: '#f5d68a', brightBlue: '#82a8ff', brightMagenta: '#d4a9fb', brightCyan: '#86dbe6', brightWhite: '#f4f6fa' },
  'dpro-day': { label: 'Dpro Agent Day', dark: false, background: '#fbfbfa', foreground: '#24292f', cursor: '#2f5fe0', cursorAccent: '#fbfbfa', selectionBackground: '#cfdcfb',
    black: '#24292f', red: '#c8303b', green: '#25803a', yellow: '#946200', blue: '#2f5fe0', magenta: '#8a3fcf', cyan: '#127a8a', white: '#6e7781',
    brightBlack: '#57606a', brightRed: '#e0434f', brightGreen: '#2f9a48', brightYellow: '#b07800', brightBlue: '#4a77f0', brightMagenta: '#a258e0', brightCyan: '#1993a6', brightWhite: '#8c959f' },
  graphite: { label: 'Graphite', dark: true, background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4', cursorAccent: '#1e1e1e', selectionBackground: '#3a3d41',
    black: '#2a2a2a', red: '#e06c6c', green: '#8fbf7f', yellow: '#d7ba7d', blue: '#7aa6da', magenta: '#c397d8', cyan: '#70c0b1', white: '#cccccc',
    brightBlack: '#6a6a6a', brightRed: '#f08080', brightGreen: '#a8d896', brightYellow: '#e8cf9a', brightBlue: '#9cc1ec', brightMagenta: '#d7b2e8', brightCyan: '#8fd6c8', brightWhite: '#f0f0f0' },
  midnight: { label: 'Midnight', dark: true, background: '#0b1020', foreground: '#c8d3f5', cursor: '#ff9e64', cursorAccent: '#0b1020', selectionBackground: '#28345c',
    black: '#141a2e', red: '#ff7a93', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#4a5378', brightRed: '#ff98aa', brightGreen: '#b5e08a', brightYellow: '#f0c58a', brightBlue: '#99b8ff', brightMagenta: '#ceb3ff', brightCyan: '#a0deff', brightWhite: '#dfe6ff' },
  ocean: { label: 'Ocean', dark: true, background: '#0f1e26', foreground: '#cfe3e8', cursor: '#4fd1c5', cursorAccent: '#0f1e26', selectionBackground: '#1f4250',
    black: '#16303b', red: '#f2777a', green: '#6fd08c', yellow: '#f6c96b', blue: '#5aa9e6', magenta: '#b48ead', cyan: '#4fd1c5', white: '#b9cdd3',
    brightBlack: '#4d6b77', brightRed: '#ff9496', brightGreen: '#8ee2a6', brightYellow: '#ffd98c', brightBlue: '#7ebff0', brightMagenta: '#c9a7c3', brightCyan: '#7ee3d9', brightWhite: '#eef6f8' },
  forest: { label: 'Forest', dark: true, background: '#141a14', foreground: '#d8e0cf', cursor: '#a3d977', cursorAccent: '#141a14', selectionBackground: '#2e3d2a',
    black: '#1d241c', red: '#e57373', green: '#a3d977', yellow: '#e6c86e', blue: '#7fb2d6', magenta: '#c49ac9', cyan: '#7cc7b2', white: '#c3ccb8',
    brightBlack: '#56614f', brightRed: '#f29191', brightGreen: '#bce892', brightYellow: '#f2d98f', brightBlue: '#9ccbe8', brightMagenta: '#d7b5db', brightCyan: '#9cdcc9', brightWhite: '#eef3e8' },
  paper: { label: 'Paper', dark: false, background: '#f6f1e7', foreground: '#3b3a36', cursor: '#b5542c', cursorAccent: '#f6f1e7', selectionBackground: '#e3d7bf',
    black: '#3b3a36', red: '#b03a2e', green: '#4f7a28', yellow: '#9a6a00', blue: '#2d5d9f', magenta: '#8e4585', cyan: '#2b7a78', white: '#7a7569',
    brightBlack: '#605b50', brightRed: '#c94b3e', brightGreen: '#5e8f32', brightYellow: '#b47d00', brightBlue: '#3b72bd', brightMagenta: '#a5569b', brightCyan: '#35918e', brightWhite: '#9b9587' },
  contrast: { label: 'High contrast', dark: true, background: '#000000', foreground: '#ffffff', cursor: '#ffff00', cursorAccent: '#000000', selectionBackground: '#3a3aff',
    black: '#000000', red: '#ff5555', green: '#55ff55', yellow: '#ffff55', blue: '#6b8cff', magenta: '#ff55ff', cyan: '#55ffff', white: '#e6e6e6',
    brightBlack: '#808080', brightRed: '#ff8080', brightGreen: '#80ff80', brightYellow: '#ffff80', brightBlue: '#99b0ff', brightMagenta: '#ff80ff', brightCyan: '#80ffff', brightWhite: '#ffffff' },
};

/** Font stacks; a font that is not installed falls back to the next one. */
export const FONTS: Record<TerminalFont, { label: string; stack: string }> = {
  system: { label: 'System mono', stack: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  'sf-mono': { label: 'SF Mono', stack: '"SF Mono", SFMono-Regular, ui-monospace, Menlo, monospace' },
  menlo: { label: 'Menlo', stack: 'Menlo, ui-monospace, monospace' },
  monaco: { label: 'Monaco', stack: 'Monaco, Menlo, ui-monospace, monospace' },
  jetbrains: { label: 'JetBrains Mono', stack: '"JetBrains Mono", ui-monospace, Menlo, monospace' },
  fira: { label: 'Fira Code', stack: '"Fira Code", ui-monospace, Menlo, monospace' },
  cascadia: { label: 'Cascadia Code', stack: '"Cascadia Code", ui-monospace, Menlo, monospace' },
  courier: { label: 'Courier', stack: '"Courier New", Courier, monospace' },
};
