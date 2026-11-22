-- self-gen-model (UAT round 3, LP4-07; Decisions 2026-11-20 D5, D6, D8): an
-- Electricity record may carry a self-generation block (spec v2.5 §2, Case A):
-- `generationTopology`, `selfGenerationSource`, `selfGeneratedKwh`, and
-- optionally `exportedToGridKwh` and `facilityConsumptionKwh`. The new
-- Electricity branch, placed before `ELSE false`, holds only what the engine
-- accepts:
--   - the keys are a subset of the five;
--   - either every key is absent or JSON null (no block, a plain grid record),
--     or the topology is 'A', the source is a named one and the generation is
--     a number from 0 (topologies 'B' and 'C' wait for LP7-09, which widens
--     this branch with another expand-only migration);
--   - `exportedToGridKwh` is absent, null, or a number from 0 to the generation;
--   - `facilityConsumptionKwh` is absent, null, or a number above 0;
--   - numbers use the jsonb_typeof pattern with the 1e300 bound, every cast
--     guarded by its type.
-- Expand-only: the previous definition refused every non-null parameters
-- object on Electricity (`ELSE false`), and every row it admits, this one
-- admits. The Natural Gas, Refrigerants and ELSE branches are copied unchanged
-- from 20261120120000_ng_kwh_cv_basis. The constraint's md5 is pinned in
-- packages/db/scripts/runtime-role.mjs (INTEGRITY_CHECKS) and re-pinned in the
-- same change.
-- ---------------------------------------------------------------------------

ALTER TABLE "activity_records" DROP CONSTRAINT "activity_records_parameters_check";

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
