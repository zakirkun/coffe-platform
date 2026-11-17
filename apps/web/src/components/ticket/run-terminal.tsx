'use client';

import '@xterm/xterm/css/xterm.css';
import type { RunOutputChunk } from '@coffe/contracts';
import type { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import { ApiRequestError, api } from '@/lib/api';
import { decodeBase64 } from '@/lib/base64';
import { getRealtimeClient, useChannel } from '@/lib/realtime';
import { SeqStream } from '@/lib/terminal-output';
import { cn } from '@/lib/utils';

/** Output pages fetched per REST request while catching up. */
const REPLAY_PAGE = 2_000;

const TERMINAL_THEME = {
  background: '#0b0d10',
  foreground: '#d7dae0',
  cursor: '#d7dae0',
  selectionBackground: '#3a3f4b',
  black: '#1e2127',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#d19a66',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#abb2bf',
  brightBlack: '#5c6370',
  brightRed: '#e06c75',
  brightGreen: '#98c379',
  brightYellow: '#d19a66',
  brightBlue: '#61afef',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff',
};

interface RunTerminalProps {
  workspaceId: string;
  runId: string;
  /**
   * Keystrokes and size go to the CLI (an active PTY run the user may control). Otherwise the
   * terminal is a read-only view of the output.
   */
  interactive: boolean;
  className?: string;
}

/**
 * The live terminal of one run (xterm.js): stored output replayed over REST, new output over the
 * realtime channel, merged gap-free by seq (architecture §9.3).
 */
export function RunTerminal({ workspaceId, runId, interactive, className }: RunTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const streamRef = useRef<SeqStream<RunOutputChunk> | null>(null);
  const interactiveRef = useRef(interactive);

  useEffect(() => {
    interactiveRef.current = interactive;
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.cursorBlink = interactive;
    terminal.options.disableStdin = !interactive;
    // The PTY was sized by the runner; adopt the browser's size once keystrokes flow.
    if (interactive) {
      getRealtimeClient().send({ op: 'run.resize', runId, cols: terminal.cols, rows: terminal.rows });
    }
  }, [interactive, runId]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      // xterm touches `window` while loading, so it is only imported in the browser.
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ]);
      const container = containerRef.current;
      if (cancelled || !container) return;

      const terminal = new Terminal({
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        scrollback: 10_000,
        cursorBlink: interactiveRef.current,
        disableStdin: !interactiveRef.current,
        theme: TERMINAL_THEME,
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.loadAddon(new WebLinksAddon());
      terminal.open(container);
      fit.fit();
      terminalRef.current = terminal;

      const stream = new SeqStream<RunOutputChunk>({
        emit: (chunk) => terminal.write(decodeBase64(chunk.data)),
        fetchPage: async (afterSeq, signal) =>
          (await api.getRunOutput(workspaceId, runId, afterSeq, REPLAY_PAGE, signal)).chunks,
        // 4xx (deleted run, lost access) will not heal by retrying.
        onError: (error) => !(error instanceof ApiRequestError && error.status >= 400 && error.status < 500),
      });
      streamRef.current = stream;
      stream.resync();

      const input = terminal.onData((data) => {
        if (interactiveRef.current) getRealtimeClient().send({ op: 'run.input', runId, data });
      });
      const resize = terminal.onResize(({ cols, rows }) => {
        if (interactiveRef.current) getRealtimeClient().send({ op: 'run.resize', runId, cols, rows });
      });
      const observer = new ResizeObserver(() => fit.fit());
      observer.observe(container);

      cleanup = () => {
        observer.disconnect();
        input.dispose();
        resize.dispose();
        stream.dispose();
        terminal.dispose();
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
      streamRef.current = null;
      terminalRef.current = null;
    };
  }, [workspaceId, runId]);

  useChannel(
    `run:${runId}`,
    (event) => {
      if (event.ev === 'run.output' && event.runId === runId) {
        streamRef.current?.pushLive({ seq: event.seq, data: event.data });
      }
    },
    // Output published while the socket was down only exists in the database.
    () => streamRef.current?.resync(),
  );

  return (
    <div
      data-testid="run-terminal"
      ref={containerRef}
      className={cn('h-[28rem] w-full overflow-hidden rounded-md bg-[#0b0d10] p-2', className)}
    />
  );
}
