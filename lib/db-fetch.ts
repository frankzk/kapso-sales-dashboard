// Dependency-free transport bridge. Shared access modules can be reached by
// client bundles; they must never pull Node-only performance instrumentation in.
let observer: typeof fetch | null = null;

/** Installed only by a server performance scope; global fetch is unchanged. */
export function setSupabaseFetchObserver(next: typeof fetch): void {
  observer = next;
}

// Existing Supabase clients (including the admin singleton) see the current
// observer. Without instrumentation this forwards the original fetch promise.
export const supabaseFetch: typeof fetch = (input, init) =>
  observer ? observer(input, init) : globalThis.fetch(input, init);
