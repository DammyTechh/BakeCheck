/**
 * Inline icon geometry.
 *
 * These were an icon *font* (Material Symbols Rounded, loaded from Google
 * Fonts). That failed badly in exactly the conditions this product runs in: a
 * laboratory on a slow or filtered connection. Until the font arrives the
 * browser renders the ligature as literal text, so buttons read
 * "photo_camera" and "fact_check" instead of showing an icon — and if the
 * request is blocked outright, they stay that way.
 *
 * Drawn as SVG, an icon is part of the bundle. It cannot half-load, costs no
 * request, and stays sharp at any size. Everything is one 24×24 grid with a
 * single stroke weight, which is what keeps the set looking like one family.
 *
 * Every icon in this app sits beside its own text label, so none of them
 * carry meaning on their own.
 */

export interface IconDef {
  /** Path `d` strings, stroked unless `fill` is set. */
  paths: string[];
  /** [cx, cy, r] circles, stroked alongside the paths. */
  circles?: Array<[number, number, number]>;
  /** Fill the paths instead of stroking them (used for solid marks). */
  fill?: boolean;
}

export const ICONS: Record<string, IconDef> = {
  // ── Navigation and structure ───────────────────────────────────────────
  dashboard: { paths: ['M4 4h7v6H4z', 'M14 4h6v4h-6z', 'M14 12h6v8h-6z', 'M4 14h7v6H4z'] },
  science: { paths: ['M9 3v6.5L4.6 17A2 2 0 0 0 6.3 20h11.4a2 2 0 0 0 1.7-3L15 9.5V3', 'M8 3h8', 'M7.5 14h9'] },
  lab_profile: { paths: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h4'] },
  settings: {
    paths: [
      'M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
    ],
    circles: [[12, 12, 3]],
  },
  apartment: { paths: ['M4 21V6l7-3v18', 'M11 10h9v11', 'M14 14h3', 'M14 17.5h3', 'M7 10h1', 'M7 14h1'] },
  group: { paths: ['M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20', 'M20 20v-1.5a3.5 3.5 0 0 0-2.6-3.4'], circles: [[10, 8, 3.2], [16.5, 8, 2.6]] },
  model_training: { paths: ['M20 12a8 8 0 1 1-2.4-5.7', 'M20 4v3.5h-3.5', 'M9 15v-2.5', 'M12 15v-5', 'M15 15v-3.5'] },
  dataset: { paths: ['M4 6c0-1.4 3.6-2.5 8-2.5s8 1.1 8 2.5-3.6 2.5-8 2.5S4 7.4 4 6z', 'M4 6v12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V6', 'M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5'] },
  monitoring: { paths: ['M4 19V5', 'M4 19h16', 'M7.5 15.5l3.5-4 3 2.5 4.5-5.5'] },
  inventory_2: { paths: ['M3 3.5h18v3.5H3z', 'M4.5 7v13.5h15V7', 'M10 11h4'] },
  biotech: {
    paths: [
      'M6 20.5h11',
      'M9.5 20.5a5.5 5.5 0 0 0 5.2-7.2',
      'M10.1 5.5l2.8-1.6 2.2 3.8-2.8 1.6z',
      'M13.1 10.1l1.1 1.9',
      'M8.9 7.4l1.2-1.9',
    ],
  },

  // ── Actions ────────────────────────────────────────────────────────────
  add: { paths: ['M12 5v14', 'M5 12h14'] },
  upload: { paths: ['M12 16V4', 'M8 8l4-4 4 4', 'M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2'] },
  photo_camera: { paths: ['M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z'], circles: [[12, 13, 3.4]] },
  add_a_photo: { paths: ['M20 11v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1h3l1.5-2h5', 'M18 3v6', 'M15 6h6'], circles: [[11.5, 13.5, 3.2]] },
  colorize: { paths: ['M14.5 4.5l5 5', 'M16 3l5 5-2 2-5-5z', 'M13 7l4 4-7.5 7.5L4 20l1.5-5.5z'] },
  print: { paths: ['M7 9V4h10v5', 'M7 18H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2', 'M7 15h10v6H7z'] },
  search: { paths: ['M20 20l-3.5-3.5'], circles: [[11, 11, 6.5]] },
  logout: { paths: ['M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8', 'M17 15l4-3-4-3', 'M21 12H10'] },
  close: { paths: ['M6 6l12 12', 'M18 6L6 18'] },
  arrow_forward: { paths: ['M4 12h15', 'M13 6l6 6-6 6'] },
  chevron_right: { paths: ['M9 5l7 7-7 7'] },
  chevron_left: { paths: ['M15 5l-7 7 7 7'] },
  rate_review: { paths: ['M20 4H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4v4l4-4h8a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1z', 'M8.5 10.5h7', 'M8.5 13.5h4'] },
  fact_check: { paths: ['M4 5h16v14H4z', 'M7.5 9h5', 'M7.5 12.5h3', 'M14 15l1.75 1.75L19 13.5'] },
  pending_actions: { paths: ['M9 4h6v2H9z', 'M15 5h3v6', 'M9 5H6v15h6', 'M12.5 9H6', 'M9.5 12.5H6', 'M17 14v2.5l1.75 1'], circles: [[17, 16.5, 4.5]] },

  // ── States and feedback ────────────────────────────────────────────────
  check: { paths: ['M5 12.5l4.5 4.5L19 7.5'] },
  check_circle: { paths: ['M8.5 12.2l2.5 2.5 4.8-5'], circles: [[12, 12, 8.5]] },
  info: { paths: ['M12 11.5v5', 'M12 8.2v.1'], circles: [[12, 12, 8.5]] },
  error: { paths: ['M12 7.5v5', 'M12 15.8v.1'], circles: [[12, 12, 8.5]] },
  warning: { paths: ['M12 4.5L2.8 20h18.4z', 'M12 10v4.2', 'M12 17.2v.1'] },
  broken_image: { paths: ['M4 5h16v14H4z', 'M4 14l3.5-3 3 2.5', 'M13.5 19l3-3.5 3.5 3'] },
  cloud_off: { paths: ['M4 4l16 16', 'M7.5 8.2A5 5 0 0 0 7 18h9.5', 'M9.8 5.3A5 5 0 0 1 17 9.4a3.8 3.8 0 0 1 2.9 5.5'] },
  search_off: { paths: ['M20 20l-3.5-3.5', 'M8.5 8.5l5 5', 'M13.5 8.5l-5 5'], circles: [[11, 11, 6.5]] },
  explore_off: { paths: ['M4 4l16 16', 'M8.4 4.9A8.5 8.5 0 0 1 19.1 15.6', 'M16.6 19.4A8.5 8.5 0 0 1 4.6 7.4', 'M14.5 9.5l-1.6 3.9'] },

  // ── Form fields ────────────────────────────────────────────────────────
  email: { paths: ['M3 6h18v12H3z', 'M3 7l9 6.5L21 7'] },
  password: { paths: ['M7 10V7.5a5 5 0 0 1 10 0V10', 'M5 10h14v10H5z', 'M12 14v2.5'] },
};

/**
 * Drawn when a name is not in the set, so a typo shows a neutral mark
 * rather than an empty gap or a crash.
 */
export const FALLBACK_ICON: IconDef = ICONS.info!;
