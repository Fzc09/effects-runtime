import * as spec from '@galacean/effects-specification';
import type { Engine } from '../../engine';
import type { Material } from '../../material';
import { Texture, TextureSourceType } from '../../texture';
import type { ItemRenderer } from '../../components';
import type { VFXItem } from '../../vfx-item';
import type { BaseLayout } from './base-layout';
import type { TextStyle } from './text-style';
import { glContext } from '../../gl';
import { isValidFontFamily } from '../../utils';
import { canvasPool } from '../../canvas-pool';

/**
 * 富文本组件特有 API
 */
export interface IRichTextComponent { }

/**
 * 文本组件基础类，包含文本组件和富文本组件的共有逻辑
 */
export class TextComponentBase {
  // 状态与通用字段
  textStyle: TextStyle;
  textLayout: BaseLayout;
  text: string;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D | null;

  // 通用状态字段
  isDirty = true;
  engine: Engine;
  material: Material;
  item: VFXItem;
  renderer: ItemRenderer;

  protected maxLineWidth = 0;
  // 常量
  protected readonly ALPHA_FIX_VALUE = 1 / 255;

  /** 默认同时更新布局；普通文本可只使像素失效。 */
  protected markTextureDirty (): void {
    this.isDirty = true;
  }

  /**
   * 设置文本内容
   * @param value - 文本内容
   */
  setText (value: string): void {
    if (this.text === value) {
      return;
    }
    this.text = value.toString();
    this.isDirty = true;
  }

  /**
   * 设置文本水平布局
   * @param value - 布局选项
   */
  setTextAlign (value: spec.TextAlignment): void {
    if (this.textLayout.textAlign === value) {
      return;
    }
    this.textLayout.textAlign = value;
    this.markTextureDirty();
  }

  /**
   * 设置文本垂直布局
   * @param value - 布局选项
   */
  setTextVerticalAlign (value: spec.TextVerticalAlign): void {
    if (this.textLayout.textVerticalAlign === (value as unknown as spec.TextVerticalAlign)) {
      return;
    }
    this.textLayout.textVerticalAlign = value as unknown as spec.TextVerticalAlign;
    this.markTextureDirty();
  }

  /**
   * @deprecated 2.8.0 本方法已废弃，请使用 setTextVerticalAlign 替代。
   */
  setTextBaseline (value: spec.TextBaseline): void {
    console.warn(
      'setTextBaseline 已废弃，请改用 setTextVerticalAlign。' +
      '本次调用将转调用 setTextVerticalAlign。'
    );

    this.setTextVerticalAlign(value as unknown as spec.TextVerticalAlign);
  }

  /**
   * 设置文本颜色
   * @param value - 颜色内容
   * @default [1, 1, 1, 1]
   */
  setTextColor (value: spec.RGBAColorValue): void {
    if (this.textStyle.textColor === value) {
      return;
    }
    this.textStyle.textColor = value;
    this.markTextureDirty();
  }

  /**
   * 设置字体
   * @param value - 字体名称，如："Arial", "Times New Roman" 等
   * @default "sans-serif"
   */
  setFontFamily (value: string): void {
    if (!isValidFontFamily(value)) {
      console.warn('Risky font family, ignored:', value);

      return;
    }
    if (this.textStyle.fontFamily === value) {
      return;
    }
    this.textStyle.fontFamily = value;
    this.isDirty = true;
  }

  /**
   * 设置字重
   * @param value - 字重类型
   */
  setFontWeight (value: spec.TextWeight): void {
    if (this.textStyle.textWeight === value) {
      return;
    }
    this.textStyle.textWeight = value;
    this.isDirty = true;
  }

  /**
   * 设置字体样式
   * @param value - 字体样式
   * @default "normal"
   */
  setFontStyle (value: spec.FontStyle): void {
    if (this.textStyle.fontStyle === value) {
      return;
    }
    this.textStyle.fontStyle = value;
    this.isDirty = true;
  }

