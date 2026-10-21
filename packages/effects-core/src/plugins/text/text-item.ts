/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import { Color, Vector2 } from '@galacean/effects-math/es/core/index';
import * as spec from '@galacean/effects-specification';
import { canvasPool } from '../../canvas-pool';
import { MaskableGraphic } from '../../components';
import { effectsClass } from '../../decorators';
import type { Engine } from '../../engine';
import { applyMixins } from '../../utils';
import { breakOpportunityAfter } from './line-break';
import { TextLayout } from './text-layout';
import { TextStyle } from './text-style';
import { TextComponentBase } from './text-component-base';
import type { Renderer } from '../../render/renderer';
import { getTextRasterSize, resolveTextRasterizationOptions, TextRasterizationPreviewState } from './text-rasterization';
import type { TextRasterizationOptions, TextRasterizationPreview } from './text-rasterization';

export const DEFAULT_FONTS = [
  'serif',
  'sans-serif',
  'monospace',
  'courier',
];

interface CharInfo {
  /**
   * 段落 y 值
   */
  y: number,
  /**
   * 段落字符
   */
  chars: string[],
  charOffsetX: number[],
  /**
   * 段落宽度
   */
  width: number,
}

/** 检测字符串是否包含需要 RTL 和连写排版的字符（阿拉伯语等） */
const HAS_RTL_OR_JOINING = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

export interface TextComponent extends TextComponentBase { }

let seed = 0;

/**
 * @since 2.0.0
 */
@effectsClass(spec.DataType.TextComponent)
export class TextComponent extends MaskableGraphic {
  private dirty = true;
  private layoutDirty = true;
  private textDestroyed = false;
  private rasterizationOptions: TextRasterizationOptions = {};
  private readonly rasterizationPreview = new TextRasterizationPreviewState();

  get isDirty (): boolean { return this.dirty; }
  set isDirty (value: boolean) {
    this.dirty = value;
    if (value) {
      this.layoutDirty = true;
    }
  }

  // 实例方法避免通用 mixin 覆盖普通文本的布局失效策略。
  protected markTextureDirty = (): void => {
    this.dirty = true;
  };

  get rasterizationMode (): 'normal' | 'preview' {
    return this.rasterizationPreview.mode;
  }

  /** 仅在运行时生效的限制；未指定的值沿用引擎策略。 */
  setRasterizationOptions (options: TextRasterizationOptions): void {
    resolveTextRasterizationOptions(this.engine.options.textRasterization, options);
    this.rasterizationOptions = { ...options };
    this.markTextureDirty();
  }

  /**
   * 临时使用 previewMaxPixels 预算栅格化后续更新，适用于连续修改字号、尺寸或样式。
   * 开始预览不触发重绘；结束时仅在生成过预览纹理后标记待刷新，下次更新恢复正常预算。
   * 需要立即更新纹理时由调用方执行 flushText。
   * 同一组件仅保留最新预览；新预览、fromData 或销毁都会使旧句柄失效。
   */
  beginRasterizationPreview (): TextRasterizationPreview {
    return this.rasterizationPreview.begin(() => { this.markTextureDirty(); });
  }

  /** 同步刷新布局和几何数据；由宿主决定何时更新像素或绘制。 */
  refreshText (): void {
    if (this.textDestroyed) {
      return;
    }
    this.isDirty = true;
    this.updateLayout();
  }

  /** 同步完成最新文本的像素更新，可选择在不推进播放时间的情况下呈现。 */
  flushText (present = true): void {
    if (this.textDestroyed || this.engine.disposed || this.engine.displayServer.renderingDevice.contextWasLost) {
      return;
    }
    this.updateTexture();
    if (present) {
      this.engine.onDraw();
    }
  }
  /**
   * 文本行数
   */
  lineCount = 0;
  textStyle: TextStyle;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D | null;
  textLayout: TextLayout;
  text: string;

