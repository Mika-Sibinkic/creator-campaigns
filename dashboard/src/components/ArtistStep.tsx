"use client";

// The new-campaign artist step. A campaign is created for a confirmed artist:
// a picked candidate card or a resolved Spotify link, never just a typed name.
// Cards carry enough (image, listeners, genres, latest release, Spotify link)
// to tell two artists with the same name apart. Server side: /api/artists/*
// and src/lib/artist-lookup.ts; the create route re-verifies the id.

import { useEffect, useRef, useState } from "react";
import { CircleCheck, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  artistNameMismatch,
  formatListeners,
  parseSpotifyArtistRef,
  type ArtistCandidate,
} from "@/lib/artist-identity";

const RESOLVE_ERROR_COPY: Record<string, string> = {
  invalid_link: "That isn't a Spotify artist link.",
  artist_not_found: "Spotify has no artist at that link.",
  artist_lookup_unavailable: "Spotify can't be reached right now. Try again in a minute.",
};

function releaseLine(c: ArtistCandidate): string | null {
  const r = c.latest_release;
  if (!r) return null;
  const year = r.release_date?.slice(0, 4);
  const meta = [r.type === "album" ? "album" : r.type, year].filter(Boolean).join(", ");
  return `Latest: ${r.name}${meta ? ` (${meta})` : ""}`;
}

// Provider image URLs can 404 or refuse hotlinking (Soundcharts' fallback
// images have), so a failed load falls back to the initial
// instead of leaving a blank square.
function ArtistImage({ src, name }: { src: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        width={48}
        height={48}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="size-11 shrink-0 rounded-md object-cover"
      />
    );
  }
  return (
    <div className="flex size-11 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-medium text-muted-foreground">
      {name.charAt(0).toUpperCase() || "?"}
    </div>
  );
}

