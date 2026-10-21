// framing.mjs — Two distinct framings, never conflated (δ-m4):
// (1) NDJSON-over-stdio for child links; (2) length-prefixed frames for the mux bridge.
// Property tests verify: arbitrary byte streams never corrupt frames; oversize/malformed → typed errors.

const MAX_FRAME_SIZE = 1024 * 1024; // 1 MiB
// A partial line one byte past the maximum frame (plus the extra byte the
// delimiter would occupy) cannot become a legal frame. Buffering exactly
// this many unterminated bytes does not throw. The framer throws only once
// the residual is greater than MAX_RESIDUAL (ADR-0006).
export const MAX_RESIDUAL = MAX_FRAME_SIZE + 1;

// Contiguous buffer with power-of-two growth. Appending a chunk copies only the
// new bytes into spare capacity; the prefix is copied only when capacity doubles,
// so a byte-at-a-time peer costs linear work. Offsets are logical (relative to #start).
class ByteBuf {
  #buf = Buffer.alloc(256);
  #start = 0;
  #end = 0;

  get length() {
    return this.#end - this.#start;
  }

  append(chunk) {
    if (chunk.length === 0) return;
    const used = this.#end - this.#start;
    if (this.#end + chunk.length > this.#buf.length) {
      let cap = this.#buf.length;
      while (cap < used + chunk.length) cap *= 2;
      const next = Buffer.alloc(cap);
      this.#buf.copy(next, 0, this.#start, this.#end);
      this.#buf = next;
      this.#start = 0;
      this.#end = used;
    }
    chunk.copy(this.#buf, this.#end);
    this.#end += chunk.length;
  }

  indexOf(byte, logicalFrom = 0) {
    if (logicalFrom < 0 || logicalFrom >= this.length) return -1;
    const found = this.#buf.indexOf(byte, this.#start + logicalFrom);
    if (found < 0 || found >= this.#end) return -1;
    return found - this.#start;
  }

  subarray(logicalStart, logicalEnd) {
    return this.#buf.subarray(this.#start + logicalStart, this.#start + logicalEnd);
  }

  readUInt32BE(logicalOffset) {
    return this.#buf.readUInt32BE(this.#start + logicalOffset);
  }

  drop(n) {
    if (n >= this.length) {
      this.#start = 0;
      this.#end = 0;
      return;
    }
    this.#start += n;
  }
}

function asBuffer(chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// =====================
// (1) NDJSON over stdio
// =====================

export class NdjsonFramingError extends Error {}
export class NdjsonOversizeError extends NdjsonFramingError {}
export class NdjsonNeverTerminatedError extends NdjsonFramingError {}
export class NdjsonUnterminatedAtEofError extends NdjsonFramingError {}

export class NdjsonFramer {
  #bytes = new ByteBuf();
  #scanned = 0;
  #firstNewline = -1;
  #lastNewline = -1;

  feed(chunk) {
    this.#bytes.append(asBuffer(chunk));
    this.#scanNew();
    // No complete frame is waiting, so the caller will not reach frames().
    if (this.#firstNewline < 0 && this.#residual() > MAX_RESIDUAL) {
      throw new NdjsonOversizeError(`partial frame exceeded ${MAX_FRAME_SIZE} bytes without newline`);
    }
  }

  // Bytes already known to contain no newline are not scanned again.
  #scanNew() {
    let from = this.#scanned;
    while (from < this.#bytes.length) {
      const idx = this.#bytes.indexOf(0x0a, from);
      if (idx === -1) break;
      if (this.#firstNewline < 0) this.#firstNewline = idx;
      this.#lastNewline = idx;
      from = idx + 1;
    }
    this.#scanned = this.#bytes.length;
  }

  #residual() {
    if (this.#lastNewline < 0) return this.#bytes.length;
    return this.#bytes.length - (this.#lastNewline + 1);
  }

  *frames() {
    while (this.#firstNewline >= 0) {
      const idx = this.#firstNewline;
      const line = this.#bytes.subarray(0, idx);
      const n = idx + 1;
      this.#bytes.drop(n);
      this.#scanned -= n;
      this.#lastNewline -= n;
      if (this.#lastNewline < 0) {
        this.#firstNewline = -1;
      } else {
        this.#firstNewline = this.#bytes.indexOf(0x0a, 0);
      }
      if (line.length > MAX_FRAME_SIZE) {
        throw new NdjsonOversizeError(`frame ${line.length} bytes > ${MAX_FRAME_SIZE}`);
      }
      let lineStr;
      try {
        // stream:false — a finished line must not retain a dangling UTF-8 sequence.
        lineStr = decodeUtf8(line);
      } catch (e) {
        throw new NdjsonFramingError(`invalid utf-8: ${e.message}`);
      }
      lineStr = lineStr.trim();
      if (!lineStr) continue;
      try {
        yield JSON.parse(lineStr);
      } catch (e) {
        throw new NdjsonFramingError(`malformed JSON: ${e.message}`);
      }
    }
    if (this.#residual() > MAX_RESIDUAL) {
      throw new NdjsonOversizeError(`partial frame exceeded ${MAX_FRAME_SIZE} bytes without newline`);
    }
  }

  eof() {
    if (this.#bytes.length > 0) {
      throw new NdjsonUnterminatedAtEofError(`unterminated frame at EOF: ${this.#bytes.length} bytes`);
    }
  }

  pendingBytes() {
    return this.#bytes.length;
  }

  // True when a complete line is still buffered. The partial-cap fault is
  // only for bytes that contain no newline.
  hasPendingNewline() {
    return this.#firstNewline >= 0;
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
export class MuxUnterminatedAtEofError extends MuxFramingError {}

export class MuxFramer {
  #bytes = new ByteBuf();
  #complete = 0;

  feed(chunk) {
    this.#bytes.append(asBuffer(chunk));
    this.#rejectLeadingOversize();
    this.#accountComplete();
  }

  // A length prefix at the start of the buffer is visible before frames() runs.
  #rejectLeadingOversize() {
    if (this.#bytes.length < 4 || this.#complete !== 0) return;
    const len = this.#bytes.readUInt32BE(0);
    if (len > MAX_FRAME_SIZE) {
      throw new MuxOversizeError(`frame length ${len} > ${MAX_FRAME_SIZE}`);
    }
  }

  // Advance past frames that are fully buffered. An oversize length after
  // those frames is left for frames() so the earlier frames can still be read.
  #accountComplete() {
    while (this.#bytes.length - this.#complete >= 4) {
      const len = this.#bytes.readUInt32BE(this.#complete);
      if (len > MAX_FRAME_SIZE) return;
      if (this.#bytes.length - this.#complete < 4 + len) return;
      this.#complete += 4 + len;
    }
  }

  *frames() {
    while (this.#bytes.length >= 4) {
      const len = this.#bytes.readUInt32BE(0);
      if (len > MAX_FRAME_SIZE) {
        throw new MuxOversizeError(`frame length ${len} > ${MAX_FRAME_SIZE}`);
      }
      if (this.#bytes.length < 4 + len) break;
      const payload = this.#bytes.subarray(4, 4 + len);
      let payloadStr;
      try {
        payloadStr = decodeUtf8(payload);
      } catch (e) {
        this.#bytes.drop(4 + len);
        this.#complete -= 4 + len;
        throw new MuxFramingError(`invalid utf-8: ${e.message}`);
      }
      this.#bytes.drop(4 + len);
      this.#complete -= 4 + len;
      try {
        yield JSON.parse(payloadStr);
      } catch (e) {
        throw new MuxFramingError(`malformed JSON: ${e.message}`);
      }
    }
  }

  eof() {
    if (this.#bytes.length > 0) {
      throw new MuxUnterminatedAtEofError(`unterminated frame at EOF: ${this.#bytes.length} bytes`);
    }
  }

  pendingBytes() {
    return this.#bytes.length;
  }

  // Bytes of the unfinished frame at the head, including its length prefix.
  // Zero until the prefix is buffered, and zero when that prefix is illegal.
  // A legal length can still be larger than the process will ever accept.
  leadingDeclared() {
    const available = this.#bytes.length - this.#complete;
    if (available < 4) return 0;
    const len = this.#bytes.readUInt32BE(this.#complete);
    if (len > MAX_FRAME_SIZE) return 0;
    return 4 + len;
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
