/**
 * The show/hide toggle on a password field (UAT BUG-09; `web-form-controls`
 * "Password fields offer a show/hide toggle"), kept out of the component so the
 * state-to-attributes mapping is tested (`password-visibility.spec.ts`).
 */

export interface PasswordVisibility {
  /** The input's `type`: masked unless the user asked to see it. */
  inputType: "password" | "text";
  /** The toggle's label (namespace `auth`): the action pressing it will take. */
  labelKey: "password.show" | "password.hide";
}

export function passwordVisibility(visible: boolean): PasswordVisibility {
  return visible
    ? { inputType: "text", labelKey: "password.hide" }
    : { inputType: "password", labelKey: "password.show" };
}
