import { Engine, TextComponent, VFXItem, getTextRasterSize, resolveTextRasterizationOptions, spec } from '@galacean/effects';
import type { Texture2DSourceOptionsData } from '@galacean/effects';

const { expect } = chai;

describe('core/plugins/text/rasterization', () => {
  it('inherits defaults and engine limits through undefined option fields', () => {
    const defaults = resolveTextRasterizationOptions();

    expect(resolveTextRasterizationOptions({
      maxTextureSize: undefined, maxPixels: undefined, previewMaxPixels: undefined, maxLogicalSize: undefined,
    })).deep.equals(defaults);
    expect(resolveTextRasterizationOptions(
      { maxTextureSize: 256, maxPixels: 16384, previewMaxPixels: undefined, maxLogicalSize: 10000 },
      { maxTextureSize: undefined, maxPixels: 2048, previewMaxPixels: 1024, maxLogicalSize: undefined },
    )).deep.equals({ maxTextureSize: 256, maxPixels: 2048, previewMaxPixels: 1024, maxLogicalSize: 10000 });
  });

  it('bounds integer allocations, including rounding, zero and extreme aspect ratios', () => {
    for (const [width, height] of [[6000, 2400], [12000, 4800], [100000, 100000], [1e300, 1], [1, 1e300], [1e300, 1e300], [0, 100], [0, 0]]) {
      for (const maxPixels of [1, 3, 31, 1048576, 4194304]) {
        for (const device of [64, 4096, 16384]) {
          const size = getTextRasterSize(width, height, 2, device, { maxPixels });

          expect(Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height)).equals(true);
          expect(size.width).within(1, Math.min(device / 2, 4096));
          expect(size.height).within(1, Math.min(device / 2, 4096));
          expect(size.width * size.height).at.most(maxPixels);
          expect(size.scale).greaterThan(0);
        }
      }
    }
  });

  it('rejects non-finite metrics and invalid budgets before allocation', () => {
    for (const value of [NaN, Infinity, -Infinity, -1, null as unknown as number]) {
      expect(() => getTextRasterSize(value, 2400, 2, 16384)).to.throw(RangeError);
      expect(() => resolveTextRasterizationOptions({ maxPixels: value })).to.throw(RangeError);
    }
    expect(() => getTextRasterSize(6000, 2400, 0, 16384)).to.throw(RangeError);
    expect(() => resolveTextRasterizationOptions({ maxPixels: 0 })).to.throw(RangeError);
  });

  let engine: Engine;
  let text: TextComponent;
  let restoreContext: () => void;

  beforeEach(() => {
    engine = Engine.create(document.createElement('canvas'), { manualRender: true, doNotHandleContextLost: false });
    text = new VFXItem(engine).addComponent(TextComponent);
    const context = text.context!;
    const { getImageData, strokeText } = context;

    restoreContext = () => { Object.assign(context, { getImageData, strokeText }); };
    text.updateWithOptions({ text: 'Text 中文 😀', fontSize: 400, lineHeight: 480, textWidth: 6000, textHeight: 2400 });
  });

  afterEach(() => {
    restoreContext();
    text.dispose();
    engine.dispose();
  });

  it('inherits component limits through undefined fields and restores engine policy with empty options', () => {
    engine.options.textRasterization = { maxTextureSize: 128, maxPixels: 8192, previewMaxPixels: 2048, maxLogicalSize: undefined };
    text.setRasterizationOptions({ maxTextureSize: undefined, maxPixels: undefined, previewMaxPixels: undefined });
    text.flushText(false);
    const size = [text.canvas.width, text.canvas.height];

    expect(Math.max(...size)).at.most(128);
    expect(size[0] * size[1]).within(1025, 8192);
    text.setRasterizationOptions({ maxTextureSize: undefined, maxPixels: 1024 });
    text.flushText(false);
    expect(text.canvas.width * text.canvas.height).at.most(1024);
    text.setRasterizationOptions({});
    text.flushText(false);
    expect([text.canvas.width, text.canvas.height]).deep.equals(size);
  });

  it('keeps the old text texture and releases a replacement whose GPU upload fails', () => {
    text.setRasterizationOptions({ maxPixels: 8192 });
    text.flushText(false);
    const previous = text.renderer.texture;
    const gl = engine.canvas.getContext('webgl2')!;
    const { createTexture, deleteTexture, texImage2D } = gl;
    const created: WebGLTexture[] = [];
    const deleted: (WebGLTexture | null)[] = [];
    const failure = new Error('replacement upload failed');

    gl.createTexture = () => {
      const handle = createTexture.call(gl)!;

      created.push(handle);

      return handle;
    };
    gl.deleteTexture = handle => { deleted.push(handle); deleteTexture.call(gl, handle); };
    gl.texImage2D = () => { throw failure; };
    try {
      text.setTextWidth(12000);
      expect(() => text.flushText(false)).to.throw(failure);
      expect(text.renderer.texture).equals(previous);
      expect(previous.isDestroyed).equals(false);
      expect(created.length).equals(1);
      expect(deleted.length).equals(1);
      expect(deleted[0]).equals(created[0]);
      expect(gl.isTexture(created[0])).equals(false);
      gl.texImage2D = texImage2D;
      text.refreshText();
      text.flushText(false);
      expect(text.renderer.texture).not.equals(previous);
      expect(previous.isDestroyed).equals(true);
      expect(gl.getError()).equals(gl.NO_ERROR);
    } finally {
      Object.assign(gl, { createTexture, deleteTexture, texImage2D });
    }
  });

  it('lets the host batch edits and explicitly draw while paused without running updates', async () => {
    let rasterizations = 0;
    const context = text.context!;
    const read = context.getImageData.bind(context);

    context.getImageData = (...args: Parameters<CanvasRenderingContext2D['getImageData']>) => {
      rasterizations++;

      return read(...args);
    };
    let updates = 0;
    const offUpdate = engine.on('update', () => updates++);

    for (const width of [6001, 6010, 6020]) {
      text.setTextWidth(width);
      text.refreshText();
      expect(text.transform.size.x).closeTo(width * 0.11092565 ** 2, 1e-8);
    }
    expect(rasterizations).equals(0);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    expect(rasterizations).equals(0);
    expect(text.isDirty).equals(true);
    text.flushText();
    expect(rasterizations).equals(1);
    expect(updates).equals(0);
    expect(text.renderer.texture.getGPUTexture().isInitialized).equals(true);
    expect(text.renderer.texture.getWidth() * text.renderer.texture.getHeight()).at.most(4194304);
    engine.onDraw();
    expect(rasterizations).equals(1);
    offUpdate();
  });

  it('restores quality only after changed previews and ignores stale preview endings', () => {
    text.flushText(false);
    const original = text.renderer.texture;
    const noChange = text.beginRasterizationPreview();

    noChange();
    text.flushText(false);
    expect(text.renderer.texture).equals(original);
    const oldEnd = text.beginRasterizationPreview();

    text.setText('Changed 中文 😀');
    text.flushText(false);
    expect(text.canvas.width * text.canvas.height).at.most(1048576);
    const end = text.beginRasterizationPreview();

    oldEnd();
    expect(oldEnd.isActive()).equals(false);
    expect(end.isActive()).equals(true);
    expect(text.rasterizationMode).equals('preview');
    expect(text.isDirty).equals(false);
    const geometry = text.transform.size.clone();

    end();
    expect(end.isActive()).equals(false);
    text.flushText(false);
    expect(text.rasterizationMode).equals('normal');
    expect(text.canvas.width * text.canvas.height).greaterThan(1048576).and.at.most(4194304);
    expect(text.transform.size).deep.equals(geometry);
    expect(text.textLayout.width).equals(6000);
    end();
    expect(text.isDirty).equals(false);
  });

  it('reuses GPU storage with texSubImage2D and retains independent restore pixels', () => {
    text.flushText(false);
    const texture = text.renderer.texture;
    const first = texture.source;
    const firstPixels = (first as Texture2DSourceOptionsData).data.data;
    const gl = engine.canvas.getContext('webgl2')!;
    const original = gl.texSubImage2D.bind(gl);
    let uploads = 0;

    chai.spy.on(gl, 'texSubImage2D', (...args: Parameters<typeof gl.texSubImage2D>) => {
      uploads++;
      original(...args);
    });
    try {
      text.setText('Different');
      text.flushText(false);
      expect(text.renderer.texture).equals(texture);
      expect(uploads).equals(1);
      expect((texture.source as Texture2DSourceOptionsData).data.data).not.equals(firstPixels);
      texture.restore();
      expect(texture.getGPUTexture().isInitialized).equals(true);
      expect(gl.getError()).equals(gl.NO_ERROR);
    } finally {
      chai.spy.restore(gl, 'texSubImage2D');
    }
  });

  it('ignores explicit refreshes after destruction, even before component awakening', () => {
    const canvas = text.canvas;

    text.refreshText();
    const end = text.beginRasterizationPreview();

    text.dispose();
    end();
    text.refreshText();
    text.flushText();
    engine.onDraw();
    expect(text.context).equals(null);
    expect(canvas.width).equals(1);
    expect(canvas.height).equals(1);
    expect(text.rasterizationMode).equals('normal');
    const inactive = text.beginRasterizationPreview();

    expect(end.isActive()).equals(false);
    expect(inactive.isActive()).equals(false);
    inactive();
    expect(text.rasterizationMode).equals('normal');
  });

  it('keeps a valid old texture after invalid imported metrics and allows explicit recovery', () => {
    text.flushText(false);
    const texture = text.renderer.texture;
    const canvasWidth = text.canvas.width;

    text.textStyle.fontOffset = Infinity;
    text.isDirty = true;
    expect(() => text.flushText(false)).to.throw(RangeError);
    expect(text.isDirty).equals(false);
    expect(text.renderer.texture).equals(texture);
    expect(texture.isDestroyed).equals(false);
    expect(text.canvas.width).equals(canvasWidth);
    text.textStyle.fontOffset = 0;
    text.refreshText();
    text.flushText(false);
    expect(text.isDirty).equals(false);
  });

  it('preserves auto sizing, wrapping, empty text and effect metrics at both budgets', () => {
    for (const content of ['', '中文 😀', 'a verylongword without breaks', 'مرحبا بالعالم']) {
      text.updateWithOptions({ text: content, fontSize: 40, lineHeight: 48, textWidth: 100, autoResize: spec.TextSizeMode.autoHeight,
        outline: { outlineWidth: 3, outlineColor: [1, 0, 0, 1] }, shadow: { shadowBlur: 4, shadowOffsetX: 5, shadowOffsetY: -4 } });
      text.refreshText();
      const size = text.transform.size.clone();
      const lines = text.lineCount;
      const end = text.beginRasterizationPreview();

      text.flushText(false);
      end();
      text.flushText(false);
      expect(text.transform.size).deep.equals(size);
      expect(text.textLayout.height).equals(48 * lines);
      expect(text.textStyle.outlineWidth).equals(3);
      expect(text.textStyle.shadowOffsetX).equals(5);
    }
  });

  for (const autoResize of [spec.TextSizeMode.autoWidth, spec.TextSizeMode.autoHeight]) {
    it(`recovers from oversized automatic layout without retaining invalid dimensions (${autoResize})`, () => {
      text.updateWithOptions({ text: 'A', fontFamily: 'sans-serif', fontSize: 40, lineHeight: 48, textWidth: 100, textHeight: 100, autoResize });
      text.setRasterizationOptions({ maxLogicalSize: 1000 });
      text.flushText(false);
      const texture = text.renderer.texture;
      const { width, height } = text.textLayout;
      const lines = text.lineCount;
      const size = text.transform.size.clone();

      text.setText(autoResize === spec.TextSizeMode.autoWidth ? 'M'.repeat(100) : 'M\n'.repeat(100));
      expect(() => text.flushText(false)).to.throw(RangeError);
      expect(text.textLayout.width).equals(width);
      expect(text.textLayout.height).equals(height);
      expect(text.lineCount).equals(lines);
      expect(text.transform.size).deep.equals(size);
      expect(text.renderer.texture).equals(texture);
      text.setText('B');
      expect(() => text.flushText(false)).not.to.throw();
      expect(text.isDirty).equals(false);
      expect(text.textLayout.width).at.most(1000);
      expect(text.textLayout.height).equals(48);
    });
  }

  it('updates text used as a stencil before drawing the mask and rasterizes only once', () => {
    text.flushText(false);
    text.setTextWidth(12000);
    const widths: number[] = [];

    chai.spy.on(text.maskManager, 'drawGeometryMask', () => { widths.push(text.renderer.texture.getWidth()); });
    chai.spy.on(engine.renderer, 'drawGeometry', () => {});
    chai.spy.on(text.context!, 'getImageData');
    try {
      text.drawStencilMask(1);
      expect(text.isDirty).equals(false);
      expect(widths).deep.equals([text.canvas.width]);
      text.render(engine.renderer);
      expect(text.context!.getImageData).to.have.been.called.once;
    } finally {
      chai.spy.restore(text.maskManager, 'drawGeometryMask');
      chai.spy.restore(engine.renderer, 'drawGeometry');
      chai.spy.restore(text.context!, 'getImageData');
    }
  });

  it('updates pixels and preview quality without repeating layout measurements', () => {
    text.flushText(false);
    const size = text.transform.size.clone();

    chai.spy.on(text, 'getLineCount');
    chai.spy.on(text, 'getTextWidth');
    try {
      const end = text.beginRasterizationPreview();

      text.setTextColor([1, 0, 0, 1]);
      text.setTextAlign(spec.TextAlignment.middle);
      text.setTextVerticalAlign(spec.TextVerticalAlign.middle);
      text.setOutlineColor([0, 1, 0, 1]);
      text.setOutlineEnabled(true);
      text.setOutlineWidth(2);
      text.setShadowBlur(3);
      text.setShadowColor([0, 0, 1, 1]);
      text.setShadowOffsetX(4);
      text.setShadowOffsetY(5);
      text.setFontScale(1.5);
      text.flushText(false);
      end();
      text.flushText(false);
      text.setRasterizationOptions({ maxPixels: 2048 });
      text.flushText(false);
      expect(text.getLineCount).not.to.have.been.called;
      expect(text.getTextWidth).not.to.have.been.called;
      expect(text.transform.size).deep.equals(size);
      expect(text.canvas.width * text.canvas.height).at.most(2048);
      text.setText('Layout changed');
      text.flushText(false);
      expect(text.getLineCount).to.have.been.called.once;
    } finally {
      chai.spy.restore(text, 'getLineCount');
      chai.spy.restore(text, 'getTextWidth');
    }
  });

  it('validates tightened logical limits even when only pixels are invalidated', () => {
    text.flushText(false);
    const texture = text.renderer.texture;

    text.setRasterizationOptions({ maxLogicalSize: 1000 });
    expect(() => text.flushText(false)).to.throw(RangeError);
    expect(text.renderer.texture).equals(texture);
    text.setRasterizationOptions({});
    expect(() => text.flushText(false)).not.to.throw();
  });

  it('budgets imported data and subsequent font relayout against a smaller device', () => {
    const detail = engine.displayServer.renderingDevice.gpuCapability.detail;
    const originalMax = detail.maxTextureSize;

    Object.defineProperty(detail, 'maxTextureSize', { value: 256, configurable: true });
    try {
      text.fromData({
        id: text.getInstanceId(), item: { id: text.item.getInstanceId() }, dataType: spec.DataType.TextComponent,
        options: { text: 'Imported', fontSize: 40, lineHeight: 48, textWidth: 12000, textHeight: 4800 },
        renderer: {},
      });
      expect(text.renderer.texture.getWidth()).at.most(128);
      expect(text.renderer.texture.getHeight()).at.most(128);
      text.setFontFamily('serif');
      text.refreshText();
      text.flushText(false);
      expect(text.textLayout.width).equals(12000);
      expect(text.canvas.width).at.most(128);
    } finally {
      Object.defineProperty(detail, 'maxTextureSize', { value: originalMax, configurable: true });
    }
  });

  it('uses logical stroke widths and effective pixel scales for shadows in both modes', () => {
    text.updateWithOptions({ text: 'Effects', fontSize: 400, lineHeight: 480, textWidth: 6000, textHeight: 2400,
      outline: { outlineWidth: 3, outlineColor: [1, 0, 0, 1] },
      shadow: { shadowBlur: 4, shadowOffsetX: 5, shadowOffsetY: -6 } });
    const context = text.context!;
    const original = context.strokeText.bind(context);
    const observations: { width: number, blur: number, x: number, y: number, scale: number }[] = [];

    context.strokeText = (...args) => {
      observations.push({ width: context.lineWidth, blur: context.shadowBlur, x: context.shadowOffsetX,
        y: context.shadowOffsetY, scale: context.getTransform().a });
      original(...args);
    };
    text.flushText(false);
    const end = text.beginRasterizationPreview();

    text.setText('Changed effects');
    text.flushText(false);
    end();
    text.flushText(false);
    expect(observations.length).greaterThan(0);
    for (const sample of observations) {
      expect(sample.width).equals(6);
      expect(sample.blur).closeTo(4 * sample.scale, 1e-5);
      expect(sample.x).closeTo(5 * sample.scale, 1e-5);
      expect(sample.y).closeTo(6 * sample.scale, 1e-5);
    }
  });

  it('preserves the previous texture after readback failure without retrying every frame', () => {
    text.flushText(false);
    const texture = text.renderer.texture;
    const context = text.context!;
    const original = context.getImageData;
    let readbacks = 0;

    context.getImageData = () => { readbacks++; throw new Error('simulated readback failure'); };
    chai.spy.on(engine.renderer, 'drawGeometry', () => {});
    try {
      text.setTextWidth(12000);
      expect(() => text.flushText(false)).to.throw('simulated readback failure');
      expect(text.renderer.texture).equals(texture);
      expect(texture.isDestroyed).equals(false);
      expect(() => engine.onDraw()).not.to.throw();
      text.setText('Failed automatic render');
      expect(() => text.render(engine.renderer)).not.to.throw();
      expect(text.renderer.texture).equals(texture);
      expect(engine.renderer.drawGeometry).to.have.been.called.once;
      expect(readbacks).equals(2);
      text.render(engine.renderer);
      expect(readbacks).equals(2);
    } finally {
      context.getImageData = original;
      chai.spy.restore(engine.renderer, 'drawGeometry');
    }
  });
});
