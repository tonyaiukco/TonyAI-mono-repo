import { Module } from '@nestjs/common';
import { RuntimeLimits } from './runtime-limits';

/**
 * The application's one `RuntimeLimits`: its quota maps, permits and shutdown
 * settling are shared by every request, so there must never be a second copy.
 * A module is instantiated once however many modules import it — the root
 * module (the request guard) and UsersModule (the reset quota) get the same
 * instance, with no `ModuleRef` lookup.
 */
@Module({ providers: [RuntimeLimits], exports: [RuntimeLimits] })
export class RuntimeLimitsModule {}