  /**
   * 描边/阴影等特效导致的纹理扩容比例 X/Y
   */
  protected effectScaleX = 1;
  protected effectScaleY = 1;

  /**
   * 每一行文本的最大宽度
   */
  protected maxLineWidth = 0;

  constructor (engine: Engine) {
    super(engine);

    this.name = 'MText' + seed++;

    // 初始化canvas资源
    const canvasAndContext = canvasPool.getCanvasAndContext(1, 1);

    this.canvas = canvasAndContext.canvas;
    this.context = canvasAndContext.context;

    // 使用默认值初始化
    const defaultData = this.getDefaultProps();

    const { options } = defaultData;

    this.updateWithOptions(options);
  }

  override onUpdate (dt: number): void {
    super.onUpdate(dt);
    this.updateMaterialSize();
  }

  private updateMaterialSize (): void {
    // 覆盖基类每帧更新 size 行为，应用扩容比例
    for (const material of this.materials) {
      let sizeX = this.transform.size.x;
      let sizeY = this.transform.size.y;
      const [scalex, scaley] = this.getTextureExpandScale();

      sizeX *= scalex;
      sizeY *= scaley;

      material.setVector2('_Size', new Vector2(sizeX, sizeY));
    }
  }

  override render (renderer: Renderer) {
    this.prepareTextForRender();
    this.maskManager.drawStencilMask(renderer, this);

    renderer.drawGeometry(this.geometry, this.transform.getWorldMatrix(), this.material);
  }

  override drawStencilMask (maskRef: number): void {
    if (!this.isActiveAndEnabled) { return; }
    this.prepareTextForRender();
    super.drawStencilMask(maskRef);
  }

  private prepareTextForRender (): void {
    try {
      this.updateTexture();
    } catch (error) {
      // 保留原纹理，让场景中的其他内容继续绘制。
      console.error('Text render update failed.', error);
    }
  }

  override onDestroy (): void {
    if (this.textDestroyed) {
      return;
    }
    this.textDestroyed = true;
    this.rasterizationPreview.dispose();
    super.onDestroy();
    this.disposeTextTexture();
    this.releaseTextCanvas();
  }

  override dispose (): void {
    super.dispose();
    // 组件可能在所属元素初始化之前就被释放。
    if (!this.textDestroyed) { this.onDestroy(); }
  }

  override fromData (data: spec.TextComponentData): void {
    const previousTexture = this.renderer.texture;

    super.fromData(data);
    this.renderer.texture = previousTexture;
    this.material.setTexture('_MainTex', previousTexture);
    const { interaction, options } = data;

    this.interaction = interaction;

    this.resetState();

    // TextComponentBase
    this.updateWithOptions(options);
    this.renderText(options);

    // 恢复默认颜色
    this.material.setColor('_Color', new Color(1, 1, 1, 1));
  }

  private resetState (): void {
    this.rasterizationPreview.reset();

    // 重置状态变量
    this.isDirty = true;
    this.lineCount = 0;
    this.maxLineWidth = 0;
  }

  /**
   * 根据配置更新文本样式和布局
   */
  updateWithOptions (options: spec.TextContentOptions): void {
    // 初始化 textStyle 和 textLayout
    if (!this.textStyle) {
      this.textStyle = new TextStyle(options);
    } else {
      this.textStyle.update(options);
    }

    if (!this.textLayout) {
      this.textLayout = new TextLayout(options);
    } else {
      this.textLayout.update(options);
    }

    this.text = options.text.toString();
    this.isDirty = true;
  }

