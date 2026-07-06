"use client";

import { useEffect, useRef, useState } from "react";

type Bullet = { x: number; y: number; vy: number };
type Missile = { x: number; y: number; vy: number; vx: number };
type Bomb = { x: number; y: number; vy: number; rot: number };
type Enemy = {
  x: number;
  y: number;
  vy: number;
  phase: number;
  amp: number;
  scale: number;
  fireTimer: number;
  bombTimer: number;
};
type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
};
type Cloud = { x: number; y: number; r: number; speed: number; opacity: number };

type Status = "ready" | "playing" | "gameover";

interface GameState {
  width: number;
  height: number;
  player: { x: number; y: number; targetX: number; targetY: number; invuln: number };
  bullets: Bullet[];
  missiles: Missile[];
  bombs: Bomb[];
  enemies: Enemy[];
  particles: Particle[];
  clouds: Cloud[];
  fireTimer: number;
  spawnTimer: number;
  elapsed: number;
  pointerDown: boolean;
  keys: Set<string>;
}

const PLAYER_RADIUS = 14;
const ENEMY_RADIUS = 15;
// Hitboxes are smaller than the sprites so near-misses look and feel fair.
const PLAYER_HIT_RADIUS = 7;
const ENEMY_HIT_RADIUS = 10;
const MISSILE_HIT_RADIUS = 3.5;
const BOMB_HIT_RADIUS = 4.5;
const INVULN_TIME = 2.2;
const GRAVITY = 130;

function makeInitialState(width: number, height: number): GameState {
  const clouds: Cloud[] = Array.from({ length: 26 }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    r: 14 + Math.random() * 34,
    speed: 18 + Math.random() * 26,
    opacity: 0.05 + Math.random() * 0.1,
  }));
  return {
    width,
    height,
    player: {
      x: width / 2,
      y: height - height * 0.16,
      targetX: width / 2,
      targetY: height - height * 0.16,
      invuln: 2,
    },
    bullets: [],
    missiles: [],
    bombs: [],
    enemies: [],
    particles: [],
    clouds,
    fireTimer: 0,
    spawnTimer: 0.6,
    elapsed: 0,
    pointerDown: false,
    keys: new Set(),
  };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function dist2(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function spawnExplosion(particles: Particle[], x: number, y: number, colorSet: string[], count = 18) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 40 + Math.random() * 140;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.4 + Math.random() * 0.5,
      maxLife: 0.4 + Math.random() * 0.5,
      size: 2 + Math.random() * 3.5,
      color: colorSet[Math.floor(Math.random() * colorSet.length)],
    });
  }
}

