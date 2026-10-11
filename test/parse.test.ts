import { test } from "node:test";
import assert from "node:assert/strict";
import { parseName } from "../src/library/parse.ts";
import type { Parsed } from "../src/library/parse.ts";

type Case = [name: string, path: string, expected: Parsed];

const ep = (show: string, showKey: string, season: number, episode: number, extra: Record<string, unknown> = {}): Parsed =>
  ({ kind: "episode", show, showKey, season, episode, ...extra }) as Parsed;
const mv = (title: string, titleKey: string, year?: number): Parsed =>
  (year === undefined ? { kind: "movie", title, titleKey } : { kind: "movie", title, titleKey, year });
const other = (reason: "not-video" | "sample" | "extra" | "unknown"): Parsed => ({ kind: "other", reason });

const cases: Case[] = [
  // scene episodes
  ["scene episode", "Show.Name.S01E02.720p.HDTV.x264-GRP.mkv", ep("Show Name", "show name", 1, 2)],
  ["lowercase short s1e2", "show.name.s1e2.mkv", ep("show name", "show name", 1, 2)],
  ["web-dl release", "The.Last.of.Us.S01E05.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv", ep("The Last of Us", "the last of us", 1, 5)],
  ["underscores", "Some_Show_S03E10_720p.mp4", ep("Some Show", "some show", 3, 10)],
  ["spaces and episode title", "Breaking Bad - S05E14 - Ozymandias.mkv", ep("Breaking Bad", "breaking bad", 5, 14)],
  ["year in show name", "Doctor.Who.2005.S01E01.Rose.720p.mkv", ep("Doctor Who", "doctor who", 1, 1, { year: 2005 })],
  ["numeric show 9-1-1", "9-1-1.S05E03.720p.HDTV.mkv", ep("9-1-1", "9 1 1", 5, 3)],
  ["numeric show 24", "24.S08E24.720p.mkv", ep("24", "24", 8, 24)],
  ["apostrophe and ampersand", "Grey's.Anatomy.S17E01.mkv", ep("Grey's Anatomy", "greys anatomy", 17, 1)],
  ["three-digit episode", "Show.S02E101.mkv", ep("Show", "show", 2, 101)],
  ["season zero", "Show.Name.S00E03.Special.mkv", ep("Show Name", "show name", 0, 3)],
  // alternate numbering
  ["1x02 format", "Show Name 1x02 Title.avi", ep("Show Name", "show name", 1, 2)],
  ["1x02 with dots", "Show.Name.2x13.HDTV.mkv", ep("Show Name", "show name", 2, 13)],
  ["Season N Episode N", "Show Name Season 2 Episode 5.mkv", ep("Show Name", "show name", 2, 5)],
  ["Season.N.Episode.N dotted", "Show.Name.Season.1.Episode.12.mp4", ep("Show Name", "show name", 1, 12)],
  // multi-episode
  ["double episode E01E02", "Show.Name.S01E01E02.720p.mkv", ep("Show Name", "show name", 1, 1, { episodeEnd: 2 })],
  ["double episode E01-E02", "Show.Name.S01E01-E02.mkv", ep("Show Name", "show name", 1, 1, { episodeEnd: 2 })],
  ["triple episode", "Show.Name.S04E05E06E07.mkv", ep("Show Name", "show name", 4, 5, { episodeEnd: 7 })],
  ["range without E", "Show.Name.S01E03-04.mkv", ep("Show Name", "show name", 1, 3, { episodeEnd: 4 })],
  ["resolution is not a range", "Show.Name.S01E03-720p.mkv", ep("Show Name", "show name", 1, 3)],
  // folders
  [
    "folder layout with season",
    "Show Name (2004)/Season 01/Show.Name.S01E02.720p.mkv",
    ep("Show Name", "show name", 1, 2, { year: 2004 }),
  ],
  [
    "title only from folder",
    "Severance (2022)/Season 2/S02E03.mkv",
    ep("Severance", "severance", 2, 3, { year: 2022 }),
  ],
  [
    "title from folder, 1x02 name",
    "Fringe/Season 3/3x04 - Amber 31422.mkv",
    ep("Fringe", "fringe", 3, 4),
  ],
  [
    "episode-only name uses season folder",
    "Shows/The Wire/Season 4/Episode 05.mkv",
    ep("The Wire", "the wire", 4, 5),
  ],
  [
    "pack folder with release junk",
    "Show.Name.S02.1080p.BluRay.x264-GRP/Show.Name.S02E04.mkv",
    ep("Show Name", "show name", 2, 4),
  ],
  [
    "windows separators",
    "Show Name (2010)\\Season 03\\Show.Name.S03E01.mkv",
    ep("Show Name", "show name", 3, 1, { year: 2010 }),
  ],
  ["nested root folders ignored", "TV/Dark/Season 1/S01E01.mkv", ep("Dark", "dark", 1, 1)],
  // anime
  [
    "anime fansub",
    "[SubsPlease] Frieren - Beyond Journey's End - 12 (1080p) [ABCD1234].mkv",
    ep("Frieren - Beyond Journey's End", "frieren beyond journeys end", 1, 12, { absolute: true }),
  ],
  ["anime brackets", "[Group] Show Name - 12 [1080p].mkv", ep("Show Name", "show name", 1, 12, { absolute: true })],
  ["anime with version", "[Group] Show Name - 07v2 [720p][HEVC].mkv", ep("Show Name", "show name", 1, 7, { absolute: true })],
  ["anime three digits", "[Group] Long Runner - 123 [1080p].mkv", ep("Long Runner", "long runner", 1, 123, { absolute: true })],
  ["anime with S2 marker", "[Group] Show Name S2 - 05 [1080p].mkv", ep("Show Name", "show name", 2, 5)],
  ["anime with SxxExx still season-based", "[Group] Show Name S01E03 [1080p].mkv", ep("Show Name", "show name", 1, 3)],
  // movies
  ["scene movie", "The.Matrix.1999.1080p.BluRay.x264-GRP.mkv", mv("The Matrix", "the matrix", 1999)],
  ["paren year", "Inception (2010).mkv", mv("Inception", "inception", 2010)],
  ["paren year with tags", "Inception (2010) 1080p BluRay.mkv", mv("Inception", "inception", 2010)],
  ["leading-number title", "2001 A Space Odyssey 1968.mkv", mv("2001 A Space Odyssey", "2001 a space odyssey", 1968)],
  ["leading-number scene", "2001.A.Space.Odyssey.1968.1080p.BluRay.x264.mkv", mv("2001 A Space Odyssey", "2001 a space odyssey", 1968)],
  ["number in title with paren year", "Blade Runner 2049 (2017).mkv", mv("Blade Runner 2049", "blade runner 2049", 2017)],
  ["number in title, scene", "Blade.Runner.2049.2017.2160p.UHD.BluRay.x265.mkv", mv("Blade Runner 2049", "blade runner 2049", 2017)],
  ["future number is not a year", "Blade Runner 2049 1080p.mkv", mv("Blade Runner 2049", "blade runner 2049")],
  ["title that is a year", "1917.2019.1080p.WEB-DL.mkv", mv("1917", "1917", 2019)],
  ["2012", "2012 (2009).mp4", mv("2012", "2012", 2009)],
  ["movie without year", "Some Obscure Movie 720p.avi", mv("Some Obscure Movie", "some obscure movie")],
  ["bare title", "Memento.mkv", mv("Memento", "memento")],
  ["movie in folder with year", "Movies/Heat (1995)/Heat.1080p.BluRay.mkv", mv("Heat", "heat", 1995)],
  ["generic file name, folder title", "Parasite (2019)/movie.mkv", mv("Parasite", "parasite", 2019)],
  ["web-dl tag cuts title", "Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.Atmos.mkv", mv("Dune Part Two", "dune part two", 2024)],
  ["web in title is preserved", "Charlottes.Web.2006.720p.mkv", mv("Charlottes Web", "charlottes web", 2006)],
  ["ampersand key", "Law & Order (1990).mkv", mv("Law & Order", "law and order", 1990)],
  // not video
  ["nfo", "Show.Name.S01E02.720p.nfo", other("not-video")],
  ["srt", "Show Name/Season 1/Show.Name.S01E02.en.srt", other("not-video")],
  ["rar", "Movie.2010.1080p.rar", other("not-video")],
  ["r00 part", "Movie.2010.1080p.r00", other("not-video")],
  ["no extension", "README", other("not-video")],
  ["jpg", "poster.jpg", other("not-video")],
  // samples
  ["sample token", "movie-sample.mkv", other("sample")],
  ["Sample file", "Sample.mkv", other("sample")],
  ["sample episode", "Show.Name.S01E02.720p.sample.mkv", other("sample")],
  ["sample folder", "Movie.2010.1080p/Sample/movie.mkv", other("sample")],
  ["Samples folder", "Show/Samples/Show.S01E01.mkv", other("sample")],
  // extras
  ["extras folder", "Movie (2010)/Extras/Making Of.mkv", other("extra")],
  ["featurettes folder", "Movie (2010)/Featurettes/The Look.mkv", other("extra")],
  ["trailer token", "Movie (2010)-trailer.mp4", other("extra")],
  ["behind the scenes token", "Movie.2010.Behind.The.Scenes.mkv", other("extra")],
  ["deleted scenes folder", "Movie (2010)/Deleted Scenes/Scene 1.mkv", other("extra")],
  ["show named like an extra keeps episode", "Trailer.Park.Boys.S01E01.mkv", ep("Trailer Park Boys", "trailer park boys", 1, 1)],
  ["Extras (the show)", "Extras.S01E01.mkv", ep("Extras", "extras", 1, 1)],
  // extensions
  ["m2ts", "Show.S01E01.1080p.m2ts", ep("Show", "show", 1, 1)],
  ["uppercase ext", "SHOW.S01E01.MKV", ep("SHOW", "show", 1, 1)],
  ["webm", "Clip.2020.webm", mv("Clip", "clip", 2020)],
  ["empty", "", other("unknown")],
];

for (const [name, path, expected] of cases) {
  test(`parse: ${name}`, () => {
    assert.deepEqual(parseName(path), expected);
  });
}

test("parse: case count is substantial", () => {
  assert.ok(cases.length >= 40);
});

test("parse: showKey ignores year and punctuation so shows group together", () => {
  const a = parseName("Doctor.Who.2005.S01E01.mkv");
  const b = parseName("Doctor Who (2005)/Season 2/Doctor.Who.S02E01.mkv");
  const c = parseName("DOCTOR_WHO_s03e01.mkv");
  assert.ok(a.kind === "episode" && b.kind === "episode" && c.kind === "episode");
  assert.equal(a.showKey, b.showKey);
  assert.equal(b.showKey, c.showKey);
});