export function ArtistCard({
  artist,
  action,
  highlighted = false,
}: {
  artist: ArtistCandidate;
  action?: React.ReactNode;
  highlighted?: boolean;
}) {
  const facts = [
    artist.monthly_listeners != null ? formatListeners(artist.monthly_listeners) : null,
    artist.genres.length > 0 ? artist.genres.join(", ") : null,
    artist.country_code,
  ].filter(Boolean);
  const release = releaseLine(artist);
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 ${
        highlighted ? "border-foreground/25 bg-muted/40" : "bg-background"
      }`}
    >
      <ArtistImage key={artist.image_url ?? ""} src={artist.image_url} name={artist.name} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-sm font-medium text-foreground">{artist.name}</p>
        {facts.length > 0 && (
          <p className="truncate text-xs text-muted-foreground">{facts.join(" · ")}</p>
        )}
        {release && <p className="truncate text-xs text-muted-foreground">{release}</p>}
        <a
          href={artist.spotify_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-faint underline-offset-4 hover:text-foreground hover:underline"
        >
          Open in Spotify
          <ExternalLink className="size-3" />
        </a>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

type LinkState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "resolved"; artist: ArtistCandidate };

export function ArtistStep({
  artistName,
  onArtistNameChange,
  identity,
  onIdentityChange,
}: {
  artistName: string;
  onArtistNameChange: (name: string) => void;
  identity: ArtistCandidate | null;
  onIdentityChange: (artist: ArtistCandidate | null) => void;
}) {
  const [candidates, setCandidates] = useState<ArtistCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchedFor, setSearchedFor] = useState("");
  const [linkText, setLinkText] = useState("");
  const [link, setLink] = useState<LinkState>({ kind: "idle" });
  const searchSeq = useRef(0);

  useEffect(() => {
    const q = artistName.trim();
    const seq = ++searchSeq.current;
    const t = setTimeout(async () => {
      if (identity || q.length < 2) {
        if (searchSeq.current === seq) {
          setCandidates([]);
          setSearching(false);
          setSearchedFor("");
        }
        return;
      }
      setSearching(true);
      try {
        const res = await fetch(`/api/artists/search?q=${encodeURIComponent(q)}`);
        const items = res.ok ? ((await res.json()) as ArtistCandidate[]) : [];
        if (searchSeq.current === seq) {
          setCandidates(Array.isArray(items) ? items : []);
          setSearchedFor(q);
        }
      } catch {
        if (searchSeq.current === seq) setCandidates([]);
      } finally {
        if (searchSeq.current === seq) setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [artistName, identity]);

  function confirm(artist: ArtistCandidate) {
    onIdentityChange(artist);
    // The campaign carries the confirmed artist's name, so the name and the
    // identity cannot drift apart. The create route checks the same thing.
    onArtistNameChange(artist.name);
    setCandidates([]);
    setLinkText("");
    setLink({ kind: "idle" });
  }

  async function resolveLink() {
    const id = parseSpotifyArtistRef(linkText);
    if (!id) {
      setLink({ kind: "error", message: "Paste a link like open.spotify.com/artist/…" });
      return;
    }
    setLink({ kind: "loading" });
    try {
      const res = await fetch(`/api/artists/resolve?ref=${encodeURIComponent(id)}`);
      const body = (await res.json().catch(() => ({}))) as {
        artist?: ArtistCandidate;
        error?: string;
      };
      if (res.ok && body.artist) {
        setLink({ kind: "resolved", artist: body.artist });
      } else {
        setLink({
          kind: "error",
          message:
            (body.error && RESOLVE_ERROR_COPY[body.error]) ??
            "That link couldn't be checked. Try again.",
        });
      }
    } catch {
      setLink({ kind: "error", message: RESOLVE_ERROR_COPY.artist_lookup_unavailable });
    }
  }

  const query = artistName.trim();
  const noMatches =
    !identity && !searching && query.length >= 2 && searchedFor === query && candidates.length === 0;
  const resolved = link.kind === "resolved" ? link.artist : null;
  const mismatch = resolved ? artistNameMismatch(artistName, resolved.name) : false;

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="artist_name">Artist name</Label>
        <Input
          id="artist_name"
          placeholder="e.g. Ada Sample"
          autoComplete="off"
          value={artistName}
          onChange={(e) => {
            const next = e.target.value;
            onArtistNameChange(next);
            if (identity && artistNameMismatch(next, identity.name)) onIdentityChange(null);
          }}
          required
        />
      </div>

      {identity ? (
        <ArtistCard
          artist={identity}
          highlighted
          action={
            <div className="flex flex-col items-end gap-1.5">
              <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                <CircleCheck className="size-3.5" aria-hidden />
                Confirmed
              </span>
              <Button type="button" variant="ghost" size="xs" onClick={() => onIdentityChange(null)}>
                Change
              </Button>
            </div>
          }
        />
      ) : (
        <>
          {(candidates.length > 0 || searching || noMatches) && (
            <div className="space-y-2" aria-live="polite">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {searching && <Loader2 className="size-3 animate-spin" />}
                {noMatches
                  ? "No match on Spotify. Paste their artist link below."
                  : "Which artist is it?"}
              </p>
              {candidates.map((c) => (
                <ArtistCard
                  key={c.spotify_id}
                  artist={c}
                  action={
                    <Button type="button" variant="outline" size="sm" onClick={() => confirm(c)}>
                      Select
                    </Button>
                  }
                />
              ))}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="spotify_artist_link">
              Or paste their Spotify artist link
            </Label>
            <div className="flex gap-2">
              <Input
                id="spotify_artist_link"
                placeholder="open.spotify.com/artist/…"
                autoComplete="off"
                value={linkText}
                aria-invalid={link.kind === "error"}
                onChange={(e) => {
                  setLinkText(e.target.value);
                  if (link.kind !== "idle") setLink({ kind: "idle" });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void resolveLink();
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void resolveLink()}
                disabled={!linkText.trim() || link.kind === "loading"}
              >
                {link.kind === "loading" ? <Loader2 className="size-4 animate-spin" /> : "Look up"}
              </Button>
            </div>
            {link.kind === "error" && <p className="text-xs text-destructive">{link.message}</p>}
          </div>

          {resolved && (
            <div className="space-y-2">
              {mismatch && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-attention-border bg-attention p-3 text-sm"
                >
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-attention-fg" />
                  <p>
                    Name doesn&apos;t match. This link is <strong>{resolved.name}</strong>, you
                    typed <strong>{query}</strong>. Check it&apos;s the right artist.
                  </p>
                </div>
              )}
              <ArtistCard
                artist={resolved}
                action={
                  <Button
                    type="button"
                    size="sm"
                    variant={mismatch ? "outline" : "default"}
                    onClick={() => confirm(resolved)}
                  >
                    {mismatch ? `Use ${resolved.name}` : "Use this artist"}
                  </Button>
                }
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