  /**
   * 获取文本行数
   * @param text - 文本内容
   * @returns 行数
   */
  getLineCount (text: string): number {
    this.validateMetrics();
    const context = this.context;
    const { letterSpace, overflow } = this.textLayout;

    this.maxLineWidth = 0;
    const width = (this.textLayout.width + this.textStyle.fontOffset);
    let lineCount = 1;
    let x = 0;
    let charCountInLine = 0;
    // 使用码点遍历，正确处理 emoji 与 CJK 扩展 B 等代理对字符
    const chars = Array.from(text);

    if (context) {
      context.font = this.getFontDesc(this.textStyle.fontSize);
    }

    if (overflow === spec.TextOverflow.display) {
      for (const str of chars) {
        const textMetrics = context?.measureText(str)?.width ?? 0;

        if (str === '\n') {
          lineCount++;
          x = 0;
          charCountInLine = 0;
        } else {
          if (charCountInLine > 0) {
            x += letterSpace;
          }
          x += textMetrics;
          charCountInLine++;
          this.maxLineWidth = Math.max(this.maxLineWidth, x);
        }
      }

      return lineCount;
    }

    if (this.textLayout.keepWordIntact) {
      // 单词完整换行：优先在换行机会处断行（空格吞断 / CJK 字间可断），避免从西文词中间断开
      let lastBreakX = 0;
      let countAtBreak = 0;

      for (const str of chars) {
        const textMetrics = context?.measureText(str)?.width ?? 0;

        if (str === '\n') {
          lineCount++;
          this.maxLineWidth = Math.max(this.maxLineWidth, x);
          x = 0;
          charCountInLine = 0;
          lastBreakX = 0;
          countAtBreak = 0;
          continue;
        }

        const spacing = charCountInLine > 0 ? letterSpace : 0;
        const willWidth = x + spacing + textMetrics;

        if (willWidth > width && charCountInLine > 0) {
          lineCount++;
          if (countAtBreak > 1) {
            this.maxLineWidth = Math.max(this.maxLineWidth, lastBreakX);
            x = x - lastBreakX;
            charCountInLine = charCountInLine - countAtBreak;
          } else {
            this.maxLineWidth = Math.max(this.maxLineWidth, x);
            x = 0;
            charCountInLine = 0;
          }
          lastBreakX = 0;
          countAtBreak = 0;
        }

        if (charCountInLine > 0) {
          x += letterSpace;
        }
        x += textMetrics;
        charCountInLine++;

        // 记换行机会：str 之后可断（空格 swallow / CJK keep）。lastBreakX 含 str 宽度（str 留本行末）
        if (breakOpportunityAfter(str) !== false) {
          lastBreakX = x;
          countAtBreak = charCountInLine;
        }
      }
    } else {
      // 逐字符换行：允许在任意字符处断开
      for (let i = 0; i < chars.length; i++) {
        const str = chars[i];
        const textMetrics = context?.measureText(str)?.width ?? 0;

        if (charCountInLine > 0) {
          x += letterSpace;
        }

        if (((x + textMetrics) > width && i > 0) || str === '\n') {
          lineCount++;
          this.maxLineWidth = Math.max(this.maxLineWidth, x);
          x = 0;
          charCountInLine = 0;
        }

        if (str !== '\n') {
          x += textMetrics;
          charCountInLine++;
        }
      }
    }
    this.maxLineWidth = Math.max(this.maxLineWidth, x);

    return lineCount;
  }

  /**
   * 设置行高
   * 行高表示每行占用的总高度
   * @param value - 行高像素值
   */
  setLineHeight (value: number): void {
    if (!Number.isFinite(value)) { return; }
    const fontSize = this.textStyle.fontSize;
    //设置行高不能小于字号大小
    const safe = Math.max(fontSize, value);

    if (this.textLayout.lineHeight === safe) {
      return;
    }

    this.textLayout.lineHeight = safe;
    this.isDirty = true;
  }

