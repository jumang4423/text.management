import { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

// SVG silhouette/filter architecture adapted from liquid-gooey (MIT).
// See LIQUID_GOOEY_NOTICE.md beside this file.

const SVG_NS = "http://www.w3.org/2000/svg";
const BODY_RADIUS = 7;
const INLINE_RADIUS = 5;
const GOO_BLUR = 4.5;
const GOO_CONTRAST = 18;

type SurfaceKind =
  | "body"
  | "selection"
  | "evaluated"
  | "error"
  | "search"
  | "bracket";

interface SurfaceShape {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  paint?: string;
}

interface SurfaceMeasurement {
  width: number;
  height: number;
  filterX: number;
  filterY: number;
  filterWidth: number;
  filterHeight: number;
  shapes: Record<SurfaceKind, SurfaceShape[]>;
  fingerprint: string;
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {}
) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

function quantize(value: number, step = 0.25) {
  return Math.round(value / step) * step;
}

function setAttributeIfChanged(
  element: Element,
  name: string,
  value: string
) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function filterDefinition(id: string) {
  const filter = svg("filter", {
    id,
    filterUnits: "userSpaceOnUse",
    x: "-16",
    y: "-16",
    width: "32",
    height: "32",
    "color-interpolation-filters": "sRGB",
  });
  const intercept = Math.round((0.5 - GOO_CONTRAST * (5 / 12)) * 100) / 100;
  filter.append(
    svg("feGaussianBlur", {
      in: "SourceGraphic",
      stdDeviation: GOO_BLUR.toString(),
      result: "blur",
    }),
    svg("feColorMatrix", {
      in: "blur",
      type: "matrix",
      values: `1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${GOO_CONTRAST} ${intercept}`,
      result: "goo",
    }),
    svg("feComposite", {
      in: "SourceGraphic",
      in2: "goo",
      operator: "atop",
      result: "shape",
    }),
    svg("feMorphology", {
      in: "shape",
      operator: "erode",
      radius: "0.65",
      result: "inner",
    }),
    svg("feComposite", {
      in: "shape",
      in2: "inner",
      operator: "out",
      result: "rim",
    }),
    svg("feFlood", {
      "flood-color": "white",
      "flood-opacity": "0.16",
      result: "rim-color",
    }),
    svg("feComposite", {
      in: "rim-color",
      in2: "rim",
      operator: "in",
      result: "lit-rim",
    })
  );
  const merge = svg("feMerge");
  merge.append(svg("feMergeNode", { in: "shape" }), svg("feMergeNode", { in: "lit-rim" }));
  filter.append(merge);
  return filter;
}

function paletteGradient(id: string, opacity = 0.82) {
  const gradient = svg("linearGradient", {
    id,
    x1: "0%",
    y1: "0%",
    x2: "100%",
    y2: "0%",
  });
  const colors = ["#94A1FF", "#6ED4E3", "#D4F357", "#FFA020", "#94A1FF"];
  colors.forEach((color, index) => {
    gradient.append(
      svg("stop", {
        offset: `${(index / (colors.length - 1)) * 100}%`,
        "stop-color": color,
        "stop-opacity": opacity.toString(),
      })
    );
  });
  return gradient;
}

function mergeAdjacentShapes(
  shapes: SurfaceShape[],
  maximumGap: number,
  verticalTolerance: number
) {
  const sorted = [...shapes].sort((left, right) => left.y - right.y || left.x - right.x);
  const merged: SurfaceShape[] = [];

  for (const shape of sorted) {
    const previous = merged.at(-1);
    const previousBottom = previous ? previous.y + previous.height : 0;
    const shapeBottom = shape.y + shape.height;
    const sameRow =
      previous !== undefined &&
      Math.abs(previous.y - shape.y) <= verticalTolerance &&
      Math.abs(previousBottom - shapeBottom) <= verticalTolerance;
    const touches =
      previous !== undefined && shape.x <= previous.x + previous.width + maximumGap;

    if (previous && sameRow && touches && previous.paint === shape.paint) {
      const right = Math.max(previous.x + previous.width, shape.x + shape.width);
      previous.x = Math.min(previous.x, shape.x);
      previous.y = Math.min(previous.y, shape.y);
      previous.width = right - previous.x;
      previous.height = Math.max(previousBottom, shapeBottom) - previous.y;
      previous.radius = Math.min(
        Math.max(previous.radius, shape.radius),
        previous.width / 2,
        previous.height / 2
      );
      previous.key = `${previous.key}+${shape.key}`;
    } else {
      merged.push({ ...shape });
    }
  }

  return merged;
}

class LiquidEditorSurface {
  private static nextID = 0;

  private readonly id = LiquidEditorSurface.nextID++;
  private readonly surface = svg("svg", {
    "aria-hidden": "true",
    focusable: "false",
    class: "cm-liquid-surface",
  });
  private readonly defs = svg("defs");
  private readonly gooFilter: SVGFilterElement;
  private readonly selectionGradient: SVGLinearGradientElement;
  private readonly groups = new Map<SurfaceKind, SVGGElement>();
  private readonly elementIDs = new WeakMap<Element, number>();
  private readonly observer: MutationObserver;
  private readonly resizeObserver: ResizeObserver;
  private readonly reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  private lastFingerprint = "";
  private destroyed = false;
  private trackingFrame = 0;
  private trackUntil = 0;
  private dynamicTimer = 0;
  private lastDynamicMeasure = 0;
  private nextElementID = 0;

  private readonly measureRequest = {
    read: () => this.measure(),
    write: (measurement: SurfaceMeasurement) => this.draw(measurement),
  };

  constructor(private readonly view: EditorView) {
    const filterID = `cm-liquid-goo-${this.id}`;
    const selectionGradientID = `cm-liquid-selection-${this.id}`;
    this.gooFilter = filterDefinition(filterID);
    this.selectionGradient = paletteGradient(selectionGradientID);
    this.defs.append(this.gooFilter, this.selectionGradient);
    this.surface.append(this.defs);

    const fills: Record<SurfaceKind, string> = {
      body: "var(--color-ui-background)",
      selection: `url(#${selectionGradientID})`,
      evaluated: "rgb(212 243 87 / 0.38)",
      error: "rgb(255 160 32 / 0.46)",
      search: "rgb(110 212 227 / 0.3)",
      bracket: "rgb(148 161 255 / 0.32)",
    };
    const order: SurfaceKind[] = [
      "body",
      "search",
      "bracket",
      "selection",
      "evaluated",
      "error",
    ];
    const signalRoot = svg("g", {
      "data-liquid-plane": "signals",
    });
    for (const kind of order) {
      const group = svg("g", {
        "data-liquid-kind": kind,
        fill: fills[kind],
      });
      if (kind === "body") group.setAttribute("filter", `url(#${filterID})`);
      this.groups.set(kind, group);
      if (kind === "body") this.surface.append(group);
      else signalRoot.append(group);
    }
    this.surface.append(signalRoot);

    this.view.scrollDOM.insertBefore(this.surface, this.view.contentDOM);
    this.observer = new MutationObserver((mutations) => {
      if (
        mutations.every(
          ({ target }) =>
            target instanceof Element && target.closest(".cm-liquid-surface")
        )
      ) {
        return;
      }
      if (
        mutations.some(({ target, addedNodes }) => {
          const element = target instanceof Element ? target : target.parentElement;
          if (element?.closest(".cm-evaluated, .cm-error-recoil-active")) {
            return true;
          }
          return [...addedNodes].some(
            (node) =>
              node instanceof Element &&
              (node.matches(".cm-evaluated, .cm-error-recoil-active") ||
                node.querySelector(".cm-evaluated, .cm-error-recoil-active"))
          );
        })
      ) {
        this.trackMotion(650);
      }
      if (!mutations.some((mutation) => this.mutationAffectsSurface(mutation))) {
        return;
      }
      this.scheduleDynamic();
    });
    this.observer.observe(this.view.dom, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["class"],
    });
    this.resizeObserver = new ResizeObserver(() => this.scheduleDynamic());
    this.resizeObserver.observe(this.view.scrollDOM);
    this.reducedMotion.addEventListener("change", this.motionPreferenceChanged);
    this.view.scrollDOM.addEventListener("scroll", this.scheduleDynamic, {
      passive: true,
    });
    this.schedule();
  }

  update(update: ViewUpdate) {
    if (
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      update.geometryChanged
    ) {
      this.schedule();
    }
  }

  destroy() {
    this.destroyed = true;
    this.observer.disconnect();
    this.resizeObserver.disconnect();
    this.reducedMotion.removeEventListener("change", this.motionPreferenceChanged);
    this.view.scrollDOM.removeEventListener("scroll", this.scheduleDynamic);
    cancelAnimationFrame(this.trackingFrame);
    window.clearTimeout(this.dynamicTimer);
    this.surface.remove();
    this.view.dom.classList.remove("cm-liquid-ready");
  }

  private readonly schedule = () => {
    if (!this.destroyed) this.view.requestMeasure(this.measureRequest);
  };

  private readonly scheduleDynamic = () => {
    if (this.destroyed || this.dynamicTimer) return;
    const elapsed = performance.now() - this.lastDynamicMeasure;
    const delay = Math.max(0, 48 - elapsed);
    this.dynamicTimer = window.setTimeout(() => {
      this.dynamicTimer = 0;
      this.lastDynamicMeasure = performance.now();
      this.schedule();
    }, delay);
  };

  private readonly motionPreferenceChanged = () => {
    if (this.reducedMotion.matches) {
      this.surface.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
    }
    this.lastFingerprint = "";
    this.schedule();
  };

  private trackMotion(duration: number) {
    if (this.reducedMotion.matches) return;
    this.trackUntil = Math.max(this.trackUntil, performance.now() + duration);
    if (this.trackingFrame) return;
    const tick = () => {
      this.trackingFrame = 0;
      if (this.destroyed || performance.now() >= this.trackUntil) return;
      this.scheduleDynamic();
      this.trackingFrame = requestAnimationFrame(tick);
    };
    this.trackingFrame = requestAnimationFrame(tick);
  }

  private mutationAffectsSurface(mutation: MutationRecord) {
    const selector = [
      ".cm-line.cm-activeLine",
      ".cm-selectionBackground",
      ".cm-evaluated",
      ".cm-error-recoil-active",
      ".cm-searchMatch",
      ".cm-selectionMatch",
      ".cm-matchingBracket",
      ".cm-nonmatchingBracket",
      ".cm-tooltip",
      ".cm-foldPlaceholder",
      ".cm-tooltip-autocomplete > ul > li[aria-selected]",
    ].join(",");
    const matches = (node: Node) =>
      node instanceof Element &&
      (node.matches(selector) || node.querySelector(selector) !== null);

    if (mutation.type === "attributes") return matches(mutation.target);
    return [...mutation.addedNodes, ...mutation.removedNodes].some(matches);
  }

  private elementKey(element: HTMLElement, kind: SurfaceKind, rectIndex = 0) {
    if (this.view.contentDOM.contains(element)) {
      try {
        const from = this.view.posAtDOM(element, 0);
        const to = this.view.posAtDOM(element, element.childNodes.length);
        return `${kind}-range-${from}-${to}-${rectIndex}`;
      } catch {
        // Widgets and transient DOM that do not map to the document fall back
        // to an element-local identity below.
      }
    }
    let elementID = this.elementIDs.get(element);
    if (elementID === undefined) {
      elementID = this.nextElementID++;
      this.elementIDs.set(element, elementID);
    }
    return `${kind}-element-${elementID}-${rectIndex}`;
  }

  private measure(): SurfaceMeasurement {
    const scroller = this.view.scrollDOM;
    const base = scroller.getBoundingClientRect();
    const scaleX = this.view.scaleX || 1;
    const scaleY = this.view.scaleY || 1;
    const shapes = {
      body: [],
      selection: [],
      evaluated: [],
      error: [],
      search: [],
      bracket: [],
    } satisfies Record<SurfaceKind, SurfaceShape[]>;
    const seen = new Map<SurfaceKind, Set<string>>();
    (Object.keys(shapes) as SurfaceKind[]).forEach((kind) => seen.set(kind, new Set()));

    const addRect = (
      kind: SurfaceKind,
      rect: DOMRect,
      radius: number,
      paint?: string,
      mode: "full" | "underline" = "full",
      sourceKey = `${kind}-anonymous`
    ) => {
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.right < base.left ||
        rect.left > base.right ||
        rect.bottom < base.top ||
        rect.top > base.bottom
      ) {
        return;
      }
      let x = (rect.left - base.left) / scaleX + scroller.scrollLeft;
      let y = (rect.top - base.top) / scaleY + scroller.scrollTop;
      let width = rect.width / scaleX;
      let height = rect.height / scaleY;
      if (mode === "underline") {
        const underlineHeight = Math.max(3, height * 0.28);
        y += height - underlineHeight;
        height = underlineHeight;
      }
      x = quantize(x);
      y = quantize(y);
      width = quantize(width);
      height = quantize(height);
      const shape: SurfaceShape = {
        key: sourceKey,
        x,
        y,
        width,
        height,
        radius: Math.min(radius, height / 2, width / 2),
        paint,
      };
      const key = `${x}/${y}/${width}/${height}/${shape.radius}/${paint ?? ""}`;
      const keys = seen.get(kind)!;
      if (keys.has(key)) return;
      keys.add(key);
      shapes[kind].push(shape);
    };

    const addElements = (
      kind: SurfaceKind,
      selector: string,
      radius = INLINE_RADIUS,
      paint?: (element: HTMLElement) => string | undefined,
      mode: "full" | "underline" = "full"
    ) => {
      for (const element of this.view.dom.querySelectorAll<HTMLElement>(selector)) {
        const value = paint?.(element);
        if (paint && value === undefined) continue;
        let rectIndex = 0;
        for (const rect of element.getClientRects()) {
          addRect(
            kind,
            rect,
            radius,
            value,
            mode,
            this.elementKey(element, kind, rectIndex)
          );
          rectIndex += 1;
        }
      }
    };

    for (const line of this.view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")) {
      if (line.classList.contains("cm-emptyLine") && !line.classList.contains("cm-activeLine")) {
        continue;
      }
      addRect(
        "body",
        line.getBoundingClientRect(),
        BODY_RADIUS,
        undefined,
        "full",
        this.elementKey(line, "body")
      );
    }

    addElements("selection", ".cm-selectionBackground", 6);
    addElements("evaluated", ".cm-evaluated", 7);
    addElements("search", ".cm-searchMatch, .cm-selectionMatch", 5);
    addElements("bracket", ".cm-matchingBracket, .cm-nonmatchingBracket", 4);
    addElements("body", ".cm-tooltip, .cm-foldPlaceholder", 9);
    addElements("selection", ".cm-tooltip-autocomplete > ul > li[aria-selected]", 6);
    addElements("error", ".cm-line.cm-error-recoil-active", 7);

    if (this.view.contentDOM.classList.contains("cm-error-recoil-active")) {
      for (const line of this.view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")) {
        addRect(
          "error",
          line.getBoundingClientRect(),
          7,
          undefined,
          "full",
          this.elementKey(line, "error")
        );
      }
    }

    shapes.selection = mergeAdjacentShapes(shapes.selection, 2, 3);
    shapes.evaluated = mergeAdjacentShapes(shapes.evaluated, 2, 3);
    shapes.error = mergeAdjacentShapes(shapes.error, 2, 3);
    shapes.search = mergeAdjacentShapes(shapes.search, 1, 2);
    shapes.bracket = mergeAdjacentShapes(shapes.bracket, 1, 2);

    const width = Math.max(scroller.clientWidth, scroller.scrollWidth);
    const height = Math.max(scroller.clientHeight, scroller.scrollHeight);
    const filterX = Math.max(-16, scroller.scrollLeft - 16);
    const filterY = Math.max(-16, scroller.scrollTop - 16);
    const filterWidth = scroller.clientWidth + 32;
    const filterHeight = scroller.clientHeight + 32;
    const fingerprint = `${quantize(width, 1)}x${quantize(height, 1)}@${quantize(filterX, 1)},${quantize(filterY, 1)},${quantize(filterWidth, 1)},${quantize(filterHeight, 1)}|${(
      Object.keys(shapes) as SurfaceKind[]
    )
      .map((kind) =>
        shapes[kind]
          .map(
            ({ key, x, y, width, height, radius, paint }) =>
              `${kind}:${key},${x},${y},${width},${height},${radius},${paint ?? ""}`
          )
          .join(";")
      )
      .join("|")}`;
    return {
      width,
      height,
      filterX,
      filterY,
      filterWidth,
      filterHeight,
      shapes,
      fingerprint,
    };
  }

  private draw({
    width,
    height,
    filterX,
    filterY,
    filterWidth,
    filterHeight,
    shapes,
    fingerprint,
  }: SurfaceMeasurement) {
    if (this.destroyed || fingerprint === this.lastFingerprint) return;
    this.lastFingerprint = fingerprint;
    setAttributeIfChanged(this.surface, "width", width.toString());
    setAttributeIfChanged(this.surface, "height", height.toString());
    setAttributeIfChanged(this.surface, "viewBox", `0 0 ${width} ${height}`);
    setAttributeIfChanged(this.gooFilter, "x", filterX.toString());
    setAttributeIfChanged(this.gooFilter, "y", filterY.toString());
    setAttributeIfChanged(this.gooFilter, "width", filterWidth.toString());
    setAttributeIfChanged(this.gooFilter, "height", filterHeight.toString());
    if (shapes.selection.length > 0) {
      const selectionLeft = Math.min(...shapes.selection.map(({ x }) => x));
      const selectionRight = Math.max(
        ...shapes.selection.map(({ x, width }) => x + width)
      );
      setAttributeIfChanged(this.selectionGradient, "gradientUnits", "userSpaceOnUse");
      setAttributeIfChanged(this.selectionGradient, "x1", selectionLeft.toString());
      setAttributeIfChanged(this.selectionGradient, "x2", selectionRight.toString());
    }

    for (const [kind, group] of this.groups) {
      const existing = new Map(
        [...group.querySelectorAll<SVGRectElement>("rect[data-liquid-shape]")].map(
          (rect) => [rect.dataset.liquidShape!, rect] as const
        )
      );
      shapes[kind].forEach((shape) => {
        let rect = existing.get(shape.key);
        if (!rect) {
          rect = svg("rect", {
            "data-liquid-shape": shape.key,
          });
          group.append(rect);
        }
        existing.delete(shape.key);
        setAttributeIfChanged(rect, "x", shape.x.toString());
        setAttributeIfChanged(rect, "y", shape.y.toString());
        setAttributeIfChanged(rect, "width", shape.width.toString());
        setAttributeIfChanged(rect, "height", shape.height.toString());
        setAttributeIfChanged(rect, "rx", shape.radius.toString());
      });
      for (const stale of existing.values()) stale.remove();
    }

    this.view.dom.classList.add("cm-liquid-ready");
  }
}

export function liquidEditorSurface(): Extension {
  return ViewPlugin.fromClass(LiquidEditorSurface);
}
