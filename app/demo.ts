// A fictional library so a fresh install is watchable with no account (gate A1).
// Every show, title and episode name here is invented for DebridTV. Demo items have
// no media at all: the browser paints a synthetic picture, so the demo costs zero
// provider traffic while exercising the real clock, guide, breaks and tuning.

import type { LibItem } from "./library.ts";
import { parseName } from "../src/library/parse.ts";
import { mulberry32, hash32 } from "../src/clock/rng.ts";

const MIN = 60_000;

interface DemoShow {
  name: string;
  seasons: number;
  perSeason: number;
  minutes: [number, number];
  genre: string;
}

const SHOWS: DemoShow[] = [
  { name: "Harbor Lights", seasons: 3, perSeason: 8, minutes: [21, 23], genre: "Sitcom" },
  { name: "The Night Desk", seasons: 2, perSeason: 10, minutes: [42, 46], genre: "Newsroom drama" },
  { name: "Saturday Robots", seasons: 2, perSeason: 13, minutes: [11, 12], genre: "Cartoon" },
  { name: "Kitchen Table", seasons: 2, perSeason: 8, minutes: [23, 25], genre: "Cooking" },
  { name: "Weathervane Mysteries", seasons: 1, perSeason: 10, minutes: [44, 48], genre: "Mystery" },
  { name: "Pocket Planet", seasons: 1, perSeason: 8, minutes: [48, 52], genre: "Nature" },
  { name: "Mall Rats Anonymous", seasons: 2, perSeason: 9, minutes: [21, 22], genre: "Sitcom" },
  { name: "Star Courier", seasons: 2, perSeason: 8, minutes: [43, 45], genre: "Sci-fi" },
];

const MOVIES: Array<[string, number, number]> = [
  ["The Long Signal", 1987, 104],
  ["Neon Harbor", 1989, 97],
  ["Paper Rockets", 1984, 92],
  ["Cassette Hearts", 1986, 101],
  ["Static Summer", 1992, 96],
  ["Ferris Wheel at Midnight", 1995, 109],
  ["Lighthouse Radio", 1998, 99],
  ["The Velvet Antenna", 1991, 112],
  ["Rollerdisco Requiem", 1988, 94],
  ["Arcade of Tomorrow", 1983, 89],
  ["Polaroid Coast", 1996, 103],
];

const WORDS_A = ["The", "A", "One", "Last", "Big", "Little", "Lost", "Secret", "Second", "Long", "Late"];
const WORDS_B = ["Pilot", "Storm", "Recipe", "Signal", "Rerun", "Blackout", "Visitor", "Deadline", "Detour", "Reunion", "Heist",
  "Snow Day", "Interview", "Telethon", "Rival", "Shortcut", "Lighthouse", "Parade", "Wager", "Map", "Tape", "Frequency", "Broadcast"];

export function demoItems(): LibItem[] {
  const items: LibItem[] = [];
  for (const s of SHOWS) {
    const rand = mulberry32(hash32(s.name));
    for (let season = 1; season <= s.seasons; season++)
      for (let ep = 1; ep <= s.perSeason; ep++) {
        const file = `${s.name.replaceAll(" ", ".")}.S${pad(season)}E${pad(ep)}.mkv`;
        const minutes = s.minutes[0] + rand() * (s.minutes[1] - s.minutes[0]);
        const title = ep === 1 && season === 1 ? "Pilot" : `${pick(WORDS_A, rand)} ${pick(WORDS_B, rand)}`;
        items.push(make(file, Math.round(minutes * MIN + rand() * 30_000), { subtitle: title, genre: s.genre }));
      }
  }
  for (const [title, year, minutes] of MOVIES) {
    const file = `${title.replaceAll(" ", ".")}.${year}.mkv`;
    items.push(make(file, minutes * MIN + 17_000, { genre: "Feature film" }));
  }
  return items;
}

function make(name: string, durationMs: number, extra: { subtitle?: string; genre: string }): LibItem & { subtitle?: string; genre: string } {
  return {
    id: `demo-${hash32(name).toString(36)}`,
    provider: "demo",
    ref: name,
    name,
    bytes: 0,
    providerState: "demo",
    parsed: parseName(name),
    durationMs,
    container: "synthetic",
    availability: "playable",
    present: true,
    ...extra,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
const pick = <T>(xs: T[], rand: () => number) => xs[Math.floor(rand() * xs.length)]!;
