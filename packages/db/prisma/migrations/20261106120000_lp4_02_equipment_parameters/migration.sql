-- LP4-02 PR3 task 3.3: refrigerant parameters become one line per equipment type
-- (D7), so two equipment types of one gas share the gas's record. The column holds
-- only NULL so far: PR2's gate refused every other value through the API.
-- ---------------------------------------------------------------------------

ALTER TABLE "activity_records" DROP CONSTRAINT "activity_records_parameters_check";

-- A CHECK allows no subquery, so a line is validated by a jsonpath filter, and the
-- array is valid when every line survives it: a line the filter cannot evaluate is
-- dropped, which refuses it. `strict`, with the types asked first, because lax mode
-- unwraps arrays: `[[line]]` or `leakRateChoice: ["default"]` would pass, and the
-- engine would read the second as the alternative rate. The sum of capacities and the annual period are the
-- engine's refusals, which a recompute asks too (D11).
ALTER TABLE "activity_records"
  ADD CONSTRAINT "activity_records_parameters_check" CHECK (
    "parameters" IS NULL
    OR CASE
      WHEN jsonb_typeof("parameters") <> 'object' THEN false
      WHEN "category" = 'Natural Gas' THEN (
        "parameters" - ARRAY['ncvKcalPerSm3', 'billedGcvKcalPerSm3', 'volumeCorrectionFactor'] = '{}'::jsonb
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