  /** 读取边界前更新逻辑布局，不进行栅格化，也不跳转合成时间。 */
  updateLayout (): void {
    if (this.textDestroyed || !this.layoutDirty) { return; }
    this.validateMetrics();
    const style = this.textStyle;
    const layout = this.textLayout;
    const { width, height } = layout;
    const { lineCount, maxLineWidth } = this;

    try {
      if (layout.autoResize === spec.TextSizeMode.autoWidth) {
        layout.width = this.getTextWidth();
        this.lineCount = this.getLineCount(this.text);
        layout.height = layout.lineHeight * this.lineCount;
      } else if (layout.autoResize === spec.TextSizeMode.autoHeight) {
        this.lineCount = this.getLineCount(this.text);
        layout.height = layout.lineHeight * this.lineCount;
      } else {
        this.lineCount = this.getLineCount(this.text);
      }
      this.validateMetrics();
    } catch (error) {
      // 超限的计算结果不能阻止后续合法内容重新排版。
      layout.width = width;
      layout.height = height;
      this.lineCount = lineCount;
      this.maxLineWidth = maxLineWidth;
      throw error;
    }
    const scaleFactor = 0.11092565;

    this.transform.setSize((layout.width + style.fontOffset) * scaleFactor * scaleFactor, layout.height * scaleFactor * scaleFactor);
    this.layoutDirty = false;
    this.updateMaterialSize();
  }

  private getRasterizationOptions (): Required<TextRasterizationOptions> {
    return resolveTextRasterizationOptions(this.engine.options.textRasterization, this.rasterizationOptions);
  }

  /** 在调用 measureText 或分配画布前，校验导入数据和直接修改的样式。 */
  private validateMetrics (): void {
    const style = this.textStyle;
    const layout = this.textLayout;
    const limit = this.getRasterizationOptions().maxLogicalSize;
    const nonnegative = [layout.width, layout.height, style.outlineWidth, style.shadowBlur];
    const positive = [style.fontSize, layout.lineHeight];
    const signed = [style.fontOffset, style.shadowOffsetX, style.shadowOffsetY, layout.letterSpace];

    if (!nonnegative.every(value => Number.isFinite(value) && value >= 0 && value <= limit)
      || !positive.every(value => Number.isFinite(value) && value > 0 && value <= limit)
      || !signed.every(value => Number.isFinite(value) && Math.abs(value) <= limit)
      || !Number.isFinite(style.fontScale) || style.fontScale <= 0
      || layout.width + style.fontOffset < 0) {
      throw new RangeError('Invalid text layout or style metrics.');
    }
  }

