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

function waitForMsgType(target, type) {
  return new Promise(resolve => {
    target.addEventListener('message', function onMsg({ data }) {
      if (data?.type !== type) return;
      target.removeEventListener('message', onMsg);
      resolve(data);
    });
  });
}

waitForMsgType(self, 'wasm_bindgen_worker_init').then(async ({ init, receiver }) => {
  // Resolve the package from this generated snippets/ directory.
  const pkg = await import('../../..');
  await pkg.default(init);
  postMessage({ type: 'wasm_bindgen_worker_ready' });
  pkg.wbg_rayon_start_worker(receiver);
}).catch(error => {
  postMessage({
    type: 'wasm_bindgen_worker_error',
    message: error instanceof Error ? error.message : String(error)
  });
});
