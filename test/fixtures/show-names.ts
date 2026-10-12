// Release names that real libraries hold for one show under many spellings, and
// pairs that look alike but are different shows. Used by test/identity.test.ts and
// by `DEBRIDTV_MOCK_SHOWS=1 npm run dev:mock` (On Demand screenshots).
//
// `show` is the name the show should end up under; `season`/`episode` where it
// lands. Names are made up in the style of public release names: no real files.

export interface NameCase {
  name: string;
  show: string;
  season: number;
  episode: number;
}

const c = (name: string, show: string, season: number, episode: number): NameCase => ({ name, show, season, episode });

/** One show each, whatever the spelling. Checked offline (no TMDB). */
export const SAME_SHOW: NameCase[] = [
  // Spacing, case and release tags
  c("[SubsPlease] Dandadan - 01 (1080p) [A1B2C3D4].mkv", "Dan Da Dan", 1, 1),
  c("Dan.Da.Dan.S01E02.1080p.WEB.H264-VARYG.mkv", "Dan Da Dan", 1, 2),
  c("DAN DA DAN - S01E03 - MULTi 1080p WEB x264.mkv", "Dan Da Dan", 1, 3),
  c("[Erai-raws] Dandadan 2nd Season - 01 [1080p][Multiple Subtitle].mkv", "Dan Da Dan", 2, 1),
  c("Dan Da Dan Season 2/Dan.Da.Dan.S02E02.1080p.mkv", "Dan Da Dan", 2, 2),
  // A known subtitle that is the same show
  c("Arcane.S01E01.Welcome.to.the.Playground.1080p.NF.WEB-DL.DDP5.1.x264.mkv", "Arcane", 1, 1),
  c("Arcane.League.of.Legends.S01E02.2160p.WEB.H265-GLHF.mkv", "Arcane", 1, 2),
  c("Arcane (2021)/Season 2/Arcane - S02E01 - Heavy Is the Crown.mkv", "Arcane", 2, 1),
  // Arcs that are seasons (JoJo's parts), English and romaji, a typo ("Adventures")
  c("JoJo's Bizarre Adventure (2012) - S01E01 - Dio the Invader.mkv", "JoJo's Bizarre Adventure", 1, 1),
  c("JoJos.Bizarre.Adventure.S01E02.720p.BluRay.x264.mkv", "JoJo's Bizarre Adventure", 1, 2),
  c("[HorribleSubs] JoJo's Bizarre Adventure - Stardust Crusaders - 05 [720p].mkv", "JoJo's Bizarre Adventure", 2, 5),
  c("JOJO'S BIZARRE ADVENTURES - STARDUST CRUSADERS JOJO NO KIMYOU NA BOUKEN - STARDUST CRUSADERS (2014) [1080p]/Episode 03.mkv", "JoJo's Bizarre Adventure", 2, 3),
  c("[Coalgirls] JoJo no Kimyou na Bouken - Ougon no Kaze - 02 (1920x1080 Blu-ray FLAC).mkv", "JoJo's Bizarre Adventure", 4, 2),
  c("[DB] JoJo's Bizarre Adventure - Battle Tendency - 01 [Dual Audio 10bit 1080p].mkv", "JoJo's Bizarre Adventure", 1, 10),
  c("JoJo's Bizarre Adventure - Stone Ocean - S01E04 - 1080p WEB.mkv", "JoJo's Bizarre Adventure", 5, 4),
  // Romaji and English titles
  c("[SubsPlease] Sousou no Frieren - 01 (1080p) [5E1A2B3C].mkv", "Frieren: Beyond Journey's End", 1, 1),
  c("Frieren.Beyond.Journeys.End.S01E02.1080p.CR.WEB-DL.AAC2.0.H.264-VARYG.mkv", "Frieren: Beyond Journey's End", 1, 2),
  c("[ASW] Shingeki no Kyojin - The Final Season - 01 [1080p HEVC].mkv", "Attack on Titan", 4, 1),
  c("Attack.on.Titan.S01E01.To.You.in.2000.Years.1080p.BluRay.mkv", "Attack on Titan", 1, 1),
  c("Attack on Titan Season 3/Attack.on.Titan.S03E01.mkv", "Attack on Titan", 3, 1),
  c("[Judas] Kimetsu no Yaiba - S01E01.mkv", "Demon Slayer: Kimetsu no Yaiba", 1, 1),
  c("Demon.Slayer.Kimetsu.no.Yaiba.S01E02.1080p.mkv", "Demon Slayer: Kimetsu no Yaiba", 1, 2),
  c("[SubsPlease] Kimetsu no Yaiba - Yuukaku-hen - 01 (1080p).mkv", "Demon Slayer: Kimetsu no Yaiba", 2, 8),
  c("[SubsPlease] Boku no Hero Academia - 01 (1080p).mkv", "My Hero Academia", 1, 1),
  c("My.Hero.Academia.S01E02.1080p.mkv", "My Hero Academia", 1, 2),
  // Typos, "The", articles and punctuation
  c("Breaking.Bad.S01E01.Pilot.720p.BluRay.mkv", "Breaking Bad", 1, 1),
  c("Braking.Bad.S01E02.720p.mkv", "Breaking Bad", 1, 2),
  c("breaking_bad_s01e03.avi", "Breaking Bad", 1, 3),
  c("The.Office.US.S01E01.720p.mkv", "The Office (US)", 1, 1),
  c("The Office (US) - S01E02 - Diversity Day.mkv", "The Office (US)", 1, 2),
  c("Office.US.S02E01.mkv", "The Office (US)", 2, 1),
  c("Better.Call.Saul.S01E01.mkv", "Better Call Saul", 1, 1),
  c("Better Caul Saul S01E02 1080p.mkv", "Better Call Saul", 1, 2),
  c("Spider-Man.The.Animated.Series.S01E01.mkv", "Spider-Man The Animated Series", 1, 1),
  c("Spiderman The Animated Series - 1x02.mkv", "Spider-Man The Animated Series", 1, 2),
  // Pack names full of noise
  c("Avatar.The.Last.Airbender.COMPLETE.SERIES.1080p.BluRay.Dual.Audio/Book 1/Avatar.The.Last.Airbender.S01E01.mkv", "Avatar The Last Airbender", 1, 1),
  c("Avatar - The Last Airbender (2005) Season 1-3 S01-S03 Complete Batch/Avatar - The Last Airbender - 1x02.mkv", "Avatar The Last Airbender", 1, 2),
];

