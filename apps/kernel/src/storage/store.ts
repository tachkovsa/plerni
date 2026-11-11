// SPDX-License-Identifier: Apache-2.0
// The object port talks to this store. A missing object is null.
// Any other failure throws, and the gateway does not copy that message.

export interface ObjectStore {
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  close(): void;
}
