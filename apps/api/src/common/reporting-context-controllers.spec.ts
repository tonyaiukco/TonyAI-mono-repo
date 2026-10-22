import 'reflect-metadata';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as nest from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import * as currentUser from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import * as contextDto from './reporting-context-query.dto';
import * as summaryDto from '../emissions/dto/emissions-summary-query.dto';
import * as matrixDto from '../emissions/dto/tracking-matrix-query.dto';
import * as completenessDto from '../emissions/dto/completeness-query.dto';
import { CodedValidationPipe, GLOBAL_VALIDATION_OPTIONS } from './coded-validation.pipe';
import { controllerModule } from './controller-metadata.test-support';
import type { EmissionsService } from '../emissions/emissions.service';
import type { IntensityService } from '../intensity/intensity.service';

const dependencies = {
  '@nestjs/common': nest,
  '../auth/current-user.decorator': currentUser,
  '../common/reporting-context-query.dto': contextDto,
};
const { EmissionsController } = controllerModule<typeof import('../emissions/emissions.controller')>(
  resolve(__dirname, '../emissions/emissions.controller.ts'), {
    ...dependencies, './emissions.service': { EmissionsService: class {} },
    './dto/emissions-summary-query.dto': summaryDto, './dto/tracking-matrix-query.dto': matrixDto,
    './dto/completeness-query.dto': completenessDto,
  },
);
const { IntensityController } = controllerModule<typeof import('../intensity/intensity.controller')>(
  resolve(__dirname, '../intensity/intensity.controller.ts'), {
    ...dependencies, './intensity.service': { IntensityService: class {} },
  },
);
const SUB = '22222222-2222-2222-2222-222222222201';
const user = { id: 'caller', accessibleSubsidiaryIds: [SUB] } as RequestUser;
const expected = { year: 2027, subsidiaryId: SUB, scope: 1 as const, category: 'Fuel' as const };
const raw = { year: '2027', subsidiaryId: SUB, scope: '1', category: 'Fuel' };
const pipe = new CodedValidationPipe(GLOBAL_VALIDATION_OPTIONS);

describe('compiled context controllers and their real query pipe', () => {
  it.each([
    { Controller: EmissionsController, handler: 'contextSummary', path: 'emissions/context/summary', serviceMethod: 'summary' },
    { Controller: EmissionsController, handler: 'contextMatrix', path: 'emissions/context/tracking-matrix', serviceMethod: 'trackingMatrix' },
    { Controller: IntensityController, handler: 'contextIntensity', path: 'intensity/context', serviceMethod: 'contextIntensity' },
  ])('$path forwards and echoes the complete validated context', async ({ Controller, handler, path, serviceMethod }) => {
    const method = Controller.prototype[handler];
    expect(`${Reflect.getMetadata(PATH_METADATA, Controller)}/${Reflect.getMetadata(PATH_METADATA, method)}`).toBe(path);
    expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(nest.RequestMethod.GET);
    const metatype = Reflect.getMetadata('design:paramtypes', Controller.prototype, handler)[1];
    expect(metatype).toBe(contextDto.ReportingContextQueryDto);
    const query = await pipe.transform(raw, { type: 'query', metatype });
    const data = { sentinel: 'service-data' };
    const call = vi.fn(async (_user, context) => serviceMethod === 'contextIntensity' ? { context, data } : data);
    const service = { [serviceMethod]: call } as unknown as EmissionsService & IntensityService;
    const controller = new Controller(service);
    expect(await controller[handler](user, query)).toEqual({ context: expected, data });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(user, expected);
    for (const invalid of [{ ...raw, year: undefined }, { ...raw, subsidiaryId: '' }, { ...raw, scope: '2' },
      { ...raw, subsidiaryId: 'sub-1' }]) {
      await expect(pipe.transform(invalid, { type: 'query', metatype }))
        .rejects.toMatchObject({ response: { code: 'validation_failed' } });
    }
  });
});
