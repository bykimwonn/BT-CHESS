import type { SVGProps } from 'react';

const paths: Record<string, string> = {
  board: 'M3 4h18v16H3zM3 10h18M3 15h18M8 4v16M13 4v16M18 4v16M3 4l5 5m8 0 5-5M3 20l5-5m8 0 5 5',
  trophy: 'M7 4h10v4a5 5 0 0 1-10 0V4zM7 6H4v2a4 4 0 0 0 4 4m9-6h3v2a4 4 0 0 1-4 4M12 13v4m-4 3h8m-6-3h4',
  puzzle: 'M9 4h4a2 2 0 0 1 2 2v1h3v4h-1a2 2 0 0 0 0 4h1v5h-5v-1a2 2 0 0 0-4 0v1H4v-5h1a2 2 0 0 0 0-4H4V7h3V6a2 2 0 0 1 2-2z',
  book: 'M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 0-2 2V5zm2 12h12',
  analysis: 'M4 19V5m0 14h16M7 15l4-5 3 3 5-7',
  leaderboard: 'M5 20V10m7 10V4m7 16v-7M2 20h20',
  wallet: 'M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1h2v10h-2v1H5a2 2 0 0 1-2-2V7zm14 5h4v4h-4a2 2 0 0 1 0-4z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 8a8 8 0 0 1 16 0',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8.4-3a8.4 8.4 0 0 0-.1-1.3l2-1.5-2-3.4-2.4 1a8 8 0 0 0-2.2-1.3L15.3 3h-4l-.4 2.5a8 8 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.5a8.4 8.4 0 0 0 0 2.6l-2 1.5 2 3.4 2.4-1a8 8 0 0 0 2.2 1.3l.4 2.5h4l.4-2.5a8 8 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.5c.1-.4.1-.9.1-1.3z',
  help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm-2-7h4m-4-3a2 2 0 1 1 3-1.7c-.5.5-1 1-1 2v.2',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zm-3 9l2 2 4-4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0-13v-2m0 18v-2M4 12H2m20 0h-2M5.6 5.6 4.2 4.2m15.6 15.6 1.4 1.4m0-17-1.4 1.4M4.2 19.8l1.4-1.4',
  bell: 'M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9zm-8 12a2 2 0 0 0 4 0',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  copy: 'M8 8h12v12H8zM16 8V4H4v12h4',
  download: 'M12 3v12m-4-4 4 4 4-4M4 19h16',
  play: 'M8 5l11 7-11 7V5z',
  pause: 'M8 5h3v14H8zm5 0h3v14h-3z',
  arrowLeft: 'M15 5l-7 7 7 7',
  arrowRight: 'M9 5l7 7-7 7',
  first: 'M6 5v14M18 6l-8 6 8 6V6z',
  last: 'M18 5v14M6 6l8 6-8 6V6z',
  flag: 'M5 21V4m0 1h12l-2 4 2 4H5',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-15v5l3 2',
  check: 'M5 12l4 4L19 6',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-14h.01M11 12h1v5h1',
  external: 'M14 4h6v6m0-6-9 9M18 13v6H5V6h6',
  lock: 'M6 10h12v11H6zM9 10V7a3 3 0 0 1 6 0v3',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z',
};

export function Icon({ name, size = 20, ...props }: { name: keyof typeof paths | string; size?: number } & SVGProps<SVGSVGElement>) {
  const d = paths[name] ?? paths.info;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      <path d={d} />
    </svg>
  );
}
