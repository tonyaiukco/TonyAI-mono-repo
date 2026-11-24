-- UAT round 4, BUG-12 (OpenSpec `uat4-fire-suppression-entry`, design decision 8;
-- Decisions 2026-11-24 (fifth)): `Fire Suppression` is a Scope 1 category of its
-- own, priced by the capacity method as Refrigerants is. Six CHECKs spell the
-- categories out in SQL, mirroring @tonyai/shared-types (record-checks.spec.ts,
-- boundary-schema-parity.spec.ts), so each is dropped and re-created exactly as
-- its last migration left it, with only the addition:
--   - activity_records_scope_check (20261105120000_lp4_02_tr_publishers):
--     Fire Suppression is Scope 1;
--   - activity_records_parameters_check (20261123120000_self_gen_model): a
--     Fire Suppression branch equal to the Refrigerants one, holding only the
--     three fire devices (`FIRE_SUPPRESSION_EQUIPMENT_TYPES`), the default leak
--     rate only, and at most one line per device. The Refrigerants branch keeps
--     its nine devices (design decision 7);
--   - inventory_attribution_policies_category_check and
--     inventory_applicability_cells_category_check
--     (20261105120000_lp4_02_tr_publishers): the category joins the list;
--   - inventory_sources_mapping_check
--     (20261110120000_uat2_marine_gas_oil_mapping): a typed category with its
--     four activity types;
--   - report_datasets_schema_check (20261105140000_lp4_02_dataset_schema_v2):
--     dataset schema 3.
-- Expand-only: no stored row is in the new category or schema, every row the
-- old definitions admit the new ones admit, and no table, column or grant
-- changes. The constraints' md5s are pinned in
-- packages/db/scripts/runtime-role.mjs (INTEGRITY_CHECKS).

ALTER TABLE "activity_records"
  DROP CONSTRAINT "activity_records_scope_check";
ALTER TABLE "activity_records"
  ADD CONSTRAINT "activity_records_scope_check" CHECK (
    CASE "category"
      WHEN 'Electricity' THEN "scope" = 2
      WHEN 'Natural Gas' THEN "scope" = 1
      WHEN 'Fuel' THEN "scope" = 1
      WHEN 'Mobile Combustion' THEN "scope" = 1
      WHEN 'Refrigerants' THEN "scope" = 1
      WHEN 'Fire Suppression' THEN "scope" = 1
      WHEN 'Fugitive Gas' THEN "scope" = 1
      WHEN 'Purchased Goods' THEN "scope" = 3
      WHEN 'Waste' THEN "scope" = 3
      WHEN 'Water' THEN "scope" = 3
      WHEN 'Business Travel' THEN "scope" = 3
      WHEN 'Commuting' THEN "scope" = 3
      WHEN 'Logistics' THEN "scope" = 3
      ELSE false
    END
  );

ALTER TABLE "activity_records"
  DROP CONSTRAINT "activity_records_parameters_check";