  /** 除非显式刷新，否则每次绘制最多对最新布局进行一次栅格化。 */
  protected updateTexture (flipY = true): void {
    if (!this.isDirty || this.textDestroyed || !this.context || !this.canvas) {
      return;
    }
    // 分配失败后，只有再次编辑并显式标记为待更新时才会重试。
    this.dirty = false;
    this.updateLayout();
    // 仅像素失效时也要校验新的分辨率、样式及资源限制。
    this.validateMetrics();
    const style = this.textStyle;
    const layout = this.textLayout;
    const baseWidth = layout.width + style.fontOffset;
    const baseHeight = layout.height;

    const fontSize = style.fontSize;
    const lineHeight = layout.lineHeight;

    style.fontDesc = this.getFontDesc(fontSize);
    // 使用 Array.from 正确分割 Unicode 字符（包括 emoji）
    const char = Array.from(this.text || '');

    const { padL, padR, padT, padB } = this.getEffectPadding();
    const hasEffect = padL + padR + padT + padB > 0;

    // 限制 fontScale，确保纹理尺寸不超过 maxTextureSize / 2
    const maxTexSize = this.engine.displayServer.renderingDevice.gpuCapability.detail.maxTextureSize;
    const logicalWidth = hasEffect ? baseWidth + padL + padR : baseWidth;
    const logicalHeight = hasEffect ? baseHeight + padT + padB : baseHeight;
    const { width: texWidth, height: texHeight, scale: fontScale } = getTextRasterSize(
      logicalWidth, logicalHeight, style.fontScale, maxTexSize, this.getRasterizationOptions(), this.rasterizationMode === 'preview',
    );

    const shiftX = hasEffect ? padL : 0;
    const shiftY = hasEffect ? (flipY ? padT : padB) : 0;

    // 给渲染层用：扩容比例
    const effectScaleX = baseWidth > 0 ? (texWidth / (baseWidth * fontScale)) : 1;
    const effectScaleY = baseHeight > 0 ? (texHeight / (baseHeight * fontScale)) : 1;

    if (!Number.isFinite(effectScaleX) || !Number.isFinite(effectScaleY)) {
      throw new RangeError('Text rasterization scale cannot represent the material size.');
    }

    this.renderToTexture(texWidth, texHeight, flipY, context => {
      context.scale(fontScale, fontScale);
      // canvas size 变化后重新刷新 context
      if (this.maxLineWidth > baseWidth && layout.overflow === spec.TextOverflow.display) {
        context.font = this.getFontDesc(fontSize * baseWidth / this.maxLineWidth);
      } else {
        context.font = style.fontDesc;
      }

      // textColor 统一是 0-1，写入 canvas 时乘 255
      const [r, g, b, a] = style.textColor;

      context.fillStyle = `rgba(${r * 255}, ${g * 255}, ${b * 255}, ${a})`;

      const charsInfo: CharInfo[] = [];
      let x = 0;
      let y = layout.getOffsetY(style, this.lineCount, lineHeight, fontSize);
      let charsArray: string[] = [];
      let charOffsetX: number[] = [];

      if (layout.keepWordIntact) {
        // 单词完整换行：优先在换行机会处断行（空格吞断 / CJK 字间可断），避免从西文词中间断开。
        // lastBreakIdx 指向断点字符在 charsArray 中的索引；breakSwallow=true 时该字符被吞（空格），
        // false 时该字符留本行末（CJK），下行均从 lastBreakIdx+1 起。
        let lastBreakIdx = -1;
        let breakSwallow = false;

        for (let i = 0; i < char.length; i++) {
          const str = char[i];
          const textMetrics = context.measureText(str);

          if (str === '\n') {
            charsInfo.push({
              y,
              width: x,
              chars: charsArray,
              charOffsetX,
            });
            x = 0;
            y += lineHeight;
            charsArray = [];
            charOffsetX = [];
            lastBreakIdx = -1;
            breakSwallow = false;
            continue;
          }

          const spacing = charsArray.length > 0 ? layout.letterSpace : 0;
          const willWidth = x + spacing + textMetrics.width;

          if (willWidth > baseWidth && charsArray.length > 0) {
            if (lastBreakIdx > 0) {
              // 在换行机会处断行：swallow 取 [0,lastBreakIdx)（吞掉断点字符），
              // keep 取 [0,lastBreakIdx]（断点字符留本行末），下行均从 lastBreakIdx+1 起。
              const endIdx = breakSwallow ? lastBreakIdx : lastBreakIdx + 1;
              const lineChars = charsArray.slice(0, endIdx);
              const lineOffsets = charOffsetX.slice(0, endIdx);
              const lineWidth = lineChars.length > 0
                ? lineOffsets[lineOffsets.length - 1] + context.measureText(lineChars[lineChars.length - 1]).width
                : 0;

              charsInfo.push({
                y,
                width: lineWidth,
                chars: lineChars,
                charOffsetX: lineOffsets,
              });
              y += lineHeight;

              charsArray = charsArray.slice(lastBreakIdx + 1);
              // 重新计算剩余字符的宽度
              x = 0;
              charOffsetX = [];
              for (let j = 0; j < charsArray.length; j++) {
                if (j > 0) { x += layout.letterSpace; }
                charOffsetX.push(x);
                x += context.measureText(charsArray[j]).width;
              }
              lastBreakIdx = -1;
              breakSwallow = false;
            } else {
              charsInfo.push({
                y,
                width: x,
                chars: charsArray,
                charOffsetX,
              });
              x = 0;
              y += lineHeight;
              charsArray = [];
              charOffsetX = [];
              lastBreakIdx = -1;
              breakSwallow = false;
            }
          }

          if (charsArray.length > 0) {
            x += layout.letterSpace;
          }
          charOffsetX.push(x);
          charsArray.push(str);
          x += textMetrics.width;

          // 记换行机会：str 之后可断。lastBreakIdx 指向 str（charsArray 末尾），
          // swallow=吞 str（空格），keep=str 留本行末（CJK）。
          const opp = breakOpportunityAfter(str);

          if (opp !== false) {
            lastBreakIdx = charsArray.length - 1;
            breakSwallow = opp === 'swallow';
          }
        }
      } else {
        // 逐字符换行：允许在任意字符处断开
        for (let i = 0; i < char.length; i++) {
          const str = char[i];
          const textMetrics = context.measureText(str);

          if (charsArray.length > 0) {
            x += layout.letterSpace;
          }

          if (((x + textMetrics.width) > baseWidth && i > 0) || str === '\n') {
            charsInfo.push({
              y,
              width: x,
              chars: charsArray,
              charOffsetX,
            });
            x = 0;
            y += lineHeight;
            charsArray = [];
            charOffsetX = [];
          }

          if (str !== '\n') {
            charsArray.push(str);
            charOffsetX.push(x);
            x += textMetrics.width;
          }
        }
      }

      if (charsArray.length > 0) {
        charsInfo.push({
          y,
          width: x,
          chars: charsArray,
          charOffsetX,
        });
      }

      const hasOutline = style.isOutlined && style.outlineWidth > 0;

      if (hasOutline) {
        // 有描边：在描边时启用阴影
        if (style.hasShadow) {
          this.setupShadow(fontScale, flipY);
        }
        // Canvas 已应用实际缩放倍率，描边宽度仍使用逻辑像素。
        this.setupOutline();

        charsInfo.forEach(charInfo => {
          const drawY = shiftY + charInfo.y;
          const lineStr = charInfo.chars.join('');
          const isRtl = lineStr.length > 0 && HAS_RTL_OR_JOINING.test(lineStr);

          if (isRtl) {
            // RTL 模式：整行绘制，使用实际测量宽度
            const rtlWidth = context.measureText(lineStr).width;
            const ox = layout.getOffsetX(style, rtlWidth);

            context.save();
            context.direction = 'rtl';
            context.strokeText(lineStr, shiftX + ox + rtlWidth, drawY);
            context.restore();
          } else {
            const ox = layout.getOffsetX(style, charInfo.width);

            for (let i = 0; i < charInfo.chars.length; i++) {
              const str = charInfo.chars[i];
              const drawX = shiftX + ox + charInfo.charOffsetX[i];

              context.strokeText(str, drawX, drawY);
            }
          }
        });

        // 描边完成后立即禁用阴影，避免填充时重复绘制阴影
        if (style.hasShadow) {
          context.shadowColor = 'transparent';
        }
      }

      // 填充阶段：无描边时才启用阴影
      if (!hasOutline && style.hasShadow) {
        this.setupShadow(fontScale, flipY);
      }

      charsInfo.forEach(charInfo => {
        const drawY = shiftY + charInfo.y;
        const lineStr = charInfo.chars.join('');
        const isRtl = lineStr.length > 0 && HAS_RTL_OR_JOINING.test(lineStr);

        if (isRtl) {
          // RTL 模式：整行绘制，使用实际测量宽度
          const rtlWidth = context.measureText(lineStr).width;
          const ox = layout.getOffsetX(style, rtlWidth);

          context.save();
          context.direction = 'rtl';
          context.fillText(lineStr, shiftX + ox + rtlWidth, drawY);
          context.restore();
        } else {
          const ox = layout.getOffsetX(style, charInfo.width);

          for (let i = 0; i < charInfo.chars.length; i++) {
            const str = charInfo.chars[i];
            const drawX = shiftX + ox + charInfo.charOffsetX[i];

            context.fillText(str, drawX, drawY);
          }
        }
      });

      // 清理阴影状态
      if (style.hasShadow) {
        context.shadowColor = 'transparent';
      }
    }, { reuse: true });

    this.effectScaleX = effectScaleX;
    this.effectScaleY = effectScaleY;
    this.rasterizationPreview.markRasterized();
    this.updateMaterialSize();
  }

