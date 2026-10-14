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
export class NdjsonUnterminatedAtEofError extends NdjsonFramingError {}

export class NdjsonFramer {
  #chunks = [];
  #totalBytes = 0;
  #decoder = new TextDecoder('utf-8', { fatal: true });

  feed(chunk) {
    const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    if (this.#totalBytes + chunkBuf.length > MAX_PARTIAL_BUFFER) {
      throw new NdjsonNeverTerminatedError(`partial frame exceeded ${MAX_PARTIAL_BUFFER} bytes without newline`);
    }
    this.#chunks.push(chunkBuf);
    this.#totalBytes += chunkBuf.length;
  }

  *frames() {
    while (this.#totalBytes > 0) {
      // Coalesce chunks only once when needed
      const buf = this.#chunks.length === 1 ? this.#chunks[0] : Buffer.concat(this.#chunks, this.#totalBytes);
      const idx = buf.indexOf('\n');
      if (idx === -1) {
        // No complete frame; save the buffer for next call
        if (this.#chunks.length > 1) {
          this.#chunks = [buf];
        }
        break;
      }
      const line = buf.slice(0, idx);
      const remainder = buf.slice(idx + 1);
      this.#chunks = remainder.length > 0 ? [remainder] : [];
      this.#totalBytes = remainder.length;
      
      if (line.length > MAX_FRAME_SIZE) {
        throw new NdjsonOversizeError(`frame ${line.length} bytes > ${MAX_FRAME_SIZE}`);
      }
      const lineStr = this.#decoder.decode(line, { stream: true }).trim();
      if (lineStr) {
        try {
          yield JSON.parse(lineStr);
        } catch (e) {
          throw new NdjsonFramingError(`malformed JSON: ${e.message}`);
        }
      }
    }
  }

  eof() {
    if (this.#totalBytes > 0) {
      throw new NdjsonUnterminatedAtEofError(`unterminated frame at EOF: ${this.#totalBytes} bytes`);
    }
  }

  pendingBytes() {
    return this.#totalBytes;
  }
}

export function encodeNdjson(obj) {
  const payload = JSON.stringify(obj);
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (payloadBytes > MAX_FRAME_SIZE) {
    throw new NdjsonOversizeError(`payload ${payloadBytes} bytes > ${MAX_FRAME_SIZE}`);
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
  #chunks = [];
  #totalBytes = 0;
  #coalesced = null;
  #decoder = new TextDecoder('utf-8', { fatal: true });

  feed(chunk) {
    if (this.#totalBytes + chunk.length > MAX_PARTIAL_BUFFER) {
      throw new MuxNeverTerminatedError(`partial frame exceeded ${MAX_PARTIAL_BUFFER} bytes without complete length prefix`);
    }
    this.#chunks.push(chunk);
    this.#totalBytes += chunk.length;
    this.#coalesced = null; // invalidate cached buffer
  }

  *frames() {
    while (this.#totalBytes >= 4) {
      // Coalesce once and reuse until we consume a frame
      if (!this.#coalesced) {
        this.#coalesced = this.#chunks.length === 1 ? this.#chunks[0] : Buffer.concat(this.#chunks, this.#totalBytes);
      }
      const buf = this.#coalesced;
      const len = buf.readUInt32BE(0);
      if (len > MAX_FRAME_SIZE) {
        throw new MuxOversizeError(`frame length ${len} > ${MAX_FRAME_SIZE}`);
      }
      if (this.#totalBytes < 4 + len) break; // incomplete
      const payload = buf.slice(4, 4 + len);
      const remainder = buf.slice(4 + len);
      this.#chunks = remainder.length > 0 ? [remainder] : [];
      this.#totalBytes = remainder.length;
      this.#coalesced = remainder.length > 0 ? remainder : null;
      const payloadStr = this.#decoder.decode(payload, { stream: false });
      try {
        yield JSON.parse(payloadStr);
      } catch (e) {
        throw new MuxFramingError(`malformed JSON: ${e.message}`);
      }
    }
  }

  pendingBytes() {
    return this.#totalBytes;
  }
}

export function encodeMux(obj) {
  const payload = JSON.stringify(obj);
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (payloadBytes > MAX_FRAME_SIZE) {
    throw new MuxOversizeError(`payload ${payloadBytes} bytes > ${MAX_FRAME_SIZE}`);
  }
  const buf = Buffer.from(payload, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}
