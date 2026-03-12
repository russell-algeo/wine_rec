export type UrlPreview = {
  title: string | null;
  domain: string;
};

export async function fetchUrlPreview(url: string): Promise<UrlPreview> {
  const parsed = new URL(url);
  const domain = parsed.hostname;

  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; WineRecBot/1.0)" },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch URL preview: ${response.status}`);
  }

  const html = await response.text();
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? null;

  return { title, domain };
}
