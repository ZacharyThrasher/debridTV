// A stand-in for C4's On Demand endpoints (N-30), built from the demo library so UI
// tests and screenshots can run before the server ships them. Shapes follow the
// contract B4 sent through the coordinator:
//   GET /api/ondemand?q=&kind=all|show|movie  -> { shows, movies, episodes (only when q is set) }
//   GET /api/ondemand/show?key=               -> { key, name, description, art, seasons, nextUp }
//   GET /api/continue?limit=                  -> { items }
// Watch progress is invented here, deterministically, so the screens have something to show.

import { demoItems } from "../../app/demo.ts";

const MIN = 60_000;

type Demo = ReturnType<typeof demoItems>[number];

export interface MockItem {
  id: string;
  kind: "episode" | "movie";
  title: string;
  showKey?: string;
  season?: number;
  episode?: number;
  label?: string;
  subtitle?: string;
  year?: number;
  description?: string;
  genre?: string;
  rating?: string | null;
  durationMs: number | null;
  seenMs: number;
  resumeMs: number | null;
  watched: boolean;
  availability: string;
  availabilityReason?: string;
  art?: Record<string, string>;
  codecs?: object;
}

export function makeOnDemand(opts: { art?: boolean; empty?: boolean; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const items = opts.empty ? [] : demoItems();
  // Progress: the first few episodes of some shows are watched, one is half way, and so on.
  const progress = new Map<string, number>(); // id -> fraction seen
  const lastAt = new Map<string, number>();
  const shows = new Map<string, Demo[]>();
  for (const i of items) if (i.parsed.kind === "episode") shows.set(i.parsed.showKey, [...(shows.get(i.parsed.showKey) ?? []), i]);
  const plan: Array<[string, number, number]> = [
    ["harbor lights", 5, 0.42], ["the night desk", 2, 0.71], ["star courier", 3, 1], ["saturday robots", 7, 0.18], ["weathervane mysteries", 0, 0.55],
  ];
  plan.forEach(([key, done, partial], n) => {
    const eps = shows.get(key) ?? [];
    eps.slice(0, done).forEach((e, k) => (progress.set(e.id, 1), lastAt.set(e.id, now - (n + 2) * 86_400_000 + k * MIN)));
    const cur = eps[done];
    if (cur) (progress.set(cur.id, partial), lastAt.set(cur.id, now - (n + 1) * 3_600_000 * (n + 1)));
  });
  const movies = items.filter((i) => i.parsed.kind === "movie");
  if (movies[1]) (progress.set(movies[1].id, 0.36), lastAt.set(movies[1].id, now - 50 * MIN));
  if (movies[4]) (progress.set(movies[4].id, 1), lastAt.set(movies[4].id, now - 4 * 86_400_000));

  const art = (i: Demo) => (opts.art ? { poster: `/api/art/${i.id}/poster`, fanart: `/api/art/${i.id}/fanart`, thumb: `/api/art/${i.id}/thumb` } : undefined);
  const view = (i: Demo): MockItem => {
    const p = i.parsed as any;
    const f = progress.get(i.id) ?? 0;
    const d = i.durationMs ?? 0;
    const seen = Math.round(f * d);
    const watched = f >= 0.9;
    return {
      id: i.id, kind: p.kind, title: p.kind === "episode" ? p.show : p.title, showKey: p.showKey, season: p.season, episode: p.episode,
      label: p.kind === "episode" ? `S${p.season} · E${p.episode}` : undefined, subtitle: i.subtitle, year: p.year ?? i.meta?.year,
      description: i.meta?.plot ?? (p.kind === "movie" ? `A ${String(i.genre).toLowerCase()} picture from ${p.year}.` : undefined),
      genre: i.genre, rating: i.meta?.ratingText ?? null, durationMs: i.durationMs, seenMs: seen,
      resumeMs: !watched && seen >= MIN ? seen : null, watched, availability: i.availability, art: art(i),
      codecs: { container: "mkv", video: "h264", audio: ["eac3"], height: 1080, audioChannels: 6 },
    };
  };
  const nextUp = (eps: Demo[]) => {
    const firstUnwatched = eps.find((e) => (progress.get(e.id) ?? 0) < 0.9);
    return firstUnwatched ? view(firstUnwatched) : null;
  };
  const showRow = (key: string, eps: Demo[]) => ({
    key, name: (eps[0]!.parsed as any).show, episodes: eps.length, seasons: [...new Set(eps.map((e) => (e.parsed as any).season))],
    genre: eps[0]!.genre, rating: eps[0]!.meta?.ratingText ?? null, art: art(eps[0]!),
    watchedCount: eps.filter((e) => (progress.get(e.id) ?? 0) >= 0.9).length, nextUp: nextUp(eps),
  });

  return {
    list(q = "", kind = "all") {
      const m = (s?: string) => !q || !!s?.toLowerCase().includes(q.toLowerCase());
      const s = [...shows].filter(([, eps]) => m((eps[0]!.parsed as any).show) || eps.some((e) => m(e.subtitle))).map(([k, eps]) => showRow(k, eps));
      const mv = movies.filter((i) => m((i.parsed as any).title)).map(view);
      // Episode names only count as hits while searching, so browsing stays show-sized.
      const episodes = q && kind !== "movie" ? items.filter((i) => i.parsed.kind === "episode" && m(i.subtitle)).slice(0, 30).map(view) : [];
      return {
        shows: kind === "movie" ? [] : s.sort((a, b) => a.name.localeCompare(b.name)),
        movies: kind === "show" ? [] : mv.sort((a, b) => a.title.localeCompare(b.title)),
        episodes,
      };
    },
    show(key: string) {
      const eps = shows.get(key);
      if (!eps) return null;
      const seasons = [...new Set(eps.map((e) => (e.parsed as any).season as number))].map((season) => ({
        season, episodes: eps.filter((e) => (e.parsed as any).season === season).map(view),
      }));
      return { key, name: (eps[0]!.parsed as any).show, description: `${eps[0]!.genre}. ${eps.length} episodes in your library.`, art: art(eps[0]!), seasons, nextUp: nextUp(eps) };
    },
    continueWatching(limit = 20) {
      const out: Array<MockItem & { reason: string; lastAt: number; channel: string }> = [];
      for (const [, eps] of shows) {
        const seen = eps.filter((e) => lastAt.has(e.id)).sort((a, b) => lastAt.get(b.id)! - lastAt.get(a.id)!);
        const last = seen[0];
        if (!last) continue;
        const v = view(last);
        if (v.resumeMs != null) out.push({ ...v, reason: "resume", lastAt: lastAt.get(last.id)!, channel: "" });
        else {
          const next = eps[eps.indexOf(last) + 1];
          if (next && (progress.get(next.id) ?? 0) < 0.9) out.push({ ...view(next), reason: "next", lastAt: lastAt.get(last.id)!, channel: "" });
        }
      }
      for (const mv of movies) {
        const v = view(mv);
        if (v.resumeMs != null) out.push({ ...v, reason: "resume", lastAt: lastAt.get(mv.id)!, channel: "" });
      }
      return { items: out.sort((a, b) => b.lastAt - a.lastAt).slice(0, limit) };
    },
  };
}

/** Answers an On Demand request from the mock, or returns null for any other path. */
export function answerOnDemand(mock: ReturnType<typeof makeOnDemand>, url: URL): unknown {
  if (url.pathname === "/api/ondemand") return mock.list(url.searchParams.get("q") ?? "", url.searchParams.get("kind") ?? "all");
  if (url.pathname === "/api/ondemand/show") return mock.show(url.searchParams.get("key") ?? "");
  if (url.pathname === "/api/continue") return mock.continueWatching(Number(url.searchParams.get("limit") ?? 20));
  return null;
}
