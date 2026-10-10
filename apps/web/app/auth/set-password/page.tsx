import { Suspense } from "react";
import { SetPasswordForm } from "./set-password-form";

export default function SetPasswordPage() {
  return (
    <Suspense>
      <SetPasswordForm />
    </Suspense>
  );
}
