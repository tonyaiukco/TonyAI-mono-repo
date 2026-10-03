import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from './auth/public.decorator';
import { PrismaService } from './prisma/prisma.service';
import { HealthReadiness } from './health-readiness';

@Controller('health')
export class HealthController {
  private readonly readiness: HealthReadiness;

  constructor(prisma: PrismaService) {
    this.readiness = new HealthReadiness(prisma);
  }

  /** Liveness after Nest startup; dependency loss must not cause restart loops. */
  @Public()
  @Get()
  check() {
    return { status: 'ok', ts: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  async ready() {
    if (!await this.readiness.check()) throw new ServiceUnavailableException('Not ready');
    return { status: 'ready' };
  }

  /** The global guard verifies a real token AND its profile/tenant grants. */
  @Get('synthetic')
  async synthetic() {
    return this.ready();
  }
}
