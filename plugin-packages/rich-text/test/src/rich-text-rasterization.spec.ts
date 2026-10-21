import { Engine, VFXItem, spec } from '@galacean/effects';
import { RichTextComponent } from '@galacean/effects-plugin-rich-text';

const { expect } = chai;

type RichOptions = spec.RichTextContentOptions & { useLegacyRichText?: boolean };

describe('plugin-rich-text/rasterization', () => {
  for (const useLegacyRichText of [false, true]) {
    describe(useLegacyRichText ? 'legacy' : 'strategies', () => {
      let engine: Engine;
      let text: RichTextComponent;
      let restoreContext: () => void;

      function load (options: Partial<RichOptions> = {}): void {
        const content: RichOptions = {
          text: 'Text <b>中文</b> <size=96>BIG</size>\nSecond line',
          fontSize: 80, lineHeight: 100, maxTextWidth: 1200, maxTextHeight: 400,
          autoResize: spec.TextSizeMode.fixed, useLegacyRichText,
          ...options,
        };

        text.fromData({
          id: text.getInstanceId(), item: { id: text.item.getInstanceId() },
          dataType: spec.DataType.RichTextComponent, renderer: {}, options: content,
        });
      }

      function layoutSnapshot () {
        return {
          width: text.textLayout.width, height: text.textLayout.height,
          frameWidth: text.textLayout.maxTextWidth, frameHeight: text.textLayout.maxTextHeight,
          size: text.transform.size.clone(), fontScale: text.textStyle.fontScale,
          segments: text.processedTextOptions.map(options => ({ ...options })),
        };
      }

      beforeEach(() => {
        engine = Engine.create(document.createElement('canvas'), {
          manualRender: true,
          textRasterization: { maxTextureSize: 256, maxPixels: 16384, previewMaxPixels: 4096, maxLogicalSize: 10000 },
        });
        text = new VFXItem(engine).addComponent(RichTextComponent);
        const context = text.context!;
        const { fillText, measureText, getImageData } = context;

        restoreContext = () => { Object.assign(context, { fillText, measureText, getImageData }); };
      });

      afterEach(() => {
        restoreContext();
        text.dispose();
        engine.dispose();
      });

      it('applies engine and device limits before allocating the canvas or GPU texture', () => {
        const detail = engine.displayServer.renderingDevice.gpuCapability.detail;
        const originalMax = detail.maxTextureSize;

        Object.defineProperty(detail, 'maxTextureSize', { value: 128, configurable: true });
        try {
          load();
          expect(text.canvas.width).within(1, 64);
          expect(text.canvas.height).within(1, 64);
          expect(text.canvas.width * text.canvas.height).at.most(16384);
          expect(text.renderer.texture.getWidth()).equals(text.canvas.width);
          expect(text.renderer.texture.getHeight()).equals(text.canvas.height);
          expect(text.renderer.texture.getGPUTexture().isInitialized).equals(true);
        } finally {
          Object.defineProperty(detail, 'maxTextureSize', { value: originalMax, configurable: true });
        }
      });

      it('uses the default budget when no host configuration is provided', () => {
        engine.options.textRasterization = undefined;
        load({ text: '<size=3000>MMMM</size>', fontSize: 3000, maxTextWidth: 6000, maxTextHeight: 2400 });
        expect(text.canvas.width).at.most(4096);
        expect(text.canvas.height).at.most(4096);
        expect(text.canvas.width * text.canvas.height).at.most(4 * 1024 * 1024);
      });

      it('inherits engine limits through undefined fields and resets component overrides', () => {
        load();
        const size = [text.canvas.width, text.canvas.height];

        text.setRasterizationOptions({ maxTextureSize: undefined, maxPixels: undefined, previewMaxPixels: undefined, maxLogicalSize: undefined });
        text.flushText(false);
        expect([text.canvas.width, text.canvas.height]).deep.equals(size);
        text.setRasterizationOptions({ maxPixels: 2048, maxLogicalSize: undefined });
        text.flushText(false);
        expect(text.canvas.width * text.canvas.height).at.most(2048);
        text.setRasterizationOptions({});
        text.flushText(false);
        expect([text.canvas.width, text.canvas.height]).deep.equals(size);
      });

      it('changes raster resolution without changing layout, segment fonts or drawing coordinates', () => {
        const context = text.context!;
        const fillText = context.fillText.bind(context);
        const draws: { value: string, x: number, y: number, font: string, scale: number }[] = [];

        context.fillText = (value, x, y) => {
          draws.push({ value, x, y, font: context.font, scale: context.getTransform().a });
          fillText(value, x, y);
        };
        load();
        const before = layoutSnapshot();
        const originalDraws = draws.splice(0);

        text.setRasterizationOptions({ maxPixels: 2048 });
        text.flushText(false);
        expect(text.canvas.width * text.canvas.height).at.most(2048);
        expect(layoutSnapshot()).deep.equals(before);
        expect(draws.length).equals(originalDraws.length).and.greaterThan(0);
        draws.forEach((draw, index) => {
          const { scale, ...coordinates } = draw;
          const { scale: originalScale, ...originalCoordinates } = originalDraws[index];

          expect(coordinates).deep.equals(originalCoordinates);
          expect(scale).lessThan(originalScale);
        });
        const pixels = context.getImageData(0, 0, text.canvas.width, text.canvas.height).data;

        expect(pixels.some((value, index) => index % 4 === 3 && value > 0)).equals(true);
        text.setRasterizationOptions({});
        text.flushText(false);
        expect(text.canvas.width * text.canvas.height).greaterThan(2048).and.at.most(16384);
        expect(layoutSnapshot()).deep.equals(before);
      });

      it('restores quality after changed previews and ignores stale preview endings', () => {
        load();
        const original = text.renderer.texture;
        const noChange = text.beginRasterizationPreview();

        noChange();
        text.flushText(false);
        expect(text.renderer.texture).equals(original);
        const stale = text.beginRasterizationPreview();

        text.setText(text.text + '!');
        text.flushText(false);
        expect(text.canvas.width * text.canvas.height).at.most(4096);
        const end = text.beginRasterizationPreview();

        stale();
        expect(end.isActive()).equals(true);
        expect(stale.isActive()).equals(false);
        expect(text.rasterizationMode).equals('preview');
        expect(text.isDirty).equals(false);
        const previewLayout = layoutSnapshot();

        end();
        end();
        text.flushText(false);
        expect(end.isActive()).equals(false);
        expect(text.rasterizationMode).equals('normal');
        expect(text.canvas.width * text.canvas.height).greaterThan(4096).and.at.most(16384);
        expect(layoutSnapshot()).deep.equals(previewLayout);
        end();
        expect(text.isDirty).equals(false);
      });

      it('reuses initialized GPU storage for edits with unchanged raster dimensions', () => {
        load();
        const texture = text.renderer.texture;
        const gl = engine.canvas.getContext('webgl2')!;

        chai.spy.on(gl, 'texSubImage2D');
        chai.spy.on(gl, 'createTexture');
        try {
          text.setTextColor([1, 0, 0, 1]);
          text.flushText(false);
          expect(text.renderer.texture).equals(texture);
          expect(gl.texSubImage2D).to.have.been.called.once;
          expect(gl.createTexture).not.to.have.been.called;
          expect(gl.getError()).equals(gl.NO_ERROR);
        } finally {
          chai.spy.restore(gl, 'texSubImage2D');
          chai.spy.restore(gl, 'createTexture');
        }
      });

      it('rejects invalid inline sizes before measurement or allocation and permits recovery', () => {
        load();
        const texture = text.renderer.texture;
        const context = text.context!;
        const measureText = context.measureText.bind(context);
        const read = context.getImageData.bind(context);
        const content = text.text;
        let measurements = 0;
        let readbacks = 0;

        context.measureText = value => {
          measurements++;

          return measureText(value);
        };
        context.getImageData = (...args: Parameters<CanvasRenderingContext2D['getImageData']>) => {
          readbacks++;

          return read(...args);
        };
        for (const size of ['0', '-1', 'NaN', 'Infinity', '10001']) {
          text.setText(`<size=${size}>Invalid</size>`);
          expect(() => text.flushText(false)).to.throw(RangeError);
          expect(text.renderer.texture).equals(texture);
          expect(texture.isDestroyed).equals(false);
          expect(text.isDirty).equals(false);
          text.flushText(false);
        }
        expect(measurements).equals(0);
        expect(readbacks).equals(0);
        text.setText(content);
        text.flushText(false);
        expect(readbacks).equals(1);
      });

      it('rejects invalid layout values and oversized computed dimensions before allocation', () => {
        load();
        const texture = text.renderer.texture;
        const canvasWidth = text.canvas.width;
        const frameWidth = text.textLayout.maxTextWidth;

        for (const width of [Infinity, NaN, -1, 10001]) {
          text.textLayout.maxTextWidth = width;
          text.isDirty = true;
          expect(() => text.flushText(false)).to.throw(RangeError);
          expect(text.canvas.width).equals(canvasWidth);
          expect(text.renderer.texture).equals(texture);
        }
        text.textLayout.maxTextWidth = frameWidth;
        text.textLayout.autoResize = spec.TextSizeMode.autoWidth;
        text.setText('<size=1000>' + 'M'.repeat(30) + '</size>');
        expect(() => text.flushText(false)).to.throw(RangeError);
        expect(text.textLayout.maxTextWidth).equals(frameWidth);
        expect(text.canvas.width).equals(canvasWidth);
        expect(text.renderer.texture).equals(texture);
      });

      it('resets preview sessions on reload and releases resources before awakening', () => {
        load();
        const end = text.beginRasterizationPreview();

        load({ text: 'Reloaded <b>text</b>' });
        expect(end.isActive()).equals(false);
        expect(text.rasterizationMode).equals('normal');
        const active = text.beginRasterizationPreview();
        const canvas = text.canvas;
        const texture = text.renderer.texture;

        text.dispose();
        active();
        text.flushText();
        expect(active.isActive()).equals(false);
        expect(texture.isDestroyed).equals(true);
        expect(text.context).equals(null);
        expect(canvas.width).equals(1);
        expect(canvas.height).equals(1);
        const inactive = text.beginRasterizationPreview();

        expect(inactive.isActive()).equals(false);
        inactive();
        expect(text.rasterizationMode).equals('normal');
      });

      if (!useLegacyRichText) {
        it('preserves auto sizing, wrapping and alignment across overflow modes when downsampling', () => {
          for (const autoResize of [spec.TextSizeMode.autoWidth, spec.TextSizeMode.autoHeight, spec.TextSizeMode.fixed]) {
            for (const textOverflow of [spec.TextOverflow.clip, spec.TextOverflow.display, spec.TextOverflow.visible]) {
              for (const textAlign of [spec.TextAlignment.left, spec.TextAlignment.middle, spec.TextAlignment.right]) {
                text.setRasterizationOptions({});
                load({ autoResize, textOverflow, textAlign, wrapEnabled: true, maxTextWidth: 180, maxTextHeight: 100 });
                const before = layoutSnapshot();

                text.setRasterizationOptions({ maxPixels: 1024 });
                text.flushText(false);
                expect(text.canvas.width * text.canvas.height).at.most(1024);
                expect(layoutSnapshot()).deep.equals(before);
              }
            }
          }
        });
      }
    });
  }
});
