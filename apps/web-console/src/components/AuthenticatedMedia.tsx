import { useEffect, useState } from 'react';
import { apiBaseUrl, readSession } from '../api/client';

/**
 * Renders an artifact that the API only serves to an authorized caller.
 *
 * A plain <img src="…"> cannot work here: the browser issues that request without the
 * Authorization header, so the API — correctly — refuses it. Putting the access token in
 * the URL instead would leak it into history, referrers and any logging proxy in between.
 * Fetching the bytes with the header and rendering an object URL keeps the credential in
 * memory where it belongs.
 */
export function useArtifactObjectUrl(artifactId: string | null): {
  url: string | null;
  error: string | null;
  loading: boolean;
} {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!artifactId) return;

    let objectUrl: string | null = null;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const token = readSession()?.accessToken;
        const response = await fetch(`${apiBaseUrl()}/api/v1/artifacts/${artifactId}/content`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`The artifact could not be loaded (${response.status}).`);

        objectUrl = URL.createObjectURL(await response.blob());
        setUrl(objectUrl);
      } catch (caught) {
        if ((caught as Error).name !== 'AbortError') {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        setLoading(false);
      }
    })();

    return () => {
      controller.abort();
      // Object URLs pin their blob in memory until revoked; a long evidence session with
      // dozens of screenshots would otherwise keep every one of them alive.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifactId]);

  return { url, error, loading };
}

export function ArtifactImage({ artifactId, alt, className }: {
  artifactId: string;
  alt: string;
  className?: string;
}) {
  const { url, error, loading } = useArtifactObjectUrl(artifactId);

  if (loading) {
    return (
      <div className={`flex items-center justify-center bg-surface-sunken ${className ?? 'h-48'}`}>
        <span className="text-xs text-ink-muted">Loading…</span>
      </div>
    );
  }

  if (error || !url) {
    return (
      <div className={`flex items-center justify-center bg-bad-light px-3 text-center ${className ?? 'h-48'}`}>
        <span className="text-xs text-bad">{error ?? 'The artifact is not available.'}</span>
      </div>
    );
  }

  return <img src={url} alt={alt} className={className} loading="lazy" />;
}

/** Opens or downloads an artifact, fetching it with the caller's credentials first. */
export function ArtifactLink({ artifactId, name, children, className }: {
  artifactId: string;
  name: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = readSession()?.accessToken;
      const response = await fetch(`${apiBaseUrl()}/api/v1/artifacts/${artifactId}/content`, {
        headers: token ? { authorization: `Bearer ${token}` } : {}
      });
      if (!response.ok) throw new Error(`The artifact could not be loaded (${response.status}).`);

      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = name;
      anchor.rel = 'noreferrer';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoked on the next tick: revoking immediately can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" onClick={open} disabled={busy} className={className}>
        {busy ? 'Fetching…' : children}
      </button>
      {error && <p className="mt-1 text-xs text-bad">{error}</p>}
    </>
  );
}
