import { Module } from '@nestjs/common';
import { ImagesModule } from '../images/images.module';
import { SamplesModule } from '../samples/samples.module';
import { AnalysesController } from './analyses.controller';
import { AnalysesService } from './analyses.service';

@Module({
  imports: [ImagesModule, SamplesModule],
  controllers: [AnalysesController],
  providers: [AnalysesService],
  exports: [AnalysesService],
})
export class AnalysesModule {}
