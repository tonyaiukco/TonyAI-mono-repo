import { Module } from '@nestjs/common';
import { InventoryBoundariesController } from './inventory-boundaries.controller';
import { InventoryBoundariesService } from './inventory-boundaries.service';

/** LP3-04's write path: the boundary routes (W1, W13; E1–E9). */
@Module({
  controllers: [InventoryBoundariesController],
  providers: [InventoryBoundariesService],
})
export class InventoryBoundaryModule {}
