-- LP3-01 — the UI language a user chooses.
--
-- `profiles.language` has existed since the init migration (TEXT NOT NULL,
-- default 'en') and nothing wrote it. LP3-01 lets a user set their own
-- (`PATCH /api/v1/me/preferences`, audited); the web mirrors it into a cookie,
-- and reports and emails will read it for their default language (D16).

-- 1. Only languages the product speaks — `SUPPORTED_LOCALES` in
--    @tonyai/shared-types. Prisma does not model CHECK constraints, so it
--    reports no drift for this one. If this statement fails on a deploy, a row
--    holds another value: correct it to 'en' (the API already read any such
--    value as 'en') and deploy again.
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_language_supported" CHECK ("language" IN ('en', 'tr'));

-- 2. The runtime role may change it. Column-level, beside `role` and
--    `updated_at` (LP1-03): no other profile column becomes writable. Which
--    row is the API's to enforce — the caller's own, by the token's subject.
GRANT UPDATE ("language") ON "profiles" TO "tonyai_runtime";