  renderText (options: spec.TextContentOptions) {
    this.updateTexture();
  }

  /**
   * 给渲染层用：获取特效扩容比例（描边/阴影导致的纹理扩容）
   * @returns
   */
  public getTextureExpandScale (): [number, number] {
    return [this.effectScaleX, this.effectScaleY];
  }

  /**
   * 获取描边和阴影的 padding 值（单位：px）
   * @returns
   */
  protected getEffectPadding () {
    const style = this.textStyle;

    const hasDrawOutline = style.isOutlined && style.outlineWidth > 0;
    const outlinePad = hasDrawOutline ? Math.ceil(style.outlineWidth * 2) : 0;

    const hasShadow = style.hasShadow && (style.shadowBlur > 0 || style.shadowOffsetX !== 0 || style.shadowOffsetY !== 0);
    const shadowPad = hasShadow
      ? Math.ceil(Math.abs(style.shadowOffsetX) + Math.abs(style.shadowOffsetY) + style.shadowBlur)
      : 0;

    const pad = outlinePad + shadowPad;

    return { padL: pad, padR: pad, padT: pad, padB: pad };
  }

  setAutoResize (value: spec.TextSizeMode): void {
    if (this.textLayout.autoResize === value) {
      return;
    }
    this.textLayout.autoResize = value;
    this.isDirty = true;
  }