ALTER TABLE "activity_records"
  ADD CONSTRAINT "activity_records_parameters_check" CHECK (
    "parameters" IS NULL
    OR CASE
      WHEN jsonb_typeof("parameters") <> 'object' THEN false
      WHEN "category" = 'Natural Gas' THEN (
        "parameters" - ARRAY['ncvKcalPerSm3', 'billedGcvKcalPerSm3', 'volumeCorrectionFactor', 'cvBasis'] = '{}'::jsonb
        AND NOT ("parameters"->>'ncvKcalPerSm3' IS NOT NULL AND "parameters"->>'billedGcvKcalPerSm3' IS NOT NULL)
        AND CASE COALESCE(jsonb_typeof("parameters"->'ncvKcalPerSm3'), 'null')
          WHEN 'number' THEN ("parameters"->>'ncvKcalPerSm3')::numeric BETWEEN 1e-300 AND 1e300
          WHEN 'null' THEN true
          ELSE false
        END
        AND CASE COALESCE(jsonb_typeof("parameters"->'billedGcvKcalPerSm3'), 'null')
          WHEN 'number' THEN ("parameters"->>'billedGcvKcalPerSm3')::numeric BETWEEN 1e-300 AND 1e300
          WHEN 'null' THEN true
          ELSE false
        END
        AND CASE COALESCE(jsonb_typeof("parameters"->'volumeCorrectionFactor'), 'null')
          WHEN 'number' THEN ("parameters"->>'volumeCorrectionFactor')::numeric BETWEEN 1e-300 AND 1e300
          WHEN 'null' THEN true
          ELSE false
        END
        AND CASE COALESCE(jsonb_typeof("parameters"->'cvBasis'), 'null')
          WHEN 'string' THEN "parameters"->>'cvBasis' IN ('net', 'gross')
          WHEN 'null' THEN true
          ELSE false
        END
      )
      WHEN "category" = 'Refrigerants' THEN COALESCE((
        "parameters" - ARRAY['equipment'] = '{}'::jsonb
        AND CASE jsonb_typeof("parameters"->'equipment')
          WHEN 'array' THEN (
            jsonb_array_length("parameters"->'equipment') >= 1
            AND jsonb_array_length(jsonb_path_query_array("parameters", 'strict $.equipment[*] ? (@.type() == "object") ? (@.equipmentType.type() == "string" && @.leakRateChoice.type() == "string") ? (@.equipmentType == "fire_suppression_system" || @.equipmentType == "fire_extinguisher" || @.equipmentType == "transformer_breaker" || @.equipmentType == "split_air_conditioner" || @.equipmentType == "water_dispenser" || @.equipmentType == "refrigerator" || @.equipmentType == "chiller" || @.equipmentType == "mobile_air_conditioner" || @.equipmentType == "portable_air_conditioner") ? (@.capacityKg.type() == "number" && @.capacityKg >= 0 && @.capacityKg <= 1e12) ? (@.refillKg.type() == "number" && @.refillKg >= 0 && @.refillKg <= 1e12) ? (@.capacityKg > 0 || @.refillKg > 0) ? (@.leakRateChoice == "default" || (@.leakRateChoice == "alternative" && (@.equipmentType == "split_air_conditioner" || @.equipmentType == "chiller"))) ? (!exists(@.keyvalue() ? (@.key != "equipmentType" && @.key != "capacityKg" && @.key != "refillKg" && @.key != "leakRateChoice")))')) = jsonb_array_length("parameters"->'equipment')
            AND jsonb_array_length(jsonb_path_query_array("parameters", 'strict $.equipment[*] ? (@.equipmentType == "fire_suppression_system")')) <= 1
            AND jsonb_array_length(jsonb_path_query_array("parameters", 'strict $.equipment[*] ? (@.equipmentType == "fire_extinguisher")')) <= 1
            AND jsonb_array_length(jsonb_path_query_array("parameters", 'strict $.equipment[*] ? (@.equipmentType == "transformer_breaker")')) <= 1
            AND jsonb_array_length(jsonb_path_query_array("parameters", 'strict $.equipment[*] ? (@.equipmentType == "split_air_conditioner")')) <= 1
            AND jsonb_array_length(jsonb_path_query_array("parameters", 'strict $.equipment[*] ? (@.equipmentType == "water_dispenser")')) <= 1
            AND jsonb_array_length(jsonb_path_query_array("parameters", 'strict $.equipment[*] ? (@.equipmentType == "refrigerator")')) <= 1
            AND jsonb_array_length(jsonb_path_query_array("parameters", 'strict $.equipment[*] ? (@.equipmentType == "chiller")')) <= 1
            AND jsonb_array_length(jsonb_path_query_array("parameters", 'strict $.equipment[*] ? (@.equipmentType == "mobile_air_conditioner")')) <= 1
            AND jsonb_array_length(jsonb_path_query_array("parameters", 'strict $.equipment[*] ? (@.equipmentType == "portable_air_conditioner")')) <= 1
          )
          ELSE false
        END
      ), false)
      WHEN "category" = 'Fire Suppression' THEN COALESCE((
        "parameters" - ARRAY['equipment'] = '{}'::jsonb
        AND CASE jsonb_typeof("parameters"->'equipment')
          WHEN 'array' THEN (
            jsonb_array_length("parameters"->'equipment') >= 1
            AND jsonb_array_length(jsonb_path_query_array("parameters", 'strict $.equipment[*] ? (@.type() == "object") ? (@.equipmentType.type() == "string" && @.leakRateChoice.type() == "string") ? (@.equipmentType == "fire_suppression_system" || @.equipmentType == "fire_extinguisher" || @.equipmentType == "transformer_breaker") ? (@.capacityKg.type() == "number" && @.capacityKg >= 0 && @.capacityKg <= 1e12) ? (@.refillKg.type() == "number" && @.refillKg >= 0 && @.refillKg <= 1e12) ? (@.capacityKg > 0 || @.refillKg > 0) ? (@.leakRateChoice == "default") ? (!exists(@.keyvalue() ? (@.key != "equipmentType" && @.key != "capacityKg" && @.key != "refillKg" && @.key != "leakRateChoice")))')) = jsonb_array_length("parameters"->'equipment')
            AND jsonb_array_length(jsonb_path_query_array("parameters", 'strict $.equipment[*] ? (@.equipmentType == "fire_suppression_system")')) <= 1
            AND jsonb_array_length(jsonb_path_query_array("parameters", 'strict $.equipment[*] ? (@.equipmentType == "fire_extinguisher")')) <= 1
            AND jsonb_array_length(jsonb_path_query_array("parameters", 'strict $.equipment[*] ? (@.equipmentType == "transformer_breaker")')) <= 1
          )
          ELSE false
        END
      ), false)
      WHEN "category" = 'Electricity' THEN COALESCE((
        "parameters" - ARRAY['generationTopology', 'selfGenerationSource', 'selfGeneratedKwh', 'exportedToGridKwh', 'facilityConsumptionKwh'] = '{}'::jsonb
        AND CASE
          WHEN COALESCE(jsonb_typeof("parameters"->'generationTopology'), 'null') = 'null'
            AND COALESCE(jsonb_typeof("parameters"->'selfGenerationSource'), 'null') = 'null'
            AND COALESCE(jsonb_typeof("parameters"->'selfGeneratedKwh'), 'null') = 'null'
            AND COALESCE(jsonb_typeof("parameters"->'exportedToGridKwh'), 'null') = 'null'
            AND COALESCE(jsonb_typeof("parameters"->'facilityConsumptionKwh'), 'null') = 'null'
            THEN true
          WHEN COALESCE(jsonb_typeof("parameters"->'generationTopology'), 'null') <> 'string'
            OR COALESCE(jsonb_typeof("parameters"->'selfGenerationSource'), 'null') <> 'string'
            OR COALESCE(jsonb_typeof("parameters"->'selfGeneratedKwh'), 'null') <> 'number'
            THEN false
          ELSE (
            "parameters"->>'generationTopology' = 'A'
            AND "parameters"->>'selfGenerationSource' IN ('solar', 'wind', 'natural_gas_chp', 'diesel_generator')
            AND ("parameters"->>'selfGeneratedKwh')::numeric BETWEEN 0 AND 1e300
            AND CASE COALESCE(jsonb_typeof("parameters"->'exportedToGridKwh'), 'null')
              WHEN 'number' THEN ("parameters"->>'exportedToGridKwh')::numeric BETWEEN 0 AND ("parameters"->>'selfGeneratedKwh')::numeric
              WHEN 'null' THEN true
              ELSE false
            END
            AND CASE COALESCE(jsonb_typeof("parameters"->'facilityConsumptionKwh'), 'null')
              WHEN 'number' THEN ("parameters"->>'facilityConsumptionKwh')::numeric BETWEEN 1e-300 AND 1e300
              WHEN 'null' THEN true
              ELSE false
            END
          )
        END
      ), false)
      ELSE false
    END
  );

