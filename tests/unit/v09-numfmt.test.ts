// 0.9 Phase 5: Excel number formats (what a cell shows for its stored value).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_FORMATS, formatText, formatValue, general, isDateFormat, serialToDate } from '../../src/import/numfmt';

const f = (v: number, code: string, d1904 = false) => formatValue(v, code, d1904).text;

test('numfmt: General like Excel (11 significant digits, scientific for extremes)', () => {
  assert.equal(general(0), '0');
  assert.equal(general(42), '42');
  assert.equal(general(-3.5), '-3.5');
  assert.equal(general(1 / 3), '0.3333333333');
  assert.equal(general(123456.789), '123456.789');
  assert.equal(general(0.1 + 0.2), '0.3');
  assert.equal(general(1.5e12), '1.5E+12');
  assert.equal(f(12.5, 'General'), '12.5');
});

test('numfmt: decimals, thousands, percent, scientific, currency, negative sections, colours', () => {
  assert.equal(f(1234.567, '0'), '1235');
  assert.equal(f(1234.567, '0.00'), '1234.57');
  assert.equal(f(1234567.891, '#,##0.00'), '1,234,567.89');
  assert.equal(f(0.5, '#,##0'), '1');
  assert.equal(f(0.256, '0%'), '26%');
  assert.equal(f(0.256, '0.0%'), '25.6%');
  assert.equal(f(12345, '0.00E+00'), '1.23E+04');
  assert.equal(f(1234.5, '"¥"#,##0.00'), '¥1,234.50');
  assert.equal(f(-1234.5, '"¥"#,##0.00;[Red]"¥"-#,##0.00'), '¥-1,234.50');
  assert.equal(formatValue(-5, '0;[Red]-0').color, '#ff0000');
  assert.equal(f(-5, '0.0'), '-5.0');
  assert.equal(f(-5, '#,##0 ;(#,##0)'), '(5)');
  assert.equal(f(0, '0.00;-0.00;"-"'), '-');
  assert.equal(f(1234.5, '[$¥-804]#,##0.0'), '¥1,234.5');
  assert.equal(f(3.14159, '0.0#'), '3.14');
  assert.equal(f(3.1, '0.0#'), '3.1');
  assert.equal(f(1500000, '#,##0,"K"'), '1,500K');
  assert.equal(f(7, '000'), '007');
  assert.equal(f(1234.5, BUILTIN_FORMATS[44]).trim(), '¥1,234.50'); // the * fill (padding to the cell width) is not reproduced
});

test('numfmt: dates and times from serial numbers (both date systems)', () => {
  assert.deepEqual([serialToDate(1).y, serialToDate(1).m, serialToDate(1).d], [1900, 1, 1]);
  assert.deepEqual([serialToDate(61).m, serialToDate(61).d], [3, 1]);
  assert.equal(f(45588, 'yyyy-mm-dd'), '2024-10-23');
  assert.equal(f(45588, BUILTIN_FORMATS[14]), '2024/10/23');
  assert.equal(f(45588, BUILTIN_FORMATS[31]), '2024年10月23日');
  assert.equal(f(45588.75, 'yyyy/m/d h:mm'), '2024/10/23 18:00');
  assert.equal(f(45588.75, 'h:mm AM/PM'), '6:00 PM');
  assert.equal(f(0.5208333333, 'hh:mm:ss'), '12:30:00');
  assert.equal(f(1.5, '[h]:mm:ss'), '36:00:00');
  assert.equal(f(45588, 'd-mmm-yy'), '23-Oct-24');
  assert.equal(f(45588, 'dddd, mmmm d'), 'Wednesday, October 23');
  assert.equal(f(45588, 'mm/dd'), '10/23');
  assert.equal(f(0.75, '上午/下午h"时"mm"分"'), '下午6时00分');
  assert.equal(f(44126, 'yyyy-mm-dd', true), '2024-10-23');
  assert.ok(isDateFormat('yyyy-mm-dd') && isDateFormat('h:mm') && isDateFormat('[h]:mm'));
  assert.ok(!isDateFormat('0.00') && !isDateFormat('#,##0') && !isDateFormat('"m"0') && !isDateFormat('0.00E+00'));
});

test('numfmt: text sections', () => {
  assert.equal(formatText('abc', '@'), 'abc');
  assert.equal(formatText('abc', '0;-0;0;"Name: "@'), 'Name: abc');
  assert.equal(formatText('abc', undefined), 'abc');
});
