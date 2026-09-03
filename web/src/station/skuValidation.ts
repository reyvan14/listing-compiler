// Pure validation for the SKU input form. No React / tldraw imports so it can
// be unit-tested directly.

export type SkuFormField = 'productName' | 'points' | 'platforms';

export type SkuFieldError = { field: SkuFormField; message: string };

export type SkuFormValues = {
  productName: string;
  points: string;
  /** ids of the platforms currently checked */
  platforms: readonly string[];
};

/**
 * Returns the list of validation problems, in field order. Empty = valid.
 * The normal "生成" action must refuse to run (and must not mutate the form)
 * when this is non-empty.
 */
export function validateSkuForm(values: SkuFormValues): SkuFieldError[] {
  const errors: SkuFieldError[] = [];
  if (!values.productName.trim()) {
    errors.push({ field: 'productName', message: '请填写品名' });
  }
  if (!values.points.trim()) {
    errors.push({ field: 'points', message: '请填写卖点' });
  }
  if (values.platforms.length === 0) {
    errors.push({ field: 'platforms', message: '请至少选择一个平台' });
  }
  return errors;
}

export function fieldError(
  errors: readonly SkuFieldError[],
  field: SkuFormField,
): string | undefined {
  return errors.find(e => e.field === field)?.message;
}

export function firstInvalidField(errors: readonly SkuFieldError[]): SkuFormField | null {
  return errors[0]?.field ?? null;
}
