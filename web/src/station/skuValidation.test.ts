import { describe, expect, it } from 'vitest';
import { fieldError, firstInvalidField, validateSkuForm } from './skuValidation';

const valid = {
  productName: '折叠硅胶水杯 350ml',
  points: '折叠到 4cm\n防漏盖',
  platforms: ['amazon'],
};

describe('validateSkuForm', () => {
  it('accepts a fully filled form', () => {
    expect(validateSkuForm(valid)).toEqual([]);
  });

  it('flags a missing product name', () => {
    const errs = validateSkuForm({ ...valid, productName: '   ' });
    expect(errs).toContainEqual({ field: 'productName', message: '请填写品名' });
  });

  it('flags missing selling points', () => {
    const errs = validateSkuForm({ ...valid, points: '' });
    expect(errs).toContainEqual({ field: 'points', message: '请填写卖点' });
  });

  it('flags zero selected platforms with an inline message', () => {
    const errs = validateSkuForm({ ...valid, platforms: [] });
    expect(errs).toContainEqual({ field: 'platforms', message: '请至少选择一个平台' });
  });

  it('returns errors in field order and firstInvalidField points at the first', () => {
    const errs = validateSkuForm({ productName: '', points: '', platforms: [] });
    expect(errs.map(e => e.field)).toEqual(['productName', 'points', 'platforms']);
    expect(firstInvalidField(errs)).toBe('productName');
  });

  it('fieldError looks up by field', () => {
    const errs = validateSkuForm({ ...valid, points: '' });
    expect(fieldError(errs, 'points')).toBe('请填写卖点');
    expect(fieldError(errs, 'productName')).toBeUndefined();
  });
});
