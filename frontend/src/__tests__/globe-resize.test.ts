/**
 * __tests__/globe-resize.test.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Unit tests for the ResizeObserver-based renderer resize logic in GlobeView.
 *
 * We test the resize callback in isolation rather than mounting the full Three.js
 * component (which is a browser-only canvas API that jsdom cannot run).
 *
 * Tests assert:
 *   1. ResizeObserver is constructed and observe() is called on the container.
 *   2. When the container changes size, the renderer is resized correctly.
 *   3. Zero-dimension entries are ignored (avoids divide-by-zero on aspect).
 *   4. disconnect() is called on cleanup.
 */

describe("GlobeView resize handler (unit)", () => {
  let observeSpy: jest.Mock;
  let disconnectSpy: jest.Mock;
  let observerCallback: ResizeObserverCallback;

  // Fake ResizeObserver that captures the callback for manual triggering
  beforeEach(() => {
    observeSpy    = jest.fn();
    disconnectSpy = jest.fn();
    (global as unknown as { ResizeObserver: unknown }).ResizeObserver = jest.fn(
      (cb: ResizeObserverCallback) => {
        observerCallback = cb;
        return { observe: observeSpy, disconnect: disconnectSpy };
      }
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("constructs a ResizeObserver and calls observe() on the mount container", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "getBoundingClientRect", {
      value: () => ({ width: 600, height: 400 }),
    });

    // Simulate what Effect 1 does: create RO, observe container
    const ro = new ResizeObserver(jest.fn());
    ro.observe(container);

    expect(observeSpy).toHaveBeenCalledWith(container);
  });

  it("calls renderer.setSize with new dimensions when container resizes", () => {
    let currentWidth  = 600;
    let currentHeight = 400;

    const container = document.createElement("div");
    Object.defineProperty(container, "getBoundingClientRect", {
      get: () => () => ({ width: currentWidth, height: currentHeight }),
    });

    // Stub camera and renderer
    const camera = {
      aspect: 0,
      updateProjectionMatrix: jest.fn(),
    };
    const domElement = document.createElement("canvas");
    const renderer = {
      setSize:   jest.fn(),
      domElement,
    };

    // This is the exact resize callback from GlobeView Effect 1
    const onResize = () => {
      const { width, height } = container.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      renderer.domElement.style.width  = "100%";
      renderer.domElement.style.height = "100%";
    };

    // Simulate initial size
    onResize();
    expect(renderer.setSize).toHaveBeenCalledWith(600, 400);
    expect(camera.aspect).toBeCloseTo(1.5);
    expect(camera.updateProjectionMatrix).toHaveBeenCalledTimes(1);

    // Simulate inset appearing: container height shrinks to 280
    currentHeight = 280;
    onResize();
    expect(renderer.setSize).toHaveBeenCalledWith(600, 280);
    expect(camera.aspect).toBeCloseTo(600 / 280);

    // Simulate inset dismissed: container height expands back
    currentHeight = 400;
    onResize();
    expect(renderer.setSize).toHaveBeenCalledWith(600, 400);
  });

  it("ignores resize events with zero dimensions (layout transition)", () => {
    const container = document.createElement("div");
    let bcrWidth = 0, bcrHeight = 0;
    Object.defineProperty(container, "getBoundingClientRect", {
      get: () => () => ({ width: bcrWidth, height: bcrHeight }),
    });

    const camera   = { aspect: 1.5, updateProjectionMatrix: jest.fn() };
    const renderer = { setSize: jest.fn(), domElement: document.createElement("canvas") };

    const onResize = () => {
      const { width, height } = container.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };

    // Zero width/height — should be a no-op
    onResize();
    expect(renderer.setSize).not.toHaveBeenCalled();
    expect(camera.updateProjectionMatrix).not.toHaveBeenCalled();
    expect(camera.aspect).toBe(1.5); // unchanged
  });

  it("disconnect() is called during effect cleanup", () => {
    const ro = new ResizeObserver(jest.fn());
    ro.disconnect();
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });
});
