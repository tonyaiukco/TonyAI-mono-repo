import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ConfirmFuelAccountDto, CreateFuelAccountDto, UpdateFuelAccountDto } from '../../fuel-accounts/dto/fuel-account.dto';
import { BulkSubmitFuelBatchesDto, FuelBatchFiltersDto } from '../../fuel-batches/dto/fuel-batch.dto';
import { TakeOverFuelRowsDto, WithdrawFuelRowsDto } from './fuel-rows.dto';

/**
 * The fuel DTOs take an id of the system's shape (`UUID_SHAPE`), not only an
 * RFC 4122 one: the seed's fixed ids carry no version nibble, and an
 * `@IsUUID()` refused every one of them (e2e, inc28-fuel-bulk task 10.1).
 */
const SEED_LIKE = '55555555-5555-5555-5555-5555555F0001';
const errorsOf = <T extends object>(cls: new () => T, body: object) => validateSync(plainToInstance(cls, body) as object);

describe('fuel DTOs accept the system id shape and refuse anything else', () => {
  it.each([
    [ConfirmFuelAccountDto, { subsidiaryId: SEED_LIKE }],
    [UpdateFuelAccountDto, { subsidiaryId: SEED_LIKE }],
    [CreateFuelAccountDto, { source: 'petrol_ofisi', code: 'PO-1', name: 'n', subsidiaryId: SEED_LIKE }],
    [FuelBatchFiltersDto, { subsidiaryId: SEED_LIKE }],
    [BulkSubmitFuelBatchesDto, { batchIds: [SEED_LIKE] }],
    [WithdrawFuelRowsDto, { accountId: SEED_LIKE, reason: 'wrong file' }],
    [TakeOverFuelRowsDto, { accountId: SEED_LIKE }],
  ] as const)('%o accepts a seed-shaped id, lowercased', (cls, body) => {
    expect(errorsOf(cls as never, body)).toEqual([]);
    const dto = plainToInstance(cls as never, body) as Record<string, unknown>;
    const id = (dto.subsidiaryId ?? dto.accountId ?? (dto.batchIds as string[])[0]) as string;
    expect(id).toBe(SEED_LIKE.toLowerCase());
  });

  it('refuses a value that is not an id', () => {
    expect(errorsOf(ConfirmFuelAccountDto, { subsidiaryId: 'not-an-id' })).not.toEqual([]);
    expect(errorsOf(BulkSubmitFuelBatchesDto, { batchIds: ['x'] })).not.toEqual([]);
    expect(errorsOf(FuelBatchFiltersDto, { subsidiaryId: "1' OR '1'='1" })).not.toEqual([]);
  });
});
