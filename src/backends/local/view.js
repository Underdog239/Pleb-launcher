// Offline scene visualisation for the local backend.
//
// There is no headless Roblox renderer, so this produces an approximate
// top-down (X/Z) projection of every BasePart as an axis-aligned rectangle.
// It is meant for agent perception — layout and footprint — not fidelity.

const PLANES = {
  xz: { u: 'x', v: 'z', label: 'X (right) / Z (down), looking along -Y' },
  xy: { u: 'x', v: 'y', label: 'X (right) / Y (down), looking along -Z' },
  zy: { u: 'z', v: 'y', label: 'Z (right) / Y (down), looking along -X' },
};

function collectParts(roots) {
  const out = [];
  const visit = (i) => {
    if (i.isA('BasePart')) {
      const size = i.get('Size');
      const cf = i.get('CFrame');
      if (size && cf && cf.position) out.push({ inst: i, size, position: cf.position });
    }
    for (const c of i.children) visit(c);
  };
  for (const r of roots) visit(r);
  return out;
}

function hex(color) {
  if (!color || typeof color.r !== 'number') return '#8a8a8a';
  const b = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  return `#${b(color.r)}${b(color.g)}${b(color.b)}`;
}

export function sceneSummary(roots) {
  const parts = collectParts(roots);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const p of parts) {
    const hx = Math.abs(p.size.x) / 2;
    const hz = Math.abs(p.size.z) / 2;
    minU = Math.min(minU, p.position.x - hx);
    maxU = Math.max(maxU, p.position.x + hx);
    minV = Math.min(minV, p.position.z - hz);
    maxV = Math.max(maxV, p.position.z + hz);
  }
  return {
    partCount: parts.length,
    bounds: parts.length
      ? { min: { x: minU, z: minV }, max: { x: maxU, z: maxV } }
      : null,
    parts: parts.slice(0, 500).map((p) => ({
      path: p.inst.getFullName(),
      className: p.inst.className,
      position: p.position,
      size: p.size,
      anchored: !!p.inst.get('Anchored'),
      color: hex(p.inst.get('Color')),
    })),
  };
}

export function viewSvg(roots, { width = 900, height = 640, plane = 'xz', padding = 24 } = {}) {
  const cfg = PLANES[plane] || PLANES.xz;
  const parts = collectParts(roots);
  const header = `<?xml version="1.0" encoding="utf-8"?>`;

  if (parts.length === 0) {
    return `${header}\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#111"/>
  <text x="16" y="32" fill="#ddd" font-family="monospace" font-size="14">no BaseParts in scene</text>
</svg>\n`;
  }

  const uOf = (p) => p.position[cfg.u];
  const vOf = (p) => p.position[cfg.v];
  const huOf = (p) => Math.abs(p.size[cfg.u]) / 2;
  const hvOf = (p) => Math.abs(p.size[cfg.v]) / 2;

  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const p of parts) {
    minU = Math.min(minU, uOf(p) - huOf(p));
    maxU = Math.max(maxU, uOf(p) + huOf(p));
    minV = Math.min(minV, vOf(p) - hvOf(p));
    maxV = Math.max(maxV, vOf(p) + hvOf(p));
  }

  const spanU = Math.max(maxU - minU, 1e-3);
  const spanV = Math.max(maxV - minV, 1e-3);
  const scale = Math.min((width - padding * 2) / spanU, (height - padding * 2) / spanV);
  const sx = (u) => padding + (u - minU) * scale;
  const sy = (v) => padding + (v - minV) * scale;

  const rects = parts
    .map((p) => {
      const x = sx(uOf(p) - huOf(p));
      const y = sy(vOf(p) - hvOf(p));
      const w = Math.max(huOf(p) * 2 * scale, 1);
      const h = Math.max(hvOf(p) * 2 * scale, 1);
      const fill = hex(p.inst.get('Color'));
      const label = p.inst.name.replace(/[<>&"]/g, '');
      return `  <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${fill}" fill-opacity="0.85" stroke="#000" stroke-width="0.5"><title>${label} (${p.inst.className})</title></rect>`;
    })
    .join('\n');

  const legend = [
    `${parts.length} parts`,
    `plane ${plane}: ${cfg.label}`,
    `bounds u[${minU.toFixed(1)}, ${maxU.toFixed(1)}] v[${minV.toFixed(1)}, ${maxV.toFixed(1)}]`,
    `scale ${scale.toFixed(3)} px/stud`,
  ];

  return `${header}
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#111"/>
${rects}
  <g font-family="monospace" font-size="12" fill="#9fe">
${legend.map((l, i) => `    <text x="16" y="${20 + i * 15}">${l.replace(/[<>&]/g, '')}</text>`).join('\n')}
  </g>
</svg>
`;
}
