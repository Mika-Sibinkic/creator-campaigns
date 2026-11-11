// The confirmed artist on the campaign page header: image, name, Spotify link.
// Renders nothing for legacy campaigns created before identity was required.

import { ExternalLink } from "lucide-react";
import { readArtistIdentity } from "@/lib/artist-identity";

export function ArtistIdentityChip({
  campaign,
}: {
  campaign: { artist_spotify_id?: string | null; artist_name?: string | null; artist_data?: unknown };
}) {
  const identity = readArtistIdentity(campaign);
  if (!identity) return null;
  return (
    <a
      href={identity.spotify_url}
      target="_blank"
      rel="noopener noreferrer"
      title="Open in Spotify"
      className="inline-flex h-6 items-center gap-1.5 rounded-full border bg-background py-0.5 pl-0.5 pr-2 text-meta text-foreground transition-colors hover:bg-accent"
    >
      {identity.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={identity.image_url}
          alt=""
          width={20}
          height={20}
          className="size-5 rounded-full object-cover"
        />
      ) : (
        <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
          {identity.name.charAt(0).toUpperCase() || "?"}
        </span>
      )}
      <span className="font-medium">{identity.name}</span>
      <span className="inline-flex items-center gap-0.5 text-xs text-faint">
        Spotify
        <ExternalLink className="size-3" />
      </span>
    </a>
  );
}
