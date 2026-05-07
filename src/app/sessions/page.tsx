"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import { buildHeaders, getProxyBase, type ListResponse } from "@/lib/api";

interface SessionId {
  id: string;
}

export default function SessionsIndexPage() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${getProxyBase()}/v2/sessions?limit=1`, {
          headers: buildHeaders(),
        });
        if (!res.ok || cancelled) return;
        const data: ListResponse<SessionId> = await res.json();
        const first = data.data?.[0];
        if (first && !cancelled) {
          router.replace(`/sessions/${first.id}`);
        }
      } catch {
        // silent
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="p-6 text-sm text-muted-foreground">Loading sessions…</div>
  );
}
