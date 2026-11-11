/**
 * The hero's particle flow. Plain canvas 2D, no dependencies.
 *
 * The nodes and the account card are real DOM elements. This reads their
 * positions, draws hairline curves between them and moves fine particles along
 * the curves: money in from the top, money out at the bottom, and one stream
 * that is stopped at a gate before it reaches its target.
 *
 * It stays light: a few hundred dots, device pixel ratio capped at 2, the loop
 * only runs while `setRunning(true)`, and `drawStatic()` gives a still frame for
 * reduced motion.
 */

type Point = [number, number];

interface Link {
  key: string;
  kind: "in" | "out" | "stop";
  p0: Point;
  p1: Point;
  p2: Point;
  p3: Point;
}

interface Particle {
  link: number;
  t: number;
  speed: number;
  offset: number;
  size: number;
  alpha: number;
  burst: boolean;
}

export interface Flow {
  setRunning(running: boolean): void;
  /** Send a short train of particles along the link to or from the node with this key. */
  burst(key: string): void;
  destroy(): void;
}

const GATE = 0.58;
const SPREAD = 7;

function bezier(link: Link, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [
    a * link.p0[0] + b * link.p1[0] + c * link.p2[0] + d * link.p3[0],
    a * link.p0[1] + b * link.p1[1] + c * link.p2[1] + d * link.p3[1],
  ];
}

