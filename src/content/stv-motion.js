(function attachMotion(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAIMotion = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createMotionApi(root) {
  "use strict";

  function createMotion(options = {}) {
    const getGsap = typeof options.getGsap === "function"
      ? options.getGsap
      : () => options.gsap || root.gsap;
    const reducedMotion = typeof options.reducedMotion === "function"
      ? options.reducedMotion
      : (node) => node?.ownerDocument?.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    const toolbarAnimations = new WeakMap();
    function finishToolbar(node) {
      const cleanup = toolbarAnimations.get(node);
      if (!cleanup) return;
      getGsap()?.killTweensOf?.(node);
      cleanup();
    }

    function animate(node, from, to) {
      const gsap = getGsap();
      if (!node?.isConnected || reducedMotion(node) || typeof gsap?.fromTo !== "function") return false;
      gsap.killTweensOf?.(node);
      gsap.fromTo(node, from, to);
      return true;
    }

    return Object.freeze({
      finishToolbar,
      toggleToolbar(node, collapsed, geometry) {
        finishToolbar(node);
        if (geometry) {
          const gsap = getGsap();
          if (!node?.isConnected || reducedMotion(node) || typeof gsap?.fromTo !== "function") return false;
          const cleanup = () => {
            node.style.removeProperty("width");
            node.style.removeProperty("height");
            delete node.dataset.stvaiToolbarAnimating;
            toolbarAnimations.delete(node);
          };
          toolbarAnimations.set(node, cleanup);
          node.dataset.stvaiToolbarAnimating = "true";
          gsap.fromTo(node, geometry.from, {
            ...geometry.to, duration: 0.2, ease: "power4.out",
            onComplete: cleanup, onInterrupt: cleanup
          });
          return true;
        }
        return animate(
          node,
          { opacity: collapsed ? 0.78 : 0.86, scale: 0.94, transformOrigin: "center" },
          { opacity: 1, scale: 1, duration: 0.16, ease: "power4.out", clearProps: "opacity,transform" }
        );
      },
      reveal(node) {
        return animate(
          node,
          { opacity: 0, y: -4 },
          { opacity: 1, y: 0, duration: 0.2, ease: "power4.out", clearProps: "opacity,transform" }
        );
      },
      completeProgress(node) {
        return animate(
          node,
          { opacity: 0.62, scaleX: 0.3, transformOrigin: "left center" },
          { opacity: 1, scaleX: 1, duration: 0.2, ease: "power4.out", clearProps: "opacity,transform" }
        );
      }
    });
  }

  return Object.freeze({
    createMotion,
    ...createMotion()
  });
});
