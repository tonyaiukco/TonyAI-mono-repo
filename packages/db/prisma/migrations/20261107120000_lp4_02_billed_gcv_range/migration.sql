-- LP4-02 PR5 task 5.5: the billed gross calorific value range (D11), owner decision
-- 2026-11-05: 8,100 to 10,427 kcal/Sm³ from Annex 1 of BOTAŞ's transmission network
-- operating rules (ŞİD). Loaded as two release parameters, so the CHECK admits their
-- keys: each in kcal/Sm3, with no subject, like the reference values. The rest of the
-- rule is unchanged. A release that carries them carries both (the import validator),
-- and the engine refuses a billed GCV outside them.
-- ---------------------------------------------------------------------------

ALTER TABLE "factor_parameters" DROP CONSTRAINT "factor_parameters_value_check";

ALTER TABLE "factor_parameters"
  ADD CONSTRAINT "factor_parameters_value_check" CHECK (
    "value" > 0 AND "value" < 'infinity'::double precision
    AND CASE "key"
      WHEN 'billed_gcv_max' THEN "unit" = 'kcal/Sm3' AND "subject" IS NULL
      WHEN 'billed_gcv_min' THEN "unit" = 'kcal/Sm3' AND "subject" IS NULL
      WHEN 'leak_rate' THEN "unit" = 'fraction' AND "value" <= 1 AND "subject" IS NOT NULL
      WHEN 'reference_gcv' THEN "unit" = 'kcal/Sm3' AND "subject" IS NULL
      WHEN 'reference_ncv' THEN "unit" = 'kcal/Sm3' AND "subject" IS NULL
      ELSE false
    END
  );
