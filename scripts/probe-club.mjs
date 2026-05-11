#!/usr/bin/env node
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve('/Users/sraths/Desktop/windsurf Projects/character-forge/public/assets/lpc/weapon/club.png');
const OUT = '/tmp/club-frames64';
const CELL = 64;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const png = readFileSync(SRC);
const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

await page.setContent(`<canvas id="c" width="${CELL}" height="${CELL}"></canvas>`);
const cells = await page.evaluate(async ({ dataUrl, CELL }) => {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve; img.onerror = reject; img.src = dataUrl;
  });
  const out = [];
  const cols = Math.floor(img.naturalWidth / CELL);
  const rows = Math.floor(img.naturalHeight / CELL);
  const c = document.getElementById('c');
  const ctx = c.getContext('2d');
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      ctx.clearRect(0, 0, CELL, CELL);
      ctx.drawImage(img, col * CELL, r * CELL, CELL, CELL, 0, 0, CELL, CELL);
      const data = ctx.getImageData(0, 0, CELL, CELL).data;
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque++;
      out.push({ row: r, col, opaque, png: c.toDataURL('image/png') });
    }
  }
  return { width: img.naturalWidth, height: img.naturalHeight, cols, rows, cells: out };
}, { dataUrl, CELL });

console.log(`club.png is ${cells.width}×${cells.height} = ${cells.cols} cols × ${cells.rows} rows of ${CELL}×${CELL} cells`);
const opaqueCells = cells.cells.filter(c => c.opaque >= 20 && c.opaque <= 200);
console.log(`Cells with 20–200 opaque pixels (likely just blade): ${opaqueCells.length} / ${cells.cells.length}`);
for (const cell of opaqueCells) {
  const filename = `${OUT}/club-r${String(cell.row).padStart(2,'0')}-c${String(cell.col).padStart(2, '0')}-op${cell.opaque}.png`;
  const b64 = cell.png.split(',')[1];
  writeFileSync(filename, Buffer.from(b64, 'base64'));
}
console.log(`Wrote ${opaqueCells.length} files to ${OUT}/`);

await browser.close();