export function createFlow(root: HTMLElement, canvas: HTMLCanvasElement, reducedMotion: boolean): Flow | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  let width = 0;
  let height = 0;
  let links: Link[] = [];
  let particles: Particle[] = [];
  let running = false;
  let frame = 0;
  let last = 0;
  let dot = "10, 10, 11";
  let line = "#dcdce0";
  let stop = "179, 38, 30";

  // Deterministic scatter so the still frame looks the same on every visit.
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  function readColors() {
    const style = getComputedStyle(root);
    dot = style.getPropertyValue("--flow-dot").trim() || dot;
    line = style.getPropertyValue("--flow-line").trim() || line;
    stop = style.getPropertyValue("--flow-stop").trim() || stop;
  }

  function spawn(link: number, burst: boolean, lead = 0): Particle {
    return burst
      ? { link, t: -lead, speed: 0.5 + random() * 0.2, offset: (random() - 0.5) * 0.9, size: 1.5, alpha: 0.95, burst }
      : {
          link,
          t: random(),
          speed: 0.07 + random() * 0.11,
          offset: (random() - 0.5) * 2,
          size: 0.7 + random() * 0.8,
          alpha: 0.3 + random() * 0.6,
          burst,
        };
  }

  function measure() {
    const box = root.getBoundingClientRect();
    width = box.width;
    height = box.height;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx!.setTransform(ratio, 0, 0, ratio, 0, 0);

    const cardEl = root.querySelector<HTMLElement>("[data-flow-card]");
    if (!cardEl) return;
    const c = cardEl.getBoundingClientRect();
    const card = { left: c.left - box.left, top: c.top - box.top, width: c.width, bottom: c.bottom - box.top };

    const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-flow]")).map((el) => {
      const [kind, key] = (el.dataset.flow ?? "").split(":");
      const r = el.getBoundingClientRect();
      return { kind, key, x: r.left - box.left + r.width / 2, top: r.top - box.top, bottom: r.bottom - box.top };
    });
    const ins = nodes.filter((n) => n.kind === "in");
    const outs = nodes.filter((n) => n.kind !== "in");

    const next: Link[] = [];
    ins.forEach((node, i) => {
      const end: Point = [card.left + (card.width * (i + 1)) / (ins.length + 1), card.top];
      const start: Point = [node.x, node.bottom];
      const dy = end[1] - start[1];
      next.push({ key: node.key, kind: "in", p0: start, p1: [start[0], start[1] + dy * 0.6], p2: [end[0], end[1] - dy * 0.6], p3: end });
    });
    outs.forEach((node, i) => {
      const start: Point = [card.left + (card.width * (i + 1)) / (outs.length + 1), card.bottom];
      const end: Point = [node.x, node.top];
      const dy = end[1] - start[1];
      next.push({
        key: node.key,
        kind: node.kind === "stop" ? "stop" : "out",
        p0: start,
        p1: [start[0], start[1] + dy * 0.6],
        p2: [end[0], end[1] - dy * 0.6],
        p3: end,
      });
    });

    const changed = next.length !== links.length;
    links = next;
    if (changed) {
      const perLink = width < 480 ? 22 : 40;
      particles = [];
      links.forEach((_, index) => {
        for (let i = 0; i < perLink; i++) particles.push(spawn(index, false));
      });
    }
  }

  function trace(link: Link, from: number, to: number) {
    const steps = 28;
    for (let i = 0; i <= steps; i++) {
      const [x, y] = bezier(link, from + ((to - from) * i) / steps);
      if (i === 0) ctx!.moveTo(x, y);
      else ctx!.lineTo(x, y);
    }
  }

  function draw() {
    ctx!.clearRect(0, 0, width, height);
    ctx!.lineWidth = 1;

    for (const link of links) {
      ctx!.beginPath();
      ctx!.strokeStyle = line;
      ctx!.setLineDash([]);
      if (link.kind === "stop") {
        trace(link, 0, GATE);
        ctx!.stroke();
        ctx!.beginPath();
        ctx!.setLineDash([2, 5]);
        trace(link, GATE, 1);
        ctx!.stroke();
        ctx!.setLineDash([]);
        const [gx, gy] = bezier(link, GATE);
        ctx!.beginPath();
        ctx!.strokeStyle = `rgba(${stop}, 0.9)`;
        ctx!.lineWidth = 1.5;
        ctx!.moveTo(gx - 11, gy);
        ctx!.lineTo(gx + 11, gy);
        ctx!.stroke();
        ctx!.lineWidth = 1;
      } else {
        trace(link, 0, 1);
        ctx!.stroke();
      }
    }

    for (const p of particles) {
      if (p.t < 0) continue;
      const link = links[p.link];
      if (!link) continue;
      let x: number;
      let y: number;
      let alpha = p.alpha * Math.min(1, p.t / 0.08, (1 - p.t) / 0.08);
      let color = dot;
      if (link.kind === "stop" && p.t > GATE - 0.02) {
        // Stopped at the gate: slide sideways along it and fade.
        const k = Math.min(1, (p.t - (GATE - 0.02)) / 0.16);
        const [gx, gy] = bezier(link, GATE - 0.02);
        x = gx + p.offset * (SPREAD * 0.6 + 16 * k);
        y = gy - 1.5;
        alpha = p.alpha * (1 - k);
        color = stop;
      } else {
        const pos = bezier(link, p.t);
        x = pos[0] + p.offset * SPREAD * Math.sin(Math.PI * p.t);
        y = pos[1];
      }
      if (alpha <= 0.01) continue;
      ctx!.beginPath();
      ctx!.fillStyle = `rgba(${color}, ${alpha.toFixed(3)})`;
      ctx!.arc(x, y, p.size, 0, Math.PI * 2);
      ctx!.fill();
    }
  }

  function step(now: number) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    let needsSweep = false;
    for (const p of particles) {
      p.t += p.speed * dt;
      const end = links[p.link]?.kind === "stop" ? GATE + 0.14 : 1;
      if (p.t >= end) {
        if (p.burst) needsSweep = true;
        else p.t = 0;
      }
    }
    if (needsSweep) {
      particles = particles.filter((p) => !p.burst || p.t < (links[p.link]?.kind === "stop" ? GATE + 0.14 : 1));
    }
    draw();
    frame = requestAnimationFrame(step);
  }

  const resize = new ResizeObserver(() => {
    measure();
    draw();
  });
  resize.observe(root);
  const cardEl = root.querySelector("[data-flow-card]");
  if (cardEl) resize.observe(cardEl);

  const theme = new MutationObserver(() => {
    readColors();
    draw();
  });
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  readColors();
  measure();
  draw();
  void document.fonts?.ready.then(() => {
    measure();
    draw();
  });

  return {
    setRunning(next: boolean) {
      const wanted = next && !reducedMotion;
      if (wanted === running) return;
      running = wanted;
      cancelAnimationFrame(frame);
      if (running) {
        last = performance.now();
        frame = requestAnimationFrame(step);
      }
    },
    burst(key: string) {
      if (!running) return;
      const index = links.findIndex((l) => l.key === key);
      if (index < 0) return;
      for (let i = 0; i < 14; i++) particles.push(spawn(index, true, i * 0.035));
    },
    destroy() {
      running = false;
      cancelAnimationFrame(frame);
      resize.disconnect();
      theme.disconnect();
    },
  };
}