  /**
   * 设置外描边文本颜色
   * @param value - 颜色内容
   */
  setOutlineColor (value: spec.RGBAColorValue): void {
    if (this.textStyle.outlineColor === value) {
      return;
    }
    this.textStyle.outlineColor = value;
    this.markTextureDirty();
  }

  /**
   * 设置是否启用外描边
   * @param value - 是否启用外描边
   */
  setOutlineEnabled (value: boolean): void {
    if (this.textStyle.isOutlined === value) {
      return;
    }
    this.textStyle.isOutlined = value;
    this.markTextureDirty();
  }

  /**
   * 设置字体清晰度
   * @param value - 字体清晰度
   */
  setFontScale (value: number): void {
    if (!Number.isFinite(value) || value <= 0 || this.textStyle.fontScale === value) {
      return;
    }
    this.textStyle.fontScale = value;
    this.markTextureDirty();
  }

  /**
   * 设置文本溢出方式
   * @param overflow - 溢出方式
   */
  setOverflow (overflow: spec.TextOverflow): void {
    this.textLayout.overflow = overflow;
    this.isDirty = true;
  }

  // 通用工具方法
  protected getFontDesc (size?: number): string {
    const { fontSize, fontFamily, textWeight, fontStyle } = this.textStyle;
    let fontDesc = `${(size || fontSize).toString()}px `;

    if (!['serif', 'sans-serif', 'monospace', 'courier'].includes(fontFamily)) {
      fontDesc += `"${fontFamily}"`;
    } else {
      fontDesc += fontFamily;
    }
    if (textWeight !== spec.TextWeight.normal) {
      fontDesc = `${textWeight} ${fontDesc}`;
    }

    if (fontStyle !== spec.FontStyle.normal) {
      fontDesc = `${fontStyle} ${fontDesc}`;
    }

    return fontDesc;
  }

  protected setupOutline (fontScale = 1): void {
    const context = this.context;
    const { outlineColor, outlineWidth } = this.textStyle;
    const [r, g, b, a] = outlineColor;

    if (context) {
      context.strokeStyle = `rgba(${r * 255}, ${g * 255}, ${b * 255}, ${a})`;
      context.lineWidth = outlineWidth * 2 / fontScale;
    }
  }

  protected setupShadow (effectiveScale = this.textStyle.fontScale, flipY = true): void {
    const context = this.context;
    const { shadowColor, shadowBlur, shadowOffsetX, shadowOffsetY } = this.textStyle;
    const [r, g, b, a] = shadowColor;

    if (context) {
      context.shadowColor = `rgba(${r * 255}, ${g * 255}, ${b * 255}, ${a})`;
      context.shadowBlur = shadowBlur * effectiveScale;
      context.shadowOffsetX = shadowOffsetX * effectiveScale;
      // Canvas 阴影偏移不受绘制变换影响。
      context.shadowOffsetY = (flipY ? -1 : 1) * shadowOffsetY * effectiveScale;
    }
  }

  // 通用纹理生命周期管理
  protected disposeTextTexture (): void {
    const texture = this.renderer.texture;

    if (texture && texture !== this.engine.assetServer.whiteTexture) {
      texture.dispose();
    }
  }

  protected releaseTextCanvas (): void {
    if (!this.canvas || !this.context) {
      return;
    }

    // 避免共享画布池中的空闲画布保留大量像素存储。
    this.canvas.width = this.canvas.height = 1;
    canvasPool.releaseCanvasAndContext({
      canvas: this.canvas,
      context: this.context,
    });

    this.canvas = undefined as unknown as HTMLCanvasElement;
    this.context = null;
  }