// Draws a shaded, detailed fighter-jet silhouette pointing "up" in local space
// before rotation is applied by the caller.
function drawJet(
  ctx: CanvasRenderingContext2D,
  scale: number,
  flameFlicker: number,
  scheme: {
    bodyTop: string;
    bodyBottom: string;
    stroke: string;
    canopyTop: string;
    canopyBottom: string;
    roundelOuter: string;
    roundelInner: string;
    accent: string;
  }
) {
  ctx.save();
  ctx.scale(scale, scale);

  // Engine flame (drawn first so the fuselage overlaps its base)
  const flameLen = 10 + flameFlicker * 6;
  const flameGrad = ctx.createLinearGradient(0, 20, 0, 20 + flameLen);
  flameGrad.addColorStop(0, "rgba(255,230,140,0.95)");
  flameGrad.addColorStop(0.5, "rgba(255,140,40,0.75)");
  flameGrad.addColorStop(1, "rgba(255,90,30,0)");
  ctx.fillStyle = flameGrad;
  ctx.beginPath();
  ctx.moveTo(-3.4, 20);
  ctx.quadraticCurveTo(0, 20 + flameLen, 3.4, 20);
  ctx.closePath();
  ctx.fill();

  // Fuselage + delta wings + tail silhouette
  const grad = ctx.createLinearGradient(0, -24, 0, 24);
  grad.addColorStop(0, scheme.bodyTop);
  grad.addColorStop(1, scheme.bodyBottom);

  ctx.beginPath();
  ctx.moveTo(0, -24);
  ctx.bezierCurveTo(3, -21, 5, -15, 5, -8);
  ctx.lineTo(19, 3);
  ctx.lineTo(20.5, 7.5);
  ctx.lineTo(6, 6.5);
  ctx.lineTo(7, 15.5);
  ctx.lineTo(13.5, 19.5);
  ctx.lineTo(4, 18.5);
  ctx.lineTo(3.2, 23.5);
  ctx.lineTo(-3.2, 23.5);
  ctx.lineTo(-4, 18.5);
  ctx.lineTo(-13.5, 19.5);
  ctx.lineTo(-7, 15.5);
  ctx.lineTo(-6, 6.5);
  ctx.lineTo(-20.5, 7.5);
  ctx.lineTo(-19, 3);
  ctx.lineTo(-5, -8);
  ctx.bezierCurveTo(-5, -15, -3, -21, 0, -24);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.lineWidth = 0.7;
  ctx.strokeStyle = scheme.stroke;
  ctx.stroke();

  // Wing accent stripes
  ctx.fillStyle = scheme.accent;
  ctx.beginPath();
  ctx.moveTo(19, 3);
  ctx.lineTo(20.5, 7.5);
  ctx.lineTo(15, 6.9);
  ctx.lineTo(14.2, 3.6);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-19, 3);
  ctx.lineTo(-20.5, 7.5);
  ctx.lineTo(-15, 6.9);
  ctx.lineTo(-14.2, 3.6);
  ctx.closePath();
  ctx.fill();

  // Panel lines for a bit of realism
  ctx.strokeStyle = "rgba(0,0,0,0.18)";
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(0, -8);
  ctx.lineTo(0, 18);
  ctx.moveTo(-3, 0);
  ctx.lineTo(-6, 6.5);
  ctx.moveTo(3, 0);
  ctx.lineTo(6, 6.5);
  ctx.stroke();

  // Canopy / cockpit glass
  const canopyGrad = ctx.createLinearGradient(0, -18, 0, -5);
  canopyGrad.addColorStop(0, scheme.canopyTop);
  canopyGrad.addColorStop(1, scheme.canopyBottom);
  ctx.beginPath();
  ctx.ellipse(0, -12, 2.6, 7, 0, 0, Math.PI * 2);
  ctx.fillStyle = canopyGrad;
  ctx.fill();
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.stroke();
  // canopy glint
  ctx.beginPath();
  ctx.ellipse(-0.9, -14.5, 0.7, 2.4, -0.3, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fill();

  // Roundel
  ctx.beginPath();
  ctx.arc(0, 1, 3.4, 0, Math.PI * 2);
  ctx.fillStyle = scheme.roundelOuter;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 1, 1.6, 0, Math.PI * 2);
  ctx.fillStyle = scheme.roundelInner;
  ctx.fill();

  ctx.restore();
}

function drawMissile(ctx: CanvasRenderingContext2D, wobble: number) {
  ctx.save();
  // exhaust
  const flameGrad = ctx.createLinearGradient(0, -6, 0, -14);
  flameGrad.addColorStop(0, "rgba(255,200,120,0.9)");
  flameGrad.addColorStop(1, "rgba(255,90,30,0)");
  ctx.fillStyle = flameGrad;
  ctx.beginPath();
  ctx.moveTo(-1.6, -6);
  ctx.quadraticCurveTo(0 + wobble, -13, 1.6, -6);
  ctx.closePath();
  ctx.fill();

  const grad = ctx.createLinearGradient(-2.2, 0, 2.2, 0);
  grad.addColorStop(0, "#8a8f96");
  grad.addColorStop(0.5, "#e7eaee");
  grad.addColorStop(1, "#6b7076");
  ctx.beginPath();
  ctx.moveTo(0, -6);
  ctx.lineTo(2.2, 3);
  ctx.lineTo(2.2, 8);
  ctx.lineTo(3.8, 10);
  ctx.lineTo(1.6, 9);
  ctx.lineTo(1.6, 3.4);
  ctx.lineTo(-1.6, 3.4);
  ctx.lineTo(-1.6, 9);
  ctx.lineTo(-3.8, 10);
  ctx.lineTo(-2.2, 8);
  ctx.lineTo(-2.2, 3);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 0.4;
  ctx.stroke();

  ctx.fillStyle = "#d43b3b";
  ctx.fillRect(-1.6, 0, 3.2, 1.6);
  ctx.restore();
}

