import { RangeNotSatisfiableException } from '../common/exceptions/domain.exception';
import { parseRange } from './range.util';

describe('parseRange', () => {
  const size = 1000;

  it.each([
    ['bytes=0-99', { start: 0, end: 99 }],
    ['bytes=500-', { start: 500, end: 999 }],
    ['bytes=-100', { start: 900, end: 999 }],
    ['bytes=900-5000', { start: 900, end: 999 }],
    ['bytes=-5000', { start: 0, end: 999 }],
    ['bytes=999-999', { start: 999, end: 999 }],
  ])('parses %s', (header, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });

  it.each([
    'bytes=1000-',
    'bytes=1000-1001',
    'bytes=50-10',
    'bytes=-0',
    'bytes=-',
    'bytes=0-1,5-9',
    'items=0-1',
    'garbage',
  ])('rejects %s with RANGE_NOT_SATISFIABLE', (header) => {
    expect(() => parseRange(header, size)).toThrow(
      RangeNotSatisfiableException,
    );
  });

  it('carries the Content-Range header for the 416 response', () => {
    try {
      parseRange('bytes=1000-', size);
      fail('expected parseRange to throw');
    } catch (err) {
      expect((err as RangeNotSatisfiableException).headers).toEqual({
        'Content-Range': 'bytes */1000',
      });
    }
  });

  it('rejects any range on an empty object', () => {
    expect(() => parseRange('bytes=0-', 0)).toThrow(
      RangeNotSatisfiableException,
    );
  });
});
