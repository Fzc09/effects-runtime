/** 运行时资源限制，不改变序列化的文本尺寸参数。 */
export interface TextRasterizationOptions {
  maxTextureSize?: number,
  maxPixels?: number,
  /** 栅格化预览期间的像素预算，不超过 maxPixels。 */
  previewMaxPixels?: number,
  /** 允许的最大逻辑尺寸（像素），独立于纹理尺寸。 */
  maxLogicalSize?: number,
}

/** 调用以结束栅格化预览；重复调用或调用已失效的句柄均无副作用。 */
export interface TextRasterizationPreview {
  (): void,
  /** 是否仍是当前预览；结束、被替代、组件重新加载或销毁后失效。 */
  isActive (): boolean,
}

/** 普通文本和富文本共享的预览生命周期，每个组件持有独立实例。 */
export class TextRasterizationPreviewState {
  private generation = 0;
  private disposed = false;
  private previewRasterized = false;
  private currentMode: 'normal' | 'preview' = 'normal';

  get mode (): 'normal' | 'preview' {
    return this.currentMode;
  }

  /** 替代旧会话，但保留已生成预览纹理的记录，确保最终恢复正常预算。 */
  begin (invalidate: () => void): TextRasterizationPreview {
    const generation = ++this.generation;

    if (!this.disposed) { this.currentMode = 'preview'; }

    const end = () => {
      if (!end.isActive()) { return; }
      const needsRedraw = this.previewRasterized;

      this.reset();
      if (needsRedraw) { invalidate(); }
    };

    end.isActive = () => !this.disposed && generation === this.generation;

    return end;
  }

  /** 纹理成功更新后记录，供结束预览时判断是否需要恢复清晰度。 */
  markRasterized (): void {
    this.previewRasterized = this.currentMode === 'preview';
  }

  /** 重新加载数据时使旧预览失效，由组件负责刷新新内容。 */
  reset (): void {
    ++this.generation;
    this.currentMode = 'normal';
    this.previewRasterized = false;
  }

  dispose (): void {
    this.reset();
    this.disposed = true;
  }
}

export const DEFAULT_TEXT_RASTERIZATION: Readonly<Required<TextRasterizationOptions>> = Object.freeze({
  maxTextureSize: 4096,
  maxPixels: 4 * 1024 * 1024,
  previewMaxPixels: 1024 * 1024,
  maxLogicalSize: 10000000,
});

/** 按传入顺序覆盖配置；undefined 沿用前一级策略，其他非法值仍参与校验。 */
export function resolveTextRasterizationOptions (
  ...overrides: (TextRasterizationOptions | undefined)[]
): Required<TextRasterizationOptions> {
  const result = { ...DEFAULT_TEXT_RASTERIZATION };

  for (const options of overrides) {
    for (const key of Object.keys(result) as (keyof TextRasterizationOptions)[]) {
      const value = options?.[key];

      if (value !== undefined) { result[key] = value; }
    }
  }

  for (const value of [result.maxTextureSize, result.maxPixels, result.previewMaxPixels, result.maxLogicalSize]) {
    if (!Number.isFinite(value) || value < 1 || value > Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Text rasterization limits must be finite positive numbers.');
    }
  }

  return result;
}

/** 在分配画布、像素读回缓冲区或纹理前，计算整数尺寸。 */
export function getTextRasterSize (
  width: number,
  height: number,
  desiredScale: number,
  deviceMaxSize: number,
  options: TextRasterizationOptions = {},
  preview = false,
): { width: number, height: number, scale: number } {
  const limits = resolveTextRasterizationOptions(options);

  if (![width, height, desiredScale, deviceMaxSize].every(Number.isFinite)
    || width < 0 || height < 0 || desiredScale <= 0 || deviceMaxSize < 2) {
    throw new RangeError('Invalid text rasterization dimensions.');
  }
  const side = Math.floor(Math.min(limits.maxTextureSize, deviceMaxSize / 2));
  const pixels = Math.floor(preview ? Math.min(limits.maxPixels, limits.previewMaxPixels) : limits.maxPixels);
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  let scale = Math.min(desiredScale, side / w, side / h, Math.sqrt(pixels) / Math.sqrt(w) / Math.sqrt(h));
  const sizeAt = (r: number) => ({ width: Math.max(1, Math.ceil(width * r)), height: Math.max(1, Math.ceil(height * r)) });
  const fits = (size: { width: number, height: number }) => size.width <= side
    && size.height <= side && size.width <= pixels / size.height;
  let size = sizeAt(scale);

  // 向上取整和最小 1 像素尺寸都会影响预算校验，细长纹理尤需注意。
  if (!fits(size)) {
    let low = 0;
    let high = scale;

    for (let i = 0; i < 64; i++) {
      const candidate = low + (high - low) / 2;

      if (fits(sizeAt(candidate))) {
        low = candidate;
      } else {
        high = candidate;
      }
    }
    scale = low;
    size = sizeAt(scale);
  }
  if (scale <= 0 || !fits(size)) {
    throw new RangeError('Text rasterization scale is not representable.');
  }

  return { ...size, scale };
}
