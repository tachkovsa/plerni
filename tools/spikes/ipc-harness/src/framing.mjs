// framing.mjs — Two distinct framings, never conflated (δ-m4):
// (1) NDJSON-over-stdio for child links; (2) length-prefixed frames for the mux bridge.
// Property tests verify: arbitrary byte streams never corrupt frames; oversize/malformed → typed errors.

const MAX_FRAME_SIZE = 1024 * 1024; // 1 MiB
const MAX_PARTIAL_BUFFER = 2 * MAX_FRAME_SIZE; // per-connection buffer cap

// =====================
// (1) NDJSON over stdio
// =====================

export class NdjsonFramingError extends Error {}
export class NdjsonOversizeError extends NdjsonFramingError {}
export class NdjsonNeverTerminatedError extends NdjsonFramingError {}

export class NdjsonFramer {
  #buffer = '';

  feed(chunk) {
    if (this.#buffer.length + chunk.length > MAX_PARTIAL_BUFFER) {
      throw new NdjsonNeverTerminatedError(`partial frame exceeded ${MAX_PARTIAL_BUFFER} bytes without newline`);
    }
    this.#buffer += chunk;
  }

  *frames() {
    while (true) {
      const idx = this.#buffer.indexOf('\n');
      if (idx === -1) break;
      const line = this.#buffer.slice(0, idx);
      this.#buffer = this.#buffer.slice(idx + 1);
      if (line.length > MAX_FRAME_SIZE) {
        throw new NdjsonOversizeError(`frame ${line.length} bytes > ${MAX_FRAME_SIZE}`);
      }
      if (line.trim()) {
        try {
          yield JSON.parse(line);
        } catch (e) {
          throw new NdjsonFramingError(`malformed JSON: ${e.message}`);
        }
      }
    }
  }

  pendingBytes() {
    return this.#buffer.length;
  }
}

export function encodeNdjson(obj) {
  const payload = JSON.stringify(obj);
  if (payload.length > MAX_FRAME_SIZE) {
    throw new NdjsonOversizeError(`payload ${payload.length} bytes > ${MAX_FRAME_SIZE}`);
  }
  return payload + '\n';
}

// =============================
// (2) Length-prefixed mux frames
// =============================

export class MuxFramingError extends Error {}
export class MuxOversizeError extends MuxFramingError {}
export class MuxNeverTerminatedError extends MuxFramingError {}

export class MuxFramer {
  #buffer = Buffer.alloc(0);

  feed(chunk) {
    if (this.#buffer.length + chunk.length > MAX_PARTIAL_BUFFER) {
      throw new MuxNeverTerminatedError(`partial frame exceeded ${MAX_PARTIAL_BUFFER} bytes without complete length prefix`);
    }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
  }

  *frames() {
    while (this.#buffer.length >= 4) {
      const len = this.#buffer.readUInt32BE(0);
      if (len > MAX_FRAME_SIZE) {
        throw new MuxOversizeError(`frame length ${len} > ${MAX_FRAME_SIZE}`);
      }
      if (this.#buffer.length < 4 + len) break; // incomplete
      const payload = this.#buffer.slice(4, 4 + len);
      this.#buffer = this.#buffer.slice(4 + len);
      try {
        yield JSON.parse(payload.toString('utf8'));
      } catch (e) {
        throw new MuxFramingError(`malformed JSON: ${e.message}`);
      }
    }
  }

  pendingBytes() {
    return this.#buffer.length;
  }
}

export function encodeMux(obj) {
  const payload = JSON.stringify(obj);
  if (payload.length > MAX_FRAME_SIZE) {
    throw new MuxOversizeError(`payload ${payload.length} bytes > ${MAX_FRAME_SIZE}`);
  }
  const buf = Buffer.from(payload, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}
