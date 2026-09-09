import type { EditorView } from "@codemirror/view";
import { dampedSpringStep, dampedSpringImpulse } from "@core/animation/spring";

const active = new WeakMap<EditorView, () => void>();

export function showSilenceAnimation(view: EditorView, from: number, to: number) {
  active.get(view)?.();
  const doc = view.state.doc;
  view.requestMeasure({
    key: active,
    read() {
      if (view.state.doc !== doc || !view.dom.isConnected) return null;
      const viewport = view.scrollDOM.getBoundingClientRect();
      const rects: DOMRect[] = [];
      for (const visible of view.visibleRanges) {
        const start = Math.max(from, visible.from);
        const end = Math.min(to, visible.to);
        if (start >= end) continue;
        const a = view.domAtPos(start), b = view.domAtPos(end);
        const range = view.dom.ownerDocument.createRange();
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
        rects.push(...Array.from(range.getClientRects()).filter((rect) =>
          rect.width > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom
        ));
      }
      if (!rects.length) return null;
      const left = Math.max(viewport.left, Math.min(...rects.map((r) => r.left)));
      const right = Math.min(viewport.right, Math.max(...rects.map((r) => r.right)));
      const top = Math.max(viewport.top, Math.min(...rects.map((r) => r.top)));
      const bottom = Math.min(viewport.bottom, Math.max(...rects.map((r) => r.bottom)));
      return {
        x: (left + right) / 2 - viewport.left + view.scrollDOM.scrollLeft,
        y: (top + bottom) / 2 - viewport.top + view.scrollDOM.scrollTop,
        size: 3 * Math.min(100, Math.max(48, view.defaultLineHeight * 2)),
      };
    },
    write(position) {
      if (!position) return;
      active.get(view)?.();
      const emoji = view.dom.ownerDocument.createElement("span");
      emoji.textContent = "🤫";
      emoji.setAttribute("aria-hidden", "true");
      emoji.style.cssText = `position:absolute;left:${position.x}px;top:${position.y}px;font-size:${position.size}px;line-height:1;font-family:"Apple Color Emoji","Segoe UI Emoji",sans-serif;pointer-events:none;z-index:30;transform:translate(-50%,-50%);`;
      view.scrollDOM.appendChild(emoji);
      const reduced = view.dom.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const duration = 1100;
      const frames = reduced
        ? [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }]
        : Array.from({ length: 97 }, (_, index) => {
          const progress = index / 96;
          const elapsed = progress * duration;
          const spring = { stiffness: 1050, damping: 16.5 };
          const size = Math.max(0.06, dampedSpringStep(elapsed, spring));
          const { displacement, velocity } = dampedSpringImpulse(elapsed, spring);
          const exit = Math.max(0, (progress - 0.78) / 0.22);
          const scaleX = Math.max(0.06, size * (1 + velocity * 0.65)) * (1 - exit * 0.2);
          const scaleY = Math.max(0.06, size * (1 - velocity * 0.6)) * (1 - exit * 0.2);
          return {
            offset: progress,
            opacity: Math.min(1, elapsed / 65) * (1 - exit),
            transform: `translate(-50%,-50%) translateY(${-displacement * 28 - exit * 30}px) rotate(${displacement * 13}deg) scale(${scaleX},${scaleY})`,
          };
        });
      const animation = emoji.animate(frames, { duration, easing: "linear" });
      const clear = () => {
        if (active.get(view) === clear) active.delete(view);
        animation.cancel();
        emoji.remove();
      };
      active.set(view, clear);
      void animation.finished.then(clear, () => { emoji.remove(); });
    },
  });
}
