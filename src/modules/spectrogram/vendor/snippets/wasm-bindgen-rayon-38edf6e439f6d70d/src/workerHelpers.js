/*
 * Copyright 2022 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import workerEntryUrl from './workerEntry.js?worker&url';

const DEFAULT_WORKER_STARTUP_TIMEOUT_MS = 15_000;
const TAURI_CUSTOM_PROTOCOL_HOST = 'tauri.localhost';

function createWorkerEntry() {
  const entryUrl = new URL(workerEntryUrl, import.meta.url).href;

  // WebView2 does not load a custom-protocol module worker when it is
  // constructed from inside another dedicated Worker. A Blob bootstrap can
  // import that entry by absolute URL and preserves its module graph.
  if (location.hostname !== TAURI_CUSTOM_PROTOCOL_HOST) {
    return {
      worker: new Worker(entryUrl, { type: 'module' }),
      bootstrapUrl: null
    };
  }

  const bootstrapUrl = URL.createObjectURL(
    new Blob([`import ${JSON.stringify(entryUrl)};`], {
      type: 'text/javascript'
    })
  );

  try {
    return {
      worker: new Worker(bootstrapUrl, { type: 'module' }),
      bootstrapUrl
    };
  } catch (error) {
    URL.revokeObjectURL(bootstrapUrl);
    throw error;
  }
}

function waitForWorkerStart(worker, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;

    const cleanup = () => {
      clearTimeout(timeout);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      worker.terminate();
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    function onMessage({ data }) {
      if (data?.type === 'wasm_bindgen_worker_error') {
        const detail = data.message ? `: ${data.message}` : '';
        fail(new Error(`Worker failed during startup${detail}`));
      } else if (data?.type === 'wasm_bindgen_worker_ready') {
        succeed();
      }
    }
    function onError(event) {
      const detail =
        typeof event?.message === 'string' && event.message
          ? `: ${event.message}`
          : '';
      fail(new Error(`Worker failed before startup${detail}`));
    }
    function onMessageError() {
      fail(new Error('Worker message could not be deserialized during startup'));
    }

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    timeout = setTimeout(() => {
      fail(new Error(`Worker startup timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
}

// Note: this is never used, but necessary to prevent a bug in Firefox
// (https://bugzilla.mozilla.org/show_bug.cgi?id=1702191) where it collects
// Web Workers that have a shared WebAssembly memory with the main thread,
// but are not explicitly rooted via a `Worker` instance.
//
// By storing them in a variable, we can keep `Worker` objects around and
// prevent them from getting GC-d.
let _workers;

export async function startWorkers(
  module,
  memory,
  builder,
  startupTimeoutMs = DEFAULT_WORKER_STARTUP_TIMEOUT_MS
) {
  if (builder.numThreads() === 0) {
    throw new Error(`num_threads must be > 0.`);
  }

  const workerInit = {
    type: 'wasm_bindgen_worker_init',
    init: { module_or_path: module, memory },
    receiver: builder.receiver()
  };

  const timeoutMs =
    Number.isFinite(startupTimeoutMs) && startupTimeoutMs > 0
      ? startupTimeoutMs
      : DEFAULT_WORKER_STARTUP_TIMEOUT_MS;
  const workerEntries = [];

  try {
    for (let index = 0; index < builder.numThreads(); index += 1) {
      // Keep the pool entry separate from this exported controller. If the
      // worker points back at workerHelpers.js while that module is shared
      // with the analyzer, Vite rewrites the URL to self.location.href and the
      // child can resolve to the outer analyzer instead of the helper entry.
      workerEntries.push(createWorkerEntry());
    }
    _workers = workerEntries.map(({ worker }) => worker);

    await Promise.all(
      workerEntries.map(async ({ worker, bootstrapUrl }) => {
        try {
          worker.postMessage(workerInit);
          await waitForWorkerStart(worker, timeoutMs);
        } finally {
          if (bootstrapUrl) URL.revokeObjectURL(bootstrapUrl);
        }
      })
    );
    builder.build();
  } catch (error) {
    _workers = undefined;
    for (const { worker, bootstrapUrl } of workerEntries) {
      if (bootstrapUrl) URL.revokeObjectURL(bootstrapUrl);
      try {
        worker.terminate();
      } catch {
        // A failed Worker may already have been terminated by waitForWorkerStart.
      }
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}