  /**
   * 设置文本框宽度
   * 手动设置宽度时会自动关闭 `autoWidth`
   * 同时会按比例更新 `transform.size.x`，让 UI 框宽度也跟着变化
   * @param value - 文本框宽度
   */
  setTextWidth (value: number): void {
    if (!Number.isFinite(Number(value))) { return; }
    const width = Math.max(0, Number(value) || 0);
    const layout = this.textLayout;

    // 宽度没变且已是非 autoWidth 模式,直接返回
    if (layout.width === width) {
      return;
    }

    // 手动设置宽度时关闭 autoWidth
    if (layout.autoResize === spec.TextSizeMode.autoWidth) {
      layout.autoResize = spec.TextSizeMode.autoHeight;
    }

    layout.width = width;

    // 按当前 overflow 模式重新计算 maxLineWidth
    this.isDirty = true;
  }

  /**
   * 设置文本框高度
   * @param value - 文本框高度
   */
  setTextHeight (value: number): void {
    if (!Number.isFinite(Number(value))) { return; }
    const height = Math.max(0, Number(value) || 0);

    if (height === 0) {
      return;
    }

    const layout = this.textLayout;

    if (layout.height === height) {
      return;
    }

    layout.height = height;
    this.isDirty = true;
  }

  /**
   * 设置字体大小
   * @param value - 字体大小
   * @default 40
   */
  setFontSize (value: number): void {
    if (!Number.isFinite(Number(value))) { return; }
    const size = Math.max(1, Number(value) || 1);

    if (this.textStyle.fontSize === size) {
      return;
    }

    this.textStyle.fontSize = size;
    this.isDirty = true;
  }

  /**
   * 设置描边宽度
   * @param value - 描边宽度
   * @default 0
   */
  setOutlineWidth (value: number): void {
    if (!Number.isFinite(Number(value))) { return; }
    const v = Math.max(0, Number(value) || 0);

    if (this.textStyle.outlineWidth === v) {
      return;
    }
    this.textStyle.outlineWidth = v;
    this.markTextureDirty();
  }

  /**
   * 设置是否启用文本描边
   * @param value - 是否启用描边
   */
  setOutlineEnabled (value: boolean): void {
    if (this.textStyle.isOutlined === value) {
      return;
    }
    this.textStyle.isOutlined = value;
    this.markTextureDirty();
  }

