/**
 * The decisions behind the sign-in, email-link and set-password screens
 * (LP4-01), kept out of the components so they are tested (`auth-view.spec.ts`).
 */

import { REGISTRATION_COMPANY_NAME_MIN, REGISTRATION_CONSENT_VERSION, type Locale, type RegistrationRequest, type RegistrationStatus } from "@/lib/types";

/**
 * The shortest password the product accepts — Supabase Auth's
 * `minimum_password_length` (decision S9: 12, no composition rules). The
 * screen checks it first so the person is told before Auth refuses.
 */
export const MIN_PASSWORD_LENGTH = 12;

export type EmailLinkType = "invite" | "recovery";

/** The catalogue key (namespace `auth`) for a failed sign-in, by Supabase's error code. */
export function signInFailureKey(code: string | undefined): "signIn.invalidCredentials" | "signIn.disabled" | "signIn.failed" {
  if (code === "invalid_credentials") return "signIn.invalidCredentials";
  // A disabled account is banned in Supabase Auth too (D19).
  if (code === "user_banned") return "signIn.disabled";
  return "signIn.failed";
}

/**
 * What an emailed link carries: `?token_hash=…&type=invite|recovery`, as the
 * API builds it (K5). Anything else is not a link this product sent.
 */
export function parseEmailLink(search: URLSearchParams): { tokenHash: string; type: EmailLinkType } | null {
  const tokenHash = search.get("token_hash");
  const type = search.get("type");
  if (!tokenHash || !/^[A-Za-z0-9_-]{16,512}$/.test(tokenHash)) return null;
  if (type !== "invite" && type !== "recovery") return null;
  return { tokenHash, type };
}

/** What is wrong with a new password before it is sent, if anything. */
export function passwordProblem(password: string, repeat: string): "tooShort" | "mismatch" | null {
  if (password.length < MIN_PASSWORD_LENGTH) return "tooShort";
  if (password !== repeat) return "mismatch";
  return null;
}

/** The catalogue key (namespace `auth`) for a password Supabase refused. */
export function setPasswordFailureKey(code: string | undefined): "setPassword.weak" | "setPassword.same" | "setPassword.failed" {
  if (code === "weak_password") return "setPassword.weak";
  if (code === "same_password") return "setPassword.same";
  return "setPassword.failed";
}

/**
 * Reachable without a session (LP4-01): sign-in, "forgot password",
 * registration, and the landing pages of the emailed links — `/auth/confirm` runs `verifyOtp` with
 * the link's token, and `/auth/set-password` works only with the session that
 * made (it says so when there is none). Exact paths and their sub-paths.
 */
export const PUBLIC_PATHS = ["/login", "/forgot-password", "/register", "/auth/confirm", "/auth/set-password"] as const;
/** A signed-in visitor has nothing to do here and goes to the dashboard. The
 *  email-link pages are not among them: an invitee is signed in by the link. */
export const SIGNED_OUT_ONLY_PATHS = ["/login", "/forgot-password", "/register"] as const;

function matchesPath(path: string, list: readonly string[]): boolean {
  return list.some((p) => path === p || path.startsWith(`${p}/`));
}

/** `proxy.ts`: may this path be served without a session? */
export function isPublicPath(path: string): boolean {
  return matchesPath(path, PUBLIC_PATHS);
}

/** `proxy.ts`: does a signed-in visitor go to the dashboard instead? */
export function isSignedOutOnlyPath(path: string): boolean {
  return matchesPath(path, SIGNED_OUT_ONLY_PATHS);
}

/** What the registration form holds while it is being typed. */
export interface RegistrationForm {
  firstName: string;
  lastName: string;
  companyName: string;
  jobTitle: string;
  email: string;
  registrationCode: string;
  consent: boolean;
}

export const EMPTY_REGISTRATION_FORM: RegistrationForm = {
  firstName: "",
  lastName: "",
  companyName: "",
  jobTitle: "",
  email: "",
  registrationCode: "",
  consent: false,
};

/**
 * What stops a registration before it is sent, if anything: a field left
 * blank (spaces only count as blank), or the notice not accepted. The API
 * checks again; this only tells the person sooner.
 */
export function registrationProblem(
  form: RegistrationForm,
): "incomplete" | "companyNameTooShort" | "consentRequired" | null {
  const typed = [form.firstName, form.lastName, form.companyName, form.jobTitle, form.email, form.registrationCode];
  if (typed.some((value) => value.trim() === "")) return "incomplete";
  // The new company's default subsidiary carries the name (UAT round 2, K1).
  if (form.companyName.trim().length < REGISTRATION_COMPANY_NAME_MIN) return "companyNameTooShort";
  if (!form.consent) return "consentRequired";
  return null;
}

/**
 * Whether this build of the page shows the notice the API records consent to.
 * The notice text is compiled into the page and the version is checked by the
 * API, so a page from another build (a rolling deploy, a stale tab) must not
 * offer the form: the consent row would name a text the person never saw.
 */
export function registrationNoticeIsCurrent(status: RegistrationStatus): boolean {
  return status.consentVersion === REGISTRATION_CONSENT_VERSION;
}

/**
 * The request for a complete form: typed values trimmed, the version of the
 * notice THIS page shows — its own build's, never one the API reported, so a
 * mismatch is refused by the API instead of recorded — and the page's
 * language, the invitation email's. The code keeps its letters' case: capital
 * and small letters are different.
 */
export function registrationRequest(form: RegistrationForm, language: Locale): RegistrationRequest {
  return {
    firstName: form.firstName.trim(),
    lastName: form.lastName.trim(),
    companyName: form.companyName.trim(),
    jobTitle: form.jobTitle.trim(),
    email: form.email.trim(),
    registrationCode: form.registrationCode.trim(),
    consent: true,
    consentVersion: REGISTRATION_CONSENT_VERSION,
    language,
  };
}

/**
 * How the page answers a refused registration: a wrong code is said at its
 * field with the form kept; registration switched off since the page loaded
 * replaces the form; anything else (the quota, the network, a notice changed
 * under an open page) is a toast.
 */
export function registrationFailure(error: unknown): "codeInvalid" | "unavailable" | "other" {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "registration_code_invalid") return "codeInvalid";
  if (code === "registration_unavailable") return "unavailable";
  return "other";
}
