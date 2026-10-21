import { GPUResource } from '../gpu-resource';
import type { TextureSourceOptions } from './types';

/** Backend allocation only. Asset identity and CPU sources belong to Texture. */
export abstract class GPUTexture extends GPUResource {
  width = 0;
  height = 0;

  get isInitialized (): boolean { return this.initialized; }

  initialize (source: TextureSourceOptions): void {
    this.releaseGPU();
    try {
      this.onInitialize(source);
      this.initialized = true;
    } catch (error) {
      // 初始化可能已经分配了句柄；releaseGPU 会跳过尚未初始化成功的资源。
      this.onReleaseGPU();
      throw error;
    }
  }

  abstract update (source: TextureSourceOptions, options?: TextureSourceOptions): void;
  abstract offloadData (): void;
  abstract restore (source: TextureSourceOptions): void;
  protected abstract onInitialize (source: TextureSourceOptions): void;

  protected override onReleaseGPU (): void {
    this.width = this.height = 0;
  }
}