  /**
   * 设置阴影模糊度
   * @param value - 阴影模糊度
   * @default 0
   */
  setShadowBlur (value: number): void {
    if (!Number.isFinite(Number(value))) { return; }
    const v = Math.max(0, Number(value) || 0);

    if (this.textStyle.shadowBlur === v) {
      return;
    }
    this.textStyle.shadowBlur = v;
    this.markTextureDirty();
  }

  /**
   * 设置阴影颜色
   * @param value - 阴影颜色
   * @returns
   */
  setShadowColor (value: spec.RGBAColorValue): void {
    const v = value ?? [0, 0, 0, 1];

    if (this.textStyle.shadowColor === v) {
      return;
    }
    this.textStyle.shadowColor = v;
    this.markTextureDirty();
  }

  /**
   * 设置阴影偏移 X
   * @param value - 阴影偏移值
   * @returns
   */
  setShadowOffsetX (value: number): void {
    if (!Number.isFinite(Number(value))) { return; }
    const v = Number(value) || 0;

    if (this.textStyle.shadowOffsetX === v) {
      return;
    }
    this.textStyle.shadowOffsetX = v;
    this.markTextureDirty();
  }

  /**
   * 设置阴影偏移 Y
   * @param value - 阴影偏移值
   * @returns
   */
  setShadowOffsetY (value: number): void {
    if (!Number.isFinite(Number(value))) { return; }
    const v = Number(value) || 0;

    if (this.textStyle.shadowOffsetY === v) {
      return;
    }
    this.textStyle.shadowOffsetY = v;
    this.markTextureDirty();
  }

  /**
   * 计算文本在当前样式与布局规则下的建议宽度（逻辑像素）。
   *
   * 说明：
   * - 使用 Canvas 2D 的 measureText，并按当前实现的逐字符排版规则累加宽度（与 updateTexture 保持一致）。
   * - 结果为"逻辑宽度"（扣除 fontOffset），可直接写回 options.textWidth。，可直接写回 options.textWidth。
   * - 通过 padding 追加少量冗余像素，用于降低边缘裁切风险。
   *
   * @returns 文本宽度（>= 0）
   */
  getTextWidth (): number {
    this.validateMetrics();
    const ctx = this.context;

    if (!ctx) { return this.textLayout?.width ?? 0; }

    const text = (this.text ?? '').toString();
    const layout = this.textLayout;
    const style = this.textStyle;

    // 与 updateTexture 一致：用逻辑字号测量
    ctx.font = this.getFontDesc(style.fontSize);

    let maxLineWidthRender = 0;
    let x = 0;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (ch === '\n') {
        maxLineWidthRender = Math.max(maxLineWidthRender, x);
        x = 0;
        continue;
      }

      // 与 updateTexture 一致：每个字符前加一次 letterSpace
      x += layout.letterSpace || 0;
      x += ctx.measureText(ch).width;
    }

    maxLineWidthRender = Math.max(maxLineWidthRender, x);

    const padding = 2;
    const EPS = 1e-4;

    const w = Math.ceil(maxLineWidthRender - (style.fontOffset || 0) - EPS) + padding;

    return Math.max(0, w);
  }

  private getDefaultProps (): spec.TextComponentData {
    return {
      id: `default-id-${Math.random().toString(36).substr(2, 9)}`,
      item: { id: `default-item-${Math.random().toString(36).substr(2, 9)}` },
      dataType: spec.DataType.TextComponent,
      options: {
        text: '默认文本',
        fontFamily: 'AlibabaSans-BoldItalic',
        fontSize: 40,
        // 统一使用 0-1 颜色值
        textColor: [1, 1, 1, 1],
        fontWeight: spec.TextWeight.normal,
        letterSpace: 0,
        textAlign: spec.TextAlignment.middle,
        fontStyle: spec.FontStyle.normal,
        textWidth: 200,
        textHeight: 42,
        lineHeight: 40.148,
      },
      renderer: {
        renderMode: 1,
        anchor: [0.5, 0.5],
      },
    };
  }
}

applyMixins(TextComponent, [TextComponentBase]);
