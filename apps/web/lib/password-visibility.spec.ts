import { describe, expect, it } from 'vitest';
import { passwordVisibility } from './password-visibility';

describe('passwordVisibility', () => {
  it('masks the field and offers to show it while hidden', () => {
    expect(passwordVisibility(false)).toEqual({ inputType: 'password', labelKey: 'password.show' });
  });

  it('shows the characters and offers to hide them while visible', () => {
    expect(passwordVisibility(true)).toEqual({ inputType: 'text', labelKey: 'password.hide' });
  });
});
