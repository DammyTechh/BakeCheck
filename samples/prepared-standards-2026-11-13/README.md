# Prepared standards, 13 November 2026

Fifteen photographs of prepared standards of known concentration, supplied by
the laboratory. Each file is named for its concentration in ppm.

These are what the reference chart is built from. Every colour in
`database/seeds/reference-chart-bromate-illustrative.json` was measured from
the file of the same name.

## How the colour was taken

Each frame was white balanced against the sheet of paper behind the tube —
the only colour reference present — then the liquid column was sampled and
the median taken, with the brightest decile dropped because that is glare off
curved glass. Values are CIELAB under D65, matching the matcher's own
conversion.

## What these do not establish

**Controlled photography.** The shots were taken at different times, by
different hands, under different light, with no grey card in any frame. The
paper correction is partial. Two consequences are visible in the data:

- 200, 250, 350 and 500 ppm each photographed *lighter* than the level below
  them;
- 20/30, 50/100 and 400/500 sit within ΔE2000 5 of each other, close to
  indistinguishable.

Both track the shooting conditions rather than the dilution series, so the
chart stays `ILLUSTRATIVE` until the set is re-shot.

**450 ppm.** No standard was supplied, so the chart has no level for it.

## Re-shooting them

One session, one camera, fixed lighting, a grey card in every frame, all
sixteen concentrations. Then:

```bash
python3 infrastructure/scripts/extract_reference_colors.py <folder> <out>
```

and mark the chart `VALIDATED`.
