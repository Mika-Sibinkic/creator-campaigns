// src/components/CampaignMaterials.tsx
//
// Promo-material upload for a campaign. The track to promote (WAV/MP3/MP4) plus
// any images/PDF, uploaded at campaign inception and auto-attached to creators
// when they pay. Self-contained: owns its own fetch + upload state so it never
// re-renders the parent's creator list.
"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Upload, Paperclip, Music, Video, Image as ImageIcon, FileText } from "lucide-react";

interface Material {
  id: string;
  filename: string;
  content_type: string | null;
  size_bytes: number | null;
  created_at: string;
}

function fmtSize(n: number | null): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function iconFor(type: string | null) {
  if (!type) return <Paperclip className="size-4 text-muted-foreground" />;
  if (type.startsWith("audio")) return <Music className="size-4 text-primary" />;
  if (type.startsWith("video")) return <Video className="size-4 text-primary" />;
  if (type.startsWith("image")) return <ImageIcon className="size-4 text-primary" />;
  return <FileText className="size-4 text-muted-foreground" />;
}

export function CampaignMaterials({ campaignId }: { campaignId: string }) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/materials`);
      if (res.ok) {
        const j = (await res.json()) as { materials: Material[] };
        setMaterials(j.materials ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/campaigns/${campaignId}/materials`, { method: "POST", body: fd });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(
          j.error === "file_too_large"
            ? "That file is over 30MB, so nothing was uploaded."
            : j.error === "unsupported_type"
              ? "That file type is not accepted. Use WAV, MP3, MP4, JPG, PNG or PDF."
              : "That file could not be uploaded. Nothing was changed. Try again."
        );
        return;
      }
      const j = (await res.json()) as { material: Material };
      setMaterials((m) => [...m, j.material]);
    } catch {
      setError("That file could not be uploaded. Nothing was changed. Try again.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Paperclip className="size-4" /> Promo materials
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Everything in this list is emailed to every creator you pay, as soon
          as their payment goes through. Put the track and the assets you want
          them posting here. Nothing private, and no contracts.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          /* One loading treatment across the campaign page and its cards. */
          <Skeleton className="h-16 w-full" />
        ) : materials.length === 0 ? (
          <div className="text-sm text-muted-foreground">Nothing uploaded yet.</div>
        ) : (
          <ul className="space-y-2">
            {materials.map((m) => (
              <li key={m.id} className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm">
                {iconFor(m.content_type)}
                <span className="flex-1 truncate">{m.filename}</span>
                <span className="text-xs text-muted-foreground">{fmtSize(m.size_bytes)}</span>
              </li>
            ))}
          </ul>
        )}

        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept="audio/wav,audio/mpeg,audio/mp3,video/mp4,image/jpeg,image/png,image/webp,application/pdf"
          onChange={onFile}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" disabled={uploading} onClick={() => inputRef.current?.click()}>
            {uploading ? (
              <><Loader2 className="size-4 animate-spin" /> Uploading…</>
            ) : (
              <><Upload className="size-4" /> Upload material</>
            )}
          </Button>
          <span className="text-xs text-muted-foreground">
            WAV, MP3, MP4, JPG, PNG or PDF, up to 30MB each.
          </span>
        </div>
        {error && <div className="text-sm text-destructive">{error}</div>}
      </CardContent>
    </Card>
  );
}
