import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import type { OrganisationDTO } from '@tonyai/shared-types';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { UpdateConsolidationApproachDto } from './dto/update-consolidation-approach.dto';
import { OrganisationService } from './organisation.service';

/** The caller's own organisation (inc26-group-tree, D8). */
@Controller('organisation')
export class OrganisationController {
  constructor(private readonly service: OrganisationService) {}

  @Get()
  get(@CurrentUser() user: RequestUser): Promise<OrganisationDTO> {
    return this.service.get(user);
  }

  @Patch('consolidation-approach')
  setConsolidationApproach(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateConsolidationApproachDto,
  ): Promise<OrganisationDTO> {
    return this.service.setConsolidationApproach(user, dto);
  }

  /** The masterkey finishes the setup wizard (inc26-central-reporter-onboarding D8). */
  @Post('onboarding/complete')
  @HttpCode(200)
  completeOnboarding(@CurrentUser() user: RequestUser): Promise<OrganisationDTO> {
    return this.service.completeOnboarding(user);
  }
}
