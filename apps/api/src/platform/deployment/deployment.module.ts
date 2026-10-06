import { Module } from '@nestjs/common';
import { DeploymentState } from './deployment-state';
import { DeploymentController } from './deployment.controller';

@Module({
  providers: [DeploymentState],
  controllers: [DeploymentController],
  exports: [DeploymentState],
})
export class DeploymentModule {}
