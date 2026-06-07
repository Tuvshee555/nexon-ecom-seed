const DRIVE_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/;

function cleanUrlCandidate(value: string): string {
  return value.replace(/[)\].,!?;:]+$/g, "");
}

function addId(ids: string[], value: string | null | undefined) {
  const cleaned = String(value || "").trim();
  if (!DRIVE_FILE_ID_PATTERN.test(cleaned)) return;
  if (!ids.includes(cleaned)) ids.push(cleaned);
}

export function extractGoogleDriveFileIds(text: string): string[] {
  const ids: string[] = [];
  const urlMatches = text.match(/https?:\/\/[^\s<>"']+/gi) || [];

  for (const rawUrl of urlMatches) {
    const urlText = cleanUrlCandidate(rawUrl);
    let url: URL;
    try {
      url = new URL(urlText);
    } catch {
      continue;
    }

    const host = url.hostname.toLowerCase();
    const isDriveHost =
      host === "drive.google.com" ||
      host.endsWith(".drive.google.com") ||
      host === "docs.google.com" ||
      host.endsWith(".docs.google.com");
    if (!isDriveHost) continue;

    addId(ids, url.searchParams.get("id"));

    const pathMatch =
      /\/d\/([^/]+)/.exec(url.pathname) ||
      /\/file\/d\/([^/]+)/.exec(url.pathname) ||
      /\/open\/([^/]+)/.exec(url.pathname);
    addId(ids, pathMatch?.[1]);
  }

  return ids;
}