/** Each pair looks alike but is two shows. */
export const DIFFERENT_SHOWS: Array<[string, string]> = [
  ["Battlestar.Galactica.1978.S01E01.mkv", "Battlestar.Galactica.2004.S01E01.mkv"],
  ["Shogun.1980.S01E01.mkv", "Shogun.2024.S01E01.mkv"],
  ["Doctor.Who.1963.S01E01.mkv", "Doctor.Who.2005.S01E01.mkv"],
  ["The.Office.US.S01E01.mkv", "The.Office.UK.S01E01.mkv"],
  ["Dragon.Ball.Z.S01E01.mkv", "Dragon.Ball.Super.S01E01.mkv"],
  ["Dragon.Ball.S01E01.mkv", "Dragon.Ball.Z.S01E01.mkv"],
  ["Star.Trek.Discovery.S01E01.mkv", "Star.Trek.Strange.New.Worlds.S01E01.mkv"],
  ["Star Trek - Discovery - S01E01.mkv", "Star.Trek.S01E01.mkv"],
  ["9-1-1.S01E01.mkv", "9-1-1.Lone.Star.S01E01.mkv"],
  ["Gotham.S01E01.mkv", "Gotham.Knights.S01E01.mkv"],
  ["Lost.S01E01.mkv", "Last.S01E01.mkv"],
  ["Fargo.S01E01.mkv", "Cargo.S01E01.mkv"],
  ["Law.and.Order.S01E01.mkv", "Law.and.Order.SVU.S01E01.mkv"],
  ["Ted.Lasso.S01E01.mkv", "Ted.S01E01.mkv"],
  ["House.S01E01.mkv", "House.of.the.Dragon.S01E01.mkv"],
  ["Daredevil.S01E01.mkv", "Daredevil.Born.Again.S01E01.mkv"],
];

/** Files for the mock library: every SAME_SHOW name plus one side of the look-alikes. */
export const MOCK_SHOW_FILES: string[] = [
  ...SAME_SHOW.map((s) => s.name),
  "Battlestar.Galactica.1978.S01E01.mkv", "Battlestar.Galactica.2004.S01E01.mkv",
  "The.Office.UK.S01E01.mkv", "Dragon.Ball.Z.S01E01.mkv", "Dragon.Ball.Super.S01E01.mkv",
  "Star.Trek.Discovery.S01E01.mkv", "Star.Trek.Strange.New.Worlds.S01E01.mkv",
];
