-- ng-kwh-engine (UAT round 3, LP4-06; Decisions 2026-11-20 D2-D3): a TR natural
-- gas record in kWh or MWh states its bill's calorific basis, `cvBasis`, `net` or
-- `gross`. The Natural Gas branch admits the key with the same rule as the other
-- gas inputs: a JSON null is an absent key, any other type is refused. Which unit
-- takes which key is the engine's rule (`parameters_not_applicable`,
-- `parameters_required`), as it already is for the volume inputs. Expand-only:
-- every row the previous definition admits, this one admits. The Refrigerants and
-- ELSE branches are copied unchanged from 20261106120000_lp4_02_equipment_parameters.
-- The constraint's md5 is pinned in packages/db/scripts/runtime-role.mjs
-- (INTEGRITY_CHECKS) and re-pinned in the same change.
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
      ELSE false
    END
  );
