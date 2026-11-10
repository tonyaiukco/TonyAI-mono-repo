-- UAT round 2, BUG-R2-11 (OpenSpec `uat2-mgo-factor-edition`, design D6): a
-- holding's source list can map a marine gas oil source. The inventory
-- boundary's mapping CHECK spells each typed category's activity types out in
-- SQL, mirroring @tonyai/shared-types (boundary-schema-parity.spec.ts), so it is
-- re-created exactly as 20261105120000_lp4_02_tr_publishers left it, with
-- `marine_gas_oil` added to Mobile Combustion's list. No table or column
-- changes and no stored row is rewritten: the new definition only admits more.

ALTER TABLE "inventory_sources"
  DROP CONSTRAINT "inventory_sources_mapping_check";

ALTER TABLE "inventory_sources"
  ADD CONSTRAINT "inventory_sources_mapping_check" CHECK (
    ("mapping" = 'mapped'
      -- Said, not left to IN: a NULL category makes this branch NULL, and a
      -- CHECK admits NULL (review round 2).
      AND "category" IS NOT NULL
      AND "category" IN ('Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants', 'Fugitive Gas')
      AND "unsupported_reason" IS NULL
      AND "scope" = CASE "category" WHEN 'Electricity' THEN 2 ELSE 1 END
      AND CASE "category"
            WHEN 'Fuel' THEN "activity_type" IS NOT NULL
              AND "activity_type" IN ('diesel', 'petrol', 'gas_oil', 'fuel_oil', 'burning_oil', 'lpg', 'lng', 'coal')
            WHEN 'Mobile Combustion' THEN "activity_type" IS NOT NULL
              AND "activity_type" IN ('diesel', 'petrol', 'lpg', 'cng',
                'on_road_petrol', 'on_road_diesel', 'on_road_lpg', 'off_road_petrol', 'off_road_diesel',
                'marine_gas_oil')
            WHEN 'Refrigerants' THEN "activity_type" IS NOT NULL
              AND "activity_type" IN ('R-22', 'R-32', 'R-134a', 'R-404A', 'R-407C', 'R-407F', 'R-410A', 'R-448A', 'R-449A', 'R-1234yf', 'HFC-227ea', 'SF6')
            ELSE "activity_type" IS NULL
          END)
    OR ("mapping" = 'unsupported'
      AND "category" IS NULL
      AND "activity_type" IS NULL
      AND "scope" IN (1, 2)
      AND "unsupported_reason" IS NOT NULL
      AND ("unsupported_reason" IS NFC NORMALIZED AND char_length("unsupported_reason") BETWEEN 1 AND 500
        AND "unsupported_reason" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻\U000E0000-\U000E0FFF]'))
  );
