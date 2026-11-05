import {
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  Min,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
  registerDecorator,
  ValidationOptions,
  validateSync,
} from 'class-validator';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import {
  EQUIPMENT_TYPES,
  EQUIPMENT_TYPES_WITH_ALTERNATIVE,
  LEAK_RATE_CHOICES,
  type EquipmentType,
  type LeakRateChoice,
} from '@tonyai/shared-types';

/**
 * Natural Gas parameters (D3). A calorific value or a correction factor of
 * zero has no meaning, and the billed GCV divides (D5), so all three are
 * positive. Whether the unit requires the correction factor is the engine's
 * refusal (D5), because only the engine sees the unit it prices.
 */
class NaturalGasParametersDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  ncvKcalPerSm3?: number | null;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  billedGcvKcalPerSm3?: number | null;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  volumeCorrectionFactor?: number | null;
}

/**
 * Refrigerant parameters (D3, D7): all three are required. The installed
 * capacity is the record's `kg` activity value, so it is not repeated here; a
 * refill may be zero.
 */
class RefrigerantParametersDto {
  @IsIn(EQUIPMENT_TYPES)
  equipmentType!: EquipmentType;

  @IsNumber()
  @Min(0)
  refillKg!: number;

  @IsIn(LEAK_RATE_CHOICES)
  leakRateChoice!: LeakRateChoice;
}

function fieldIssues<T extends object>(Dto: ClassConstructor<T>, value: object): { dto: T; issues: string[] } {
  const dto = plainToInstance(Dto, value);
  // Nested by hand, so the request pipe's whitelist does not reach this object:
  // without these two options an unknown key would be stored as if it were an input.
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, issues: errors.flatMap((e) => Object.values(e.constraints ?? {})) };
}

/**
 * What is wrong with `value` as a `category` record's parameters (D3), empty
 * when nothing is. The one rule both callers ask: the DTO, for a request that
 * names its category, and the service, against the effective category of every
 * write.
 */
export function recordParametersIssues(category: string, value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object' || Array.isArray(value)) return ['parameters must be an object or null'];

  if (category === 'Natural Gas') {
    const { dto, issues } = fieldIssues(NaturalGasParametersDto, value);
    if (dto.ncvKcalPerSm3 != null && dto.billedGcvKcalPerSm3 != null) {
      issues.push('ncvKcalPerSm3 and billedGcvKcalPerSm3 are mutually exclusive: provide at most one');
    }
    return issues;
  }
  if (category === 'Refrigerants') {
    const { dto, issues } = fieldIssues(RefrigerantParametersDto, value);
    if (dto.leakRateChoice === 'alternative' && !EQUIPMENT_TYPES_WITH_ALTERNATIVE.includes(dto.equipmentType)) {
      issues.push(`${String(dto.equipmentType)} has no alternative leak rate: leakRateChoice must be 'default'`);
    }
    return issues;
  }
  return [`${category} does not accept record parameters`];
}

/**
 * An edit that does not name its category leaves the category rule to the
 * service, which knows the effective one; the DTO then asks only for an object.
 */
function issuesFor(args: ValidationArguments): string[] {
  const { category } = args.object as { category?: unknown };
  if (typeof category === 'string') return recordParametersIssues(category, args.value);
  const { value } = args;
  return value === null || value === undefined || (typeof value === 'object' && !Array.isArray(value))
    ? []
    : ['parameters must be an object or null'];
}

@ValidatorConstraint({ name: 'ValidRecordParameters', async: false })
class ValidRecordParametersConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    return issuesFor(args).length === 0;
  }

  defaultMessage(args: ValidationArguments): string {
    return issuesFor(args).join('; ');
  }
}

/** The record's `parameters` hold to its category's rule (`recordParametersIssues`). */
export function IsValidRecordParameters(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: ValidRecordParametersConstraint,
    });
  };
}
