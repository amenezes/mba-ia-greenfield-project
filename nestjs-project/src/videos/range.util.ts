import { RangeNotSatisfiableException } from '../common/exceptions/domain.exception';

export interface ByteRange {
  start: number;
  end: number;
}

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Parses a single-range HTTP `Range` header (RFC 9110 §14.1.2) against an
 * object of `size` bytes. Multi-range, malformed or unsatisfiable → 416.
 */
export function parseRange(header: string, size: number): ByteRange {
  const match = SINGLE_RANGE.exec(header.trim());
  if (!match || size === 0) throw new RangeNotSatisfiableException(size);
  const [, rawStart, rawEnd] = match;

  if (rawStart === '') {
    // Suffix range: the last N bytes.
    const suffixLength = Number(rawEnd);
    if (rawEnd === '' || suffixLength === 0) {
      throw new RangeNotSatisfiableException(size);
    }
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (start >= size || start > end) {
    throw new RangeNotSatisfiableException(size);
  }
  return { start, end };
}
