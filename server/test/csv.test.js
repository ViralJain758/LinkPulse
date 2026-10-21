import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, detectDelimiter } from '../src/services/csv.js';

const cells = (text) => parseCsv(text).records.map((r) => r.cells);

test('parses plain rows with LF, CRLF and a trailing newline', () => {
  assert.deepEqual(cells('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(cells('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(cells('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
});

test('handles quotes, escaped quotes, delimiters and newlines inside quotes', () => {
  assert.deepEqual(cells('a,b\n"x, y","say ""hi"""\n"line1\nline2",z'), [
    ['a', 'b'],
    ['x, y', 'say "hi"'],
    ['line1\nline2', 'z'],
  ]);
});

test('strips a UTF-8 BOM and skips blank lines, but row numbers still count them', () => {
  const { records } = parseCsv('\ufeffurl,slug\n\nhttps://a.com,a\n');
  assert.equal(records[0].cells[0], 'url');
  assert.deepEqual(records.map((r) => r.row), [1, 3]);
});

test('keeps empty fields and a quoted empty field as a row', () => {
  assert.deepEqual(cells('a,b,c\n1,,3'), [['a', 'b', 'c'], ['1', '', '3']]);
  assert.deepEqual(cells('a\n""'), [['a'], ['']]);
});

test('reports an unterminated quote', () => {
  assert.match(parseCsv('a,b\n"oops,1').error, /never closed/);
});

test('detects semicolon and tab delimiters', () => {
  assert.equal(detectDelimiter('url;slug\nx;y'), ';');
  assert.equal(detectDelimiter('url\tslug\nx\ty'), '\t');
  assert.equal(detectDelimiter('url,slug'), ',');
  assert.equal(detectDelimiter('url'), ',');
  assert.deepEqual(cells('url;slug\nhttps://a.com;a'), [['url', 'slug'], ['https://a.com', 'a']]);
});

import { toCsv } from '../src/services/csv.js';

test('toCsv quotes, escapes, guards formulas and round-trips through parseCsv', () => {
  const out = toCsv([['a', 'b'], ['x, y', 'say "hi"'], ['=SUM(A1)', 5], [null, 'line1\nline2']]);
  assert.ok(out.startsWith('﻿'));
  assert.ok(out.includes("'=SUM(A1)"));
  const back = parseCsv(out).records.map((r) => r.cells);
  assert.deepEqual(back[1], ['x, y', 'say "hi"']);
  assert.deepEqual(back[3], ['', 'line1\nline2']);
});
