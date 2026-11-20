"use client";

import { useState, type ComponentProps } from "react";
import { useTranslations } from "use-intl";
import { Eye, EyeOff } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { passwordVisibility } from "@/lib/password-visibility";

/**
 * A password field with a show/hide toggle (UAT BUG-09; `web-form-controls`).
 * Every input prop passes through, so `id` (the label's `htmlFor`),
 * `autoComplete`, `required`, `aria-invalid`, `disabled` and a controlled
 * `value`/`onChange` behave as on a plain input. The field always starts
 * masked; the toggle is a `type="button"`, so it never submits the form.
 */
export function PasswordInput({ disabled, ...props }: Omit<ComponentProps<"input">, "type">) {
  const t = useTranslations("auth");
  const [visible, setVisible] = useState(false);
  const { inputType, labelKey } = passwordVisibility(visible);
  return (
    <InputGroup>
      <InputGroupInput {...props} type={inputType} disabled={disabled} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          type="button"
          size="icon-xs"
          aria-label={t(labelKey)}
          aria-pressed={visible}
          aria-controls={props.id}
          disabled={disabled}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
