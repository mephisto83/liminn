import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement Element.prototype.scrollIntoView; ChatArea uses it.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}
