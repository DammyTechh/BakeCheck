import { Module } from '@nestjs/common';
import { SamplesModule } from '../samples/samples.module';
import { ImagesController } from './images.controller';
import { ImagesService } from './images.service';
import { ImageValidationService } from './image-validation.service';

@Module({
  imports: [SamplesModule],
  controllers: [ImagesController],
  providers: [ImagesService, ImageValidationService],
  exports: [ImagesService, ImageValidationService],
})
export class ImagesModule {}