ALTER TABLE "inventory_attribution_policies"
  DROP CONSTRAINT "inventory_attribution_policies_category_check";
ALTER TABLE "inventory_attribution_policies"
  ADD CONSTRAINT "inventory_attribution_policies_category_check"
    CHECK ("category" IN ('Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants', 'Fire Suppression', 'Fugitive Gas'));

ALTER TABLE "inventory_applicability_cells"
  DROP CONSTRAINT "inventory_applicability_cells_category_check";
ALTER TABLE "inventory_applicability_cells"
  ADD CONSTRAINT "inventory_applicability_cells_category_check"
    CHECK ("category" IN ('Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants', 'Fire Suppression', 'Fugitive Gas'));

ALTER TABLE "inventory_sources"
  DROP CONSTRAINT "inventory_sources_mapping_check";
ALTER TABLE "inventory_sources"
  ADD CONSTRAINT "inventory_sources_mapping_check" CHECK (
    ("mapping" = 'mapped'
      -- Said, not left to IN: a NULL category makes this branch NULL, and a
      -- CHECK admits NULL (review round 2).
      AND "category" IS NOT NULL
      AND "category" IN ('Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants', 'Fire Suppression',
        'Fugitive Gas')
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
            WHEN 'Fire Suppression' THEN "activity_type" IS NOT NULL
              AND "activity_type" IN ('CO2', 'HFC-227ea', 'SF6', 'dry_powder_or_foam')
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

ALTER TABLE "report_datasets"
  DROP CONSTRAINT "report_datasets_schema_check";
ALTER TABLE "report_datasets"
  ADD CONSTRAINT "report_datasets_schema_check"
    CHECK ("schema_version" IN (1, 2, 3) AND "canonicalization" = 'tonyai-report-dataset-v1');
