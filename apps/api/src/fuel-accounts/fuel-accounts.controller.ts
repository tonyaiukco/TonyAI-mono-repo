import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import type { FuelAccountDTO } from '@tonyai/shared-types';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';
import { ConfirmFuelAccountDto, CreateFuelAccountDto, UpdateFuelAccountDto } from './dto/fuel-account.dto';
import { FuelAccountsService } from './fuel-accounts.service';

/** Fuel accounts and their mappings (inc28-fuel-bulk D7, D14). */
@Controller('fuel-accounts')
export class FuelAccountsController {
  constructor(private readonly accounts: FuelAccountsService) {}

  @Get()
  list(@CurrentUser() user: RequestUser): Promise<FuelAccountDTO[]> {
    return this.accounts.list(user);
  }

  @Post()
  create(@CurrentUser() user: RequestUser, @Body() body: CreateFuelAccountDto): Promise<FuelAccountDTO> {
    return this.accounts.create(user, body);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUuidParamPipe) id: string,
    @Body() body: ConfirmFuelAccountDto,
  ): Promise<FuelAccountDTO> {
    return this.accounts.confirm(user, id, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUuidParamPipe) id: string,
    @Body() body: UpdateFuelAccountDto,
  ): Promise<FuelAccountDTO> {
    return this.accounts.update(user, id, body);
  }
}
