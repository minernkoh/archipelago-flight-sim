# Archipelago Flight Sim

A browser flight simulator built with **Three.js** — 5 aircraft, a procedural archipelago plus a stylized Singapore, ring races, and a PPL-style flight school.

## Features

- **5 flyable aircraft** with distinct handling.
- **Procedural archipelago** terrain plus a stylized Singapore.
- **Ring races** — timed courses through floating gates.
- **Flight school** — PPL-style guided lessons.

## Getting started

```bash
npm install
npm run serve      # → http://localhost:8123
```

## Development

```bash
npm test           # physics tests
node test/e2e.mjs  # end-to-end test
```

## Layout

```
index.html
src/            # simulator source (aircraft, terrain, races, flight school)
test/           # physics + e2e tests
package.json
```

## Status

Personal project, actively developed. See `CLAUDE.md` for the current phase roadmap.
