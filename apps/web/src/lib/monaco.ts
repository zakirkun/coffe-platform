import { loader } from '@monaco-editor/react';

let setup: Promise<void> | null = null;

/**
 * Loads Monaco from the app bundle (never a CDN) and points `@monaco-editor/react` at it.
 * Browser only; resolves once the editor components may be rendered.
 *
 * Worker specifiers follow monaco-editor's `exports` map (`monaco-editor/<path>` resolves to
 * `esm/vs/<path>`). Each `new Worker(new URL(...))` must stay a literal so the bundler emits
 * the worker as its own chunk.
 */
export function ensureMonaco(): Promise<void> {
  setup ??= (async () => {
    self.MonacoEnvironment = {
      getWorker(_workerId, label) {
        switch (label) {
          case 'json':
            return new Worker(
              new URL('monaco-editor/language/json/json.worker.js', import.meta.url),
              { type: 'module' },
            );
          case 'css':
          case 'scss':
          case 'less':
            return new Worker(
              new URL('monaco-editor/language/css/css.worker.js', import.meta.url),
              { type: 'module' },
            );
          case 'html':
          case 'handlebars':
          case 'razor':
            return new Worker(
              new URL('monaco-editor/language/html/html.worker.js', import.meta.url),
              { type: 'module' },
            );
          case 'typescript':
          case 'javascript':
            return new Worker(
              new URL('monaco-editor/language/typescript/ts.worker.js', import.meta.url),
              { type: 'module' },
            );
          default:
            return new Worker(new URL('monaco-editor/editor/editor.worker.js', import.meta.url), {
              type: 'module',
            });
        }
      },
    };

    // Dynamic on purpose: monaco-editor touches `window`/`document` while loading, so it cannot
    // be part of a module graph that is also evaluated during server rendering.
    const monaco = await import('monaco-editor');
    // Review shows single files without their project: semantic errors would all be noise.
    const reviewDiagnostics = { noSemanticValidation: true, noSuggestionDiagnostics: true };
    monaco.typescript.typescriptDefaults.setDiagnosticsOptions(reviewDiagnostics);
    monaco.typescript.javascriptDefaults.setDiagnosticsOptions(reviewDiagnostics);
    loader.config({ monaco });
  })();
  return setup;
}
