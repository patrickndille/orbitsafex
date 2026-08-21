// Minimal Three.js stub — only what GlobeView imports needs to resolve.
module.exports = new Proxy(
  {},
  {
    get(_target, name) {
      if (name === "__esModule") return true;
      // Return a no-op constructor / constant for any Three.js symbol
      const fn = function () {};
      fn.prototype = {};
      return fn;
    },
  }
);