function drawBomb(ctx: CanvasRenderingContext2D) {
  ctx.save();
  const grad = ctx.createLinearGradient(-3, 0, 3, 0);
  grad.addColorStop(0, "#3a3d33");
  grad.addColorStop(0.5, "#6b6f5e");
  grad.addColorStop(1, "#25271f");
  ctx.beginPath();
  ctx.ellipse(0, 0, 3.2, 6.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // tail fins
  ctx.fillStyle = "#20221b";
  ctx.beginPath();
  ctx.moveTo(0, 4.5);
  ctx.lineTo(4.5, 8.5);
  ctx.lineTo(1.4, 6.5);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, 4.5);
  ctx.lineTo(-4.5, 8.5);
  ctx.lineTo(-1.4, 6.5);
  ctx.closePath();
  ctx.fill();

  // nose highlight
  ctx.beginPath();
  ctx.ellipse(-1, -3.5, 0.9, 1.8, -0.3, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fill();

  ctx.fillStyle = "#c73a2f";
  ctx.beginPath();
  ctx.arc(0, -1, 0.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBullet(ctx: CanvasRenderingContext2D) {
  const grad = ctx.createLinearGradient(0, -7, 0, 5);
  grad.addColorStop(0, "rgba(255,255,255,0.95)");
  grad.addColorStop(0.5, "rgba(255,241,150,0.95)");
  grad.addColorStop(1, "rgba(255,190,60,0.15)");
  ctx.beginPath();
  ctx.moveTo(0, -7);
  ctx.quadraticCurveTo(1.6, -2, 1.1, 5);
  ctx.quadraticCurveTo(0, 6, -1.1, 5);
  ctx.quadraticCurveTo(-1.6, -2, 0, -7);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
}

const PLAYER_SCHEME = {
  bodyTop: "#eef2f6",
  bodyBottom: "#8d99a6",
  stroke: "#2c333a",
  canopyTop: "#bfe6ff",
  canopyBottom: "#0d3a5c",
  roundelOuter: "#1c5fb0",
  roundelInner: "#ffffff",
  accent: "#d1372c",
};

const ENEMY_SCHEME = {
  bodyTop: "#5c5f66",
  bodyBottom: "#26282c",
  stroke: "#111214",
  canopyTop: "#ffb199",
  canopyBottom: "#4a0d0d",
  roundelOuter: "#b7141f",
  roundelInner: "#161616",
  accent: "#e0e0e0",
};

export default function FighterGame() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<GameState | null>(null);
  const statusRef = useRef<Status>("ready");
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  const [status, setStatus] = useState<Status>("ready");
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [best, setBest] = useState(() => {
    if (typeof window === "undefined") return 0;
    try {
      return parseInt(window.localStorage.getItem("skyfighter-best") ?? "0", 10) || 0;
    } catch {
      return 0;
    }
  });

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const startGame = () => {
    const el = containerRef.current;
    const width = el?.clientWidth ?? 360;
    const height = el?.clientHeight ?? 640;
    stateRef.current = makeInitialState(width, height);
    setScore(0);
    setLives(3);
    setStatus("playing");
  };

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = container.clientWidth;
      const height = container.clientHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (stateRef.current) {
        stateRef.current.width = width;
        stateRef.current.height = height;
        stateRef.current.player.x = clamp(stateRef.current.player.x, PLAYER_RADIUS, width - PLAYER_RADIUS);
        stateRef.current.player.y = clamp(stateRef.current.player.y, PLAYER_RADIUS, height - PLAYER_RADIUS);
      } else {
        stateRef.current = makeInitialState(width, height);
      }
    };
    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(container);

    const getLocalPoint = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const onPointerDown = (e: PointerEvent) => {
      const s = stateRef.current;
      if (!s) return;
      s.pointerDown = true;
      const p = getLocalPoint(e.clientX, e.clientY);
      s.player.targetX = p.x;
      s.player.targetY = p.y;
      if (statusRef.current === "ready") startGame();
      e.preventDefault();
    };
    const onPointerMove = (e: PointerEvent) => {
      const s = stateRef.current;
      if (!s) return;
      if (e.pointerType === "mouse" || s.pointerDown) {
        const p = getLocalPoint(e.clientX, e.clientY);
        s.player.targetX = p.x;
        s.player.targetY = p.y;
      }
    };
    const onPointerUp = () => {
      const s = stateRef.current;
      if (s) s.pointerDown = false;
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    canvas.style.touchAction = "none";

    const onKeyDown = (e: KeyboardEvent) => {
      const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d", "W", "A", "S", "D"];
      if (keys.includes(e.key)) {
        e.preventDefault();
        stateRef.current?.keys.add(e.key.toLowerCase());
        if (statusRef.current === "ready") startGame();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      stateRef.current?.keys.delete(e.key.toLowerCase());
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    const onVisibility = () => {
      if (!document.hidden) lastTimeRef.current = performance.now();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - lastTimeRef.current) / 1000 || 0);
      lastTimeRef.current = now;
      const s = stateRef.current;
      if (s) {
        if (statusRef.current === "playing") update(s, dt);
        render(ctx, s, statusRef.current);
      }
      rafRef.current = requestAnimationFrame(loop);
    };

    function update(s: GameState, dt: number) {
      s.elapsed += dt;
      const p = s.player;

      // keyboard movement overrides pointer target for this frame
      const speed = 320;
      let kx = 0;
      let ky = 0;
      if (s.keys.has("arrowleft") || s.keys.has("a")) kx -= 1;
      if (s.keys.has("arrowright") || s.keys.has("d")) kx += 1;
      if (s.keys.has("arrowup") || s.keys.has("w")) ky -= 1;
      if (s.keys.has("arrowdown") || s.keys.has("s")) ky += 1;
      if (kx !== 0 || ky !== 0) {
        const len = Math.hypot(kx, ky) || 1;
        p.x = clamp(p.x + (kx / len) * speed * dt, PLAYER_RADIUS, s.width - PLAYER_RADIUS);
        p.y = clamp(p.y + (ky / len) * speed * dt, PLAYER_RADIUS, s.height - PLAYER_RADIUS);
        p.targetX = p.x;
        p.targetY = p.y;
      } else {
        p.targetX = clamp(p.targetX, PLAYER_RADIUS, s.width - PLAYER_RADIUS);
        p.targetY = clamp(p.targetY, PLAYER_RADIUS, s.height - PLAYER_RADIUS);
        p.x += (p.targetX - p.x) * Math.min(1, dt * 10);
        p.y += (p.targetY - p.y) * Math.min(1, dt * 10);
      }
      if (p.invuln > 0) p.invuln -= dt;

      // clouds
      for (const c of s.clouds) {
        c.y += c.speed * dt;
        if (c.y - c.r > s.height) {
          c.y = -c.r;
          c.x = Math.random() * s.width;
        }
      }

      // auto-fire
      s.fireTimer -= dt;
      if (s.fireTimer <= 0) {
        s.fireTimer = 0.18;
        s.bullets.push({ x: p.x - 7, y: p.y - 14, vy: -560 });
        s.bullets.push({ x: p.x + 7, y: p.y - 14, vy: -560 });
      }
      for (const b of s.bullets) b.y += b.vy * dt;
      s.bullets = s.bullets.filter((b) => b.y > -20);

      // difficulty ramps with elapsed time
      const difficulty = Math.min(1, s.elapsed / 45);
      s.spawnTimer -= dt;
      if (s.spawnTimer <= 0) {
        s.spawnTimer = clamp(1.15 - difficulty * 0.65, 0.35, 1.15) + Math.random() * 0.3;
        s.enemies.push({
          x: 30 + Math.random() * (s.width - 60),
          y: -30,
          vy: 55 + Math.random() * 35 + difficulty * 40,
          phase: Math.random() * Math.PI * 2,
          amp: 20 + Math.random() * 40,
          scale: 0.85 + Math.random() * 0.35,
          fireTimer: 1.8 + Math.random() * 1.8,
          bombTimer: 1.2 + Math.random() * 2.2,
        });
      }

      for (const en of s.enemies) {
        en.y += en.vy * dt;
        en.phase += dt * 1.6;
        en.x = clamp(en.x + Math.sin(en.phase) * en.amp * dt * 0.6, 20, s.width - 20);
        en.fireTimer -= dt;
        if (en.fireTimer <= 0 && en.y > 10 && en.y < s.height - 60) {
          en.fireTimer = 2.2 + Math.random() * 1.6 - difficulty * 0.5;
          const dx = p.x - en.x;
          const dy = p.y - en.y;
          const len = Math.hypot(dx, dy) || 1;
          s.missiles.push({
            x: en.x,
            y: en.y + 10,
            vy: (dy / len) * 190 + 80,
            vx: (dx / len) * 100,
          });
        }
        en.bombTimer -= dt;
        if (en.bombTimer <= 0 && en.y > 10 && en.y < s.height - 100) {
          en.bombTimer = 2.8 + Math.random() * 2.4 - difficulty * 0.6;
          s.bombs.push({ x: en.x, y: en.y + 12, vy: 40, rot: Math.random() * Math.PI * 2 });
        }
      }
      s.enemies = s.enemies.filter((en) => en.y < s.height + 40);

      for (const m of s.missiles) {
        const dx = p.x - m.x;
        // gentle homing so missiles are threatening but still dodgeable
        m.vx += clamp(dx, -1, 1) * 16 * dt;
        m.x += m.vx * dt;
        m.y += m.vy * dt;
      }
      s.missiles = s.missiles.filter((m) => m.y < s.height + 30);

      // bombs fall straight down and accelerate under gravity, unlike homing missiles
      for (const bm of s.bombs) {
        bm.vy += GRAVITY * dt;
        bm.y += bm.vy * dt;
        bm.rot += dt * 2.4;
      }
      s.bombs = s.bombs.filter((bm) => bm.y < s.height + 30);

      // bullet vs enemy
      const deadEnemies = new Set<Enemy>();
      const deadBullets = new Set<Bullet>();
      for (const b of s.bullets) {
        for (const en of s.enemies) {
          if (deadEnemies.has(en) || deadBullets.has(b)) continue;
          const r = ENEMY_RADIUS * en.scale;
          if (dist2(b.x, b.y, en.x, en.y) < r * r) {
            deadEnemies.add(en);
            deadBullets.add(b);
            spawnExplosion(s.particles, en.x, en.y, ["#ffcf5c", "#ff7a3c", "#8a8f96"]);
            setScore((sc) => sc + 10);
          }
        }
      }
      if (deadEnemies.size) s.enemies = s.enemies.filter((en) => !deadEnemies.has(en));
      if (deadBullets.size) s.bullets = s.bullets.filter((b) => !deadBullets.has(b));

      // player collisions
      if (p.invuln <= 0) {
        let hitBy: "missile" | "bomb" | "enemy" | null = null;
        for (const m of s.missiles) {
          if (
            dist2(p.x, p.y, m.x, m.y) <
            (PLAYER_HIT_RADIUS + MISSILE_HIT_RADIUS) * (PLAYER_HIT_RADIUS + MISSILE_HIT_RADIUS)
          ) {
            hitBy = "missile";
            s.missiles = s.missiles.filter((mm) => mm !== m);
            break;
          }
        }
        if (!hitBy) {
          for (const bm of s.bombs) {
            if (
              dist2(p.x, p.y, bm.x, bm.y) <
              (PLAYER_HIT_RADIUS + BOMB_HIT_RADIUS) * (PLAYER_HIT_RADIUS + BOMB_HIT_RADIUS)
            ) {
              hitBy = "bomb";
              s.bombs = s.bombs.filter((bb) => bb !== bm);
              break;
            }
          }
        }
        if (!hitBy) {
          for (const en of s.enemies) {
            const r = PLAYER_HIT_RADIUS + ENEMY_HIT_RADIUS * en.scale;
            if (dist2(p.x, p.y, en.x, en.y) < r * r) {
              hitBy = "enemy";
              s.enemies = s.enemies.filter((ee) => ee !== en);
              break;
            }
          }
        }
        if (hitBy) {
          p.invuln = INVULN_TIME;
          spawnExplosion(s.particles, p.x, p.y, ["#8fd3ff", "#ffffff", "#ff7a3c"], 24);
          setLives((lv) => {
            const next = lv - 1;
            if (next <= 0) {
              statusRef.current = "gameover";
              setStatus("gameover");
              setScore((sc) => {
                setBest((b) => {
                  const nb = Math.max(b, sc);
                  try {
                    window.localStorage.setItem("skyfighter-best", String(nb));
                  } catch {
                    // ignore
                  }
                  return nb;
                });
                return sc;
              });
            }
            return next;
          });
        }
      }

      // particles
      for (const pt of s.particles) {
        pt.x += pt.vx * dt;
        pt.y += pt.vy * dt;
        pt.vx *= 0.94;
        pt.vy *= 0.94;
        pt.life -= dt;
      }
      s.particles = s.particles.filter((pt) => pt.life > 0);
    }

    function render(c: CanvasRenderingContext2D, s: GameState, currentStatus: Status) {
      const { width, height } = s;
      const sky = c.createLinearGradient(0, 0, 0, height);
      sky.addColorStop(0, "#0b1a33");
      sky.addColorStop(1, "#173a5c");
      c.fillStyle = sky;
      c.fillRect(0, 0, width, height);

      c.save();
      for (const cl of s.clouds) {
        c.beginPath();
        c.arc(cl.x, cl.y, cl.r, 0, Math.PI * 2);
        c.fillStyle = `rgba(255,255,255,${cl.opacity})`;
        c.fill();
      }
      c.restore();

      // missiles
      for (const m of s.missiles) {
        c.save();
        c.translate(m.x, m.y);
        const angle = Math.atan2(m.vy, m.vx) - Math.PI / 2;
        c.rotate(angle);
        drawMissile(c, Math.sin(s.elapsed * 30) * 0.8);
        c.restore();
      }

      // bombs
      for (const bm of s.bombs) {
        c.save();
        c.translate(bm.x, bm.y);
        c.rotate(bm.rot);
        drawBomb(c);
        c.restore();
      }

      // bullets
      for (const b of s.bullets) {
        c.save();
        c.translate(b.x, b.y);
        drawBullet(c);
        c.restore();
      }

      // enemies
      for (const en of s.enemies) {
        c.save();
        c.translate(en.x, en.y);
        c.rotate(Math.PI);
        drawJet(c, en.scale, Math.abs(Math.sin(s.elapsed * 18 + en.phase)), ENEMY_SCHEME);
        c.restore();
      }

      // player
      const p = s.player;
      const flashHidden = p.invuln > 0 && Math.floor(p.invuln * 10) % 2 === 0;
      if (currentStatus !== "gameover" && !flashHidden) {
        c.save();
        c.translate(p.x, p.y);
        drawJet(c, 1, Math.abs(Math.sin(s.elapsed * 22)), PLAYER_SCHEME);
        c.restore();
      }

      // particles
      for (const pt of s.particles) {
        const t = pt.life / pt.maxLife;
        c.save();
        c.globalAlpha = clamp(t, 0, 1);
        c.beginPath();
        c.arc(pt.x, pt.y, pt.size * t, 0, Math.PI * 2);
        c.fillStyle = pt.color;
        c.fill();
        c.restore();
      }
    }

    lastTimeRef.current = performance.now();
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative h-dvh w-full overflow-hidden select-none bg-[#0b1a33]"
    >
      <canvas ref={canvasRef} className="absolute inset-0 block" />

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3 sm:p-4 text-white font-sans">
        <div className="rounded-lg bg-black/35 px-3 py-1.5 backdrop-blur-sm">
          <div className="text-xs uppercase tracking-wide text-white/60">Score</div>
          <div className="text-lg font-bold tabular-nums leading-tight">{score}</div>
        </div>
        <div className="flex gap-1.5 rounded-lg bg-black/35 px-3 py-1.5 backdrop-blur-sm">
          {Array.from({ length: 3 }, (_, i) => (
            <span
              key={i}
              className={`text-lg leading-none ${i < lives ? "opacity-100" : "opacity-25"}`}
            >
              &#9992;
            </span>
          ))}
        </div>
      </div>

      {status === "ready" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-black/55 px-6 text-center text-white font-sans">
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">Sky Fighter</h1>
          <p className="max-w-xs text-sm sm:text-base text-white/80">
            Drag or move your mouse to steer. Your jet auto-fires — dodge homing missiles and falling bombs, and
            shoot down every plane you can.
          </p>
          {best > 0 && <p className="text-xs text-white/60">Best score: {best}</p>}
          <button
            onClick={startGame}
            className="mt-1 rounded-full bg-red-600 px-8 py-3 text-base font-bold shadow-lg shadow-red-900/40 active:scale-95 transition-transform"
          >
            Tap to Start
          </button>
          <p className="text-xs text-white/50">Arrow keys / WASD also work on desktop</p>
        </div>
      )}

      {status === "gameover" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/65 px-6 text-center text-white font-sans">
          <h2 className="text-3xl font-extrabold">Shot Down!</h2>
          <p className="text-lg">
            Score: <span className="font-bold">{score}</span>
          </p>
          <p className="text-sm text-white/70">Best: {best}</p>
          <button
            onClick={startGame}
            className="mt-1 rounded-full bg-red-600 px-8 py-3 text-base font-bold shadow-lg shadow-red-900/40 active:scale-95 transition-transform"
          >
            Play Again
          </button>
        </div>
      )}
    </div>
  );
}
