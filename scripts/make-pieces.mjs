#!/usr/bin/env node
/**
 * Generates the chess piece set into public/pieces/.
 *
 * Custom Staunton-inspired silhouettes, hand-authored here (no CDN, no external
 * download - consistent with the app's vendored-asset policy). Pieces are built
 * from simple, reliable SVG geometry so they render identically in every
 * browser. White pieces: near-white fill with a dark outline; black pieces:
 * deep slate fill with a soft light outline.
 *
 * Output: 12 SVGs (wK,wQ,wR,wB,wN,wP + black).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'pieces');
fs.mkdirSync(OUT, { recursive: true });

const SW = 1.6;

// Each piece is drawn for the WHITE side (viewBox 0 0 45 45). Bodies use the
// inherited fill; outline strokes are inherited too.
const BODY = {
  // ---- King: cross + wide crown + flared base ----
  K: `
    <g stroke-linecap="round" stroke-linejoin="round">
      <rect x="21.6" y="2.2" width="1.8" height="8.4" rx="0.6"/>
      <rect x="18.6" y="4.6" width="7.8" height="1.8" rx="0.7"/>
      <path d="M14.5 37.4
               L14.5 33.6 C14.5 31.6 16 30.4 17.4 29.4
               C15.4 27.4 14.6 24.8 14.6 21.4
               C14.6 15.6 18 11.8 22.5 11.4
               C27 11.8 30.4 15.6 30.4 21.4
               C30.4 24.8 29.6 27.4 27.6 29.4
               C29 30.4 30.5 31.6 30.5 33.6
               L30.5 37.4 Z"/>
      <path d="M14.5 33.6 H30.5" fill="none"/>
      <path d="M12 40.4 H33 L31.4 37.4 H13.6 Z"/>
    </g>`,

  // ---- Queen: five-point coronet + bell body + base ----
  Q: `
    <g stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 15.5 L15.4 12.6 L22.5 10.4 L29.6 12.6 L36 15.5
               C35.4 21.5 32.6 26 29.2 28.6
               C31.6 30.4 33.4 32.6 33.4 35.2
               L11.6 35.2 C11.6 32.6 13.4 30.4 15.8 28.6
               C12.4 26 9.6 21.5 9 15.5 Z"/>
      <circle cx="9" cy="14.2" r="1.7"/>
      <circle cx="15.4" cy="10.6" r="1.7"/>
      <circle cx="22.5" cy="8.2" r="1.9"/>
      <circle cx="29.6" cy="10.6" r="1.7"/>
      <circle cx="36" cy="14.2" r="1.7"/>
      <path d="M11.8 22.6 H33.2" fill="none" stroke-width="${SW * 0.8}"/>
      <path d="M12.4 29.6 H32.6" fill="none" stroke-width="${SW * 0.8}"/>
      <path d="M11.6 35.2 H33.4" fill="none"/>
      <path d="M10.6 40.4 H34.4 L33 35.2 H12 Z"/>
    </g>`,

  // ---- Rook: crenellated tower (kept) ----
  R: `
    <g stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 39.6 H34 V35.8 C31.5 34.8 30.4 33.6 30.4 32 V14.2 H33.4 V10.6 H30.4 V7.4 H27.4 V10.6 H23.9 V7.4 H21.1 V10.6 H17.6 V7.4 H14.6 V10.6 H11.6 V14.2 H14.6 V32
               C14.6 33.6 13.5 34.8 11 35.8 Z"/>
    </g>`,

  // ---- Bishop: mitre with slit, collar and base ----
  B: `
    <g stroke-linecap="round" stroke-linejoin="round">
      <path d="M22.5 7.6
               C27.2 7.6 30.2 12.2 30.2 18.6
               C30.2 24.2 27.6 28.2 22.5 29
               C17.4 28.2 14.8 24.2 14.8 18.6
               C14.8 12.2 17.8 7.6 22.5 7.6 Z"/>
      <circle cx="22.5" cy="8.6" r="1.7"/>
      <path d="M18.6 15.4 L26.4 23.2" fill="none"/>
      <path d="M15.6 30.6 H29.4 L30.6 33.4 H14.4 Z"/>
      <path d="M13.2 39.8 H31.8 L30.4 33.4 H14.6 Z"/>
    </g>`,

  // ---- Knight: horse head facing left ----
  N: `
    <g stroke-linecap="round" stroke-linejoin="round">
      <path d="M21.5 9
               C17.5 9 14.6 11.2 13.2 14.6
               C12 17.6 12 21 12.6 24
               C12.9 25.6 13.4 27 14.2 28.2
               L11.8 30.4
               C11.2 31 11.4 31.9 12.3 32.2
               C13 32.5 13.7 32.4 14.3 32.2
               L19 30.4
               H31
               C32 30.4 32.9 29.9 33 29
               C33 28.3 32.6 27.8 32 27.6
               C32.5 26.8 32.3 25.8 31.4 25.3
               C30.9 25 30.3 25 29.8 25.2
               C29.6 23.2 28.7 21.5 27.2 20.2
               C27.6 19.3 27.5 18.3 26.8 17.6
               C26.1 16.9 25 16.8 24.3 17.4
               C23.8 15.3 22.7 13.3 21 11.7
               C19.6 10.4 18 9.6 16.2 9.3
               C18 8.4 19.8 8.4 21.5 9 Z"/>
      <circle cx="15.4" cy="16" r="1.15" fill="#f8fafc" stroke="none"/>
    </g>`,

  // ---- Pawn (kept) ----
  P: `
    <g stroke-linecap="round" stroke-linejoin="round">
      <path d="M22.5 9 c-2.1 0-3.7 1.7-3.7 3.7 c0 1.4.8 2.7 2.1 3.3
               c-3.1.7-5.6 3.3-5.6 6.6 c0 1.9.8 3.6 2 4.8
               c-1.5.6-2.5 1.8-2.5 3.3 c0 1.1.5 2 1.3 2.6
               c-1.3.6-2.1 1.7-2.1 2.9 c0 2.1 2.9 3.4 8.5 3.4
               s8.5-1.3 8.5-3.4 c0-1.2-.8-2.3-2.1-2.9
               c.8-.6 1.3-1.5 1.3-2.6 c0-1.5-1-2.7-2.5-3.3
               c1.2-1.2 2-2.9 2-4.8 c0-3.3-2.5-5.9-5.6-6.6
               c1.3-.6 2.1-1.9 2.1-3.3 c0-2-1.6-3.7-3.7-3.7 z"/>
    </g>`,
};

function svg(body, { fill, stroke }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45" width="45" height="45" fill="${fill}" stroke="${stroke}" stroke-width="${SW}">${body}</svg>`;
}

const WHITE = { fill: '#f8fafc', stroke: '#1e293b' };
const BLACK = { fill: '#16213a', stroke: '#5b6b85' };

for (const piece of Object.keys(BODY)) {
  fs.writeFileSync(path.join(OUT, `w${piece}.svg`), svg(BODY[piece], WHITE));
  fs.writeFileSync(path.join(OUT, `b${piece}.svg`), svg(BODY[piece], BLACK));
}
console.log(`[pieces] wrote ${Object.keys(BODY).length * 2} SVGs to ${OUT}`);