  /**
   * 通用纹理渲染辅助方法
   */
  protected renderToTexture (
    width: number,
    height: number,
    flipY: boolean,
    drawCallback: (ctx: CanvasRenderingContext2D) => void,
    options: { disposeOld?: boolean, reuse?: boolean } = {}
  ): void {
    if (!this.context || !this.canvas) {
      return;
    }

    const context = this.context;
    const textureWidth = Math.max(1, width);
    const textureHeight = Math.max(1, height);

    if (!Number.isSafeInteger(textureWidth) || !Number.isSafeInteger(textureHeight)) {
      throw new RangeError('Invalid text texture size.');
    }
    // 调整画布尺寸会重置整个上下文，包括已保存的状态栈。
    if (this.canvas.width !== textureWidth) { this.canvas.width = textureWidth; }
    if (this.canvas.height !== textureHeight) { this.canvas.height = textureHeight; }
    context.save();
    try {

      //重置变换
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalAlpha = 1;
      context.globalCompositeOperation = 'source-over';
      context.direction = 'ltr';
      context.textAlign = 'left';
      context.textBaseline = 'alphabetic';
      context.shadowColor = 'transparent';
      context.shadowBlur = context.shadowOffsetX = context.shadowOffsetY = 0;

      // 处理翻转
      if (!flipY) {
        context.translate(0, textureHeight);
        context.scale(1, -1);
      }

      // 在翻转后清空画布
      context.clearRect(0, 0, textureWidth, textureHeight);

      // 设置 alpha 修复用填充色（不实际输出像素）
      context.fillStyle = `rgba(255, 255, 255, ${this.ALPHA_FIX_VALUE})`;

      // 执行绘制回调
      drawCallback(context);
    } finally {
      context.restore();
    }

    // 创建新纹理
    const imageData = context.getImageData(0, 0, textureWidth, textureHeight);
    // getImageData 返回独立的新缓冲区，后续画布绘制不会覆盖此视图中的数据；
    // 启用上下文恢复时，Texture 会保留该缓冲区。
    const data = {
      data: new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength),
      width: imageData.width,
      height: imageData.height,
    };
    const oldTexture = this.renderer.texture;

    if (options.reuse && oldTexture && oldTexture !== this.engine.assetServer.whiteTexture
      && !oldTexture.isDestroyed && oldTexture.getWidth() === textureWidth && oldTexture.getHeight() === textureHeight
      && oldTexture.sourceType === TextureSourceType.data && oldTexture.source.target === glContext.TEXTURE_2D
      && oldTexture.source.flipY === flipY && oldTexture.source.format === glContext.RGBA
      && oldTexture.source.internalFormat === glContext.RGBA && oldTexture.source.type === glContext.UNSIGNED_BYTE
      && oldTexture.source.wrapS === glContext.CLAMP_TO_EDGE && oldTexture.source.wrapT === glContext.CLAMP_TO_EDGE
      && oldTexture.source.magFilter === glContext.LINEAR && oldTexture.source.minFilter === glContext.LINEAR) {
      const previousSource = oldTexture.source;

      try {
        oldTexture.updateSource({ data });
      } catch (error) {
        oldTexture.source = previousSource;
        throw error;
      }
      oldTexture.release();

      return;
    }
    const texture = Texture.createWithData(
      this.engine,
      data,
      {
        flipY,
        magFilter: glContext.LINEAR,
        minFilter: glContext.LINEAR,
        wrapS: glContext.CLAMP_TO_EDGE,
        wrapT: glContext.CLAMP_TO_EDGE,
      },
    );

    try {
      texture.initialize();
    } catch (error) {
      texture.dispose();
      throw error;
    }

    // 根据选项决定是否释放旧纹理
    this.renderer.texture = texture;
    this.material.setTexture('_MainTex', texture);
    if (options.disposeOld !== false && oldTexture && oldTexture !== this.engine.assetServer.whiteTexture) {
      oldTexture.dispose();
    }
  }

  // 初始化方法，由子类调用
  protected initTextBase (engine: Engine): void {
    this.engine = engine;
    const canvasAndContext = canvasPool.getCanvasAndContext(1, 1);

    this.canvas = canvasAndContext.canvas;
    this.context = canvasAndContext.context;
  }
}
