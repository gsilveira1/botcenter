import { describe, expect, it } from 'vitest';
import { readJsonPointer } from './json-pointer.js';

const document = {
  data: { approved: true, 'a/b': 1, 'm~n': 2, list: [10, { x: null }] },
  '': 'empty key',
};

describe('readJsonPointer', () => {
  it.each([
    ['', document],
    ['/data/approved', true],
    ['/data/a~1b', 1],
    ['/data/m~0n', 2],
    ['/data/list/0', 10],
    ['/data/list/1/x', null],
    ['/', 'empty key'],
  ])('reads %j', (pointer, expected) => {
    expect(readJsonPointer(document, pointer)).toEqual({ found: true, value: expected });
  });

  it.each([
    '/missing',
    '/data/list/2',
    '/data/list/01',
    '/data/list/-',
    '/data/approved/deeper',
    '/data/constructor',
    'data',
  ])('does not find %j', (pointer) => {
    expect(readJsonPointer(document, pointer)).toEqual({ found: false });
  });

  it('does not read through null or a primitive document', () => {
    expect(readJsonPointer(null, '/a')).toEqual({ found: false });
    expect(readJsonPointer('text', '/0')).toEqual({ found: false });
  });
});
