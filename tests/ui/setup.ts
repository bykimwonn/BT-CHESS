import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => { localStorage.clear(); document.documentElement.dataset.theme = 'dark'; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

if (!window.PointerEvent) {
  class MockPointerEvent extends MouseEvent {
    pointerId = 1;
    pointerType = 'mouse';
    isPrimary = true;
  }
  vi.stubGlobal('PointerEvent', MockPointerEvent);
}
if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => undefined;
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => undefined;
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;
if (!HTMLElement.prototype.getBoundingClientRect) {
  HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 400, height: 400, top: 0, left: 0, right: 400, bottom: 400, toJSON: () => ({}) });
}
if (!window.crypto.randomUUID) {
  Object.defineProperty(window.crypto, 'randomUUID', { value: () => `test-${Math.random().toString(16).slice(2)}` });
}
